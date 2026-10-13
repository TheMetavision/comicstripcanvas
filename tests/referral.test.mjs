import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeBody, referralsFrom, isFriendCode, friendCodeFor, issueReward, KIND_FRIEND, KIND_REWARD, FRIEND_COUPON_ID } from '../netlify/functions/_shared/referral.mjs';
import { isWelcomeCode, readDiscount } from '../netlify/functions/_shared/discount.mjs';
import { customerPayload, productTitleFor, addShippedCustomer } from '../netlify/functions/_shared/mailerlite-customer.mjs';

test('codeBody uses the unambiguous alphabet and requested length', () => {
  const c = codeBody(8);
  assert.equal(c.length, 8);
  assert.match(c, /^[A-HJKMNP-Z2-9]+$/);
});

test('referral codes are not mistaken for the POW10 welcome code', () => {
  const friend = { code: 'PAL-K7QM2X', restrictions: { first_time_transaction: true }, metadata: { kind: KIND_FRIEND } };
  const reward = { code: 'THANKS-ABC234', restrictions: {}, metadata: { kind: KIND_REWARD } };
  assert.equal(isWelcomeCode(friend), false);
  assert.equal(isWelcomeCode(reward), false);
  assert.equal(isWelcomeCode({ code: 'POW10', restrictions: {} }), true);
  assert.equal(isFriendCode(friend), true);
});

test('referralsFrom ignores self-referral and non-referral codes', () => {
  const promos = [
    { code: 'PAL-AAAAAA', metadata: { kind: KIND_FRIEND, referrer_email: 'ann@example.com', referrer_order: 'CSC-1010' } },
    { code: 'PAL-BBBBBB', metadata: { kind: KIND_FRIEND, referrer_email: 'buyer@example.com' } },
    { code: 'POW10', metadata: {} },
  ];
  const r = referralsFrom(promos, 'Buyer@Example.com');
  assert.deepEqual(r, [{ code: 'PAL-AAAAAA', referrerEmail: 'ann@example.com', referrerOrder: 'CSC-1010' }]);
});

function fakeStripe() {
  const created = { coupons: [], promos: [] };
  return {
    created,
    coupons: {
      retrieve: async (id) => { if (!created.coupons.find((c) => c.id === id)) { const e = new Error('No such coupon'); e.statusCode = 404; throw e; } return { id }; },
      create: async (c) => { created.coupons.push(c); return c; },
    },
    promotionCodes: { create: async (p) => { created.promos.push(p); return p; } },
  };
}

test('friendCodeFor reuses an existing code, otherwise creates coupon + first-order PAL code', async () => {
  const s = fakeStripe();
  assert.equal(await friendCodeFor(s, { email: 'a@b.co', existingCode: 'PAL-EXIST1' }), 'PAL-EXIST1');
  assert.equal(s.created.promos.length, 0);
  const code = await friendCodeFor(s, { email: 'A@B.co', orderNumber: 'CSC-1011' });
  assert.match(code, /^PAL-[A-Z2-9]{6}$/);
  assert.equal(s.created.coupons[0].id, FRIEND_COUPON_ID);
  assert.equal(s.created.coupons[0].percent_off, 10);
  const p = s.created.promos[0];
  assert.equal(p.restrictions.first_time_transaction, true);
  assert.equal(p.metadata.referrer_email, 'a@b.co');
});

test('issueReward creates a single-use THANKS code', async () => {
  const s = fakeStripe();
  const code = await issueReward(s, { referrerEmail: 'ann@example.com', referredOrder: 'CSC-1012' });
  assert.match(code, /^THANKS-/);
  assert.equal(s.created.promos[0].max_redemptions, 1);
});

test('readDiscount returns the expanded promos', async () => {
  const promo = { code: 'PAL-AAAAAA', metadata: { kind: KIND_FRIEND, referrer_email: 'ann@example.com' }, restrictions: { first_time_transaction: true } };
  const stripe = { checkout: { sessions: { retrieve: async () => ({ total_details: { breakdown: { discounts: [{ discount: { promotion_code: promo } }] } } }) } } };
  const d = await readDiscount(stripe, { id: 'cs_1', total_details: { amount_discount: 300 } });
  assert.deepEqual(d.codes, ['PAL-AAAAAA']);
  assert.deepEqual(d.welcomeCodes, []);
  assert.equal(d.promos.length, 1);
});

test('MailerLite payload: fields, first name, consent', () => {
  const order = { customerEmail: ' x@y.co ', customerName: 'Jo Bloggs', orderNumber: 'CSC-1013', isPersonalised: true,
    lineItems: [{ productTitle: 'Michael Myers' }, { productTitle: 'Chucky' }], marketingConsent: 'opt_out' };
  const b = customerPayload(order, { referralCode: 'PAL-XYZ234', groupId: 123 });
  assert.equal(b.email, 'x@y.co');
  assert.deepEqual(b.groups, ['123']);
  assert.equal(b.fields.name, 'Jo');
  assert.equal(b.fields.product, 'Michael Myers and 1 more');
  assert.equal(b.fields.is_personalised, 'yes');
  assert.equal(b.fields.marketing_ok, 'no');
  assert.equal(customerPayload({ ...order, marketingConsent: 'opt_in' }, {}).fields.marketing_ok, 'yes');
  assert.equal(productTitleFor([]), 'your order');
});

test('addShippedCustomer skips without config and posts with it', async () => {
  const order = { customerEmail: 'x@y.co', lineItems: [] };
  assert.equal((await addShippedCustomer(order, {}, {})).ok, false);
  let seen;
  const r = await addShippedCustomer(order, { referralCode: 'PAL-1' }, { MAILERLITE_API_KEY: 'k', MAILERLITE_CUSTOMERS_GROUP_ID: '9' },
    async (url, init) => { seen = { url, init }; return { ok: true, status: 200 }; });
  assert.equal(r.ok, true);
  assert.match(seen.url, /\/subscribers$/);
  assert.equal(JSON.parse(seen.init.body).fields.referral_code, 'PAL-1');
});
