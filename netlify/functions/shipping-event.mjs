import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { createHash } from 'node:crypto';
import { shippingEnabled, verifyShippingCallback } from './_shared/shipping-client.mjs';
import { classifyStatus, isCarrierScan } from './_shared/tracking-status.mjs';
import { mapCarrier } from './_shared/parcel-bands.mjs';
import { sendDispatchEmail } from './_shared/dispatch-email.mjs';
import { sendEmail, parcelAlertEmail, returnReadyEmail, returnAlertEmail } from './_shared/shipping-emails.mjs';
import { docIdFor, isBuildRef } from './_shared/pp-id.mjs';

/**
 * shipping-event.mjs
 * --------------------------------------------------------------------------
 * POST /api/shipping-event   the shipping service's tracking callback
 *
 * metavision-shipping receives Sendcloud's webhooks and forwards each status
 * change for a CSC parcel here, signed with SHIPPING_SECRET (x-mv-brand,
 * x-mv-timestamp, x-mv-signature over `${timestamp}.${rawBody}`). It wants a
 * 2xx within 4 seconds; anything else is queued and retried hourly, so a
 * failure here is retried rather than lost, and every step is safe to repeat.
 *
 * Outbound parcel ("kind": "parcel", matched to the order by orderRef = order
 * number and to the parcel by parcelRef):
 *   - the event is appended to shipment.events (newest 30 kept; a repeat of
 *     the same parcel + status + time is recognised and not added twice);
 *   - first carrier scan: shipment In transit, dispatchedAt, the order's own
 *     status Dispatched with the tracking number and carrier -- so the
 *     existing views, the post-delivery sequence and photo retention all work
 *     as they do for an order dispatched by hand -- the linked personalised
 *     builds to Dispatched, and the existing branded dispatch email, ONCE
 *     (dispatch-email.mjs claims the order before sending);
 *   - every parcel delivered: deliveredAt, shipment and order Delivered;
 *   - exception / returned to sender: the team is emailed.
 *
 * Return ("kind": "return", matched by returnRef): the return request's
 * events, In transit, and Ready to collect when it reaches Alan's collection
 * point -- with an email to the team saying which point. The customer is
 * never told where returns are collected.
 *
 * Answers 503 when SHIPPING_ENABLED is off, so the service keeps the event and
 * retries rather than it being dropped.
 */

const EVENT_CAP = 30;

const isConflict = (err) => {
  const status = err && (err.statusCode || err.response?.statusCode);
  return status === 409 || /revision/i.test((err && err.message) || '');
};

/** The same event delivered twice has the same key. */
export const eventKey = (e) => createHash('sha256')
  .update([e.kind, e.parcelRef ?? e.returnRef ?? '', e.parcelId ?? '', e.statusCode ?? '', e.status ?? '', e.at ?? ''].join('|'))
  .digest('hex').slice(0, 16);

function eventRecord(e, kind) {
  return {
    _key: eventKey(e),
    _type: 'shipmentEvent',
    at: e.at || new Date().toISOString(),
    ...(e.parcelRef != null ? { parcelRef: String(e.parcelRef) } : {}),
    status: e.status || undefined,
    statusCode: e.statusCode != null ? Number(e.statusCode) : undefined,
    carrierStatus: e.carrierStatus || undefined,
    kind,
    ...(e.test ? { test: true } : {}),
  };
}

/** Newest EVENT_CAP, oldest first. */
const capped = (events) => [...events].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-EVENT_CAP);

/* ------------------------------------------------------------------ parcels */

export async function applyParcelEvent(event, deps) {
  const { sanity, getResend, now = () => Date.now(), log = console, sendDispatch = sendDispatchEmail } = deps;
  const orderId = await sanity.fetch('*[_type == "order" && orderNumber == $n][0]._id', { n: String(event.orderRef || '') });
  if (!orderId) {
    log.warn(`shipping-event: no order ${event.orderRef} — ignored`);
    return { status: 200, body: 'Unknown order — ignored' };
  }
  const kind = classifyStatus(event.statusCode, event.status);
  const rec = eventRecord(event, kind);

  let order, effects;
  for (let attempt = 0; attempt < 5; attempt++) {
    order = await sanity.getDocument(orderId);
    const shipment = order.shipment || {};
    const events = Array.isArray(shipment.events) ? shipment.events : [];
    effects = {
      duplicate: events.some((x) => x._key === rec._key), firstScan: false, alert: false, delivered: false,
      dispatched: Boolean(shipment.dispatchedAt),
    };
    if (effects.duplicate) break;

    const parcels = (shipment.parcels || []).map((p) => ({ ...p }));
    const parcel = parcels.find((p) => String(p.parcelRef) === String(event.parcelRef))
      || parcels.find((p) => event.parcelId != null && String(p.parcelId) === String(event.parcelId));
    if (parcel) {
      parcel.status = kind;
      parcel.statusText = event.status || undefined;
      if (event.trackingNumber) parcel.trackingNumber = event.trackingNumber;
      if (event.trackingUrl) parcel.trackingUrl = event.trackingUrl;
    } else {
      log.warn(`shipping-event: ${order.orderNumber} has no parcel ${event.parcelRef} on record; event kept`);
    }

    const set = { 'shipment.events': capped([...events, rec]), 'shipment.parcels': parcels };
    const iso = new Date(now()).toISOString();

    if (isCarrierScan(kind) && !shipment.dispatchedAt) {
      effects.firstScan = true;
      effects.dispatched = true;
      set['shipment.dispatchedAt'] = iso;
      if (['label_created', 'ready_to_ship', 'none', undefined].includes(shipment.status)) {
        set['shipment.status'] = 'in_transit';
      }
      const tracked = parcel?.trackingNumber ? parcel : parcels.find((p) => p.trackingNumber);
      if (!['dispatched', 'delivered', 'cancelled', 'refunded'].includes(order.status)) set.status = 'dispatched';
      if (!order.trackingNumber && tracked?.trackingNumber) set.trackingNumber = tracked.trackingNumber;
      if (!order.carrierOverride && (parcel || tracked)?.carrier) {
        const c = mapCarrier((parcel || tracked).carrier);
        set.carrier = c.carrier;
        if (c.carrierOther) set.carrierOther = c.carrierOther;
      }
    } else if (kind === 'in_transit' && shipment.status === 'label_created') {
      set['shipment.status'] = 'in_transit';
    }

    if (kind === 'delivered') {
      const labelled = parcels.filter((p) => p.labelId);
      if (labelled.length && labelled.every((p) => p.status === 'delivered') && !shipment.deliveredAt) {
        effects.delivered = true;
        set['shipment.deliveredAt'] = iso;
        set['shipment.status'] = 'delivered';
        if (order.status !== 'cancelled' && order.status !== 'refunded') set.status = 'delivered';
      }
    }
    if (kind === 'exception' || kind === 'returned_to_sender') {
      effects.alert = true;
      set['shipment.status'] = kind;
    }

    try {
      const patch = sanity.patch(orderId).ifRevisionId(order._rev);
      if (!order.shipment) patch.setIfMissing({ shipment: {} });
      await patch.set(set).commit();
      effects.parcel = parcel;
      break;
    } catch (err) {
      if (!isConflict(err) || attempt === 4) throw err;
    }
  }

  const resend = getResend();
  if (effects.alert) {
    const sent = await sendEmail(resend, parcelAlertEmail(order, effects.parcel, event, kind));
    if (!sent.ok) log.error(`shipping-event: ${order.orderNumber} alert email not sent: ${sent.error}`);
  }
  if (effects.firstScan) await markBuildsDispatched(order, deps);

  /* The dispatch email: due once a carrier has the parcel. Checked on EVERY
     event, not only the first scan, so an email that failed or was cut off is
     sent by the next event to arrive -- dispatch-email.mjs makes it once only. */
  let emailed = null;
  if (effects.dispatched && order.shippingEmailSent !== true) {
    emailed = await sendDispatch({ orderId, sanity, getResend, log });
  }
  log.log(`shipping-event: ${order.orderNumber} parcel ${event.parcelRef} ${event.statusCode} ${kind}`
    + `${effects.duplicate ? ' (repeat)' : ''}${effects.firstScan ? ' first scan' : ''}${effects.delivered ? ' all delivered' : ''}`
    + `${emailed ? ` dispatch email: ${emailed.reason}` : ''}`);
  return { status: 200, body: 'OK', effects, emailed };
}

/** The builds on this order go to Dispatched, which is where their queue expects them. */
async function markBuildsDispatched(order, { sanity, log = console }) {
  const refs = [...new Set((order.lineItems || []).map((l) => l.personalisationId).filter(isBuildRef))];
  for (const ref of refs) {
    try {
      const id = docIdFor(ref);
      const build = await sanity.getDocument(id);
      if (build && ['approved', 'in_production'].includes(build.status)) {
        await sanity.patch(id).ifRevisionId(build._rev).set({ status: 'dispatched' }).commit();
      }
    } catch (err) {
      log.error(`shipping-event: could not mark build ${ref} dispatched:`, err?.message || err);
    }
  }
}

/* ------------------------------------------------------------------ returns */

export async function applyReturnEvent(event, { sanity, getResend, now = () => Date.now(), log = console }) {
  const retId = await sanity.fetch('*[_type == "returnRequest" && returnRef == $r][0]._id', { r: String(event.returnRef || '') });
  if (!retId) {
    log.warn(`shipping-event: no return ${event.returnRef} — ignored`);
    return { status: 200, body: 'Unknown return — ignored' };
  }
  const kind = classifyStatus(event.statusCode, event.status);
  const rec = eventRecord(event, kind);

  let ret, becameReady = false, alert = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    ret = await sanity.getDocument(retId);
    const events = Array.isArray(ret.events) ? ret.events : [];
    becameReady = false; alert = false;
    if (events.some((x) => x._key === rec._key)) break;

    const iso = new Date(now()).toISOString();
    const set = { events: capped([...events, rec]) };
    if (event.trackingNumber) set.trackingNumber = event.trackingNumber;
    if (event.trackingUrl) set.trackingUrl = event.trackingUrl;
    const s = ret.status;
    const before = ['approved', 'label_sent', 'in_transit'].includes(s);
    if (kind === 'in_transit' && ['approved', 'label_sent'].includes(s)) set.status = 'in_transit';
    if (kind === 'ready_to_collect' && before) set.status = 'ready_to_collect';
    if (kind === 'delivered') {
      // Delivered to the point (some carriers say "delivered" on arrival), or
      // collected from it after "awaiting pickup".
      if (before) set.status = 'ready_to_collect';
      else if (s === 'ready_to_collect') { set.status = 'received'; set.receivedAt = iso; }
    }
    if (set.status === 'ready_to_collect') { set.readyToCollectAt = iso; becameReady = true; }
    if (kind === 'exception' || kind === 'returned_to_sender') alert = true;
    try {
      await sanity.patch(retId).ifRevisionId(ret._rev).set(set).commit();
      ret = { ...ret, ...set };
      break;
    } catch (err) {
      if (!isConflict(err) || attempt === 4) throw err;
    }
  }

  const resend = getResend();
  if (becameReady) {
    const sent = await sendEmail(resend, returnReadyEmail(ret, event));
    if (!sent.ok) log.error(`shipping-event: return ${ret.returnNumber} ready email not sent: ${sent.error}`);
  }
  if (alert) {
    const sent = await sendEmail(resend, returnAlertEmail(ret, event, kind));
    if (!sent.ok) log.error(`shipping-event: return ${ret.returnNumber} alert email not sent: ${sent.error}`);
  }
  log.log(`shipping-event: return ${ret.returnNumber} ${event.statusCode} ${kind} -> ${ret.status}`);
  return { status: 200, body: 'OK', becameReady };
}

/* ------------------------------------------------------------------ handler */

export async function handleShippingEvent(req, deps) {
  const env = deps.env || process.env;
  if (req.method !== 'POST') return { status: 405, body: 'Method not allowed' };
  const rawBody = await req.text();
  if (!verifyShippingCallback(req, rawBody, { env, now: deps.now ? deps.now() : Date.now() })) {
    return { status: 401, body: 'Invalid signature' };
  }
  if (!shippingEnabled(env)) return { status: 503, body: 'Shipping is not enabled here yet — retry later' };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: 'Bad JSON' }; }
  if (event?.kind === 'parcel') return applyParcelEvent(event, deps);
  if (event?.kind === 'return') return applyReturnEvent(event, deps);
  return { status: 200, body: 'Unknown kind — ignored' };
}

let resendClient;
const getResend = () => {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  return (resendClient = new Resend(process.env.RESEND_API_KEY));
};

export default async (req) => {
  try {
    const sanity = createClient({
      projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
      token: process.env.SANITY_WRITE_TOKEN, useCdn: false,
    });
    const r = await handleShippingEvent(req, { sanity, getResend });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } catch (err) {
    console.error('shipping-event: failed:', err?.stack || err);
    // 5xx: the service queues it and retries hourly.
    return new Response('Failed', { status: 500 });
  }
};

// NOTE: no `export const config = { path }`. Routed by the forced /api/* redirect.
