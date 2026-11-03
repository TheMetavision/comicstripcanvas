import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { isValidSignature, SIGNATURE_HEADER_NAME } from '@sanity/webhook';
import { shippingEnabled, shippingCreate, shippingRequest, quotedPounds, testOrderFlag } from './_shared/shipping-client.mjs';
import { ALL_BANDS, recipientFor } from './_shared/parcel-bands.mjs';
import {
  sendEmail, returnLabelEmail, returnDeclinedEmail, returnProblemEmail,
} from './_shared/shipping-emails.mjs';

/**
 * shipping-return-background.mjs
 * --------------------------------------------------------------------------
 * POST /api/shipping-return   (started by sanity-orders-webhook.mjs, the Sanity
 *                              webhook "CSC orders", with a request signed with
 *                              SANITY_WEBHOOK_SECRET_SHIPPING)
 *
 * Alan decides a return request in the Studio:
 *   Approved -> the service's create-return buys the label, choosing the route
 *               itself (InPost locker drop-off for small parcels, Evri
 *               collection from the customer for large canvases). The
 *               customer is emailed the label PDF and the service's
 *               customerInstructions, plus -- unless it is a free label for a
 *               faulty or wrong item -- "£X.XX return postage will be deducted
 *               from your refund", from the quotedPrice create-return gives,
 *               which is also recorded as postageDeduction for Alan to take
 *               off the refund in Stripe. Status -> Label sent. Should the
 *               service ever give no price, the label still goes, with the
 *               deduction worded without a figure, and the request says so.
 *   Rejected -> a polite decline with the reason Alan wrote.
 *
 * Each email goes once: the request is claimed (a conditional write) before
 * anything is done, and labelSentAt / rejectionEmailSentAt mark it done. A
 * failure records the reason on the request and emails the team; changing the
 * band or setting the status to Approved again retries, and a label that
 * already exists is reused, never bought twice.
 *
 * The collection point a return is addressed to is never shown to the
 * customer: the label says it, and nothing else we send does.
 *
 * Background function (create-return, then the label PDF, then an email with
 * an attachment), routed from /api/shipping-return in netlify.toml.
 */

const CLAIM_TTL_MS = 10 * 60 * 1000;

const isConflict = (err) => {
  const status = err && (err.statusCode || err.response?.statusCode);
  return status === 409 || /revision/i.test((err && err.message) || '');
};

export async function processReturn(retId, { sanity, shipping, fetchLabel, getResend, now = () => Date.now(), log = console }) {
  let ret = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    ret = await sanity.getDocument(retId);
    if (!ret || ret._type !== 'returnRequest') return { outcome: 'ignored', reason: 'not a return request' };
    if (ret.status === 'approved' && ret.labelSentAt) return { outcome: 'ignored', reason: 'label already sent' };
    if (ret.status === 'rejected' && ret.rejectionEmailSentAt) return { outcome: 'ignored', reason: 'decline already sent' };
    if (ret.status !== 'approved' && ret.status !== 'rejected') return { outcome: 'ignored', reason: `status is ${ret.status}` };
    const claimedAt = Date.parse(ret.claimedAt || '');
    if (Number.isFinite(claimedAt) && now() - claimedAt < CLAIM_TTL_MS) return { outcome: 'ignored', reason: 'already in hand' };
    try {
      await sanity.patch(retId).ifRevisionId(ret._rev).set({ claimedAt: new Date(now()).toISOString() }).commit();
      break;
    } catch (err) {
      if (!isConflict(err)) throw err;
      ret = null;
    }
  }
  if (!ret) return { outcome: 'ignored', reason: 'the request kept changing; the next webhook will retry' };

  const resend = getResend();
  const name = ret.returnNumber || ret._id;
  const fail = async (reason, extra = {}) => {
    await sanity.patch(retId).set({ error: reason, ...extra }).unset(['claimedAt']).commit();
    log.error(`shipping-return: ${name}: ${reason}`);
    const sent = await sendEmail(resend, returnProblemEmail(ret, reason));
    if (!sent.ok) log.error(`shipping-return: ${name} problem email not sent: ${sent.error}`);
    return { outcome: 'error', reason };
  };

  /* ── rejected ─────────────────────────────────────────────────────────── */
  if (ret.status === 'rejected') {
    if (!String(ret.rejectionReason || '').trim()) {
      return fail('Rejected with no reason: write the reason in "Reason for rejecting" (the customer is sent it), then set the status to Rejected again.');
    }
    const sent = await sendEmail(resend, returnDeclinedEmail(ret));
    if (!sent.ok) return fail(`The decline email was not sent: ${sent.error}`);
    await sanity.patch(retId).set({ rejectionEmailSentAt: new Date(now()).toISOString() }).unset(['claimedAt', 'error']).commit();
    log.log(`shipping-return: ${name} declined, customer emailed`);
    return { outcome: 'rejected' };
  }

  /* ── approved ─────────────────────────────────────────────────────────── */
  if (!ret.band || !ALL_BANDS.includes(ret.band)) {
    return fail(`Choose the return parcel's band ("Parcel band") — ${ret.band ? `"${ret.band}" is not a known band` : 'none is set'}. More than one item, or an item from an older order, needs it chosen by hand.`);
  }
  if (!Array.isArray(ret.lines) || !ret.lines.length) return fail('The request has no items on it.');
  const order = ret.orderId ? await sanity.getDocument(ret.orderId) : null;
  if (!order) return fail(`The order ${ret.orderNumber || ''} could not be found.`);
  if ((order.shippingAddress?.country || '').toUpperCase() !== 'GB') {
    return fail('The order address is outside the UK. Sendcloud returns are UK-only: arrange this one by hand.');
  }

  let label = ret.labelId ? ret : null;
  if (!label) {
    let res;
    try {
      res = await shipping('create-return', {
        orderRef: ret.orderNumber,
        returnRef: ret.returnRef,
        band: ret.band,
        // Name, address and email: a collection from the customer's door is
        // booked against them.
        customer: { ...recipientFor(order), email: ret.customerEmail || order.customerEmail || '' },
        // The return of a Stripe test-mode order: the free void label (shipping-client.mjs).
        ...testOrderFlag(order),
        items: ret.lines.map((l) => ({
          description: [l.productTitle, l.format, l.size].filter(Boolean).join(' — ').slice(0, 120) || 'Print',
          qty: Math.max(1, Math.floor(Number(l.quantity) || 1)),
          valueGBP: Math.round((Number(l.unitPrice) || 0) * (Number(l.quantity) || 1) * 100) / 100,
        })),
      });
    } catch (err) {
      const details = err?.details ? `\n${JSON.stringify(err.details).slice(0, 800)}` : '';
      return fail(`create-return failed: ${err?.code || 'error'} — ${err?.message || err}${details}`);
    }
    label = {
      carrier: res.carrier || undefined,
      option: res.method || undefined,
      trackingNumber: res.trackingNumber || undefined,
      trackingUrl: res.trackingUrl || undefined,
      labelId: res.labelId != null ? String(res.labelId) : undefined,
      parcelId: res.parcelId != null ? String(res.parcelId) : undefined,
      quotedPrice: quotedPounds(res) ?? undefined,
      customerInstructions: res.customerInstructions || undefined,
      ...(res.test ? { test: true } : {}),
    };
    // Recorded at once, so a retry after a later failure reuses this label.
    await sanity.patch(retId).set(label).commit();
    ret = { ...ret, ...label };
  }

  const postage = ret.freeLabel ? 0 : (ret.quotedPrice ?? null);
  let pdf;
  try {
    pdf = await fetchLabel(ret.labelId);
  } catch (err) {
    return fail(`The label PDF could not be fetched: ${err?.code || ''} ${err?.message || err}`);
  }
  const sent = await sendEmail(resend, returnLabelEmail(ret, { pdf, instructions: ret.customerInstructions, postage }));
  if (!sent.ok) return fail(`The label email was not sent: ${sent.error}`);

  const done = sanity.patch(retId).set({ status: 'label_sent', labelSentAt: new Date(now()).toISOString() });
  if (postage === null) {
    // Not a failure: the customer has the label. Only the figure is missing.
    await done.set({ error: `The shipping service gave no price for label ${ret.labelId}, so the email said postage is deducted without a figure. Take the label cost from Sendcloud off the refund.` })
      .unset(['claimedAt', 'postageDeduction']).commit();
    log.error(`shipping-return: ${name} label sent with no quoted price`);
    return { outcome: 'label_sent', postage };
  }
  await done.set({ postageDeduction: postage }).unset(['claimedAt', 'error']).commit();
  log.log(`shipping-return: ${name} label sent (${ret.carrier || '?'}, deduction £${postage.toFixed(2)})`);
  return { outcome: 'label_sent', postage };
}

export async function handleReturnWebhook({ rawBody, signature, env = process.env, deps }) {
  if (!shippingEnabled(env)) return { status: 200, body: 'Shipping is not enabled — ignored' };
  const secret = env.SANITY_WEBHOOK_SECRET_SHIPPING;
  if (!secret) return { status: 500, body: 'SANITY_WEBHOOK_SECRET_SHIPPING is not set' };
  let valid = false;
  try { valid = Boolean(signature) && (await isValidSignature(rawBody, signature, secret)); } catch { valid = false; }
  if (!valid) return { status: 401, body: 'Invalid signature' };
  let body;
  try { body = JSON.parse(rawBody); } catch { return { status: 400, body: 'Bad JSON' }; }
  if (body?._type !== 'returnRequest' || typeof body._id !== 'string' || body._id.startsWith('drafts.')) {
    return { status: 200, body: 'Not a published return request — ignored' };
  }
  return { status: 200, body: JSON.stringify(await processReturn(body._id, deps)) };
}

let resendClient;
const getResend = () => {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  return (resendClient = new Resend(process.env.RESEND_API_KEY));
};

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const rawBody = await req.text();
  try {
    const sanity = createClient({
      projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
      token: process.env.SANITY_WRITE_TOKEN, useCdn: false,
    });
    const r = await handleReturnWebhook({
      rawBody,
      signature: req.headers.get(SIGNATURE_HEADER_NAME),
      deps: {
        sanity,
        shipping: (path, body) => shippingCreate(path, body),
        fetchLabel: (labelId) => shippingRequest(`label?labelId=${encodeURIComponent(labelId)}`, { method: 'GET' }),
        getResend,
      },
    });
    (r.status >= 400 ? console.error : console.log)(`shipping-return: ${r.status} ${r.body}`);
    return new Response(r.body, { status: r.status });
  } catch (err) {
    console.error('shipping-return: failed:', err?.stack || err);
    return new Response('Failed', { status: 500 });
  }
};

// NOTE: no `export const config = { path }`. netlify.toml rewrites
// /api/shipping-return to this background function, ahead of the /api/* rule.
