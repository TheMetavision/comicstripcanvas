/**
 * Referral programme: "give 10%, get 10%" (Alan, 13 Oct 2026).
 *
 *   FRIEND side   Every buyer gets their own Stripe promotion code (PAL-XXXXXX)
 *                 when their first order ships. A friend who uses it gets 10%
 *                 off a first order. One code per buyer email, reused on later
 *                 orders.
 *   REFERRER side When a paid order used someone's PAL code, the webhook issues
 *                 the referrer a single-use 10% code (THANKS-XXXXXX) and emails
 *                 it to them.
 *
 * Coupons are created on first use with fixed ids, so there is nothing to set
 * up in the Stripe Dashboard. Promotion codes carry metadata.kind so the rest
 * of the code can tell them apart from POW10 (see isWelcomeCode in discount.mjs).
 *
 * Everything here is best-effort: a referral problem never blocks an order,
 * a shipping email or a payment. Callers log and carry on.
 */

export const FRIEND_COUPON_ID = 'csc-referral-friend-10';
export const REWARD_COUPON_ID = 'csc-referral-reward-10';
export const KIND_FRIEND = 'csc-referral';
export const KIND_REWARD = 'csc-referral-reward';

// No 0/O/1/I/L: codes get read out loud and typed off phones.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A random code body, e.g. "K7QM2X". `rand` is injectable for tests. */
export function codeBody(len = 6, rand = Math.random) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

/** Is this Stripe promotion code one of our friend (PAL) codes? */
export const isFriendCode = (promo) =>
  !!promo && typeof promo === 'object' && promo.metadata?.kind === KIND_FRIEND;

/** Is this Stripe promotion code a referrer's thank-you code? */
export const isRewardCode = (promo) =>
  !!promo && typeof promo === 'object' && promo.metadata?.kind === KIND_REWARD;

/** Create the coupon if it does not exist yet. Returns its id. */
export async function ensureCoupon(stripe, id, name) {
  try {
    await stripe.coupons.retrieve(id);
    return id;
  } catch (err) {
    if (err?.statusCode !== 404 && err?.code !== 'resource_missing') throw err;
  }
  try {
    await stripe.coupons.create({ id, name, percent_off: 10, duration: 'once' });
  } catch (err) {
    // Two deliveries racing to create it: the other one won, which is fine.
    if (err?.code !== 'resource_already_exists') throw err;
  }
  return id;
}

/** Create a promotion code, retrying on the (very unlikely) clash of a random code. */
async function createPromo(stripe, prefix, params, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const code = `${prefix}-${codeBody()}`;
    try {
      return await stripe.promotionCodes.create({ ...params, code });
    } catch (err) {
      lastErr = err;
      if (!/already exists/i.test(err?.message || '')) throw err;
    }
  }
  throw lastErr;
}

/**
 * The buyer's friend code: reuse one already recorded on an earlier order from
 * the same email (`existingCode`), otherwise create a new one.
 * Returns the code string.
 */
export async function friendCodeFor(stripe, { email, orderNumber, existingCode }) {
  if (existingCode) return existingCode;
  await ensureCoupon(stripe, FRIEND_COUPON_ID, 'Referral: friend 10% off first order');
  const promo = await createPromo(stripe, 'PAL', {
    coupon: FRIEND_COUPON_ID,
    restrictions: { first_time_transaction: true },
    metadata: { kind: KIND_FRIEND, referrer_email: String(email || '').toLowerCase(), referrer_order: orderNumber || '' },
  });
  return promo.code;
}

/** A single-use 10% thank-you code for the referrer. Returns the code string. */
export async function issueReward(stripe, { referrerEmail, referredOrder }) {
  await ensureCoupon(stripe, REWARD_COUPON_ID, 'Referral: thank-you 10% off next order');
  const promo = await createPromo(stripe, 'THANKS', {
    coupon: REWARD_COUPON_ID,
    max_redemptions: 1,
    metadata: { kind: KIND_REWARD, referrer_email: String(referrerEmail || '').toLowerCase(), referred_order: referredOrder || '' },
  });
  return promo.code;
}

/**
 * Pick out the friend codes used on a paid order, and whether each is a real
 * referral: not the buyer's own code, and the referrer email is known.
 * `promos` are expanded Stripe promotion code objects.
 */
export function referralsFrom(promos, buyerEmail) {
  const buyer = String(buyerEmail || '').trim().toLowerCase();
  return (promos || [])
    .filter(isFriendCode)
    .map((p) => ({
      code: p.code,
      referrerEmail: String(p.metadata?.referrer_email || '').toLowerCase(),
      referrerOrder: p.metadata?.referrer_order || '',
    }))
    .filter((r) => r.referrerEmail && r.referrerEmail !== buyer);
}

/* ── New customers only (Alan, 3 Nov 2026) ─────────────────────────────────
   The PAL coupon's first_time_transaction restriction is judged by Stripe per
   Customer, and checkout is a guest, so Stripe lets anyone use a PAL code:
   the code's owner, or a repeat buyer. The discount is still accepted (an
   accepted risk); the THANKS reward is not. checkReferral decides, and the
   referrer is rewarded only when
     a) the buyer is not the code's owner (emails trimmed, lower-cased), and
     b) there is no earlier paid order from the buyer's email in the order
        log. Every order in the log was paid (the webhook writes it on
        checkout.session.completed); this order, drafts, and an order
        cancelled or refunded before it was dispatched (no tracking number,
        no shipping email) do not count.
   Refused: no code, no email, referralError self_referral / repeat_customer,
   and a line on the team email (referralNote). A failed lookup is logged,
   skips the reward, records lookup_failed and is flagged on the team email;
   it never blocks the order or its emails. */

export const SELF_REFERRAL = 'self_referral';
export const REPEAT_CUSTOMER = 'repeat_customer';
export const LOOKUP_FAILED = 'lookup_failed';

/** An email as the referral checks compare it: trimmed, lower-cased. */
export const normEmail = (email) => String(email || '').trim().toLowerCase();

export const EARLIER_ORDER_QUERY =
  '*[_type == "order" && !(_id in path("drafts.**")) && _id != $docId && stripeSessionId != $sid' +
  ' && lower(customerEmail) == $email' +
  ' && !(status in ["cancelled", "refunded"] && !defined(trackingNumber) && shippingEmailSent != true)]' +
  ' | order(createdAt asc)[0]{ _id, orderNumber, createdAt }';

/**
 * Is the PAL code on this order (if any) entitled to a thank-you? Never throws.
 * @returns {Promise<null | { code, referrerEmail, referrerOrder, eligible: boolean, reason?, earlier?, error? }>}
 *   null when there is no friend code with a known referrer.
 */
export async function checkReferral({ sanity, promos, buyerEmail, docId, sessionId, log = console }) {
  const p = (promos || []).find((x) => isFriendCode(x) && normEmail(x.metadata?.referrer_email));
  if (!p) return null;
  const r = { code: p.code, referrerEmail: normEmail(p.metadata.referrer_email), referrerOrder: p.metadata.referrer_order || '' };
  const buyer = normEmail(buyerEmail);
  if (buyer && buyer === r.referrerEmail) return { ...r, eligible: false, reason: SELF_REFERRAL };
  try {
    if (!buyer) throw new Error('no buyer email on the checkout');
    if (!sanity || typeof sanity.fetch !== 'function') throw new Error('no Sanity client');
    const earlier = await sanity.fetch(EARLIER_ORDER_QUERY, { email: buyer, docId: docId || '', sid: sessionId || '' });
    if (earlier && earlier._id) return { ...r, eligible: false, reason: REPEAT_CUSTOMER, earlier };
    return { ...r, eligible: true };
  } catch (err) {
    const msg = err?.message || String(err);
    log.error(`referral: new-customer check for ${r.code} failed, no reward issued:`, msg);
    return { ...r, eligible: false, reason: LOOKUP_FAILED, error: msg };
  }
}

/** The team email's line for a refused or unchecked reward; '' otherwise. */
export function referralNote(check) {
  if (!check || check.eligible) return '';
  if (check.reason === SELF_REFERRAL) {
    return `Friend code ${check.code} used by an existing customer (the code's own owner) — no reward issued (self-referral).`;
  }
  if (check.reason === REPEAT_CUSTOMER) {
    const e = check.earlier || {};
    const ref = e.orderNumber || e._id || '';
    return `Friend code ${check.code} used by an existing customer${ref ? ` (earlier order ${ref})` : ''} — no reward issued (repeat customer).`;
  }
  return `Friend code ${check.code} used, but the new-customer check failed (${check.error || 'unknown error'}) — no reward issued. ` +
    `If this is a genuinely new customer, issue the referrer (${check.referrerEmail}) a thank-you code by hand.`;
}

/**
 * The reward step, given checkReferral's answer. Never throws.
 *   refused  -> referralError = the reason (lookup_failed with its error); nothing issued
 *   eligible -> THANKS code, referredBy on the order, sendRewardEmail(ref, rewardCode)
 * `flagOrderError(field, message)` and `sendRewardEmail` come from the webhook.
 * @returns {Promise<{ rewarded: boolean, rewardCode?, refused?, error? }>}
 */
export async function rewardReferrer({ stripe, sanity, check, orderId, orderNumber, sendRewardEmail, flagOrderError, log = console, issue = issueReward }) {
  if (!check) return { rewarded: false };
  if (!check.eligible) {
    log.warn(`referral: ${orderNumber}: ${check.code} — no reward (${check.reason})`);
    await flagOrderError('referralError',
      check.reason === LOOKUP_FAILED ? `${LOOKUP_FAILED} — ${String(check.error || '').slice(0, 300)}` : check.reason);
    return { rewarded: false, refused: check.reason };
  }
  try {
    const rewardCode = await issue(stripe, { referrerEmail: check.referrerEmail, referredOrder: orderNumber });
    await sanity.patch(orderId).set({
      referredBy: { code: check.code, referrerEmail: check.referrerEmail, referrerOrder: check.referrerOrder, rewardCode },
    }).commit();
    await sendRewardEmail(check, rewardCode);
    log.log(`Referral reward ${rewardCode} sent to ${check.referrerEmail} for ${orderNumber}`);
    return { rewarded: true, rewardCode };
  } catch (err) {
    log.error(`Referral reward for ${orderNumber} failed:`, err?.message || err);
    await flagOrderError('referralError', err?.message || String(err));
    return { rewarded: false, error: err?.message || String(err) };
  }
}
