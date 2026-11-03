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

/* ── New customers only ─────────────────────────────────────────────────── */

import { checkReferral, referralNote, rewardReferrer, normEmail, EARLIER_ORDER_QUERY, SELF_REFERRAL, REPEAT_CUSTOMER, LOOKUP_FAILED } from '../netlify/functions/_shared/referral.mjs';
import { readFileSync } from 'node:fs';

const quiet = { log() {}, warn() {}, error() {} };
const ORDER = 'order.cs_live_now';
const SID = 'cs_live_now';
const pal = (over = {}) => ({ code: 'PAL-AAAAAA', metadata: { kind: KIND_FRIEND, referrer_email: 'contact@themetavision.co.uk', referrer_order: 'CSC-1010' }, ...over });

/** A Sanity stand-in: answers EARLIER_ORDER_QUERY over `docs`, records patches. */
function fakeSanity(docs = [], { fail } = {}) {
  const patches = [];
  return {
    patches, seen: [],
    async fetch(q, p) {
      this.seen.push(p);
      if (fail) throw new Error(fail);
      assert.equal(q, EARLIER_ORDER_QUERY);
      return docs
        .filter((d) => !d._id.startsWith('drafts.') && d._id !== p.docId && d.stripeSessionId !== p.sid)
        .filter((d) => String(d.customerEmail || '').toLowerCase() === p.email)
        .filter((d) => !(['cancelled', 'refunded'].includes(d.status) && !d.trackingNumber && d.shippingEmailSent !== true))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
    },
    patch(id) { return { set(v) { return { commit: async () => { patches.push({ id, ...v }); } }; } }; },
  };
}

/** Runs the reward step the way webhook.mjs does; returns what happened. */
async function runReward({ buyerEmail, docs = [], fail, promos = [pal()] }) {
  const sanity = fakeSanity(docs, { fail });
  const s = fakeStripe();
  const flags = {};
  const sent = [];
  const check = await checkReferral({ sanity, promos, buyerEmail, docId: ORDER, sessionId: SID, log: quiet });
  const result = await rewardReferrer({
    stripe: s, sanity, check, orderId: ORDER, orderNumber: 'CSC-2000', log: quiet,
    flagOrderError: async (f, m) => { flags[f] = m; },
    sendRewardEmail: async (ref, code) => { sent.push({ to: ref.referrerEmail, code }); },
  });
  return { check, result, flags, sent, sanity, stripe: s, note: referralNote(check) };
}

const earlier = (over = {}) => ({ _id: 'order.cs_live_old', stripeSessionId: 'cs_live_old', orderNumber: 'CSC-1500', createdAt: '2026-10-01T10:00:00Z', customerEmail: 'hello@themetavision.co.uk', status: 'delivered', ...over });

test('new customers only: a new customer on a PAL code -> THANKS code issued, recorded and emailed', async () => {
  const r = await runReward({ buyerEmail: 'hello@themetavision.co.uk' });
  assert.equal(r.result.rewarded, true);
  assert.match(r.result.rewardCode, /^THANKS-/);
  assert.deepEqual(r.sent, [{ to: 'contact@themetavision.co.uk', code: r.result.rewardCode }]);
  assert.equal(r.sanity.patches[0].referredBy.rewardCode, r.result.rewardCode);
  assert.deepEqual(r.flags, {});
  assert.equal(r.note, '');
});

test('new customers only: the code owner on their own code -> no reward, referralError self_referral, team line', async () => {
  const r = await runReward({ buyerEmail: 'contact@themetavision.co.uk' });
  assert.deepEqual(r.result, { rewarded: false, refused: SELF_REFERRAL });
  assert.equal(r.stripe.created.promos.length, 0);
  assert.equal(r.sent.length, 0);
  assert.equal(r.sanity.patches.length, 0);
  assert.deepEqual(r.flags, { referralError: 'self_referral' });
  assert.equal(r.note, 'Friend code PAL-AAAAAA used by an existing customer (the code\'s own owner) — no reward issued (self-referral).');
});

test('new customers only: a repeat buyer on a PAL code -> no reward, referralError repeat_customer, team line', async () => {
  const r = await runReward({ buyerEmail: 'hello@themetavision.co.uk', docs: [earlier()] });
  assert.deepEqual(r.result, { rewarded: false, refused: REPEAT_CUSTOMER });
  assert.equal(r.stripe.created.promos.length + r.sent.length, 0);
  assert.deepEqual(r.flags, { referralError: 'repeat_customer' });
  assert.equal(r.note, 'Friend code PAL-AAAAAA used by an existing customer (earlier order CSC-1500) — no reward issued (repeat customer).');
});

test('new customers only: this order, drafts and orders cancelled/refunded before dispatch are not earlier orders', async () => {
  const docs = [
    earlier({ _id: ORDER, stripeSessionId: SID }),
    earlier({ _id: 'drafts.order.cs_live_old' }),
    earlier({ _id: 'order.c', stripeSessionId: 'c', status: 'cancelled' }),
    earlier({ _id: 'order.r', stripeSessionId: 'r', status: 'refunded', shippingEmailSent: false }),
  ];
  assert.equal((await runReward({ buyerEmail: 'hello@themetavision.co.uk', docs })).result.rewarded, true);
  // Refunded after it was dispatched: still a customer.
  const shipped = await runReward({ buyerEmail: 'hello@themetavision.co.uk', docs: [earlier({ status: 'refunded', trackingNumber: 'RM1' })] });
  assert.equal(shipped.result.refused, REPEAT_CUSTOMER);
});

test('new customers only: email case and whitespace are the same email', async () => {
  assert.equal(normEmail(' Contact@TheMetavision.co.uk '), 'contact@themetavision.co.uk');
  const self = await runReward({ buyerEmail: ' Contact@TheMetavision.co.uk ' });
  assert.equal(self.result.refused, SELF_REFERRAL);
  const self2 = await runReward({ buyerEmail: 'contact@themetavision.co.uk', promos: [pal({ metadata: { ...pal().metadata, referrer_email: ' CONTACT@themetavision.co.uk' } })] });
  assert.equal(self2.result.refused, SELF_REFERRAL);
  const repeat = await runReward({ buyerEmail: '  HELLO@TheMetavision.co.uk', docs: [earlier({ customerEmail: 'Hello@TheMetavision.co.uk' })] });
  assert.equal(repeat.result.refused, REPEAT_CUSTOMER);
  assert.equal(repeat.sanity.seen[0].email, 'hello@themetavision.co.uk');
  assert.match(EARLIER_ORDER_QUERY, /lower\(customerEmail\) == \$email/);
});

test('new customers only: a failed Sanity lookup -> no reward, logged and flagged, never thrown', async () => {
  const r = await runReward({ buyerEmail: 'hello@themetavision.co.uk', fail: 'Sanity is down' });
  assert.deepEqual(r.result, { rewarded: false, refused: LOOKUP_FAILED });
  assert.equal(r.stripe.created.promos.length + r.sent.length, 0);
  assert.match(r.flags.referralError, /^lookup_failed — Sanity is down/);
  assert.match(r.note, /PAL-AAAAAA used, but the new-customer check failed \(Sanity is down\) — no reward issued.*contact@themetavision\.co\.uk/);
});

test('new customers only: no PAL code, or one without a referrer, does nothing', async () => {
  for (const promos of [[], [{ code: 'POW10', metadata: {} }], [pal({ metadata: { kind: KIND_FRIEND } })]]) {
    const r = await runReward({ buyerEmail: 'hello@themetavision.co.uk', promos });
    assert.equal(r.check, null);
    assert.deepEqual(r.result, { rewarded: false });
    assert.deepEqual(r.flags, {});
  }
});

test('webhook.mjs: the check runs before the team email, which carries the line; the old referralsFrom path is gone', () => {
  const src = readFileSync(new URL('../netlify/functions/webhook.mjs', import.meta.url), 'utf8');
  const check = src.indexOf('await checkReferral({ sanity, promos: discount.promos, buyerEmail: customerEmail, docId: orderId, sessionId: session.id })');
  const team = src.indexOf("const teamEmail = setting('TEAM_EMAIL');");
  assert.ok(check > 0 && team > check, 'the check comes before the team email');
  assert.match(src.slice(team), /\$\{referralCheckNote \? `<div[^`]*⚠ Friend code, no reward/);
  assert.doesNotMatch(src, /referralsFrom\(/);
  assert.match(src, /rewardReferrer\(\{\s*stripe, sanity, check: referral, orderId, orderNumber, flagOrderError,/);
});
