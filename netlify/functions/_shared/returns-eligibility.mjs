/**
 * What a customer may send back for a change of mind, per the refund policy
 * (src/pages/refund-policy.astro, September 2026). Pure: the order and any
 * earlier return requests go in, a verdict per line comes out.
 *
 *   "you have 14 days from the day you receive it to change your mind"
 *     -> the window ends at the end of the 14th day after delivery, UK time.
 *        Delivery is shipment.deliveredAt, which only Sendcloud-tracked orders
 *        have. Without it the request is ALLOWED and marked "delivery date
 *        unknown" for Alan to judge -- refusing would deny someone who is
 *        entitled, and measuring from dispatch is stricter than the policy.
 *   "does not apply to personalised items or to designs made through
 *    'Customise this design'"
 *     -> any line with a buildKind, and every line of a legacy personalised
 *        order, is excluded. Faulty or wrong items are NOT handled here: the
 *        policy says to contact us first, and Alan raises a free-label return
 *        from the order in the Studio.
 *   An order not yet dispatched is a cancellation, not a return.
 */
import { isNonPhysical } from './parcel-bands.mjs';

export const RETURN_WINDOW_DAYS = 14;

export const REASONS = {
  changed_mind: 'Changed my mind',
  doesnt_suit: "Doesn't suit the room",
  wrong_choice: 'Ordered the wrong size or format',
  other: 'Other',
};

const LONDON = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The UK calendar date of an instant, as YYYY-MM-DD. */
export const londonDate = (t) => LONDON.format(new Date(t));

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** The last day a change of mind can be raised, YYYY-MM-DD. */
export const windowEndsOn = (deliveredAt) => addDays(londonDate(deliveredAt), RETURN_WINDOW_DAYS);

/** '2026-11-12' -> '12 November 2026' */
export const longDate = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export const EXCLUDED_BUILT = "Personalised and customised items are made to your specification, so they can't be returned for a change of mind. If it arrived faulty, damaged or not as described, please contact us.";

/**
 * @param {object} order       the order document
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {object[]} [opts.existing]  this order's earlier return requests
 * @returns {{ eligible: boolean, reason: string|null, deliveredAt: string|null,
 *   deliveryDateUnknown: boolean, windowEndsOn: string|null, lines: object[] }}
 *   lines[].returnable is how many of that line may be sent back now (0 = none,
 *   with lines[].why saying why).
 */
export function evaluateReturn(order, { now = Date.now(), existing = [] } = {}) {
  const out = { eligible: false, reason: null, deliveredAt: null, deliveryDateUnknown: false, windowEndsOn: null, lines: [] };
  if (!order) { out.reason = 'Order not found.'; return out; }

  if (order.status === 'cancelled' || order.status === 'refunded') {
    out.reason = 'This order has been cancelled or refunded, so there is nothing to return.';
  } else {
    const dispatched = Boolean(order.shipment?.dispatchedAt || order.shippingEmailSentAt)
      || order.status === 'dispatched' || order.status === 'delivered';
    if (!dispatched) {
      out.reason = "This order hasn't been dispatched yet. If you'd like to cancel it, please contact us with your order number.";
    }
  }

  const deliveredAt = order.shipment?.deliveredAt || null;
  if (deliveredAt) {
    out.deliveredAt = deliveredAt;
    out.windowEndsOn = windowEndsOn(deliveredAt);
    if (!out.reason && londonDate(now) > out.windowEndsOn) {
      out.reason = `The 14-day period to change your mind ended on ${longDate(out.windowEndsOn)}. If your item is faulty, please contact us.`;
    }
  } else {
    out.deliveryDateUnknown = true;
  }

  const requested = new Map();
  for (const r of existing || []) {
    if (!r || r.status === 'rejected') continue;
    for (const l of r.lines || []) requested.set(l.lineKey, (requested.get(l.lineKey) || 0) + (Number(l.quantity) || 0));
  }

  const legacyPersonalised = Boolean(order.personalisationDetails);
  for (const line of order.lineItems || []) {
    if (isNonPhysical(line)) continue;
    const ordered = Math.max(1, Math.floor(Number(line.quantity) || 1));
    const row = {
      lineKey: line._key,
      productTitle: line.productTitle || 'Item',
      format: line.format || '',
      size: line.size || '',
      formatKey: line.formatKey,
      sizeKey: line.sizeKey,
      unitPrice: Number(line.unitPrice) || 0,
      ordered,
      returnable: 0,
      why: null,
    };
    if (line.buildKind || legacyPersonalised) {
      row.why = EXCLUDED_BUILT;
    } else if (out.reason) {
      row.why = out.reason;
    } else {
      const left = ordered - (requested.get(line._key) || 0);
      if (left <= 0) row.why = 'Already in a return request.';
      else row.returnable = left;
    }
    out.lines.push(row);
  }

  out.eligible = !out.reason && out.lines.some((l) => l.returnable > 0);
  if (!out.reason && !out.eligible) {
    out.reason = out.lines.length
      ? 'Nothing on this order can be returned for a change of mind.'
      : 'This order has nothing that can be returned.';
  }
  return out;
}

/**
 * Check what the customer picked against the verdict. Returns the lines to
 * put on the request, or { error }.
 */
export function pickLines(verdict, picked) {
  if (!verdict.eligible) return { error: verdict.reason || 'Nothing can be returned.' };
  if (!Array.isArray(picked) || !picked.length) return { error: 'Choose at least one item to return.' };
  const byKey = new Map(verdict.lines.map((l) => [l.lineKey, l]));
  const lines = [];
  const seen = new Set();
  for (const p of picked) {
    const l = byKey.get(p?.lineKey);
    if (!l || seen.has(p.lineKey)) return { error: 'One of the chosen items is not on this order.' };
    seen.add(p.lineKey);
    const q = Math.floor(Number(p.quantity) || 0);
    if (q < 1) continue;
    if (l.returnable < 1) return { error: `"${l.productTitle}" can't be returned: ${l.why}` };
    if (q > l.returnable) return { error: `You can return at most ${l.returnable} of "${l.productTitle}".` };
    lines.push({
      _key: l.lineKey, _type: 'returnLine', lineKey: l.lineKey, productTitle: l.productTitle,
      format: l.format, size: l.size, formatKey: l.formatKey, sizeKey: l.sizeKey,
      quantity: q, unitPrice: l.unitPrice,
    });
  }
  if (!lines.length) return { error: 'Choose at least one item to return.' };
  return { lines };
}
