// shipping-event: tracking callbacks from the service, and the once-only
// dispatch email shared with order-shipped.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyParcelEvent, applyReturnEvent } from '../netlify/functions/_shared/shipping-events.mjs';
import {
  acceptShippingEvent, runShippingEvent, startEventBackground, eventHandoffKey, EVENT_HANDOFF_HEADER,
} from '../netlify/functions/_shared/shipping-event-handoff.mjs';
import { sendDispatchEmail, buildDispatchEmail } from '../netlify/functions/_shared/dispatch-email.mjs';
import { fakeSanity, fakeResend, quiet } from './fixtures/fake-sanity.mjs';

const ORDER_ID = 'order.cs_test_events';
const BUILD = 'pp-0123456789abcdef0123456789abcdef';

const labelledOrder = (extra = {}) => ({
  _id: ORDER_ID, _type: 'order', orderNumber: 'CSC-3001', customerName: 'Grace Hopper', customerEmail: 'grace@example.com',
  status: 'in-production', totalAmount: 115, shippingCost: 0,
  shippingAddress: { line1: '1 Lane', city: 'York', postcode: 'YO1 1AA', country: 'GB' },
  lineItems: [
    { _key: 'a', productTitle: 'Hulk', format: 'Poster Print', size: 'Medium', formatKey: 'poster', sizeKey: 'medium', quantity: 1, unitPrice: 25 },
    { _key: 'b', productTitle: 'Your Photo', format: 'Canvas (Gallery Frame)', size: 'Large', formatKey: 'canvas-gallery', sizeKey: 'large', quantity: 1, unitPrice: 90, buildKind: 'personalised', personalisationId: BUILD },
  ],
  shippingEmailSent: false,
  shipment: {
    status: 'label_created',
    parcels: [
      { _key: 'parcel-1', parcelRef: '1', band: 'P3', parcelId: '501', carrier: 'royal_mailv2', trackingNumber: 'RM1', trackingUrl: 'https://track/rm1', labelId: '501', status: 'label_created' },
      { _key: 'parcel-2', parcelRef: '2', band: 'CG4', parcelId: '502', carrier: 'hermes_c2c_gb', trackingNumber: 'EV2', trackingUrl: 'https://track/ev2', labelId: '502', status: 'label_created' },
    ],
  },
  ...extra,
});

const QUERIES = {
  'orderNumber == \\$n': (docs, p) => docs.find((d) => d._type === 'order' && d.orderNumber === p.n)?._id ?? null,
  'returnRef == \\$r': (docs, p) => docs.find((d) => d._type === 'returnRequest' && d.returnRef === p.r)?._id ?? null,
};

const ev = (statusCode, status, extra = {}) => ({
  kind: 'parcel', brand: 'csc', orderRef: 'CSC-3001', parcelRef: '1', parcelId: 501, status, statusCode,
  trackingNumber: 'RM1', trackingUrl: 'https://track/rm1', at: '2026-10-29T12:00:00.000Z', ...extra,
});

function setup(order = labelledOrder()) {
  const sanity = fakeSanity([order, { _id: `pendingPersonalisation.${BUILD}`, _type: 'pendingPersonalisation', status: 'in_production' }], { queries: QUERIES });
  const resend = fakeResend();
  const postDelivery = [];
  const sendDispatch = (args) => sendDispatchEmail({ ...args, log: quiet, postDelivery: async (o) => { postDelivery.push(o.orderNumber); } });
  const deps = { sanity, getResend: () => resend, log: quiet, sendDispatch };
  return { sanity, resend, postDelivery, deps };
}

const customerEmails = (resend) => resend.sent.filter((m) => m.to[0] === 'grace@example.com');

test('first carrier scan: in transit, order dispatched, builds dispatched, and the branded dispatch email once', async () => {
  const { sanity, resend, postDelivery, deps } = setup();
  await applyParcelEvent(ev(91, 'Parcel en route'), deps);
  const o = sanity.store.get(ORDER_ID);
  assert.equal(o.shipment.status, 'in_transit');
  assert.ok(o.shipment.dispatchedAt);
  assert.equal(o.status, 'dispatched');
  assert.equal(o.trackingNumber, 'RM1');
  assert.equal(o.carrier, 'royal-mail', 'carrier set from the service, in the schema\'s own list');
  assert.equal(o.shipment.events.length, 1);
  assert.equal(o.shipment.parcels[0].status, 'in_transit');
  assert.equal(sanity.store.get(`pendingPersonalisation.${BUILD}`).status, 'dispatched');

  const mail = customerEmails(resend);
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /Your order is on the way \(CSC-3001\)/);
  assert.match(mail[0].html, /https:\/\/track\/rm1/, 'the service\'s tracking link');
  assert.match(mail[0].html, /https:\/\/track\/ev2/, 'one block per parcel');
  assert.match(mail[0].html, /Parcel 1 of 2/);
  assert.match(mail[0].html, /2-3 working days/);
  assert.doesNotMatch(mail[0].html, /1-2 working days/);
  assert.equal(o.shippingEmailSent, true);
  assert.ok(o.shippingEmailSentAt, 'photo retention counts from this');
  assert.deepEqual(postDelivery, ['CSC-3001'], 'the post-delivery sequence starts once');
});

test('the dispatch email is sent once: replays, later scans and concurrent first scans send nothing more', async () => {
  const { sanity, resend, postDelivery, deps } = setup();
  await Promise.all([
    applyParcelEvent(ev(91, 'Parcel en route'), deps),
    applyParcelEvent(ev(91, 'Parcel en route', { parcelRef: '2', parcelId: 502, at: '2026-10-29T12:00:01.000Z' }), deps),
  ]);
  await applyParcelEvent(ev(91, 'Parcel en route'), deps);           // the service retries one
  await applyParcelEvent(ev(32, 'Sorted', { at: '2026-10-29T15:00:00.000Z' }), deps);
  assert.equal(customerEmails(resend).length, 1);
  assert.equal(postDelivery.length, 1);
  assert.equal(sanity.store.get(ORDER_ID).shipment.events.length, 3, 'the replay is not stored twice');
});

test('the old hand-dispatch webhook and a first scan racing still send one email', async () => {
  const { sanity, resend, deps } = setup();
  await Promise.all([
    applyParcelEvent(ev(91, 'Parcel en route'), deps),
    (async () => {
      // order-shipped fires when status becomes dispatched with a tracking number.
      for (let i = 0; i < 20 && sanity.store.get(ORDER_ID).status !== 'dispatched'; i++) await Promise.resolve();
      return sendDispatchEmail({ orderId: ORDER_ID, sanity, getResend: deps.getResend, log: quiet, postDelivery: async () => {} });
    })(),
  ]);
  assert.equal(customerEmails(resend).length, 1);
});

test('a failed send is retried by the next event, still only once', async () => {
  const { sanity, deps } = setup();
  const failing = fakeResend({ fail: true });
  await applyParcelEvent(ev(91, 'Parcel en route'), { ...deps, getResend: () => failing });
  assert.equal(sanity.store.get(ORDER_ID).shippingEmailSent, false);
  assert.equal(sanity.store.get(ORDER_ID).shippingEmailClaimedAt, undefined, 'the claim was given back');
  const working = fakeResend();
  await applyParcelEvent(ev(32, 'Sorted', { at: '2026-10-29T13:00:00.000Z' }), { ...deps, getResend: () => working });
  await applyParcelEvent(ev(32, 'Sorted', { at: '2026-10-29T14:00:00.000Z' }), { ...deps, getResend: () => working });
  assert.equal(customerEmails(working).length, 1);
});

test('a label with no scan yet ("Ready to send") emails nobody', async () => {
  const { sanity, resend, deps } = setup();
  await applyParcelEvent(ev(1000, 'Ready to send'), deps);
  assert.equal(resend.sent.length, 0);
  assert.equal(sanity.store.get(ORDER_ID).shipment.dispatchedAt, undefined);
  assert.equal(sanity.store.get(ORDER_ID).status, 'in-production');
});

test('delivered when every parcel is delivered: deliveredAt, shipment and order Delivered', async () => {
  const { sanity, deps } = setup();
  await applyParcelEvent(ev(11, 'Delivered'), deps);
  assert.equal(sanity.store.get(ORDER_ID).shipment.deliveredAt, undefined, 'one of two parcels is not the order');
  await applyParcelEvent(ev(11, 'Delivered', { parcelRef: '2', parcelId: 502, at: '2026-10-30T10:00:00.000Z' }), deps);
  const o = sanity.store.get(ORDER_ID);
  assert.ok(o.shipment.deliveredAt);
  assert.equal(o.shipment.status, 'delivered');
  assert.equal(o.status, 'delivered');
});

test('exception and returned-to-sender alert the team, not the customer', async () => {
  const { sanity, resend, deps } = setup(labelledOrder({ shippingEmailSent: true, status: 'dispatched', shipment: { ...labelledOrder().shipment, dispatchedAt: '2026-10-28T10:00:00Z', status: 'in_transit' } }));
  await applyParcelEvent(ev(62996, 'Exception', { carrierStatus: 'Address not found' }), deps);
  assert.equal(sanity.store.get(ORDER_ID).shipment.status, 'exception');
  assert.equal(resend.sent.length, 1);
  assert.match(resend.sent[0].subject, /CSC-3001: parcel 1 has a delivery problem/);
  assert.match(resend.sent[0].html, /Address not found/);
  assert.notEqual(resend.sent[0].to[0], 'grace@example.com');
  await applyParcelEvent(ev(62992, 'Returned to sender', { at: '2026-10-31T10:00:00.000Z' }), deps);
  assert.equal(sanity.store.get(ORDER_ID).shipment.status, 'returned_to_sender');
  assert.match(resend.sent[1].subject, /returned to sender/);
});

test('events are capped at the newest 30', async () => {
  const { sanity, deps } = setup(labelledOrder({ shippingEmailSent: true }));
  for (let i = 0; i < 35; i++) {
    await applyParcelEvent(ev(32, 'Sorted', { at: `2026-10-29T12:${String(i).padStart(2, '0')}:00.000Z` }), deps);
  }
  const events = sanity.store.get(ORDER_ID).shipment.events;
  assert.equal(events.length, 30);
  assert.equal(events[0].at, '2026-10-29T12:05:00.000Z');
  assert.equal(events[29].at, '2026-10-29T12:34:00.000Z');
});

test('an unknown order is acknowledged, not retried for ever', async () => {
  const { deps } = setup();
  const r = await applyParcelEvent(ev(91, 'x', { orderRef: 'CSC-9999' }), deps);
  assert.equal(r.status, 200);
});

/* ---------------------------------------------------------------- the handler */

const SECRET = 'cb-secret';
const env = { SHIPPING_ENABLED: 'true', SHIPPING_SECRET: SECRET, SHIPPING_BRAND: 'CSC' };
const request = (body, secret = SECRET) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request('https://x/api/shipping-event', {
    method: 'POST',
    headers: { 'x-mv-brand': 'csc', 'x-mv-timestamp': ts, 'x-mv-signature': createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex') },
    body,
  });
};

// shipping-event (fast) hands the unchanged signed body to
// shipping-event-background, which runs the event. `handOff` returns the
// request the background function would receive, or null if none was started.
async function handOff(body, { secret = SECRET, env: e = env } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 202 }); };
  const r = await acceptShippingEvent(request(body, secret), { env: e, log: quiet, start: (req, raw, o) => startEventBackground(req, raw, { ...o, fetchImpl }) });
  const bg = calls[0] ? new Request(calls[0].url, { method: 'POST', headers: calls[0].init.headers, body: calls[0].init.body }) : null;
  return { r, calls, bg };
}
const applyWith = (deps) => (e) => (e.kind === 'parcel' ? applyParcelEvent(e, deps) : applyReturnEvent(e, deps));

test('fast path: signature first (401, nothing started), 503 while switched off, else handed off and 200 with no work done', async () => {
  const { sanity, resend } = setup();
  const body = JSON.stringify(ev(91, 'Parcel en route'));
  const forged = await handOff(body, { secret: 'forged' });
  assert.equal(forged.r.status, 401);
  assert.equal(forged.calls.length, 0);
  const off = await handOff(body, { env: { ...env, SHIPPING_ENABLED: '' } });
  assert.equal(off.r.status, 503);
  assert.equal(off.calls.length, 0);
  const ok = await handOff(body);
  assert.equal(ok.r.status, 200);
  assert.equal(ok.calls.length, 1, 'only the background start leaves the fast path');
  assert.match(ok.calls[0].url, /\/\.netlify\/functions\/shipping-event-background$/);
  assert.equal(ok.calls[0].init.body, body, 'the same raw body');
  assert.equal(ok.calls[0].init.headers[EVENT_HANDOFF_HEADER], eventHandoffKey(env));
  assert.equal(sanity.store.get(ORDER_ID).shipment.events, undefined, 'nothing written by the fast path');
  assert.equal(resend.sent.length, 0);
});

test('fast path: shipping-event.mjs imports nothing that reaches Sanity, Resend, Stripe or MailerLite', () => {
  const src = readFileSync(new URL('../netlify/functions/shipping-event.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]), ['./_shared/shipping-event-handoff.mjs']);
  const handoff = readFileSync(new URL('../netlify/functions/_shared/shipping-event-handoff.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...handoff.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]), ['node:crypto', './shipping-client.mjs']);
});

test('fast path: a failed background start is 503 so the service retries', async () => {
  const r = await acceptShippingEvent(request(JSON.stringify(ev(91, 'Parcel en route'))), { env, log: quiet, start: async () => ({ ok: false, error: 'HTTP 500' }) });
  assert.equal(r.status, 503);
});

test('background path: does the work -- order dispatched, builds dispatched, one dispatch email', async () => {
  const { sanity, resend, postDelivery, deps } = setup();
  const { bg } = await handOff(JSON.stringify(ev(91, 'Parcel en route')));
  const r = await runShippingEvent(bg, { apply: applyWith(deps), env, log: quiet });
  assert.equal(r.status, 200);
  assert.equal(r.retry, false);
  assert.equal(sanity.store.get(ORDER_ID).status, 'dispatched');
  assert.equal(customerEmails(resend).length, 1);
  assert.deepEqual(postDelivery, ['CSC-3001']);
});

test('background path: the same event delivered twice still sends one email', async () => {
  const { resend, deps } = setup();
  for (let i = 0; i < 2; i++) {
    const { bg } = await handOff(JSON.stringify(ev(91, 'Parcel en route')));
    assert.equal((await runShippingEvent(bg, { apply: applyWith(deps), env, log: quiet })).status, 200);
  }
  assert.equal(customerEmails(resend).length, 1);
});

test('background path: needs the handoff key and the signature; a Netlify retry minutes later still passes', async () => {
  const body = JSON.stringify(ev(91, 'Parcel en route'));
  const { calls } = await handOff(body);
  let applied = 0;
  const apply = async () => { applied++; return { status: 200, body: 'OK' }; };
  const rebuild = (headers, b = body) => new Request(calls[0].url, { method: 'POST', headers, body: b });
  const h = calls[0].init.headers;
  assert.equal((await runShippingEvent(rebuild({ ...h, [EVENT_HANDOFF_HEADER]: 'x'.repeat(48) }), { apply, env, log: quiet })).status, 403);
  assert.equal((await runShippingEvent(rebuild(h, JSON.stringify(ev(11, 'Delivered'))), { apply, env, log: quiet })).status, 401);
  assert.equal((await runShippingEvent(rebuild(h), { apply, env, log: quiet, now: Date.now() + 4 * 60_000 })).status, 200);
  assert.equal((await runShippingEvent(rebuild(h), { apply, env, log: quiet, now: Date.now() + 16 * 60_000 })).status, 401);
  assert.equal(applied, 1);
});

test('background path: a failed dispatch email (5xx outcome) asks Netlify to retry', async () => {
  const { bg } = await handOff(JSON.stringify(ev(91, 'Parcel en route')));
  const r = await runShippingEvent(bg, { apply: async () => ({ status: 503, body: 'Dispatch email not sent' }), env, log: quiet });
  assert.equal(r.retry, true);
});

/* ---------------------------------------------------------------- returns */

test('a return reaching the collection point: Ready to collect, and the team told which point', async () => {
  const ret = {
    _id: 'returnRequest.ret-1', _type: 'returnRequest', returnRef: 'ret-1', returnNumber: 'CSC-3001-R1', orderNumber: 'CSC-3001',
    customerName: 'Grace Hopper', customerEmail: 'grace@example.com', status: 'label_sent', carrier: 'inpost_gb', trackingNumber: 'IP1',
    lines: [{ _key: 'a', productTitle: 'Hulk', quantity: 1, unitPrice: 25 }], postageDeduction: 2.95,
  };
  const sanity = fakeSanity([ret], { queries: QUERIES });
  const resend = fakeResend();
  const deps = { sanity, getResend: () => resend, log: quiet };
  const rev = (statusCode, status, at) => ({ kind: 'return', brand: 'csc', orderRef: 'CSC-3001', returnRef: 'ret-1', status, statusCode, at });

  process.env.RETURN_POINT_INPOST = 'InPost locker, Tesco Southend';
  try {
    await applyReturnEvent(rev(91, 'Parcel en route', '2026-11-01T10:00:00Z'), deps);
    assert.equal(sanity.store.get(ret._id).status, 'in_transit');
    await applyReturnEvent(rev(12, 'Awaiting customer pickup', '2026-11-02T10:00:00Z'), deps);
    await applyReturnEvent(rev(12, 'Awaiting customer pickup', '2026-11-02T10:00:00Z'), deps);   // replay
    const r = sanity.store.get(ret._id);
    assert.equal(r.status, 'ready_to_collect');
    assert.ok(r.readyToCollectAt);
    assert.equal(resend.sent.length, 1);
    assert.match(resend.sent[0].subject, /ready to collect/);
    assert.match(resend.sent[0].html, /InPost locker, Tesco Southend/);
    assert.notEqual(resend.sent[0].to[0], 'grace@example.com', 'the collection point is never sent to the customer');
    await applyReturnEvent(rev(93, 'Shipment collected by customer', '2026-11-03T10:00:00Z'), deps);
    assert.equal(sanity.store.get(ret._id).status, 'received');
  } finally {
    delete process.env.RETURN_POINT_INPOST;
  }
});

/* ---------------------------------------------------------------- the email itself */

test('an order dispatched by hand gets the email it always got', () => {
  const { html, carrierName } = buildDispatchEmail({
    _id: 'order.x', orderNumber: 'CSC-1', customerName: 'Al', trackingNumber: 'AB123', status: 'dispatched',
    lineItems: [{ productTitle: 'Hulk', format: 'Canvas (Standard Frame)', size: 'Large', quantity: 1, unitPrice: 50 }],
    totalAmount: 50, shippingCost: 0,
  });
  assert.equal(carrierName, 'UPS');
  assert.match(html, /1-2 working days/);
  assert.match(html, /https:\/\/www\.ups\.com\/track\?tracknum=AB123/);
  assert.doesNotMatch(html, /Parcel 1 of/);
});
