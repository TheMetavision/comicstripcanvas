import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { optOutMetadata, consentFromSession, marketingRefused } from '../netlify/functions/_shared/marketing-consent.mjs';
import { addShippedCustomer, customerPayload } from '../netlify/functions/_shared/mailerlite-customer.mjs';
import { startPostDelivery } from '../netlify/functions/_shared/dispatch-email.mjs';

/* The basket's "Don't send me offers or referral emails" box, end to end:
   checkbox -> checkout request -> Stripe metadata -> order marketingConsent ->
   post-delivery (PAL- code, MailerLite "CSC - Customers" and its day-21 email). */

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
const quiet = { log() {}, error() {}, warn() {} };
const ML_ENV = { MAILERLITE_API_KEY: 'k', MAILERLITE_CUSTOMERS_GROUP_ID: '9' };

// ── 1. The checkbox ─────────────────────────────────────────────────────────

test('basket: an unticked, labelled opt-out checkbox sits directly above Checkout', () => {
  const src = code(read('../src/components/CartPanel.astro'));
  const box = src.match(/<input id="marketing-opt-out"[^>]*>/);
  assert.ok(box, 'checkbox exists');
  assert.match(box[0], /type="checkbox"/);
  assert.equal(/\schecked\b/.test(box[0]), false, 'not ticked by default');
  assert.match(src, /<label for="marketing-opt-out"[^>]*>\s*Don't send me offers or referral emails\s*<\/label>/);
  const boxAt = src.indexOf('id="marketing-opt-out"');
  const btnAt = src.indexOf('id="checkout-btn"');
  assert.ok(boxAt > 0 && boxAt < btnAt, 'before the Checkout button');
  assert.equal(/<(button|a|input)\b/.test(src.slice(boxAt + 1, src.lastIndexOf('<button', btnAt))), false, 'nothing else in between');
});

test('basket: the box is in the cart store and sent with the checkout request', () => {
  const panel = code(read('../src/components/CartPanel.astro'));
  assert.match(panel, /marketingOptOut\.set\(optOutBox\.checked\)/);
  assert.match(panel, /marketingOptOut:\s*optOutBox \? optOutBox\.checked : marketingOptOut\.get\(\)/);
  const store = code(read('../src/stores/cart.ts'));
  assert.match(store, /export const marketingOptOut = atom<boolean>/);
  assert.match(store, /sessionStorage/, 'remembered for the session');
});

test('every route to checkout goes through the basket drawer', () => {
  // The builders add to the cart and open the drawer; only CartPanel posts to /api/checkout.
  const builder = read('../src/scripts/product-builder.js');
  assert.equal(builder.includes('/api/checkout'), false);
  assert.ok(builder.includes('addToCart('));
});

// ── 2. Checkout stamps the metadata ─────────────────────────────────────────

test('optOutMetadata: only a literal true opts out', () => {
  assert.equal(optOutMetadata(true), 'true');
  for (const v of [false, undefined, null, 'true', 1, 'yes', {}]) assert.equal(optOutMetadata(v), 'false', String(v));
});

test('checkout.mjs always stamps marketing_opt_out from the request body', () => {
  const src = code(read('../netlify/functions/checkout.mjs'));
  assert.match(src, /const \{[^}]*\bmarketingOptOut\b[^}]*\} = await req\.json\(\)/);
  assert.match(src, /marketing_opt_out:\s*optOutMetadata\(marketingOptOut\)/);
  assert.equal(/consent_collection\s*:/.test(src), false);
});

// ── 3. Webhook records the consent ──────────────────────────────────────────

test('consentFromSession: refused, not_asked, and older Stripe values kept', () => {
  assert.equal(consentFromSession({ metadata: { marketing_opt_out: 'true' } }), 'refused');
  assert.equal(consentFromSession({ metadata: { marketing_opt_out: 'false' } }), 'not_asked');
  assert.equal(consentFromSession({ metadata: {} }), 'not_asked');
  assert.equal(consentFromSession({}), 'not_asked');
  assert.equal(consentFromSession({ consent: { promotions: 'opt_in' } }), 'opt_in');
  assert.equal(consentFromSession({ consent: { promotions: 'opt_out' } }), 'opt_out');
  assert.equal(consentFromSession({ metadata: { marketing_opt_out: 'TRUE' } }), 'not_asked');
});

test('webhook.mjs records marketingConsent through consentFromSession', () => {
  const src = code(read('../netlify/functions/webhook.mjs'));
  assert.match(src, /marketingConsent:\s*consentFromSession\(session\)/);
});

test('marketingRefused covers the new and the old refusal', () => {
  assert.equal(marketingRefused('refused'), true);
  assert.equal(marketingRefused('opt_out'), true);
  for (const v of ['not_asked', 'opt_in', undefined, '']) assert.equal(marketingRefused(v), false);
});

// ── 4. Marketing that hangs off the order respects 'refused' ─────────────────

const order = (marketingConsent) => ({
  _id: 'order.x', orderNumber: 'CSC-4001', customerEmail: 'jo@example.com', customerName: 'Jo Bloggs',
  lineItems: [{ productTitle: 'Chucky' }], ...(marketingConsent ? { marketingConsent } : {}),
});

test('MailerLite: a refused buyer is never posted to "CSC - Customers"', async () => {
  let calls = 0;
  const r = await addShippedCustomer(order('refused'), { referralCode: 'PAL-1' }, ML_ENV, async () => { calls++; return { ok: true, status: 200 }; });
  assert.equal(r.ok, false);
  assert.match(r.skipped, /refused/);
  assert.equal(calls, 0);
  assert.equal(customerPayload(order('refused'), { groupId: 9 }).fields.marketing_ok, 'no');
});

test('MailerLite: the default (not_asked) path is unchanged', async () => {
  let body;
  const r = await addShippedCustomer(order('not_asked'), { referralCode: 'PAL-1' }, ML_ENV,
    async (_url, init) => { body = JSON.parse(init.body); return { ok: true, status: 200 }; });
  assert.equal(r.ok, true);
  assert.deepEqual(body.groups, ['9']);
  assert.equal(body.fields.marketing_ok, 'yes');
  assert.equal(body.fields.referral_code, 'PAL-1');
});

function postDeliveryDeps() {
  const calls = { friendCode: 0, addCustomer: 0, patched: [] };
  const sanity = {
    fetch: async () => null,
    patch: (id) => ({ set: (v) => ({ commit: async () => { calls.patched.push({ id, ...v }); } }) }),
  };
  const deps = {
    stripeKey: 'sk_test_dummy',
    friendCode: async () => { calls.friendCode++; return 'PAL-NEW234'; },
    addCustomer: async (_o, { referralCode }) => { calls.addCustomer++; calls.referralCode = referralCode; return { ok: true }; },
  };
  return { calls, sanity, deps };
}

test('post-delivery: refused gets no PAL- code and no MailerLite (so no day-21 email)', async () => {
  const { calls, sanity, deps } = postDeliveryDeps();
  const r = await startPostDelivery(order('refused'), 'CSC-4001', { sanity, log: quiet }, deps);
  assert.deepEqual(r, { skipped: 'refused' });
  assert.equal(calls.friendCode, 0);
  assert.equal(calls.addCustomer, 0);
  assert.equal(calls.patched.length, 0, 'no referralCode written to the order');
});

test('post-delivery: an older Stripe opt_out is treated the same', async () => {
  const { calls, sanity, deps } = postDeliveryDeps();
  await startPostDelivery(order('opt_out'), 'CSC-4001', { sanity, log: quiet }, deps);
  assert.equal(calls.friendCode + calls.addCustomer, 0);
});

test('post-delivery: default path still mints the PAL- code and adds to MailerLite', async () => {
  for (const consent of ['not_asked', 'opt_in', undefined]) {
    const { calls, sanity, deps } = postDeliveryDeps();
    await startPostDelivery(order(consent), 'CSC-4001', { sanity, log: quiet }, deps);
    assert.equal(calls.friendCode, 1, String(consent));
    assert.equal(calls.addCustomer, 1, String(consent));
    assert.equal(calls.referralCode, 'PAL-NEW234');
    assert.deepEqual(calls.patched, [{ id: 'order.x', referralCode: 'PAL-NEW234' }]);
  }
});

// ── Full chain ──────────────────────────────────────────────────────────────

test('chain: ticked box -> metadata -> refused -> nothing marketing; unticked -> all as before', async () => {
  for (const [ticked, expected] of [[true, 'refused'], [false, 'not_asked']]) {
    const session = { metadata: { marketing_opt_out: optOutMetadata(ticked) } };
    const consent = consentFromSession(session);
    assert.equal(consent, expected);
    const { calls, sanity, deps } = postDeliveryDeps();
    await startPostDelivery(order(consent), 'CSC-4001', { sanity, log: quiet }, deps);
    assert.equal(calls.friendCode, ticked ? 0 : 1);
    assert.equal(calls.addCustomer, ticked ? 0 : 1);
  }
});
