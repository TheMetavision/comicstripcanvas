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
 * Never throws. The payment is taken whatever this finds, so a failed lookup
 * costs the order its code and keeps the amount, which is on the event itself.
 */
export async function readDiscount(stripe, session) {
  const amountPence = session?.total_details?.amount_discount || 0;
  if (!amountPence) return { amountPence: 0, codes: [] };

  const codes = [];
  try {
    const full = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ['total_details.breakdown'],
    });
    for (const d of full?.total_details?.breakdown?.discounts || []) {
      const disc = d.discount || {};
      let code = null;
      const promo = disc.promotion_code;
      if (promo && typeof promo === 'object') code = promo.code;
      else if (typeof promo === 'string') {
        try {
          code = (await stripe.promotionCodes.retrieve(promo))?.code || null;
        } catch (err) {
          console.error(`discount: could not look up promotion code ${promo}:`, err.message);
        }
      }
      /* A coupon applied without a customer-facing code (from the Dashboard,
         say) still gets named, by the coupon's own name. */
      code = code || disc.coupon?.name || disc.coupon?.id || null;
      if (code && !codes.includes(code)) codes.push(code);
    }
  } catch (err) {
    console.error(`discount: could not read the discount breakdown for ${session.id}:`, err.message);
  }
  return { amountPence, codes };
}

/** "Discount (POW10)", or plain "Discount" when the code could not be read. */
export const discountLabel = (codes) =>
  (codes && codes.length ? `Discount (${codes.join(', ')})` : 'Discount');
