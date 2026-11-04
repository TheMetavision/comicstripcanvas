import { acceptShippingEvent } from './_shared/shipping-event-handoff.mjs';

/**
 * shipping-event.mjs
 * --------------------------------------------------------------------------
 * POST /api/shipping-event   the shipping service's tracking callback
 *
 * metavision-shipping forwards each Sendcloud status change for a CSC parcel
 * here, signed with SHIPPING_SECRET (x-mv-brand, x-mv-timestamp,
 * x-mv-signature over `${timestamp}.${rawBody}`), and wants a 2xx within 4
 * seconds. So this only checks the signature (401) and the event's shape,
 * hands the unchanged signed body to shipping-event-background -- which does
 * the work, see _shared/shipping-events.mjs -- and answers 200 once that has
 * started. 503 while SHIPPING_ENABLED is off or if the start fails, so the
 * service keeps the event and retries. See _shared/shipping-event-handoff.mjs.
 *
 * Imports nothing that talks to Sanity, Resend, Stripe or MailerLite.
 */
export default async (req) => {
  const r = await acceptShippingEvent(req);
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};

// NOTE: no `export const config = { path }`. Routed by the forced /api/* redirect.
