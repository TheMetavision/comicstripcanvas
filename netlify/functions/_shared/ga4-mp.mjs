/**
 * GA4 purchase, sent server-side through the Measurement Protocol.
 *
 * Called by webhook.mjs once an order is committed. The browser never sends
 * `purchase`: the confirmation page can be reloaded, and a Klarna payment
 * reaches it before the money has cleared. The webhook only gets here for a
 * paid session, and its idempotency guard stops a redelivery before this runs,
 * so each order is counted once.
 *
 * Consent: ga_client_id is on the session only if the visitor accepted
 * analytics (CartPanel asks gtag for it, and gtag only exists after "Accept
 * all"). No id, no send. The ads signals go as denied, matching the consent
 * default set in the browser.
 *
 * Never throws. Analytics must not fail an order: every outcome comes back as
 * { sent, skipped?, error? } and is only logged by the caller.
 */

export const GA_CLIENT_ID_RE = /^\d+\.\d+$/;
export const GA_SESSION_ID_RE = /^\d+$/;

const MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

const pounds = (pence) => Math.round(pence || 0) / 100;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * One GA4 item per Stripe line item (expanded with data.price.product).
 * price is the unit price actually charged, after any discount and before tax;
 * discount is the unit share of the discount.
 */
export function itemsFromLineItems(lineItems) {
  return (lineItems || []).map((li) => {
    const meta = li.price?.product?.metadata || {};
    const qty = li.quantity || 1;
    const subtotal = li.amount_subtotal ?? (li.price?.unit_amount || 0) * qty;
    const discount = li.amount_discount || 0;
    const item = {
      item_id: meta.slug || meta.productId || li.price?.product?.id || 'item',
      item_name: li.price?.product?.name || li.description || 'Item',
      item_variant: [meta.format, meta.size, meta.artworkStyle].filter(Boolean).join(' / ') || undefined,
      // Same categories as the browser's events (src/stores/cart.ts gaItem),
      // which cannot tell a customised build from a personalised one.
      item_category: meta.personalisationId ? 'personalised' : 'stock',
      ...(meta.buildKind ? { item_category2: meta.buildKind } : {}),
      price: round2(pounds(subtotal - discount) / qty),
      quantity: qty,
    };
    if (discount) item.discount = round2(pounds(discount) / qty);
    if (!item.item_variant) delete item.item_variant;
    return item;
  });
}

/** The Measurement Protocol body for a paid Checkout Session. */
export function buildPurchasePayload({ session, orderNumber, lineItems, clientId, sessionId }) {
  const shippingPence = session.shipping_cost?.amount_total ?? session.total_details?.amount_shipping ?? 0;
  const taxPence = session.total_details?.amount_tax || 0;
  return {
    client_id: clientId,
    consent: { ad_user_data: 'DENIED', ad_personalization: 'DENIED' },
    events: [{
      name: 'purchase',
      params: {
        transaction_id: orderNumber || session.id,
        currency: 'GBP',
        // What was charged for the goods: the total less postage.
        value: pounds((session.amount_total || 0) - shippingPence),
        shipping: pounds(shippingPence),
        tax: pounds(taxPence),
        items: itemsFromLineItems(lineItems),
        // session_id puts the purchase in the visit that made it, so GA4
        // credits that visit's source. Without it the purchase still counts.
        ...(sessionId && GA_SESSION_ID_RE.test(sessionId) ? { session_id: sessionId } : {}),
        engagement_time_msec: 1,
      },
    }],
  };
}

/**
 * Send the purchase. Skips (without sending) when the session is test mode,
 * carries no valid ga_client_id, or GA4_MEASUREMENT_ID / GA4_API_SECRET is
 * unset. Waits at most timeoutMs for Google.
 */
export async function sendPurchase({
  session, orderNumber, lineItems,
  env = process.env, fetch: http = globalThis.fetch, timeoutMs = 3000,
}) {
  try {
    const measurementId = env.GA4_MEASUREMENT_ID;
    const apiSecret = env.GA4_API_SECRET;
    if (!measurementId || !apiSecret) return { sent: false, skipped: 'not-configured' };
    if (session?.livemode !== true) return { sent: false, skipped: 'test-mode' };
    const clientId = session.metadata?.ga_client_id;
    if (!clientId || !GA_CLIENT_ID_RE.test(clientId)) return { sent: false, skipped: 'no-client-id' };

    const sessionId = session.metadata?.ga_session_id;
    const payload = buildPurchasePayload({ session, orderNumber, lineItems, clientId, sessionId });
    const url = `${MP_ENDPOINT}?measurement_id=${encodeURIComponent(measurementId)}`
      + `&api_secret=${encodeURIComponent(apiSecret)}`;
    const res = await http(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // MP answers 2xx even for a malformed hit; anything else is worth a line.
    if (!res.ok) return { sent: false, error: `HTTP ${res.status}` };
    return { sent: true, value: payload.events[0].params.value };
  } catch (err) {
    return { sent: false, error: err?.message || String(err) };
  }
}
