import { createClient } from '@sanity/client';
import { Resend } from 'resend';

/**
 * Studio document actions that need to reach outside Sanity.
 *
 *   approve   status -> approved, stamps approvedAt, mints a one-shot
 *             approveToken and emails the customer their proof
 *   hold      status -> on_hold with the reviewer's note
 *   rerender  asks the render job to run again, status -> preparing
 *
 * Guarded by a shared secret the Studio sends as a header. Be clear-eyed about
 * what that is worth: SANITY_STUDIO_* values are compiled into the Studio bundle
 * and that bundle is public, so this stops drive-by traffic, not somebody who
 * reads the JavaScript. Nothing here exposes the print file or a customer photo,
 * and every action is idempotent-ish and reversible from the Studio, which is
 * why a shared secret is a reasonable fit for now. Anything with real financial
 * consequence should not be added behind it without moving to a proper check of
 * the caller's Sanity session.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

// Built on first use, not at import. `new Resend()` throws when RESEND_API_KEY
// is absent, and at module scope that throw happens at IMPORT time -- before
// the handler exists -- so a missing key took down Hold and Re-render too,
// neither of which sends anything. Memoised, so warm containers still reuse one
// client. Mirrors getStripe() in personalise.mjs.
let resendClient;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

/** Constant-time-ish compare so the secret cannot be probed a byte at a time. */
function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const newToken = () => {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
};

const BRAND = {
  yellow: '#FFF200',
  pink: '#EC008C',
  dark: '#111111',
  site: 'https://comicstripcanvas.co.uk',
};

export default async (req, context) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const expected = process.env.PERSONALISATION_ACTION_SECRET;
  if (!expected) {
    console.error('personalisation-action: PERSONALISATION_ACTION_SECRET is not set — refusing.');
    return json({ ok: false, error: 'Actions are not configured on this deploy' }, 503);
  }
  if (!sameSecret(req.headers.get('x-csc-action-secret'), expected)) {
    console.warn('personalisation-action: rejected a call with a bad or missing secret');
    return json({ ok: false, error: 'Not authorised' }, 401);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad JSON' }, 400); }

  const { action, id } = body || {};
  if (!isId(id)) return json({ ok: false, error: 'Invalid id' }, 400);

  const doc = await sanity.getDocument(id);
  if (!doc) return json({ ok: false, error: 'Unknown personalisation' }, 404);

  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;

  try {
    if (action === 'approve') return await approve(doc, id, origin);
    if (action === 'hold') return await hold(doc, id, body.note);
    if (action === 'rerender') return await rerender(doc, id, origin);
    return json({ ok: false, error: `Unknown action "${action}"` }, 400);
  } catch (err) {
    console.error(`personalisation-action: ${action} on ${id} failed:`, err.message);
    return json({ ok: false, error: err.message }, 500);
  }
};

/** The address a customer should reply to, taken from the configured sender. */
function replyAddress() {
  const from = process.env.EMAIL_FROM || '';
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim() || 'orders@comicstripcanvas.co.uk';
}

async function customerEmailFor(doc) {
  if (doc.customerEmail) return doc.customerEmail;   // if it is ever stored here
  if (!doc.orderId) return '';
  const order = await sanity.fetch('*[_id == $id][0]{ customerEmail }', { id: doc.orderId });
  return (order && order.customerEmail) || '';
}

/* ---------------------------------------------------------------- approve --- */
async function approve(doc, id, origin) {
  if (doc.status !== 'rendered') {
    return json({ ok: false, error: `Only a rendered proof can be approved (this is "${doc.status}")` }, 409);
  }
  if (!doc.proofUrl) {
    return json({ ok: false, error: 'There is no proof to send' }, 409);
  }

  // Minted before the email so the link in it is the one we stored.
  const token = newToken();
  const approvedAt = new Date().toISOString();
  await sanity.patch(id).set({ status: 'approved', approvedAt, approveToken: token }).commit();

  // The customer address lives on the order the webhook stamped onto this
  // document, not on the personalisation itself.
  const email = (await customerEmailFor(doc)).trim();
  if (!email) {
    console.error(`personalisation-action: ${id} approved but has no customer email on the document`);
    return json({ ok: true, status: 'approved', emailed: false, emailError: 'No customer email on the document' });
  }

  const approveLink = `${origin}/api/personalisation-approve?id=${id}&t=${token}`;
  const shopEmail = replyAddress();
  const subject = 'Your Comic Strip Canvas artwork is ready to approve';

  try {
    const resend = getResend();
    if (!resend) throw new Error('RESEND_API_KEY is not set on this deploy');
    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
      to: email,
      replyTo: shopEmail,
      subject,
      html: proofEmailHtml({ proofUrl: doc.proofUrl, approveLink, shopEmail, subject }),
    });
    if (error) throw new Error(typeof error === 'string' ? error : error.message || 'Resend rejected the send');
  } catch (err) {
    console.error(`personalisation-action: proof email for ${id} failed:`, err.message);
    // The approval stands — a reviewer did approve it — but say plainly that the
    // customer has not been told.
    return json({ ok: true, status: 'approved', emailed: false, emailError: err.message });
  }

  console.log(`personalisation-action: ${id} approved and proof emailed to ${email}`);
  return json({ ok: true, status: 'approved', emailed: true });
}

/* ------------------------------------------------------------------- hold --- */
async function hold(doc, id, note) {
  const text = typeof note === 'string' ? note.trim().slice(0, 2000) : '';
  if (!text) return json({ ok: false, error: 'A hold needs a note' }, 400);
  await sanity.patch(id).set({ status: 'on_hold', holdNote: text }).commit();
  console.log(`personalisation-action: ${id} put on hold — ${text.slice(0, 120)}`);
  return json({ ok: true, status: 'on_hold' });
}

/* -------------------------------------------------------------- re-render --- */
async function rerender(doc, id, origin) {
  if (doc.status !== 'rendered' && doc.status !== 'on_hold') {
    return json({ ok: false, error: `Cannot re-render from "${doc.status}"` }, 409);
  }
  // preparing is in the render job's renderable set, so it will pick this up.
  await sanity.patch(id).set({ status: 'preparing' }).unset(['renderError']).commit();

  const res = await fetch(`${origin}/api/render-personalisation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const msg = `The render job would not start (${res.status})`;
    await sanity.patch(id).set({ status: 'on_hold', renderError: msg }).commit();
    return json({ ok: false, error: msg }, 502);
  }
  console.log(`personalisation-action: ${id} queued for re-render`);
  return json({ ok: true, status: 'preparing' });
}

/* ------------------------------------------------------------------ email --- */
function proofEmailHtml({ proofUrl, approveLink, shopEmail, subject }) {
  const mailto = `mailto:${shopEmail}?subject=${encodeURIComponent('Re: ' + subject)}`;
  return `
  <div style="background:#f4f4f4;padding:24px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;">
      <div style="background:${BRAND.dark};padding:24px;text-align:center;">
        <p style="margin:0;color:${BRAND.yellow};font-size:20px;font-weight:bold;letter-spacing:1px;">COMIC STRIP CANVAS</p>
      </div>

      <div style="padding:28px 24px;">
        <h1 style="margin:0 0 8px;font-size:22px;color:${BRAND.dark};">Your artwork is ready to approve</h1>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#444;">
          This is exactly the layout you set in the builder &mdash; your photos, your wording,
          your sizing. Nothing has been moved.
        </p>

        <div style="border:3px solid ${BRAND.dark};margin:0 0 22px;">
          <img src="${proofUrl}" alt="Your artwork proof" style="display:block;width:100%;height:auto;border:0;" />
        </div>

        <div style="text-align:center;margin:0 0 20px;">
          <a href="${approveLink}"
             style="display:inline-block;background:${BRAND.yellow};color:#000;text-decoration:none;
                    font-size:17px;font-weight:bold;letter-spacing:1px;padding:15px 38px;
                    border:3px solid #000;">APPROVE THIS ARTWORK</a>
        </div>

        <p style="margin:0;text-align:center;font-size:13px;color:#666;">
          <a href="${mailto}" style="color:${BRAND.pink};">Something&rsquo;s not right?</a>
          Reply and we&rsquo;ll put it right before anything is printed.
        </p>
      </div>

      <div style="background:${BRAND.dark};padding:18px;text-align:center;">
        <a href="${BRAND.site}" style="color:${BRAND.pink};text-decoration:none;font-size:12px;">comicstripcanvas.co.uk</a>
      </div>
    </div>
  </div>`;
}

// NOTE: deliberately NO `export const config = { path }` here.
// /api/personalisation-action is routed by the forced /api/* redirect in
// netlify.toml (/api/* -> /.netlify/functions/:splat), exactly like the others.
