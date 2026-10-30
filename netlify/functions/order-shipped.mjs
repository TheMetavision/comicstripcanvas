import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { isValidSignature, SIGNATURE_HEADER_NAME } from '@sanity/webhook';
import { sendDispatchEmail } from './_shared/dispatch-email.mjs';

/**
 * order-shipped.mjs
 * --------------------------------------------------------------------------
 * Receives a Sanity webhook when an `order` document changes. If the order
 * has just transitioned to status = 'dispatched' AND has a trackingNumber
 * AND has not already been emailed, send the customer a branded shipping
 * notification email and mark the order as emailed.
 *
 * Signature verification uses the official @sanity/webhook toolkit so the
 * format always matches whatever Sanity is currently sending. The shared
 * secret is the SANITY_WEBHOOK_SECRET env var, which must match the secret
 * configured on the Sanity webhook in sanity.io/manage.
 *
 * The email, the "sent" flag and the post-delivery sequence live in
 * _shared/dispatch-email.mjs, shared with shipping-event.mjs (a Sendcloud
 * parcel's first carrier scan). It re-reads the order and claims it before
 * sending, so the two paths -- or Sanity firing this webhook twice -- can never
 * send the email twice. Once shippingEmailSent is true, nothing does anything.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

// Built on first use, not at import. `new Resend()` throws when RESEND_API_KEY
// is absent, and at module scope that throw happens at IMPORT time -- before
// the handler exists -- so the platform surfaces an opaque 500 with no log line
// from this function. Deferring it turns the same condition into something
// readable. Memoised, so warm containers still reuse one client. Mirrors
// getStripe() in webhook.mjs.
let resendClient;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();
  const sigHeader = req.headers.get(SIGNATURE_HEADER_NAME);
  const secret = process.env.SANITY_WEBHOOK_SECRET;

  // ── Signature verification (using Sanity's official toolkit) ────────────
  if (!secret) {
    console.error('SANITY_WEBHOOK_SECRET is not configured — rejecting request.');
    return new Response('Server misconfigured', { status: 500 });
  }
  if (!sigHeader) {
    console.error(`Missing ${SIGNATURE_HEADER_NAME} header — rejecting request.`);
    return new Response('Missing signature', { status: 401 });
  }
  const valid = await isValidSignature(rawBody, sigHeader, secret);
  if (!valid) {
    console.error('Sanity webhook signature failed verification.');
    return new Response('Invalid signature', { status: 401 });
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (err) {
    console.error('Could not parse webhook body:', err.message);
    return new Response('Bad request', { status: 400 });
  }

  // ── Dispatch criteria check ─────────────────────────────────────────────
  // We only proceed if ALL of these are true:
  //   1. The document is an order (not the counter, pending doc, etc.)
  //   2. Status is "dispatched"
  //   3. There is a tracking number
  //   4. The shipping email has not already been sent
  //   5. There is a customer email to send to
  // Otherwise return 200 (acknowledge) but do nothing — Sanity won't retry.
  // sendDispatchEmail checks all of these again on the order as it is NOW.
  if (order._type !== 'order') {
    return new Response('Not an order document — ignored', { status: 200 });
  }
  if (order.status !== 'dispatched') {
    return new Response('Order not dispatched — ignored', { status: 200 });
  }
  if (!order.trackingNumber) {
    console.log(`Order ${order.orderNumber || order._id} dispatched but no tracking number yet — skipping email.`);
    return new Response('No tracking number — ignored', { status: 200 });
  }
  if (order.shippingEmailSent === true) {
    console.log(`Order ${order.orderNumber || order._id} shipping email already sent — skipping.`);
    return new Response('Already sent — ignored', { status: 200 });
  }
  if (!order.customerEmail) {
    console.error(`Order ${order.orderNumber || order._id} has no customer email — cannot send.`);
    return new Response('No customer email — ignored', { status: 200 });
  }

  const result = await sendDispatchEmail({ orderId: order._id, sanity, getResend });
  if (result.status === 503) {
    return new Response(
      JSON.stringify({ error: result.reason, orderNumber: result.orderNumber }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return new Response(result.sent && result.reason === 'OK' ? 'OK' : result.reason, { status: result.status });
};

// NOTE: no `export const config = { path }`. Routed by the forced /api/* redirect
// in netlify.toml (/api/* -> /.netlify/functions/:splat). This is the SANITY order webhook;
// Sanity must POST to https://comicstripcanvas.co.uk/api/order-shipped (the redirect sends
// it to /.netlify/functions/order-shipped). An inline config.path collides and 404s.
