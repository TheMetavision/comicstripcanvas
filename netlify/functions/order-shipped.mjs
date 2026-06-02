import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { isValidSignature, SIGNATURE_HEADER_NAME } from '@sanity/webhook';

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
 * The `shippingEmailSent` flag on the order document is the safety net that
 * prevents duplicates if Sanity fires the webhook more than once. Once true,
 * this function does nothing.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const resend = new Resend(process.env.RESEND_API_KEY);

// Brand constants — match webhook.mjs exactly so emails feel consistent.
const BRAND = {
  logo: 'https://comicstripcanvas.co.uk/logo.png',
  yellow: '#FFF200',
  pink: '#EC008C',
  cyan: '#00AEEF',
  dark: '#111111',
  site: 'https://comicstripcanvas.co.uk',
  facebook: 'https://www.facebook.com/ComicStripCanvas/',
  instagram: 'https://www.instagram.com/comicstripcanvas',
  tiktok: 'https://www.tiktok.com/@comicstripcanvas',
};

const FORMAT_LABELS_FROM_KEY = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas (Standard Frame)',
  'canvas-gallery': 'Canvas (Gallery Frame)',
};

/**
 * Auto-detect the carrier from the order's line items.
 * Rule: any canvas in the order → UPS (canvases force the bigger packaging
 *       even in a mixed-bundle order).
 *       Poster-only orders → Royal Mail.
 */
function detectCarrier(lineItems = []) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const hasCanvas = items.some((item) => {
    const fmt = (item.format || '').toLowerCase();
    return fmt.includes('canvas');
  });
  return hasCanvas ? 'ups' : 'royal-mail';
}

/**
 * Build the correct tracking URL for a given carrier.
 * Returns null for "other" so the email shows a plain tracking number.
 */
function buildTrackingUrl(carrier, trackingNumber) {
  const num = encodeURIComponent(trackingNumber || '');
  if (carrier === 'ups') {
    return `https://www.ups.com/track?tracknum=${num}&loc=en_GB`;
  }
  if (carrier === 'royal-mail') {
    return `https://www.royalmail.com/track-your-item#/tracking-results/${num}`;
  }
  return null;
}

function carrierDisplayName(carrier, otherName) {
  if (carrier === 'ups') return 'UPS';
  if (carrier === 'royal-mail') return 'Royal Mail';
  return otherName || 'Courier';
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

  // ── Decide the carrier ───────────────────────────────────────────────────
  // If the user has ticked "Override carrier" in Studio, respect whatever
  // they've chosen. Otherwise auto-detect from line items.
  let carrier;
  if (order.carrierOverride === true && order.carrier) {
    carrier = order.carrier;
  } else {
    carrier = detectCarrier(order.lineItems);
  }

  const trackingNumber = order.trackingNumber;
  const trackingUrl = buildTrackingUrl(carrier, trackingNumber);
  const carrierName = carrierDisplayName(carrier, order.carrierOther);
  const orderNumber = order.orderNumber || `CSC-${order._id}`;
  const customerName = order.customerName || 'there';
  const totalAmount = order.totalAmount || 0;
  const shippingCost = order.shippingCost || 0;
  const shippingLabel = shippingCost === 0 ? 'FREE UK P&P' : `£${shippingCost.toFixed(2)}`;
  const shippingColor = shippingCost === 0 ? '#28a745' : '#333333';
  const shipping = order.shippingAddress || {};

  // ── Order table rows (matches webhook.mjs style) ─────────────────────────
  const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
  const itemRows = lineItems
    .map((item) => {
      const formatLabel = FORMAT_LABELS_FROM_KEY[item.format] || item.format || '';
      const lineTotal = (item.unitPrice || 0) * (item.quantity || 1);
      return `<tr>
        <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${item.productTitle || ''}</td>
        <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${formatLabel}</td>
        <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${item.size || ''}</td>
        <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity || 1}</td>
        <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: right;">£${lineTotal.toFixed(2)}</td>
      </tr>`;
    })
    .join('');

  // ── Email building blocks ────────────────────────────────────────────────
  const emailHeader = `
    <div style="background: ${BRAND.dark}; padding: 32px 24px; text-align: center;">
      <table role="presentation" style="margin: 0 auto; border-collapse: collapse;">
        <tr>
          <td style="text-align: center;">
            <img src="${BRAND.logo}" alt="Comic Strip Canvas" width="280" style="max-width: 280px; width: 100%; height: auto; display: block; margin: 0 auto; border: 0;" />
          </td>
        </tr>
      </table>
      <p style="color: #777; margin: 16px 0 0; font-size: 13px; letter-spacing: 1px; text-align: center;">BOLD POP CULTURE WALL ART</p>
    </div>`;

  const emailFooter = `
    <div style="background: ${BRAND.dark}; padding: 24px; text-align: center;">
      <p style="margin: 0 0 12px; font-size: 13px; color: #aaa;">Follow us</p>
      <p style="margin: 0 0 16px;">
        <a href="${BRAND.facebook}" style="color: ${BRAND.pink}; text-decoration: none; margin: 0 8px; font-size: 13px;">Facebook</a>
        <a href="${BRAND.instagram}" style="color: ${BRAND.pink}; text-decoration: none; margin: 0 8px; font-size: 13px;">Instagram</a>
        <a href="${BRAND.tiktok}" style="color: ${BRAND.pink}; text-decoration: none; margin: 0 8px; font-size: 13px;">TikTok</a>
      </p>
      <p style="margin: 0 0 8px; font-size: 12px; color: #666;">
        <a href="${BRAND.site}" style="color: ${BRAND.pink}; text-decoration: none;">comicstripcanvas.co.uk</a>
      </p>
      <p style="margin: 0; font-size: 11px; color: #555;">&copy; ${new Date().getFullYear()} Comic Strip Canvas. All rights reserved.</p>
    </div>`;

  const orderTable = `
    <table style="width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; font-size: 14px; margin: 20px 0;">
      <thead>
        <tr style="background: ${BRAND.dark};">
          <th style="padding: 12px 16px; text-align: left; color: ${BRAND.yellow}; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Product</th>
          <th style="padding: 12px 16px; text-align: left; color: ${BRAND.yellow}; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Format</th>
          <th style="padding: 12px 16px; text-align: left; color: ${BRAND.yellow}; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Size</th>
          <th style="padding: 12px 16px; text-align: center; color: ${BRAND.yellow}; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Qty</th>
          <th style="padding: 12px 16px; text-align: right; color: ${BRAND.yellow}; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Total</th>
        </tr>
      </thead>
      <tbody style="color: #333;">
        ${itemRows}
      </tbody>
      <tfoot>
        <tr style="background: #f9f9f9;">
          <td colspan="3" style="padding: 14px 16px; text-align: right; font-weight: bold; font-size: 15px;">Shipping:</td>
          <td colspan="2" style="padding: 14px 16px; text-align: right; font-weight: bold; color: ${shippingColor};">${shippingLabel}</td>
        </tr>
        <tr style="background: ${BRAND.dark};">
          <td colspan="3" style="padding: 14px 16px; text-align: right; font-weight: bold; color: #fff; font-size: 16px;">Total:</td>
          <td colspan="2" style="padding: 14px 16px; text-align: right; font-weight: bold; color: ${BRAND.yellow}; font-size: 18px;">£${totalAmount.toFixed(2)}</td>
        </tr>
      </tfoot>
    </table>`;

  const shippingBlock = `
    <div style="background: #f8f8f8; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${BRAND.pink};">
      <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #666;">Shipping To</strong><br/><br/>
      <span style="color: #333; line-height: 1.8;">
        ${customerName}<br/>
        ${shipping.line1 || ''}${shipping.line2 ? '<br/>' + shipping.line2 : ''}<br/>
        ${shipping.city || ''}${shipping.county ? ', ' + shipping.county : ''}<br/>
        ${shipping.postcode || ''}<br/>
        ${shipping.country || ''}
      </span>
    </div>`;

  // The tracking block — the centrepiece of the email.
  // Big number, branded button if we have a tracking URL, plain copy if not.
  const trackingBlock = `
    <div style="background: #ffffff; padding: 28px 20px; margin: 20px 0; border: 4px solid ${BRAND.dark}; border-radius: 8px; text-align: center; box-shadow: 4px 4px 0 ${BRAND.dark};">
      <p style="margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color: #888;">Tracking Number</p>
      <p style="margin: 0 0 6px; font-size: 22px; font-weight: bold; color: ${BRAND.dark}; font-family: 'Courier New', monospace; word-break: break-all;">${trackingNumber}</p>
      <p style="margin: 0 0 20px; font-size: 13px; color: #666;">Carrier: <strong style="color: ${BRAND.pink};">${carrierName}</strong></p>
      ${trackingUrl
        ? `<a href="${trackingUrl}" target="_blank"
             style="display: inline-block; background: ${BRAND.pink}; color: #ffffff; text-decoration: none; padding: 14px 32px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; border: 3px solid ${BRAND.dark}; box-shadow: 3px 3px 0 ${BRAND.dark};">
             Track Your Parcel →
           </a>`
        : `<p style="margin: 0; font-size: 13px; color: #555;">Use the tracking number above on the ${carrierName} website to follow your parcel.</p>`}
      <p style="margin: 18px 0 0; font-size: 12px; color: #888;">Tracking can take up to 24 hours to become active after dispatch — don't worry if the link doesn't show anything yet.</p>
    </div>`;

  // ── Compose the full email ───────────────────────────────────────────────
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff;">
      ${emailHeader}
      
      <div style="padding: 32px 24px;">
        <h2 style="margin: 0 0 12px; font-size: 26px; color: ${BRAND.dark};">📦 Your order is on the way, ${customerName}!</h2>
        <p style="color: #666; line-height: 1.7; margin: 0 0 24px; font-size: 15px;">
          Great news — your Comic Strip Canvas order has been carefully packaged and dispatched. It's now with <strong style="color: ${BRAND.pink};">${carrierName}</strong> for delivery to you.
        </p>

        ${trackingBlock}

        <h3 style="margin: 28px 0 4px; font-size: 16px; color: ${BRAND.dark};">What to expect</h3>
        <p style="color: #666; line-height: 1.7; margin: 0 0 8px; font-size: 14px;">
          Delivery typically takes <strong>3-6 working days</strong> from dispatch. Your print is packaged to protect it in transit — please check it carefully when it arrives.
        </p>
        <p style="color: #666; line-height: 1.7; margin: 0 0 24px; font-size: 14px;">
          If anything isn't quite right, just reply to this email and we'll sort it straight away.
        </p>

        ${orderTable}
        ${shippingBlock}

        <div style="background: #fff9e6; padding: 18px 20px; border-radius: 8px; margin: 24px 0; border-left: 4px solid ${BRAND.yellow}; text-align: center;">
          <strong style="font-size: 14px; color: ${BRAND.dark};">We'd love to see it on your wall!</strong><br/>
          <span style="font-size: 13px; color: #555;">Tag us <strong>@comicstripcanvas</strong> on <a href="${BRAND.facebook}" style="color: ${BRAND.pink}; text-decoration: none;">Facebook</a>, <a href="${BRAND.instagram}" style="color: ${BRAND.pink}; text-decoration: none;">Instagram</a> or <a href="${BRAND.tiktok}" style="color: ${BRAND.pink}; text-decoration: none;">TikTok</a> and we'll share the love.</span>
        </div>

        <p style="color: #aaa; margin-top: 28px; font-size: 12px;">
          Order number: <strong style="color: ${BRAND.pink};">${orderNumber}</strong><br/>
          Dispatched: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>
      
      ${emailFooter}
    </div>`;

  // ── Send the email ──────────────────────────────────────────────────────
  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
      to: [order.customerEmail],
      subject: `📦 Your order is on the way (${orderNumber}) — Comic Strip Canvas`,
      html,
    });
    console.log(`Shipping email sent for ${orderNumber} to ${order.customerEmail} via ${carrierName}`);
  } catch (emailErr) {
    console.error(`Failed to send shipping email for ${orderNumber}:`, emailErr);
    // Don't mark as sent — let a future webhook fire retry the send.
    return new Response('Email send failed (will retry)', { status: 500 });
  }

  // ── Mark as sent so we never email twice ─────────────────────────────────
  // Also persist the auto-detected carrier back to the document, so the
  // Studio reflects what was actually used.
  try {
    const patch = sanity.patch(order._id).set({
      shippingEmailSent: true,
      shippingEmailSentAt: new Date().toISOString(),
    });
    // Only write the carrier back if the user didn't override it manually.
    if (!order.carrierOverride) {
      patch.set({ carrier });
    }
    await patch.commit();
  } catch (patchErr) {
    console.error(`Email sent but FAILED to mark ${orderNumber} as sent:`, patchErr);
    // The email's gone — return 200 so Sanity doesn't retry and trigger a
    // duplicate. We've logged the issue for manual review.
    return new Response('Sent but flag update failed (logged)', { status: 200 });
  }

  return new Response('OK', { status: 200 });
};

// NOTE: no `export const config = { path }`. Routed by the forced /api/* redirect
// in netlify.toml (/api/* -> /.netlify/functions/:splat). This is the SANITY order webhook;
// Sanity must POST to https://comicstripcanvas.co.uk/api/order-shipped (the redirect sends
// it to /.netlify/functions/order-shipped). An inline config.path collides and 404s.
