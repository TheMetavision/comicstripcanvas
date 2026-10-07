/**
 * The discount on a paid Checkout Session: how much, and which code.
 *
 * checkout.mjs lets the customer enter a promotion code on Stripe's page
 * (allow_promotion_codes), so the basket never knows about it. The amount is
 * always on the session (total_details.amount_discount); the CODE is not, and
 * needs the breakdown expanded and the promotion code looked up. Shipping is a
 * shipping_options rate, which coupons do not touch, so the discount is goods
 * only and the order's lines still read at the price they were sold at.
 *
 * `welcomeCodes` are the codes among them that are the newsletter's welcome
 * offer (see isWelcomeCode), for the webhook's repeat-customer check.
 *
 * Never throws. The payment is taken whatever this finds, so a failed lookup
 * costs the order its code and keeps the amount, which is on the event itself.
 */
export async function readDiscount(stripe, session) {
  const amountPence = session?.total_details?.amount_discount || 0;
  if (!amountPence) return { amountPence: 0, codes: [], welcomeCodes: [] };

  const codes = [];
  const welcomeCodes = [];
  try {
    const full = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['total_details.breakdown'],
    });
    for (const d of full?.total_details?.breakdown?.discounts || []) {
      const disc = d.discount || {};
      let promo = disc.promotion_code;
      if (typeof promo === 'string') {
        try {
          promo = await stripe.promotionCodes.retrieve(promo);
        } catch (err) {
          console.error(`discount: could not look up promotion code ${promo}:`, err.message);
          promo = null;
        }
      }
      let code = (promo && typeof promo === 'object' && promo.code) || null;
      /* A coupon applied without a customer-facing code (from the Dashboard,
         say) still gets named, by the coupon's own name. */
      code = code || disc.coupon?.name || disc.coupon?.id || null;
      if (code && !codes.includes(code)) codes.push(code);
      if (code && isWelcomeCode(promo) && !welcomeCodes.includes(code)) welcomeCodes.push(code);
    }
  } catch (err) {
    console.error(`discount: could not read the discount breakdown for ${session.id}:`, err.message);
  }
  return { amountPence, codes, welcomeCodes };
}

/** "Discount (POW10)", or plain "Discount" when the code could not be read. */
export const discountLabel = (codes) =>
  (codes && codes.length ? `Discount (${codes.join(', ')})` : 'Discount');

/**
 * The welcome offer from the newsletter (POW10), meant for a first order.
 * Recognised by the promotion code's own "first-time order only"
 * restriction, so a future welcome code needs no change here; WELCOME_CODES
 * is the fallback for one created without it. Stripe cannot enforce
 * first-time on CSC's checkout (a guest session has no Customer), so the
 * webhook flags repeats instead.
 */
export const WELCOME_CODES = ['POW10'];
export function isWelcomeCode(promo) {
  if (!promo || typeof promo !== 'object') return false;
  return promo.restrictions?.first_time_transaction === true
    || WELCOME_CODES.includes(String(promo.code || '').toUpperCase());
}

/** The note stored on an order when a welcome code was used by an email that has ordered before. */
export const repeatWelcomeNote = (codes, earlier) =>
  `${codes.join(', ')} is a first-order welcome code, and this email already has a paid order ` +
  `(${earlier.orderNumber || earlier._id}${earlier.createdAt ? `, ${String(earlier.createdAt).slice(0, 10)}` : ''}). ` +
  'Stripe cannot refuse it on a guest checkout. The order stands; decide whether to follow up.';
