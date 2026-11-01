/**
 * Marketing consent for an order.
 *
 * Stripe's own marketing checkbox (consent_collection.promotions) is refused
 * for UK accounts, so since 13 Oct 2026 every order relies on the UK soft
 * opt-in for existing customers. That needs a simple way to refuse at the
 * point of collection: the basket's unticked "Don't send me offers or
 * referral emails" box. The basket sends `marketingOptOut`, checkout.mjs
 * stamps it onto the Stripe session as metadata.marketing_opt_out, and the
 * webhook turns that into the order's marketingConsent.
 *
 * Values on an order:
 *   'refused'    ticked the basket box (new orders)
 *   'not_asked'  did not tick it, or no box at all (soft opt-in applies)
 *   'opt_in' / 'opt_out'  Stripe's old checkbox, on orders before 13 Oct 2026
 */

/** checkout.mjs: the metadata value. Only a literal `true` counts as opting out. */
export function optOutMetadata(marketingOptOut) {
  return marketingOptOut === true ? 'true' : 'false';
}

/** webhook.mjs: the marketingConsent to record for a paid session. */
export function consentFromSession(session) {
  if (session?.metadata?.marketing_opt_out === 'true') return 'refused';
  return session?.consent?.promotions || 'not_asked';
}

/** True when this order must get no marketing: the PAL- code, MailerLite, the day-21 email. */
export function marketingRefused(consent) {
  return consent === 'refused' || consent === 'opt_out';
}
