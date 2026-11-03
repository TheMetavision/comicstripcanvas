// Stripe test-mode orders (fix/test-order-safety, 3 Nov 2026). webhook.mjs
// builds its clients at load, so the wiring is checked in the source; the
// labels themselves are in shipping-dispatch / shipping-returns tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { testOrderFlag, shippingRequest } from '../netlify/functions/_shared/shipping-client.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('testOrderFlag: { test: true } only for an order with test === true', () => {
  assert.deepEqual(testOrderFlag({ test: true }), { test: true });
  for (const o of [{}, { test: false }, { test: 'true' }, null, undefined]) assert.deepEqual(testOrderFlag(o), {});
});

test('shippingRequest: a test order\'s flag reaches the service with SHIPPING_TEST_MODE off; a live body stays live', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const env = { SHIPPING_SECRET: 'sek' };
  await shippingRequest('create-parcel', { body: { orderRef: 'A', ...testOrderFlag({ test: true }) }, env, fetchImpl });
  await shippingRequest('create-parcel', { body: { orderRef: 'B', ...testOrderFlag({}) }, env, fetchImpl });
  assert.equal(sent[0].test, true);
  assert.equal('test' in sent[1], false);
});

test('webhook.mjs: a test-mode session is saved with test: true, and its team email is [TEST]', () => {
  const src = code(read('../netlify/functions/webhook.mjs'));
  const doc = src.slice(src.indexOf('const orderDoc = {'), src.indexOf('const orderDoc = {') + 600);
  assert.match(doc, /\.\.\.\(session\.livemode === false \? \{ test: true \} : \{\}\),/);
  const team = src.slice(src.indexOf("const teamEmail = setting('TEAM_EMAIL');"));
  assert.match(team, /subject: `\$\{session\.livemode === false \? '\[TEST\] ' : ''\}/);
});

test('Studio: the order shows a read-only "Test order" field, hidden on live orders', () => {
  const schema = read('../studio/schemas/order.ts');
  const at = schema.indexOf("name: 'test'");
  assert.ok(at > 0);
  const field = schema.slice(at, at + 300);
  assert.match(field, /title: 'Test order \(Stripe test mode\)'/);
  assert.match(field, /readOnly: true/);
  assert.match(field, /hidden: \(\{ value \}\) => !value/);
});
