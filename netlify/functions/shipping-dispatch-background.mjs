import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { isValidSignature, SIGNATURE_HEADER_NAME } from '@sanity/webhook';
import { shippingEnabled, shippingCreate, quotedPounds } from './_shared/shipping-client.mjs';
import { proposeParcelPlan, validateParcelPlan, parcelItems, recipientFor } from './_shared/parcel-bands.mjs';
import { sendEmail, labelReadyEmail, shipmentProblemEmail } from './_shared/shipping-emails.mjs';

/**
 * shipping-dispatch-background.mjs
 * --------------------------------------------------------------------------
 * POST /api/shipping-dispatch   (the Sanity webhook "CSC shipping — dispatch")
 *
 * Alan sets an order's Shipment status to "Ready to ship" in the Studio. The
 * webhook fires, and this buys one label per planned parcel from the shipping
 * service, writes carrier, option, quoted price, tracking and label id to the
 * order, sets "Label created" and emails the team "Label ready" with a print
 * link per parcel. The CUSTOMER is not emailed here: they get the dispatch
 * email at the first carrier scan (shipping-event.mjs).
 *
 * Any failure -- a plan that does not add up, band_not_configured,
 * no_available_option, the service down -- sets "Exception", records why on
 * the order and emails the team the reason. Setting "Ready to ship" again
 * retries; a parcel that already has a label is never bought twice (it is
 * skipped here, and the service is idempotent on orderRef + parcelRef anyway).
 *
 * A background function, routed from /api/shipping-dispatch in netlify.toml:
 * each create-parcel is a Sendcloud announcement of a few seconds, and an
 * order of several parcels would not fit a synchronous function's limit.
 * Sanity therefore always sees 202; a bad signature is logged and ignored.
 *
 * Signature: @sanity/webhook, the same check as order-shipped.mjs and
 * sanity-content-changed.mts, with SANITY_WEBHOOK_SECRET_SHIPPING.
 *
 * Does nothing at all unless SHIPPING_ENABLED is "true".
 */

const CLAIM_TTL_MS = 10 * 60 * 1000;

const isConflict = (err) => {
  const status = err && (err.statusCode || err.response?.statusCode);
  return status === 409 || /revision/i.test((err && err.message) || '');
};

/** What we keep about a parcel on the order. */
export function parcelRecord(planned, res) {
  return {
    _key: `parcel-${planned.parcelRef}`,
    _type: 'shipmentParcel',
    parcelRef: String(planned.parcelRef),
    band: planned.band,
    parcelId: res.parcelId != null ? String(res.parcelId) : undefined,
    shipmentId: res.shipmentId != null ? String(res.shipmentId) : undefined,
    carrier: res.carrier || undefined,
    option: res.method || undefined,
    quotedPrice: quotedPounds(res) ?? undefined,
    trackingNumber: res.trackingNumber || undefined,
    trackingUrl: res.trackingUrl || undefined,
    labelId: res.labelId != null ? String(res.labelId) : undefined,
    status: 'label_created',
    ...(res.test ? { test: true } : {}),
  };
}

/**
 * The whole job for one order. Exported for the tests, which hand it fakes.
 *
 * @returns {Promise<{ outcome: string, reason?: string, parcels?: object[] }>}
 */
export async function dispatchOrder(orderId, { sanity, shipping, getResend, now = () => Date.now(), log = console }) {
  /* Claim it first. Sanity can deliver the same webhook twice, and Alan can
     flip the status twice; only the caller whose conditional write lands goes
     on. The claim is cleared at the end, and a stale one (a function that
     died) is ignored after CLAIM_TTL_MS. */
  let order = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    order = await sanity.getDocument(orderId);
    if (!order || order._type !== 'order') return { outcome: 'ignored', reason: 'not an order' };
    if (order.shipment?.status !== 'ready_to_ship') return { outcome: 'ignored', reason: `shipment status is ${order.shipment?.status || 'unset'}` };
    const claimedAt = Date.parse(order.shipment.dispatchClaimedAt || '');
    if (Number.isFinite(claimedAt) && now() - claimedAt < CLAIM_TTL_MS) return { outcome: 'ignored', reason: 'already being dispatched' };
    try {
      await sanity.patch(orderId).ifRevisionId(order._rev)
        .set({ 'shipment.dispatchClaimedAt': new Date(now()).toISOString() }).commit();
      break;
    } catch (err) {
      if (!isConflict(err)) throw err;
      order = null;
    }
  }
  if (!order) return { outcome: 'ignored', reason: 'the order kept changing; the next webhook will retry' };

  const orderNumber = order.orderNumber || order._id;
  const resend = getResend();

  const fail = async (reason, parcels) => {
    const patch = sanity.patch(orderId)
      .set({ 'shipment.status': 'exception', 'shipment.error': reason })
      .unset(['shipment.dispatchClaimedAt']);
    if (parcels) patch.set({ 'shipment.parcels': parcels });
    await patch.commit();
    log.error(`shipping-dispatch: ${orderNumber} -> exception: ${reason}`);
    const sent = await sendEmail(resend, shipmentProblemEmail(order, reason));
    if (!sent.ok) log.error(`shipping-dispatch: ${orderNumber} problem email not sent: ${sent.error}`);
    return { outcome: 'exception', reason };
  };

  /* The plan: Alan's, as edited in the Studio, or the default (one parcel per
     item) for an order placed before shipping was switched on. */
  let plan = Array.isArray(order.parcelPlan) && order.parcelPlan.length ? order.parcelPlan : null;
  let defaulted = false;
  if (!plan) {
    plan = proposeParcelPlan(order.lineItems).plan;
    defaulted = true;
  }
  const problems = validateParcelPlan(plan, order.lineItems);
  if (problems.length) {
    return fail(`The parcel plan needs fixing before a label can be bought:\n- ${problems.join('\n- ')}`);
  }
  const country = (order.shippingAddress?.country || '').toUpperCase();
  if (country !== 'GB') {
    return fail(`The delivery address is in ${country || 'an unknown country'}. Sendcloud shipping is UK-only for now: ship this one by hand.`);
  }

  const already = new Map((order.shipment?.parcels || []).filter((p) => p?.labelId).map((p) => [String(p.parcelRef), p]));
  const made = [];
  let error = null;
  for (const planned of plan) {
    const ref = String(planned.parcelRef);
    if (already.has(ref)) { made.push(already.get(ref)); continue; }
    try {
      const res = await shipping('create-parcel', {
        orderRef: orderNumber,
        parcelRef: ref,
        band: planned.band,
        recipient: recipientFor(order),
        items: parcelItems(planned, order.lineItems),
      });
      made.push(parcelRecord(planned, res));
    } catch (err) {
      const details = err?.details ? `\n${JSON.stringify(err.details).slice(0, 800)}` : '';
      error = `Parcel ${ref} (${planned.band}): ${err?.code || 'error'} — ${err?.message || err}${details}`;
      break;
    }
  }
  // Labels bought earlier but no longer in the plan stay on record: they exist.
  const inPlan = new Set(plan.map((p) => String(p.parcelRef)));
  const parcels = [...made, ...[...already.values()].filter((p) => !inPlan.has(String(p.parcelRef)))];

  if (error) {
    const bought = made.filter((p) => p.labelId).length;
    return fail(bought ? `${error}\n\n${bought} label(s) were bought before this and are kept.` : error, parcels);
  }

  const set = {
    'shipment.status': 'label_created',
    'shipment.parcels': parcels,
    'shipment.labelCreatedAt': new Date(now()).toISOString(),
  };
  if (defaulted) set.parcelPlan = plan;
  await sanity.patch(orderId).set(set)
    .unset(['shipment.dispatchClaimedAt', 'shipment.error', 'shipment.planProblem']).commit();
  log.log(`shipping-dispatch: ${orderNumber} -> label_created (${parcels.length} parcel(s))`);

  const sent = await sendEmail(resend, labelReadyEmail(order, parcels.filter((p) => inPlan.has(String(p.parcelRef)))));
  if (!sent.ok) log.error(`shipping-dispatch: ${orderNumber} "label ready" email not sent: ${sent.error}`);
  return { outcome: 'label_created', parcels };
}

/** Signature, switch, and the document id out of the webhook body. */
export async function handleDispatchWebhook({ rawBody, signature, env = process.env, deps }) {
  if (!shippingEnabled(env)) return { status: 200, body: 'Shipping is not enabled — ignored' };
  const secret = env.SANITY_WEBHOOK_SECRET_SHIPPING;
  if (!secret) return { status: 500, body: 'SANITY_WEBHOOK_SECRET_SHIPPING is not set' };
  let valid = false;
  try { valid = Boolean(signature) && (await isValidSignature(rawBody, signature, secret)); } catch { valid = false; }
  if (!valid) return { status: 401, body: 'Invalid signature' };
  let body;
  try { body = JSON.parse(rawBody); } catch { return { status: 400, body: 'Bad JSON' }; }
  if (body?._type !== 'order' || typeof body._id !== 'string' || body._id.startsWith('drafts.')) {
    return { status: 200, body: 'Not a published order — ignored' };
  }
  const result = await dispatchOrder(body._id, deps);
  return { status: 200, body: JSON.stringify(result) };
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
    const r = await handleDispatchWebhook({
      rawBody,
      signature: req.headers.get(SIGNATURE_HEADER_NAME),
      deps: { sanity, shipping: (path, body) => shippingCreate(path, body), getResend },
    });
    (r.status >= 400 ? console.error : console.log)(`shipping-dispatch: ${r.status} ${r.body}`);
    return new Response(r.body, { status: r.status });
  } catch (err) {
    console.error('shipping-dispatch: failed:', err?.stack || err);
    return new Response('Failed', { status: 500 });
  }
};

// NOTE: no `export const config = { path }`. netlify.toml rewrites
// /api/shipping-dispatch to this background function, ahead of the /api/* rule.
