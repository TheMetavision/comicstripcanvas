// sanity-orders-webhook: the one Sanity webhook for orders and return requests.
// The routing table, the signature, and that a delivery Sanity repeats -- or
// sends twice at once -- never sends anything twice. Sanity, the shipping
// service and Resend are fakes; the background handlers are the real ones,
// reached through the internally signed request the router really sends.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeSignatureHeader } from '@sanity/webhook';
import { routeFor, handleOrdersWebhook, startBackground } from '../netlify/functions/sanity-orders-webhook.mjs';
import { handleDispatchWebhook } from '../netlify/functions/shipping-dispatch-background.mjs';
import { handleReturnWebhook } from '../netlify/functions/shipping-return-background.mjs';
import { sendDispatchEmail } from '../netlify/functions/_shared/dispatch-email.mjs';
import { fakeSanity, fakeResend, quiet } from './fixtures/fake-sanity.mjs';

const SECRET = 'orders-webhook-secret';
const INTERNAL = 'internal-shipping-secret';
const ENV = { SANITY_WEBHOOK_SECRET: SECRET, SANITY_WEBHOOK_SECRET_SHIPPING: INTERNAL, SHIPPING_ENABLED: 'true' };
const sign = (body, secret = SECRET) => encodeSignatureHeader(body, Date.now(), secret);

/* ── The routing table ─────────────────────────────────────────────────── */

const order = (extra = {}) => ({ _id: 'order.cs_test_1', _type: 'order', orderNumber: 'CSC-1', status: 'in-production', ...extra });
const ret = (extra = {}) => ({ _id: 'returnRequest.ret-1', _type: 'returnRequest', returnNumber: 'CSC-1-R1', status: 'requested', ...extra });

const TABLE = [
  ['order dispatched, tracking, not yet emailed', order({ status: 'dispatched', trackingNumber: 'T1' }), ['dispatch-email']],
  ['order dispatched, tracking, shippingEmailSent false', order({ status: 'dispatched', trackingNumber: 'T1', shippingEmailSent: false }), ['dispatch-email']],
  ['order dispatched, already emailed', order({ status: 'dispatched', trackingNumber: 'T1', shippingEmailSent: true }), []],
  ['order dispatched, no tracking number', order({ status: 'dispatched' }), []],
  ['order in production with tracking', order({ trackingNumber: 'T1' }), []],
  ['order ready to ship, no labels', order({ shipment: { status: 'ready_to_ship' } }), ['shipping-dispatch']],
  ['order ready to ship, plan, no labels', order({ shipment: { status: 'ready_to_ship', parcels: [] }, parcelPlan: [{ parcelRef: '1' }] }), ['shipping-dispatch']],
  ['order ready to ship, one of two planned parcels labelled (the retry)',
    order({ shipment: { status: 'ready_to_ship', parcels: [{ parcelRef: '1', labelId: '9' }] }, parcelPlan: [{ parcelRef: '1' }, { parcelRef: '2' }] }), ['shipping-dispatch']],
  ['order ready to ship, every planned parcel labelled',
    order({ shipment: { status: 'ready_to_ship', parcels: [{ parcelRef: '1', labelId: '9' }, { parcelRef: '2', labelId: '10' }] }, parcelPlan: [{ parcelRef: '1' }, { parcelRef: '2' }] }), []],
  ['order label created', order({ shipment: { status: 'label_created' } }), []],
  ['order exception', order({ shipment: { status: 'exception' } }), []],
  ['order dispatched by hand AND ready to ship', order({ status: 'dispatched', trackingNumber: 'T1', shipment: { status: 'ready_to_ship' } }), ['dispatch-email', 'shipping-dispatch']],
  ['return approved, not actioned', ret({ status: 'approved' }), ['shipping-return']],
  ['return approved, label already sent', ret({ status: 'approved', labelSentAt: '2026-10-01T00:00:00Z' }), []],
  ['return rejected, not actioned', ret({ status: 'rejected' }), ['shipping-return']],
  ['return rejected, decline already sent', ret({ status: 'rejected', rejectionEmailSentAt: '2026-10-01T00:00:00Z' }), []],
  ['return requested', ret(), []],
  ['return label sent', ret({ status: 'label_sent', labelSentAt: '2026-10-01T00:00:00Z' }), []],
  ['a draft order', order({ _id: 'drafts.order.cs_test_1', status: 'dispatched', trackingNumber: 'T1' }), []],
  ['a product', { _id: 'p1', _type: 'product', title: 'Hulk' }, []],
  ['an orderCounter', { _id: 'orderCounter.main', _type: 'orderCounter' }, []],
  ['no document', {}, []],
];

for (const [name, doc, expected] of TABLE) {
  test(`route: ${name} -> ${expected.join(' + ') || 'nothing'}`, () => {
    assert.deepEqual(routeFor(doc).actions, expected);
  });
}

test('the handler acts on exactly what the table says, and answers 200 to the rest', async () => {
  for (const [name, doc, expected] of TABLE) {
    const done = [];
    const deps = {
      log: quiet,
      sendDispatch: async () => { done.push('dispatch-email'); return { status: 200, reason: 'OK' }; },
      start: async ({ action }) => { done.push(action); return { ok: true, status: 202 }; },
    };
    const rawBody = JSON.stringify(doc);
    const r = await handleOrdersWebhook({ rawBody, signature: await sign(rawBody), env: ENV, deps });
    assert.equal(r.status, 200, name);
    assert.deepEqual(done, expected, name);
  }
});

test('shipping switched off: the dispatch email still goes, the shipping jobs are not started', async () => {
  const done = [];
  const deps = {
    log: quiet,
    sendDispatch: async () => { done.push('dispatch-email'); return { status: 200, reason: 'OK' }; },
    start: async ({ action }) => { done.push(action); return { ok: true, status: 202 }; },
  };
  for (const doc of [TABLE[0][1], TABLE[5][1], TABLE[12][1]]) {
    const rawBody = JSON.stringify(doc);
    const r = await handleOrdersWebhook({ rawBody, signature: await sign(rawBody), env: { SANITY_WEBHOOK_SECRET: SECRET }, deps });
    assert.equal(r.status, 200);
  }
  assert.deepEqual(done, ['dispatch-email']);
});

test('a background job that will not start answers 502, so Sanity retries the delivery', async () => {
  const rawBody = JSON.stringify(ret({ status: 'approved' }));
  const deps = { log: quiet, sendDispatch: async () => assert.fail(), start: async () => ({ ok: false, status: 0, url: 'x', error: 'fetch failed' }) };
  const r = await handleOrdersWebhook({ rawBody, signature: await sign(rawBody), env: ENV, deps });
  assert.equal(r.status, 502);
});

/* ── Signature ─────────────────────────────────────────────────────────── */

test('signature: wrong secret, missing, tampered body, garbage and no secret configured are all refused, nothing done', async () => {
  const doc = order({ status: 'dispatched', trackingNumber: 'T1' });
  const rawBody = JSON.stringify(doc);
  const deps = { log: quiet, sendDispatch: async () => assert.fail('must not send'), start: async () => assert.fail('must not start') };
  const call = (signature, env = ENV, body = rawBody) => handleOrdersWebhook({ rawBody: body, signature, env, deps });

  assert.equal((await call(await sign(rawBody, 'not-the-secret'))).status, 401);
  // The internal shipping secret is not this webhook's secret.
  assert.equal((await call(await sign(rawBody, INTERNAL))).status, 401);
  assert.equal((await call(null)).status, 401);
  assert.equal((await call('t=1,v1=nonsense')).status, 401);
  assert.equal((await call(await sign(rawBody), ENV, rawBody.replace('T1', 'T2'))).status, 401);
  assert.equal((await call(await sign(rawBody), { ...ENV, SANITY_WEBHOOK_SECRET: '' })).status, 500);
});

test('the default export refuses an unsigned POST and a GET', async () => {
  const fn = (await import('../netlify/functions/sanity-orders-webhook.mjs'));
  assert.equal(fn.config?.path, undefined, 'must not set config.path');
  const saved = process.env.SANITY_WEBHOOK_SECRET;
  process.env.SANITY_WEBHOOK_SECRET = SECRET;
  try {
    assert.equal((await fn.default(new Request('https://x/api/sanity-orders-webhook', { method: 'POST', body: '{}' }))).status, 401);
    assert.equal((await fn.default(new Request('https://x/api/sanity-orders-webhook'))).status, 405);
  } finally {
    if (saved === undefined) delete process.env.SANITY_WEBHOOK_SECRET; else process.env.SANITY_WEBHOOK_SECRET = saved;
  }
});

/* ── The internal request, and double delivery ─────────────────────────── */

/** A fetch that hands the router's request to a real background handler. */
const backgroundFetch = (handlers, seen = []) => async (url, init) => {
  const path = new URL(url).pathname;
  seen.push({ path, headers: init.headers, body: init.body });
  const r = await handlers[path]({ rawBody: init.body, signature: init.headers['sanity-webhook-signature'], env: ENV });
  // A real background function answers 202 at once; the work is what matters here.
  return { ok: r.status < 400, status: r.status < 400 ? 202 : r.status };
};

test('the internal request is signed with SANITY_WEBHOOK_SECRET_SHIPPING, and only that secret', async () => {
  const seen = [];
  // A product body: the handler stops after the signature, before any deps.
  const handler = (a) => handleDispatchWebhook({ ...a, deps: null });
  const r = await startBackground({
    action: 'shipping-dispatch', doc: { _id: 'product.x', _type: 'product' }, origin: 'https://site.netlify.app', secret: INTERNAL,
    fetchImpl: backgroundFetch({ '/api/shipping-dispatch': handler }, seen),
  });
  assert.equal(r.ok, true);
  assert.equal(seen[0].path, '/api/shipping-dispatch');
  assert.deepEqual(JSON.parse(seen[0].body), { _id: 'product.x', _type: 'product' });

  // The background function accepts it (an ignored product, not a 401)...
  const accepted = await handleDispatchWebhook({ rawBody: seen[0].body, signature: seen[0].headers['sanity-webhook-signature'], env: ENV, deps: null });
  assert.equal(accepted.status, 200);
  // ...and refuses the same request signed with the orders webhook's secret.
  const wrong = await handleDispatchWebhook({ rawBody: seen[0].body, signature: await sign(seen[0].body, SECRET), env: ENV, deps: null });
  assert.equal(wrong.status, 401);
});

const DISPATCHED = {
  _id: 'order.cs_test_double', _type: 'order', orderNumber: 'CSC-7001', customerName: 'Ada Lovelace', customerEmail: 'ada@example.com',
  status: 'dispatched', trackingNumber: '1Z999', totalAmount: 25, shippingCost: 0,
  shippingAddress: { line1: '2 Road', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' },
  lineItems: [{ _key: 'a', productTitle: 'Hulk', format: 'Poster Print', size: 'Medium', formatKey: 'poster', sizeKey: 'medium', quantity: 1, unitPrice: 25 }],
};

function emailSetup() {
  const sanity = fakeSanity([DISPATCHED]);
  const resend = fakeResend();
  const deps = {
    log: quiet,
    sendDispatch: ({ orderId }) => sendDispatchEmail({ orderId, sanity, getResend: () => resend, log: quiet, postDelivery: async () => {} }),
    start: async () => assert.fail('no background job for this order'),
  };
  return { sanity, resend, deps };
}

test('dispatch email: the same delivery twice in a row sends one email', async () => {
  const { sanity, resend, deps } = emailSetup();
  const rawBody = JSON.stringify(DISPATCHED);
  const signature = await sign(rawBody);
  const first = await handleOrdersWebhook({ rawBody, signature, env: ENV, deps });
  const second = await handleOrdersWebhook({ rawBody, signature, env: ENV, deps });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(second.body, /Already sent/);
  assert.equal(resend.sent.length, 1);
  assert.equal(sanity.store.get(DISPATCHED._id).shippingEmailSent, true);
});

test('dispatch email: two deliveries at once send one email', async () => {
  const { resend, deps } = emailSetup();
  const rawBody = JSON.stringify(DISPATCHED);
  const signature = await sign(rawBody);
  await Promise.all([1, 2, 3].map(() => handleOrdersWebhook({ rawBody, signature, env: ENV, deps })));
  assert.equal(resend.sent.length, 1);
});

const READY = {
  _id: 'order.cs_test_ready', _type: 'order', orderNumber: 'CSC-7002', customerName: 'Ada Lovelace', customerEmail: 'ada@example.com',
  status: 'in-production',
  shippingAddress: { line1: '2 Road', line2: '', city: 'Leeds', county: '', postcode: 'LS1 1AA', country: 'GB' },
  lineItems: [{ _key: 'a', productTitle: 'Hulk', format: 'Poster Print', size: 'Medium', formatKey: 'poster', sizeKey: 'medium', quantity: 1, unitPrice: 25 }],
  shipment: { status: 'ready_to_ship' },
};

test('ready to ship: repeated and simultaneous deliveries buy one label and send one "label ready" email', async () => {
  const sanity = fakeSanity([READY]);
  const resend = fakeResend();
  const labels = [];
  const shipping = async (path, body) => {
    labels.push(body.parcelRef);
    await Promise.resolve();
    return { parcelId: 1, shipmentId: 's1', carrier: 'royal_mailv2', method: 'm', trackingNumber: 'TRK1', labelId: '501', quotedPrice: { amount: 3.5, currency: 'GBP' } };
  };
  const bgDeps = { sanity, shipping, getResend: () => resend, log: quiet };
  const fetchImpl = backgroundFetch({ '/api/shipping-dispatch': (a) => handleDispatchWebhook({ ...a, deps: bgDeps }) });
  const deps = {
    log: quiet,
    sendDispatch: async () => assert.fail('not dispatched yet'),
    start: ({ action, doc }) => startBackground({ action, doc, origin: 'https://site.netlify.app', secret: INTERNAL, fetchImpl }),
  };
  const rawBody = JSON.stringify(READY);
  const signature = await sign(rawBody);

  await Promise.all([1, 2].map(() => handleOrdersWebhook({ rawBody, signature, env: ENV, deps })));
  // And Sanity's retry of the same, stale, payload afterwards.
  const again = await handleOrdersWebhook({ rawBody, signature, env: ENV, deps });
  assert.equal(again.status, 200);

  assert.deepEqual(labels, ['1']);
  assert.equal(sanity.store.get(READY._id).shipment.status, 'label_created');
  assert.equal(resend.sent.length, 1, 'one "label ready" email to the team');
});

const ORDER_FOR_RETURN = {
  _id: 'order.cs_test_ret', _type: 'order', orderNumber: 'CSC-7003', customerName: 'Mary Shelley', customerEmail: 'mary@example.com',
  status: 'delivered', shippingAddress: { line1: '9 Close', city: 'Bath', postcode: 'BA1 1AA', country: 'GB' }, lineItems: [],
};
const RETURN = (status) => ({
  _id: 'returnRequest.ret-dbl', _type: 'returnRequest', returnRef: 'ret-dbl', returnNumber: 'CSC-7003-R1',
  orderId: ORDER_FOR_RETURN._id, orderNumber: 'CSC-7003', customerName: 'Mary Shelley', customerEmail: 'mary@example.com',
  status, band: 'P3', freeLabel: false, rejectionReason: 'Outside the return window.',
  lines: [{ _key: 'a', lineKey: 'a', productTitle: 'Hulk', format: 'Poster Print', size: 'Medium', quantity: 1, unitPrice: 25 }],
});

for (const status of ['approved', 'rejected']) {
  test(`return ${status}: repeated and simultaneous deliveries send the customer one email`, async () => {
    const sanity = fakeSanity([ORDER_FOR_RETURN, RETURN(status)]);
    const resend = fakeResend();
    const labels = [];
    const bgDeps = {
      sanity, getResend: () => resend, log: quiet,
      shipping: async (path, body) => {
        labels.push(body.returnRef);
        await Promise.resolve();
        return { parcelId: 77, carrier: 'inpost_gb', method: 'm', trackingNumber: 'IP77', labelId: '77', customerInstructions: 'Drop it off.', quotedPrice: { amount: 2.95, currency: 'GBP' } };
      },
      fetchLabel: async () => Buffer.from('%PDF-label'),
    };
    const fetchImpl = backgroundFetch({ '/api/shipping-return': (a) => handleReturnWebhook({ ...a, deps: bgDeps }) });
    const deps = {
      log: quiet,
      sendDispatch: async () => assert.fail(),
      start: ({ action, doc }) => startBackground({ action, doc, origin: 'https://site.netlify.app', secret: INTERNAL, fetchImpl }),
    };
    const rawBody = JSON.stringify(RETURN(status));
    const signature = await sign(rawBody);

    await Promise.all([1, 2].map(() => handleOrdersWebhook({ rawBody, signature, env: ENV, deps })));
    await handleOrdersWebhook({ rawBody, signature, env: ENV, deps });

    const toCustomer = resend.sent.filter((m) => m.to.includes('mary@example.com'));
    assert.equal(toCustomer.length, 1);
    assert.deepEqual(labels, status === 'approved' ? ['ret-dbl'] : []);
  });
}
