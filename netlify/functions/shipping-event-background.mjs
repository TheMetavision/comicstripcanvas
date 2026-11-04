import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { runShippingEvent } from './_shared/shipping-event-handoff.mjs';
import { applyParcelEvent, applyReturnEvent } from './_shared/shipping-events.mjs';

/**
 * shipping-event-background.mjs
 * --------------------------------------------------------------------------
 * Started only by shipping-event (handoff key + the service's signature over
 * the same body, see _shared/shipping-event-handoff.mjs). Does what a
 * tracking event does -- _shared/shipping-events.mjs: shipment events, first
 * scan (order + builds Dispatched, the branded dispatch email ONCE),
 * delivered, team alerts, return status -- every step safe to repeat.
 *
 * A failure throws, so Netlify retries the background function (about 1 and
 * 3 minutes later); the next tracking event re-checks the dispatch email too.
 */

let resendClient;
const getResend = () => {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  return (resendClient = new Resend(process.env.RESEND_API_KEY));
};

export default async (req) => {
  const sanity = createClient({
    projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
    token: process.env.SANITY_WRITE_TOKEN, useCdn: false,
  });
  const deps = { sanity, getResend };
  const r = await runShippingEvent(req, {
    apply: (event) => (event.kind === 'parcel' ? applyParcelEvent(event, deps) : applyReturnEvent(event, deps)),
  });
  console.log(`shipping-event-background: ${r.status} ${r.body}`);
  if (r.retry) throw new Error(`shipping-event-background: ${r.body}`);
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};

// NOTE: no `export const config = { path }`. Started at
// /.netlify/functions/shipping-event-background; the public /api/ address is
// closed in netlify.toml.
