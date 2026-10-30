import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { shippingEnabled, shippingRequest, quoteReturnPounds } from './_shared/shipping-client.mjs';
import { verifyTurnstile } from './_shared/turnstile.mjs';
import { takeSlot, hashKey } from './_shared/rate-limit.mjs';
import { evaluateReturn, pickLines, REASONS, longDate } from './_shared/returns-eligibility.mjs';
import { bandFor } from './_shared/parcel-bands.mjs';
import { sendEmail, newReturnEmail } from './_shared/shipping-emails.mjs';

/**
 * returns.mjs
 * --------------------------------------------------------------------------
 * POST /api/returns   the public /returns page's two steps
 *
 *   {action: "lookup", orderNumber, email, turnstileToken, ...bot fields}
 *     -> which lines of that order can be returned for a change of mind, and
 *        a short-lived signed session for the second step.
 *   {action: "quote", session, lines: [{lineKey, quantity}]}
 *     -> {postage}: the return postage, in pounds, that would be deducted
 *        from the refund, from the service's quote-return; null when there is
 *        no exact figure (more than one item, so Alan chooses the box; an
 *        address outside the UK; or the quote failed). The page then shows the
 *        general wording, and the customer can still submit.
 *   {action: "submit", session, lines: [{lineKey, quantity}], reason, notes, ...bot fields}
 *     -> a returnRequest for Alan to approve, and an email to the team.
 *
 * Protected like the contact form: Cloudflare Turnstile on the lookup (the
 * step that reads an order), the same two honeypot fields and the 3-second
 * time-to-submit check on both, and a per-visitor rate limit. A wrong order
 * number and a wrong email get the same answer, so the form cannot be used to
 * find out whether an order exists.
 *
 * The second step needs no second Turnstile: it carries the session the first
 * step signed (HMAC with a key derived from SHIPPING_SECRET), which names the
 * order and expires after 30 minutes, and everything is re-checked against the
 * order as it is when the request is made. The quote needs the session too.
 *
 * The figure the customer is shown is a live quote. What is deducted is the
 * price create-return quotes when the label is bought (shipping-return-
 * background.mjs), which is the figure the label email states.
 *
 * The request is stored at returnRequest.<ref> -- a dotted id, so, like every
 * other customer document, anonymous reads of the public dataset never see it.
 *
 * 404 unless SHIPPING_ENABLED is "true".
 */

const SESSION_TTL_MS = 30 * 60 * 1000;
const MIN_SUBMIT_MS = 3000;
const HONEYPOT_FIELDS = ['csc_extra_note', 'csc_extra_confirm'];
const NOT_FOUND = "We couldn't find an order with that number and email address. Please check both — the order number is in your confirmation email, e.g. CSC-1042.";

const json = (status, body) => ({ status, body });

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sessionKey = (env) => createHmac('sha256', String(env.SHIPPING_SECRET || '')).update('csc-returns-session-v1').digest();

export function issueSession({ orderId, email }, { env = process.env, now = Date.now() } = {}) {
  const payload = b64(JSON.stringify({ o: orderId, e: email, x: now + SESSION_TTL_MS }));
  return `${payload}.${b64(createHmac('sha256', sessionKey(env)).update(payload).digest())}`;
}

export function readSession(token, { env = process.env, now = Date.now() } = {}) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !env.SHIPPING_SECRET) return null;
  const want = Buffer.from(b64(createHmac('sha256', sessionKey(env)).update(payload).digest()));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return s && typeof s.o === 'string' && s.x > now ? { orderId: s.o, email: s.e } : null;
  } catch { return null; }
}

/** "csc 1042", "#1042", "CSC-1042" -> "CSC-1042". */
export const normaliseOrderNumber = (s) => {
  const digits = String(s || '').toUpperCase().replace(/^\s*#?\s*(CSC)?[\s-]*/, '').trim();
  return /^\d{1,8}$/.test(digits) ? `CSC-${digits}` : null;
};

const clientIp = (req) => req.headers.get('x-nf-client-connection-ip')
  || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

/** True when the bot signals say this is not a person. Logged by name and length only. */
function botSignal(p) {
  const tripped = HONEYPOT_FIELDS.find((f) => typeof p[f] === 'string' && p[f].trim().length > 0);
  if (tripped) { console.warn(`returns bot signal — honeypot "${tripped}" non-empty — discarded`); return true; }
  const elapsed = Number(p.csc_ts_submit) - Number(p.csc_ts_load);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_SUBMIT_MS) {
    console.warn(`returns bot signal — submitted ${elapsed}ms after load — discarded`);
    return true;
  }
  return false;
}

const ORDER_FIELDS = '{ _id, _type, orderNumber, customerName, customerEmail, status, lineItems, personalisationDetails, shipment, shippingEmailSentAt, shippingAddress }';
const RETURNS_OF = '*[_type == "returnRequest" && orderId == $id]{ status, lines }';

async function findOrder(sanity, orderNumber, email) {
  return sanity.fetch(`*[_type == "order" && orderNumber == $n && lower(customerEmail) == $e][0]${ORDER_FIELDS}`, { n: orderNumber, e: email });
}

/** One item, one box: its band. Anything more is a box Alan chooses by hand. */
const bandOfPick = (lines) => (lines.length === 1 && lines[0].quantity === 1
  ? bandFor(lines[0].formatKey, lines[0].sizeKey) : null);

/** The session's order, re-read, if it still matches the session's email. */
async function sessionOrder(sanity, session) {
  const order = await sanity.fetch(`*[_type == "order" && _id == $id][0]${ORDER_FIELDS}`, { id: session.orderId });
  return order && String(order.customerEmail || '').trim().toLowerCase() === session.email ? order : null;
}

const publicLine = (l) => ({
  lineKey: l.lineKey, productTitle: l.productTitle, format: l.format, size: l.size,
  ordered: l.ordered, returnable: l.returnable, why: l.why,
});

export async function handleReturns(req, deps) {
  const {
    sanity, getResend, env = process.env, now = () => Date.now(), turnstile = verifyTurnstile, rateLimit = takeSlot,
    quote = async () => { throw new Error('no quote client'); }, log = console,
  } = deps;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!shippingEnabled(env)) return json(404, { error: 'Online returns are not available yet. Please contact us with your order number.' });

  let p;
  try { p = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  if (!p || typeof p !== 'object') return json(400, { error: 'Bad request' });
  const ip = clientIp(req);

  /* ── step 1: find the order ─────────────────────────────────────────── */
  if (p.action === 'lookup') {
    if (!env.TURNSTILE_SECRET_KEY) {
      log.error('returns: TURNSTILE_SECRET_KEY is not set — refusing');
      return json(503, { error: 'Returns are unavailable right now. Please contact us.' });
    }
    const token = typeof p.turnstileToken === 'string' ? p.turnstileToken.slice(0, 2048) : '';
    if (!token) return json(400, { error: 'Please complete the anti-spam check.' });
    const verdict = await turnstile(env.TURNSTILE_SECRET_KEY, token, ip);
    if (!verdict.ok) return json(verdict.status, { error: verdict.error });
    if (botSignal(p)) return json(404, { error: NOT_FOUND });

    const slot = await rateLimit('returns-lookup', hashKey('returns-lookup', ip), 10, 60 * 60 * 1000);
    if (!slot) return json(429, { error: 'Too many attempts. Please wait an hour, or contact us.' });

    const orderNumber = normaliseOrderNumber(p.orderNumber);
    const email = String(p.email || '').trim().toLowerCase().slice(0, 254);
    if (!orderNumber || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(404, { error: NOT_FOUND });

    const order = await findOrder(sanity, orderNumber, email);
    if (!order) return json(404, { error: NOT_FOUND });
    const existing = await sanity.fetch(RETURNS_OF, { id: order._id });
    const v = evaluateReturn(order, { now: now(), existing });
    return json(200, {
      ok: true,
      orderNumber: order.orderNumber,
      eligible: v.eligible,
      reason: v.reason,
      deliveryDateUnknown: v.deliveryDateUnknown,
      windowEndsOn: v.windowEndsOn ? longDate(v.windowEndsOn) : null,
      lines: v.lines.map(publicLine),
      reasons: REASONS,
      session: v.eligible ? issueSession({ orderId: order._id, email }, { env, now: now() }) : null,
    });
  }

  /* ── between the steps: what the postage will be ────────────────────── */
  if (p.action === 'quote') {
    const session = readSession(p.session, { env, now: now() });
    if (!session) return json(400, { error: 'This page has timed out. Please look up your order again.' });
    const slot = await rateLimit('returns-quote', hashKey('returns-quote', ip), 60, 60 * 60 * 1000);
    if (!slot) return json(200, { ok: true, postage: null });

    const order = await sessionOrder(sanity, session);
    if (!order) return json(400, { error: 'This page has timed out. Please look up your order again.' });
    const existing = await sanity.fetch(RETURNS_OF, { id: order._id });
    const picked = pickLines(evaluateReturn(order, { now: now(), existing }), p.lines);
    if (picked.error) return json(200, { ok: true, postage: null });
    const band = bandOfPick(picked.lines);
    const a = order.shippingAddress || {};
    const country = String(a.country || '').toUpperCase();
    if (!band || country !== 'GB' || !String(a.postcode || '').trim()) return json(200, { ok: true, postage: null });
    try {
      const postage = quoteReturnPounds(await quote({ band, postalCode: String(a.postcode).trim(), countryCode: country }));
      return json(200, { ok: true, postage });
    } catch (err) {
      log.warn(`returns: quote for ${order.orderNumber} (${band}) failed: ${err?.code || ''} ${err?.message || err}`);
      return json(200, { ok: true, postage: null });
    }
  }

  /* ── step 2: make the request ───────────────────────────────────────── */
  if (p.action === 'submit') {
    const session = readSession(p.session, { env, now: now() });
    if (!session) return json(400, { error: 'This page has timed out. Please look up your order again.' });
    if (botSignal(p)) return json(200, { ok: true, returnNumber: null });
    if (!Object.hasOwn(REASONS, p.reason)) return json(400, { error: 'Please choose a reason.' });
    const notes = typeof p.notes === 'string' ? p.notes.trim().slice(0, 1000) : '';

    const slot = await rateLimit('returns-submit', hashKey('returns-submit', ip), 5, 60 * 60 * 1000);
    if (!slot) return json(429, { error: 'Too many requests. Please wait an hour, or contact us.' });

    const order = await sessionOrder(sanity, session);
    if (!order) return json(400, { error: 'This page has timed out. Please look up your order again.' });
    const existing = await sanity.fetch(RETURNS_OF, { id: order._id });
    const v = evaluateReturn(order, { now: now(), existing });
    const picked = pickLines(v, p.lines);
    if (picked.error) return json(400, { error: picked.error });

    const ref = `ret-${randomBytes(8).toString('hex')}`;
    const returnNumber = `${order.orderNumber}-R${(existing || []).length + 1}`;
    const band = bandOfPick(picked.lines);
    const doc = {
      _id: `returnRequest.${ref}`,
      _type: 'returnRequest',
      returnRef: ref,
      returnNumber,
      source: 'customer',
      order: { _type: 'reference', _ref: order._id, _weak: true },
      orderId: order._id,
      orderNumber: order.orderNumber,
      customerName: order.customerName || '',
      customerEmail: order.customerEmail,
      lines: picked.lines,
      reason: p.reason,
      reasonLabel: REASONS[p.reason],
      ...(notes ? { customerNotes: notes } : {}),
      status: 'requested',
      freeLabel: false,
      ...(band ? { band } : {}),
      ...(v.deliveredAt ? { deliveredAt: v.deliveredAt, windowEndsOn: v.windowEndsOn } : {}),
      deliveryDateUnknown: v.deliveryDateUnknown,
      requestedAt: new Date(now()).toISOString(),
    };
    await sanity.create(doc);
    log.log(`returns: ${returnNumber} requested (${picked.lines.length} line(s))${v.deliveryDateUnknown ? ', delivery date unknown' : ''}`);

    const sent = await sendEmail(getResend(), newReturnEmail({ ...doc, windowEndsOn: v.windowEndsOn ? longDate(v.windowEndsOn) : null }));
    if (!sent.ok) log.error(`returns: ${returnNumber} team email not sent: ${sent.error}`);
    return json(200, { ok: true, returnNumber });
  }

  return json(400, { error: 'Bad request' });
}

let resendClient;
const getResend = () => {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  return (resendClient = new Resend(process.env.RESEND_API_KEY));
};

export default async (req) => {
  let r;
  try {
    const sanity = createClient({
      projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
      token: process.env.SANITY_WRITE_TOKEN, useCdn: false,
    });
    // A slow quote must not hold the page: 6 s, then the general wording.
    const quote = (body) => shippingRequest('quote-return', {
      body, fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(6000) }),
    });
    r = await handleReturns(req, { sanity, getResend, quote });
  } catch (err) {
    console.error('returns: failed:', err?.stack || err);
    r = json(500, { error: 'Something went wrong. Please try again, or contact us.' });
  }
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

// NOTE: no `export const config = { path }`. Routed by the forced /api/* redirect.
