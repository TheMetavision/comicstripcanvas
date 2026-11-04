/**
 * The handler-test Stripe stub, plus coupons and promotion-code creation, so
 * the webhook's referral reward (and its email) can run.
 */
import * as base from '../../tools/builder/_stubs/stripe.mjs';

export * from '../../tools/builder/_stubs/stripe.mjs';

export class Stripe extends base.Stripe {
  /* The base stub's line items carry no name or price, so every email line
     would read "£0.00". Filled in from the stored session. */
  get checkout() {
    const parent = super.checkout;
    const listLineItems = async (id, opts) => {
      const res = await parent.sessions.listLineItems(id, opts);
      const s = base.sessions.find((x) => x.id === id);
      res.data.forEach((li, i) => {
        const pd = s?.line_items?.[i]?.price_data;
        if (!pd) return;
        li.price = { ...li.price, unit_amount: pd.unit_amount, product: { ...li.price.product, name: pd.product_data.name } };
      });
      return res;
    };
    return { sessions: { ...parent.sessions, listLineItems } };
  }

  get coupons() {
    return { retrieve: async (id) => ({ id }), create: async (params) => params };
  }

  get promotionCodes() {
    const parent = super.promotionCodes;
    return { ...parent, create: async (params) => ({ id: `promo_${params.code}`, ...params }) };
  }
}

export default Stripe;
