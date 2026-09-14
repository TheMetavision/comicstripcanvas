/**
 * Enough of the stripe SDK to run the handlers.
 *
 * Sessions and their line items are kept, so a test can read back exactly what
 * would have been charged rather than trusting a 200. `new Stripe()` throws
 * without a key here too, because the handlers memoise a client only when the
 * key is present and that branch is worth exercising.
 */

export const sessions = [];
export const events = [];
export const failures = { create: false, constructEvent: false };

export function reset() {
  sessions.length = 0;
  events.length = 0;
  failures.create = false;
  failures.constructEvent = false;
}

/** The last session created, which is what a checkout test wants to inspect. */
export const lastSession = () => sessions[sessions.length - 1] || null;

/** One line's charge in pence, and what Stripe was told about it. */
export const linesOf = (session) => (session?.line_items || []).map((l) => ({
  name: l.price_data.product_data.name,
  description: l.price_data.product_data.description,
  images: l.price_data.product_data.images || [],
  metadata: l.price_data.product_data.metadata || {},
  unitPence: l.price_data.unit_amount,
  quantity: l.quantity,
  totalPence: l.price_data.unit_amount * l.quantity,
}));

export class Stripe {
  constructor(key, opts) {
    if (!key) throw new Error('stub: Stripe was constructed with no key');
    this.key = key;
    this.opts = opts;
  }

  get checkout() {
    return {
      sessions: {
        create: async (params) => {
          if (failures.create) throw new Error('stub: Stripe refused the session');
          const id = `cs_test_${sessions.length + 1}`;
          const session = { id, url: `https://checkout.stripe.test/${id}`, ...params };
          sessions.push(session);
          return session;
        },
        retrieve: async (id) => {
          const s = sessions.find((x) => x.id === id);
          if (!s) throw new Error(`stub: no session ${id}`);
          return s;
        },
        listLineItems: async (id) => {
          const s = sessions.find((x) => x.id === id);
          if (!s) throw new Error(`stub: no session ${id}`);
          return {
            data: (s.line_items || []).map((l, i) => ({
              id: `li_${i}`,
              amount_total: l.price_data.unit_amount * l.quantity,
              quantity: l.quantity,
              description: l.price_data.product_data.name,
              price: { product: { metadata: l.price_data.product_data.metadata || {} } },
            })),
          };
        },
      },
    };
  }

  get webhooks() {
    return {
      constructEvent: (body, sig, secret) => {
        if (failures.constructEvent) throw new Error('stub: bad signature');
        if (!secret) throw new Error('stub: no webhook secret');
        if (sig !== 'good-signature') throw new Error('stub: bad signature');
        const parsed = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
        events.push(parsed);
        return parsed;
      },
    };
  }
}

export default Stripe;
