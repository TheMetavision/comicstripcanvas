import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { isValidSignature, encodeSignatureHeader, SIGNATURE_HEADER_NAME } from '@sanity/webhook';
import { sendDispatchEmail } from './_shared/dispatch-email.mjs';
import { shippingEnabled } from './_shared/shipping-client.mjs';
import { internalOrigin } from './_shared/origin.mjs';

/**
 * sanity-orders-webhook.mjs
 * --------------------------------------------------------------------------
 * POST /api/sanity-orders-webhook   (the Sanity webhook "CSC orders")
 *
 * Sanity's plan allows two webhooks, and "Netlify rebuild" holds one. This is
 * the other: every order and return-request event comes here and is routed.
 *
 *   order, status dispatched + trackingNumber + shippingEmailSent != true
 *       -> the customer's dispatch email (sendDispatchEmail, as order-shipped)
 *   order, shipment.status ready_to_ship, a planned parcel still unlabelled
 *       -> shipping-dispatch-background
 *   returnRequest, approved with no labelSentAt / rejected with no
 *   rejectionEmailSentAt
 *       -> shipping-return-background
 *   anything else -> 200, nothing done, a debug line.
 *
 * Verified with SANITY_WEBHOOK_SECRET, the secret "Order shipped" already had,
 * so editing that webhook in place keeps it.
 *
 * The background functions are started with an AWAITED POST (an un-awaited one
 * is frozen with this function and never arrives) carrying a
 * sanity-webhook-signature made here with SANITY_WEBHOOK_SECRET_SHIPPING -- the
 * exact header and secret those functions already verify, so they need no
 * second check. That secret is now only ever used between our own functions.
 *
 * This decides what to START, nothing more. Each handler re-reads the document
 * and claims it with a conditional write before doing anything, and that claim
 * is what stops a double send: Sanity delivers at least once, and this webhook
 * fires on more edits than any of the three it replaces.
 */

const OK = 200;

/** Labels exist for every parcel the plan asks for: nothing left to buy. */
function everyPlannedParcelLabelled(doc) {
  const plan = Array.isArray(doc.parcelPlan) ? doc.parcelPlan : [];
  if (!plan.length) return false;
  const labelled = new Set((doc.shipment?.parcels || []).filter((p) => p?.labelId).map((p) => String(p.parcelRef)));
  return plan.every((p) => labelled.has(String(p?.parcelRef)));
}

/**
 * What a webhook body asks for. Pure, so the routing table is testable.
 *
 * @returns {{ actions: ('dispatch-email'|'shipping-dispatch'|'shipping-return')[], reason: string }}
 */
export function routeFor(doc) {
  if (!doc || typeof doc._id !== 'string' || typeof doc._type !== 'string') return { actions: [], reason: 'no document in the body' };
  if (doc._id.startsWith('drafts.') || doc._id.startsWith('versions.')) return { actions: [], reason: 'a draft or version' };

  if (doc._type === 'order') {
    const actions = [];
    const why = [];
    // The same three conditions order-shipped.mjs checks.
    if (doc.status === 'dispatched' && doc.trackingNumber && doc.shippingEmailSent !== true) actions.push('dispatch-email');
    else why.push(doc.shippingEmailSent === true ? 'dispatch email already sent' : `status ${doc.status || 'unset'}${doc.trackingNumber ? '' : ', no tracking number'}`);

    if (doc.shipment?.status === 'ready_to_ship') {
      // "No labels yet" read as "a planned parcel still has no label": after a
      // partial failure some labels exist, and Ready to ship again is the retry
      // (dispatchOrder skips the parcels already bought).
      if (everyPlannedParcelLabelled(doc)) why.push('every planned parcel already has a label');
      else actions.push('shipping-dispatch');
    } else {
      why.push(`shipment ${doc.shipment?.status || 'unset'}`);
    }
    return { actions, reason: actions.length ? actions.join(' + ') : why.join('; ') };
  }

  if (doc._type === 'returnRequest') {
    if (doc.status === 'approved' && !doc.labelSentAt) return { actions: ['shipping-return'], reason: 'return approved' };
    if (doc.status === 'rejected' && !doc.rejectionEmailSentAt) return { actions: ['shipping-return'], reason: 'return rejected' };
    return { actions: [], reason: `return ${doc.status || 'unset'}${doc.labelSentAt || doc.rejectionEmailSentAt ? ', already actioned' : ''}` };
  }

  return { actions: [], reason: `type ${doc._type}` };
}

/** Where each background job lives (netlify.toml maps the alias to the -background name). */
export const BACKGROUND_PATHS = {
  'shipping-dispatch': '/api/shipping-dispatch',
  'shipping-return': '/api/shipping-return',
};

/**
 * Start a background function and wait for the platform to accept it (202).
 * Never throws.
 */
export async function startBackground({ action, doc, origin, secret, fetchImpl = fetch, now = () => Date.now() }) {
  const url = `${origin}${BACKGROUND_PATHS[action]}`;
  // Only what the handlers read: they fetch the document themselves.
  const body = JSON.stringify({ _id: doc._id, _type: doc._type });
  try {
    const signature = await encodeSignatureHeader(body, now(), secret);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SIGNATURE_HEADER_NAME]: signature },
      body,
    });
    return { ok: res.ok, status: res.status, url, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, url, error: err?.message || String(err) };
  }
}

/**
 * Everything but the Request object. Exported for the tests.
 *
 * @param deps.sendDispatch ({ orderId }) => sendDispatchEmail's result
 * @param deps.start        ({ action, doc }) => startBackground's result
 */
export async function handleOrdersWebhook({ rawBody, signature, env = process.env, deps }) {
  const log = deps.log || console;
  const secret = env.SANITY_WEBHOOK_SECRET;
  if (!secret) return { status: 500, body: 'SANITY_WEBHOOK_SECRET is not set' };
  let valid = false;
  try { valid = Boolean(signature) && (await isValidSignature(rawBody, signature, secret)); } catch { valid = false; }
  if (!valid) return { status: 401, body: 'Invalid signature' };

  let doc;
  try { doc = JSON.parse(rawBody); } catch { return { status: 400, body: 'Bad JSON' }; }

  const { actions, reason } = routeFor(doc);
  const name = doc?.orderNumber || doc?.returnNumber || doc?._id || '?';
  if (!actions.length) {
    log.debug?.(`sanity-orders-webhook: ${name}: no action (${reason})`);
    return { status: OK, body: `No action — ${reason}` };
  }

  const results = [];
  let status = OK;
  for (const action of actions) {
    if (action === 'dispatch-email') {
      const r = await deps.sendDispatch({ orderId: doc._id });
      results.push(`dispatch-email: ${r.reason}`);
      if (r.status >= 500) status = Math.max(status, r.status);
      continue;
    }
    if (!shippingEnabled(env)) {
      log.debug?.(`sanity-orders-webhook: ${name}: ${action} skipped, shipping is not enabled`);
      results.push(`${action}: shipping is not enabled`);
      continue;
    }
    if (!env.SANITY_WEBHOOK_SECRET_SHIPPING) {
      log.error(`sanity-orders-webhook: ${name}: ${action} not started, SANITY_WEBHOOK_SECRET_SHIPPING is not set`);
      results.push(`${action}: SANITY_WEBHOOK_SECRET_SHIPPING is not set`);
      status = Math.max(status, 500);
      continue;
    }
    const r = await deps.start({ action, doc });
    if (r.ok) {
      log.log(`sanity-orders-webhook: ${name}: started ${action} (${r.status})`);
      results.push(`${action}: started`);
    } else {
      // 502, so Sanity retries the delivery; the handler's claim makes a
      // retry harmless if the first start did in fact land.
      log.error(`sanity-orders-webhook: ${name}: ${action} did not start: ${r.error} (${r.url})`);
      results.push(`${action}: not started (${r.error})`);
      status = Math.max(status, 502);
    }
  }
  return { status, body: results.join('\n') };
}

const sanityClient = () => createClient({
  projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN, useCdn: false,
});

// Built on first use, not at import: `new Resend()` throws without a key.
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
    const origin = internalOrigin(req);
    const r = await handleOrdersWebhook({
      rawBody,
      signature: req.headers.get(SIGNATURE_HEADER_NAME),
      deps: {
        sendDispatch: ({ orderId }) => sendDispatchEmail({ orderId, sanity: sanityClient(), getResend }),
        start: ({ action, doc }) => startBackground({ action, doc, origin, secret: process.env.SANITY_WEBHOOK_SECRET_SHIPPING }),
      },
    });
    if (r.status >= 400) console.error(`sanity-orders-webhook: ${r.status} ${r.body}`);
    return new Response(r.body, { status: r.status });
  } catch (err) {
    console.error('sanity-orders-webhook: failed:', err?.stack || err);
    return new Response('Failed', { status: 500 });
  }
};

// NOTE: no `export const config = { path }`. Routed by the forced /api/* redirect
// in netlify.toml (/api/sanity-orders-webhook -> /.netlify/functions/sanity-orders-webhook).
// An inline config.path collides with that rule and 404s.
