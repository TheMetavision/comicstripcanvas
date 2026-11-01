/**
 * Add or update a buyer in the MailerLite group "CSC - Customers" when their
 * order ships. Joining the group starts the post-delivery automation
 * (crm/archie-sequence-postdelivery-mailerlite-2026-10-13.md in the agent
 * workspace): arriving soon, did it land, then the day-21 referral email.
 *
 * Email 3 is marketing, so it must only go to buyers who did not refuse
 * marketing at checkout. A buyer who ticked the basket's opt-out box
 * (marketingConsent 'refused', or Stripe's old 'opt_out') is never added to
 * the group at all, so the automation never starts for them; marketing_ok
 * ("yes"/"no") stays as a second guard, and the automation sends Email 3 only
 * when marketing_ok = yes.
 *
 * MailerLite's POST /subscribers is an upsert. It never resubscribes someone
 * who unsubscribed, so a buyer who opted out of our emails stays opted out.
 *
 * Env: MAILERLITE_API_KEY (already set for the newsletter) and
 * MAILERLITE_CUSTOMERS_GROUP_ID (new: the id of "CSC - Customers").
 * Custom fields used: order_id, product, last_order_date (already in the
 * account) and is_personalised, referral_code, marketing_ok (added 13 Oct 2026).
 *
 * Never throws: returns { ok, skipped?, status?, error? } for the caller to log.
 */
import { fetchWithTimeout } from './timing.mjs';
import { setting } from './site-config.mjs';
import { marketingRefused } from './marketing-consent.mjs';

const ML = 'https://connect.mailerlite.com/api';

/** "Michael Myers", or "Michael Myers and 2 more" for a multi-item order. */
export function productTitleFor(lineItems) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const first = (items[0]?.productTitle || '').trim();
  if (!first) return 'your order';
  const more = items.length - 1;
  return more > 0 ? `${first} and ${more} more` : first;
}

/** The MailerLite subscriber body for one shipped order. */
export function customerPayload(order, { referralCode, groupId }) {
  const consent = order.marketingConsent;
  return {
    email: String(order.customerEmail || '').trim(),
    groups: [String(groupId)],
    fields: {
      name: String(order.customerName || '').split(' ')[0] || '',
      // order_id, product and last_order_date already existed in the account
      // (created with the Sept 2026 MailerLite set-up), so they are reused.
      order_id: order.orderNumber || '',
      product: productTitleFor(order.lineItems),
      last_order_date: String(order.paidAt || order.createdAt || '').slice(0, 10),
      is_personalised: order.isPersonalised ? 'yes' : 'no',
      referral_code: referralCode || '',
      // A refusal ('refused' from the basket box, or Stripe's old 'opt_out')
      // blocks the marketing email. 'opt_in', or not ticking the box
      // ('not_asked'), allows it under the UK soft opt-in for existing
      // customers; Email 3 has an unsubscribe.
      marketing_ok: marketingRefused(consent) ? 'no' : 'yes',
    },
  };
}

export async function addShippedCustomer(order, { referralCode } = {}, env = process.env, fetchFn = fetchWithTimeout) {
  if (marketingRefused(order?.marketingConsent)) return { ok: false, skipped: 'buyer refused marketing at checkout' };
  const apiKey = env.MAILERLITE_API_KEY;
  const groupId = setting('MAILERLITE_CUSTOMERS_GROUP_ID', env);
  if (!apiKey || !groupId) return { ok: false, skipped: 'MAILERLITE_API_KEY or MAILERLITE_CUSTOMERS_GROUP_ID not set' };
  const body = customerPayload(order, { referralCode, groupId });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return { ok: false, skipped: 'no valid email' };
  try {
    const res = await fetchFn(`${ML}/subscribers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    }, 4000);
    if (!res.ok) return { ok: false, status: res.status, error: await res.text().catch(() => '') };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
