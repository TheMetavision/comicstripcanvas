// shipping-dispatch: one label per planned parcel, never twice, and an
// Exception with the reason when the service says no. Sanity, the service and
// Resend are all fakes.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSignatureHeader } from '@sanity/webhook';
import { dispatchOrder, handleDispatchWebhook } from '../netlify/functions/shipping-dispatch-background.mjs';
import { ShippingServiceError } from '../netlify/functions/_shared/shipping-client.mjs';
import { fakeSanity, fakeResend, quiet } from './fixtures/fake-sanity.mjs';

const ORDER_ID = 'order.cs_test_dispatch';
const baseOrder = (extra = {}) => ({
  _id: ORDER_ID, _type: 'order', orderNumber: 'CSC-2001', customerName: 'Ada Lovelace', customerEmail: 'ada@example.com',
  status: 'in-production',
  shippingAddress: { line1: '2 Road', line2: '', city: 'Leeds', county: '', postcode: 'LS1 1AA', country: 'GB' },
  lineItems: [
    { _key: 'a', productTitle: 'Hulk', format: 'Poster Print', size: 'Medium', formatKey: 'poster', sizeKey: 'medium', quantity: 1, unitPrice: 25 },
    { _key: 'b', productTitle: 'Thor', format: 'Canvas (Gallery Frame)', size: 'Large', formatKey: 'canvas-gallery', sizeKey: 'large', quantity: 1, unitPrice: 90 },
  ],
  shipment: { status: 'ready_to_ship' },
  ...extra,
});

function fakeService({ failOn } = {}) {
  const calls = [];
  const shipping = async (path, body) => {
    calls.push({ path, body });
    await Promise.resolve();
    if (failOn && failOn(body)) throw new ShippingServiceError('Band CG4 has no sizes yet', { code: 'band_not_configured', status: 422 });
    return {
      parcelId: 1000 + calls.length, shipmentId: `s${calls.length}`, carrier: 'royal_mailv2', method: 'royal_mailv2:tracked_48/size=m',
      trackingNumber: `TRK${calls.length}`, trackingUrl: `https://track.example/${calls.length}`, labelId: String(1000 + calls.length),
      quotedPrice: { amount: 3.5, currency: 'GBP' },
    };
  };
  return { calls, shipping };
}

const run = (sanity, svc, resend) => dispatchOrder(ORDER_ID, { sanity, shipping: svc.shipping, getResend: () => resend, log: quiet });

test('ready to ship: one label per planned parcel, recorded, team emailed once, customer not emailed', async () => {
  const sanity = fakeSanity([baseOrder()]);
  const svc = fakeService();
  const resend = fakeResend();
  const r = await run(sanity, svc, resend);
  assert.equal(r.outcome, 'label_created');
  assert.equal(svc.calls.length, 2);
  assert.deepEqual(svc.calls.map((c) => [c.body.orderRef, c.body.parcelRef, c.body.band]), [['CSC-2001', '1', 'P3'], ['CSC-2001', '2', 'CG4']]);
  assert.equal(svc.calls[0].body.recipient.postalCode, 'LS1 1AA');
  assert.equal(svc.calls[0].body.recipient.email, '', 'the carrier gets name and address, not the email');
  assert.equal(svc.calls[0].body.items[0].valueGBP, 25);

  const o = sanity.store.get(ORDER_ID);
  assert.equal(o.shipment.status, 'label_created');
  assert.equal(o.shipment.parcels.length, 2);
  assert.deepEqual(o.shipment.parcels.map((p) => [p.parcelRef, p.carrier, p.option, p.quotedPrice, p.trackingNumber, p.labelId]),
    [['1', 'royal_mailv2', 'royal_mailv2:tracked_48/size=m', 3.5, 'TRK1', '1001'], ['2', 'royal_mailv2', 'royal_mailv2:tracked_48/size=m', 3.5, 'TRK2', '1002']]);
  assert.ok(o.shipment.labelCreatedAt);
  assert.equal(o.shipment.dispatchClaimedAt, undefined, 'the claim is cleared');
  assert.equal(o.parcelPlan.length, 2, 'the default plan used is written back for the Studio');
  assert.equal(o.status, 'in-production', 'the order itself is not dispatched until a carrier scans it');

  assert.equal(resend.sent.length, 1);
  assert.match(resend.sent[0].subject, /Label ready — CSC-2001/);
  assert.match(resend.sent[0].html, /\/admin\/shipping\/label\/1001/);
  assert.match(resend.sent[0].html, /\/admin\/shipping\/label\/1002/);
  assert.notEqual(resend.sent[0].to[0], 'ada@example.com');
});

test('idempotent: a repeated webhook buys nothing and sends nothing; ready-to-ship again skips labelled parcels', async () => {
  const sanity = fakeSanity([baseOrder()]);
  const svc = fakeService();
  const resend = fakeResend();
  await run(sanity, svc, resend);
  const again = await run(sanity, svc, resend);
  assert.equal(again.outcome, 'ignored');
  assert.equal(svc.calls.length, 2);
  assert.equal(resend.sent.length, 1);

  // Alan sets Ready to ship again by mistake.
  await sanity.patch(ORDER_ID).set({ 'shipment.status': 'ready_to_ship' }).commit();
  const third = await run(sanity, svc, resend);
  assert.equal(third.outcome, 'label_created');
  assert.equal(svc.calls.length, 2, 'no parcel that already has a label is bought again');
});

test('two webhooks at once: exactly one claims the order', async () => {
  const sanity = fakeSanity([baseOrder()]);
  const svc = fakeService();
  const resend = fakeResend();
  const [a, b] = await Promise.all([run(sanity, svc, resend), run(sanity, svc, resend)]);
  assert.deepEqual([a.outcome, b.outcome].sort(), ['ignored', 'label_created']);
  assert.equal(svc.calls.length, 2);
  assert.equal(resend.sent.length, 1);
});

test('a service error sets Exception, keeps the labels already bought, and emails the team the reason; a retry buys only the rest', async () => {
  const sanity = fakeSanity([baseOrder()]);
  let broken = true;
  const svc = fakeService({ failOn: (b) => broken && b.band === 'CG4' });
  const resend = fakeResend();
  const r = await run(sanity, svc, resend);
  assert.equal(r.outcome, 'exception');
  const o = sanity.store.get(ORDER_ID);
  assert.equal(o.shipment.status, 'exception');
  assert.match(o.shipment.error, /band_not_configured/);
  assert.match(o.shipment.error, /1 label\(s\) were bought before this and are kept/);
  assert.equal(o.shipment.parcels.length, 1);
  assert.equal(resend.sent.length, 1);
  assert.match(resend.sent[0].subject, /Shipping problem — CSC-2001/);
  assert.match(resend.sent[0].html, /band_not_configured/);

  broken = false;
  await sanity.patch(ORDER_ID).set({ 'shipment.status': 'ready_to_ship' }).commit();
  const retry = await run(sanity, svc, resend);
  assert.equal(retry.outcome, 'label_created');
  assert.deepEqual(svc.calls.map((c) => c.body.parcelRef), ['1', '2', '2'], 'parcel 1 was not bought again');
  assert.equal(sanity.store.get(ORDER_ID).shipment.error, undefined);
});

test('a line with no band is never guessed: Exception before the service is called', async () => {
  const sanity = fakeSanity([baseOrder({
    lineItems: [{ _key: 'old', productTitle: 'Old order line', format: 'Poster Print', size: 'Small', quantity: 1, unitPrice: 20 }],
  })]);
  const svc = fakeService();
  const resend = fakeResend();
  const r = await run(sanity, svc, resend);
  assert.equal(r.outcome, 'exception');
  assert.equal(svc.calls.length, 0);
  assert.match(sanity.store.get(ORDER_ID).shipment.error, /has no band/);
});

test('Alan\'s edited plan is used: two posters in one tube is one label', async () => {
  const sanity = fakeSanity([baseOrder({
    lineItems: [
      { _key: 'a', productTitle: 'Hulk', formatKey: 'poster', sizeKey: 'medium', quantity: 1, unitPrice: 25 },
      { _key: 'c', productTitle: 'Thor', formatKey: 'poster', sizeKey: 'large', quantity: 1, unitPrice: 30 },
    ],
    parcelPlan: [{ _key: 'p1', parcelRef: '1', band: 'P4', items: [{ _key: 'i1', lineKey: 'a', quantity: 1 }, { _key: 'i2', lineKey: 'c', quantity: 1 }] }],
  })]);
  const svc = fakeService();
  await run(sanity, svc, fakeResend());
  assert.equal(svc.calls.length, 1);
  assert.equal(svc.calls[0].body.band, 'P4');
  assert.equal(svc.calls[0].body.items.length, 2);
});

test('outside the UK: Exception, no label (international stays off)', async () => {
  const sanity = fakeSanity([baseOrder({ shippingAddress: { line1: '1 Rue', city: 'Paris', postcode: '75001', country: 'FR' } })]);
  const svc = fakeService();
  const r = await run(sanity, svc, fakeResend());
  assert.equal(r.outcome, 'exception');
  assert.equal(svc.calls.length, 0);
});

/* ---------------------------------------------------------------- the webhook */

const SECRET = 'whsec-test';
const signed = async (doc) => {
  const body = JSON.stringify(doc);
  return { rawBody: body, signature: await encodeSignatureHeader(body, Date.now(), SECRET) };
};

test('the webhook: off unless SHIPPING_ENABLED, verified with @sanity/webhook, drafts ignored', async () => {
  const sanity = fakeSanity([baseOrder()]);
  const svc = fakeService();
  const deps = { sanity, shipping: svc.shipping, getResend: () => fakeResend(), log: quiet };
  const env = { SHIPPING_ENABLED: 'true', SANITY_WEBHOOK_SECRET_SHIPPING: SECRET };
  const ok = await signed({ _id: ORDER_ID, _type: 'order' });

  const off = await handleDispatchWebhook({ ...ok, env: {}, deps });
  assert.equal(off.status, 200);
  assert.match(off.body, /not enabled/);
  assert.equal(svc.calls.length, 0, 'switched off, nothing happens at all');

  const bad = await handleDispatchWebhook({ rawBody: ok.rawBody, signature: await encodeSignatureHeader(ok.rawBody, Date.now(), 'wrong'), env, deps });
  assert.equal(bad.status, 401);
  const none = await handleDispatchWebhook({ rawBody: ok.rawBody, signature: null, env, deps });
  assert.equal(none.status, 401);

  const draft = await handleDispatchWebhook({ ...(await signed({ _id: `drafts.${ORDER_ID}`, _type: 'order' })), env, deps });
  assert.match(draft.body, /ignored/);
  assert.equal(svc.calls.length, 0);

  const good = await handleDispatchWebhook({ ...ok, env, deps });
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.body).outcome, 'label_created');
});

test('a Stripe test-mode order asks the service for a free test label; a live order does not', async () => {
  for (const [extra, expectTest] of [[{ test: true }, true], [{}, false], [{ test: false }, false]]) {
    const sanity = fakeSanity([baseOrder(extra)]);
    const svc = fakeService();
    const resend = fakeResend();
    assert.equal((await run(sanity, svc, resend)).outcome, 'label_created');
    assert.ok(svc.calls.length > 0);
    for (const c of svc.calls) assert.equal(c.body.test === true, expectTest, JSON.stringify(extra));
    if (!expectTest) assert.ok(svc.calls.every((c) => !('test' in c.body)), 'a live order never sends test');
    // The team's label email is [TEST] for a test-mode order, whatever SHIPPING_TEST_MODE says.
    assert.equal(/^\[TEST\] /.test(resend.sent[0].subject), expectTest || /^(true|1|yes)$/i.test(process.env.SHIPPING_TEST_MODE || ''));
  }
});
