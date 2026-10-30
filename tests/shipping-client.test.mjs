// The signed calls to metavision-shipping, and the check on its callbacks.
// fetch is stubbed: nothing leaves this machine.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  shippingRequest, shippingCreate, verifyShippingCallback, sign, quotedPounds, quoteReturnPounds,
  shippingEnabled, shippingTestMode,
} from '../netlify/functions/_shared/shipping-client.mjs';

const SECRET = 'test-secret-not-real';
const env = { SHIPPING_API_URL: 'https://ship.example/', SHIPPING_BRAND: 'CSC', SHIPPING_SECRET: SECRET };
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const hmac = (ts, body) => createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');

function recorder(response = Response.json({ ok: true }, { status: 201 })) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, ...init }); return typeof response === 'function' ? response() : response.clone(); };
  return { calls, fetchImpl };
}

test('a POST is signed over `${timestamp}.${rawBody}` with the brand secret', async () => {
  const { calls, fetchImpl } = recorder();
  const body = { orderRef: 'CSC-1042', parcelRef: '1', band: 'CS3' };
  await shippingRequest('create-parcel', { body, env, fetchImpl, now: NOW });
  const c = calls[0];
  assert.equal(c.url, 'https://ship.example/api/create-parcel');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['x-mv-brand'], 'CSC');
  assert.equal(c.headers['x-mv-timestamp'], String(NOW / 1000));
  assert.equal(c.body, JSON.stringify(body));
  assert.equal(c.headers['x-mv-signature'], hmac(String(NOW / 1000), c.body));
  assert.equal(c.headers['x-mv-signature'], sign(SECRET, String(NOW / 1000), c.body));
});

test('a GET (the label) is signed with an empty body and returns the PDF bytes', async () => {
  const { calls, fetchImpl } = recorder(new Response(Buffer.from('%PDF-1.4 x'), { status: 200 }));
  const pdf = await shippingRequest('label?labelId=383707309', { method: 'GET', env, fetchImpl, now: NOW });
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].headers['x-mv-signature'], hmac(String(NOW / 1000), ''));
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.toString(), '%PDF-1.4 x');
});

test('SHIPPING_TEST_MODE adds "test": true to label purchases and return quotes only, and the signature covers it', async () => {
  const { calls, fetchImpl } = recorder();
  const testEnv = { ...env, SHIPPING_TEST_MODE: 'true' };
  await shippingRequest('create-parcel', { body: { a: 1 }, env: testEnv, fetchImpl, now: NOW });
  await shippingRequest('create-return', { body: { a: 1 }, env: testEnv, fetchImpl, now: NOW });
  await shippingRequest('rates', { body: { band: 'P1', country: 'GB' }, env: testEnv, fetchImpl, now: NOW });
  await shippingRequest('quote-return', { body: { band: 'P3', postalCode: 'BA1 1AA' }, env: testEnv, fetchImpl, now: NOW });
  assert.deepEqual(JSON.parse(calls[0].body), { a: 1, test: true });
  assert.deepEqual(JSON.parse(calls[1].body), { a: 1, test: true });
  assert.equal(JSON.parse(calls[2].body).test, undefined, 'rates is never flagged');
  assert.equal(JSON.parse(calls[3].body).test, true, 'quote-return is, so an unfilled band can be quoted');
  assert.equal(calls[0].headers['x-mv-signature'], hmac(String(NOW / 1000), calls[0].body));

  await shippingRequest('create-parcel', { body: { a: 1 }, env, fetchImpl, now: NOW });
  await shippingRequest('quote-return', { body: { band: 'P3', postalCode: 'BA1 1AA' }, env, fetchImpl, now: NOW });
  assert.equal(JSON.parse(calls[4].body).test, undefined, 'without the variable, a real label is asked for');
  assert.equal(JSON.parse(calls[5].body).test, undefined, '  and a real quote');
});

test('the service\'s error code comes back on the thrown error', async () => {
  const { fetchImpl } = recorder(Response.json({ error: { code: 'band_not_configured', message: 'Band CS3 has no sizes' } }, { status: 422 }));
  await assert.rejects(
    shippingRequest('create-parcel', { body: {}, env, fetchImpl, now: NOW }),
    (err) => err.code === 'band_not_configured' && err.status === 422 && /CS3/.test(err.message),
  );
});

test('missing configuration is refused before anything is sent, and the secret is never in the message', async () => {
  const { calls, fetchImpl } = recorder();
  await assert.rejects(
    shippingRequest('create-parcel', { body: {}, env: { ...env, SHIPPING_SECRET: '' }, fetchImpl }),
    (err) => err.code === 'not_configured' && !err.message.includes(SECRET),
  );
  assert.equal(calls.length, 0);
});

test('409 in_progress is retried; anything else is not', async () => {
  let n = 0;
  const fetchImpl = async () => (++n < 3
    ? Response.json({ error: { code: 'in_progress', message: 'busy' } }, { status: 409 })
    : Response.json({ parcelId: 1 }, { status: 201 }));
  const r = await shippingCreate('create-parcel', {}, { env, fetchImpl, sleep: async () => {} });
  assert.equal(r.parcelId, 1);
  assert.equal(n, 3);

  let m = 0;
  const failing = async () => { m++; return Response.json({ error: { code: 'no_available_option', message: 'x' } }, { status: 422 }); };
  await assert.rejects(shippingCreate('create-parcel', {}, { env, fetchImpl: failing, sleep: async () => {} }), { code: 'no_available_option' });
  assert.equal(m, 1);
});

/* ---------------------------------------------------------------- callbacks */

const signedRequest = ({ body, ts = String(NOW / 1000), brand = 'csc', secret = SECRET, sig } = {}) => new Request('https://x/api/shipping-event', {
  method: 'POST',
  headers: {
    'x-mv-brand': brand,
    'x-mv-timestamp': ts,
    'x-mv-signature': sig ?? createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'),
  },
  body,
});

test('a callback signed by the service verifies (brand compared case-insensitively)', () => {
  const body = JSON.stringify({ kind: 'parcel', orderRef: 'CSC-1042' });
  assert.equal(verifyShippingCallback(signedRequest({ body }), body, { env, now: NOW }), true);
  assert.equal(verifyShippingCallback(signedRequest({ body, brand: 'CSC' }), body, { env, now: NOW }), true);
});

test('a callback is refused if tampered, stale, from another brand, or signed with another secret', () => {
  const body = JSON.stringify({ kind: 'parcel', orderRef: 'CSC-1042' });
  assert.equal(verifyShippingCallback(signedRequest({ body }), body.replace('1042', '1043'), { env, now: NOW }), false, 'tampered');
  assert.equal(verifyShippingCallback(signedRequest({ body, ts: String(NOW / 1000 - 301) }), body, { env, now: NOW }), false, 'stale');
  assert.equal(verifyShippingCallback(signedRequest({ body, brand: 'pixel8' }), body, { env, now: NOW }), false, 'other brand');
  assert.equal(verifyShippingCallback(signedRequest({ body, secret: 'other' }), body, { env, now: NOW }), false, 'other secret');
  assert.equal(verifyShippingCallback(signedRequest({ body, sig: 'abc' }), body, { env, now: NOW }), false, 'short signature');
  assert.equal(verifyShippingCallback(signedRequest({ body, ts: 'nope' }), body, { env, now: NOW }), false, 'bad timestamp');
  assert.equal(verifyShippingCallback(signedRequest({ body }), body, { env: { ...env, SHIPPING_SECRET: '' }, now: NOW }), false, 'no secret configured');
});

test('the switches are off unless set to true', () => {
  assert.equal(shippingEnabled({}), false);
  assert.equal(shippingEnabled({ SHIPPING_ENABLED: '' }), false);
  assert.equal(shippingEnabled({ SHIPPING_ENABLED: 'false' }), false);
  assert.equal(shippingEnabled({ SHIPPING_ENABLED: 'true' }), true);
  assert.equal(shippingTestMode({}), false);
  assert.equal(shippingTestMode({ SHIPPING_TEST_MODE: 'TRUE' }), true);
});

test('prices are read as the service sends them: quotedPrice {amount, currency}, quote-return {price, currency}', () => {
  assert.equal(quotedPounds({ quotedPrice: { amount: 3.05, currency: 'GBP' } }), 3.05);
  assert.equal(quotedPounds({ quotedPrice: { amount: '4.2', currency: 'GBP' } }), 4.2);
  assert.equal(quotedPounds({ test: true, quotedPrice: { amount: 5.049, currency: 'GBP' } }), 5.05, 'to the penny');
  assert.equal(quotedPounds({ quotedPrice: { amount: 0, currency: 'GBP' } }), 0);
  assert.equal(quotedPounds({ quotedPrice: { amount: 3, currency: 'EUR' } }), null, 'never a euro figure as pounds');
  assert.equal(quotedPounds({ quotedPrice: null }), null);
  assert.equal(quotedPounds({}), null);
  assert.equal(quoteReturnPounds({ option: 'inpost_gb:l2l/size=s', price: 2.57, currency: 'GBP' }), 2.57);
  assert.equal(quoteReturnPounds({ price: null, currency: 'GBP' }), null);
  assert.equal(quoteReturnPounds(undefined), null);
});
