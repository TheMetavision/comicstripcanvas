import { emailHeader } from './email.mjs';
import Stripe from 'stripe';
import { friendCodeFor } from './referral.mjs';
import { addShippedCustomer } from './mailerlite-customer.mjs';
import { carrierName } from './parcel-bands.mjs';

/**
 * The customer's "your order is on the way" email, and what follows it.
 *
 * Two things can decide an order has shipped:
 *   - order-shipped.mjs, the Sanity webhook, when Alan sets status Dispatched
 *     with a tracking number by hand (the way it has always worked);
 *   - shipping-event.mjs, when a Sendcloud parcel gets its first carrier scan.
 * Both come here, and this is the only place the email is sent from, so there
 * is one email, one shippingEmailSentAt (which photo retention counts its 90
 * days from) and one start of the post-delivery sequence.
 *
 * ONCE ONLY. Before sending, the order is claimed: shippingEmailClaimedAt is
 * written with ifRevisionId set to the revision just read, so of two callers
 * racing, exactly one write lands and the other re-reads and sees the claim.
 * The claim is given back if the send fails (so a later webhook retries), and
 * a claim older than CLAIM_TTL_MS is treated as abandoned -- a function that
 * died between claiming and sending must not block the email for ever.
 */

export const CLAIM_TTL_MS = 10 * 60 * 1000;

// Brand constants — match webhook.mjs exactly so emails feel consistent.
const BRAND = {
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
export function detectCarrier(lineItems = []) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const hasCanvas = items.some((item) => {
    const fmt = (item.format || '').toLowerCase();
    return fmt.includes('canvas');
  });
  return hasCanvas ? 'ups' : 'royal-mail';
}

/**
 * Build the correct tracking URL for a given carrier.
 * Returns null for anything else so the email shows a plain tracking number.
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
  if (carrier === 'evri') return 'Evri';
  if (carrier === 'inpost') return 'InPost';
  if (carrier === 'dpd') return 'DPD';
  return otherName || 'Courier';
}

/** Parcels the shipping service made, that have something to track. */
export const trackedParcels = (order) =>
  (order?.shipment?.parcels || []).filter((p) => p && (p.trackingNumber || p.trackingUrl));

/** Which carrier the hand-dispatch path uses (it writes this back to the order). */
export function carrierFor(order) {
  return order.carrierOverride === true && order.carrier ? order.carrier : detectCarrier(order.lineItems);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The email itself. An order dispatched by hand gets exactly the email it
 * always got. An order shipped through Sendcloud gets one tracking block per
 * parcel, each with the carrier's own tracking link from the service, and
 * "2-3 working days" -- the economy services the service picks are not
 * next-day.
 *
 * @returns {{ subject: string, html: string, carrierName: string }}
 */
export function buildDispatchEmail(order, { now = new Date() } = {}) {
  const parcels = trackedParcels(order);
  const viaService = parcels.length > 0;

  const carrier = carrierFor(order);
  const trackingNumber = order.trackingNumber;
  const trackingUrl = buildTrackingUrl(carrier, trackingNumber);
  const singleCarrierName = carrierDisplayName(carrier, order.carrierOther);
  const names = viaService ? [...new Set(parcels.map((p) => carrierName(p.carrier)))] : [singleCarrierName];
  const shownCarrier = names.join(' and ');

  const orderNumber = order.orderNumber || `CSC-${order._id}`;
  const customerName = order.customerName || 'there';
  const totalAmount = order.totalAmount || 0;
  const shippingCost = order.shippingCost || 0;
  const shippingLabel = shippingCost === 0 ? 'FREE UK P&P' : `£${shippingCost.toFixed(2)}`;
  const shippingColor = shippingCost === 0 ? '#28a745' : '#333333';
  // Recorded by webhook.mjs from the Stripe session; absent on undiscounted orders.
  const discountAmount = order.discountAmount || 0;
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
      <p style="margin: 0; font-size: 11px; color: #555;">&copy; ${now.getFullYear()} Comic Strip Canvas. All rights reserved.</p>
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
        ${discountAmount ? `<tr style="background: #f9f9f9;">
          <td colspan="3" style="padding: 14px 16px; text-align: right; font-weight: bold; font-size: 15px;">${order.discountCode ? `Discount (${order.discountCode})` : 'Discount'}:</td>
          <td colspan="2" style="padding: 14px 16px; text-align: right; font-weight: bold; color: #28a745;">&minus;£${discountAmount.toFixed(2)}</td>
        </tr>` : ''}
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
  const block = ({ number, url, name, heading }) => `
    <div style="background: #ffffff; padding: 28px 20px; margin: 20px 0; border: 4px solid ${BRAND.dark}; border-radius: 8px; text-align: center; box-shadow: 4px 4px 0 ${BRAND.dark};">
      <p style="margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; color: #888;">${heading}</p>
      <p style="margin: 0 0 6px; font-size: 22px; font-weight: bold; color: ${BRAND.dark}; font-family: 'Courier New', monospace; word-break: break-all;">${number}</p>
      <p style="margin: 0 0 20px; font-size: 13px; color: #666;">Carrier: <strong style="color: ${BRAND.pink};">${name}</strong></p>
      ${url
        ? `<a href="${url}" target="_blank"
             style="display: inline-block; background: ${BRAND.pink}; color: #ffffff; text-decoration: none; padding: 14px 32px; font-weight: bold; font-size: 14px; letter-spacing: 1px; text-transform: uppercase; border: 3px solid ${BRAND.dark}; box-shadow: 3px 3px 0 ${BRAND.dark};">
             Track Your Parcel →
           </a>`
        : `<p style="margin: 0; font-size: 13px; color: #555;">Use the tracking number above on the ${name} website to follow your parcel.</p>`}
      <p style="margin: 18px 0 0; font-size: 12px; color: #888;">Tracking can take up to 24 hours to become active after dispatch — don't worry if the link doesn't show anything yet.</p>
    </div>`;

  const trackingBlock = viaService
    ? parcels.map((p, i) => block({
      number: esc(p.trackingNumber || 'See tracking link'),
      url: p.trackingUrl ? esc(p.trackingUrl) : null,
      name: esc(carrierName(p.carrier)),
      heading: parcels.length > 1 ? `Parcel ${i + 1} of ${parcels.length} — Tracking Number` : 'Tracking Number',
    })).join('')
    : block({ number: trackingNumber, url: trackingUrl, name: singleCarrierName, heading: 'Tracking Number' });

  const deliveryDays = viaService ? '2-3 working days' : '1-2 working days';
  const intro = viaService && parcels.length > 1
    ? `Great news — your Comic Strip Canvas order has been carefully packaged and dispatched in ${parcels.length} parcels. It's now with <strong style="color: ${BRAND.pink};">${esc(shownCarrier)}</strong> for delivery to you.`
    : `Great news — your Comic Strip Canvas order has been carefully packaged and dispatched. It's now with <strong style="color: ${BRAND.pink};">${viaService ? esc(shownCarrier) : singleCarrierName}</strong> for delivery to you.`;

  // ── Compose the full email ───────────────────────────────────────────────
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff;">
      ${emailHeader}

      <div style="padding: 32px 24px;">
        <h2 style="margin: 0 0 12px; font-size: 26px; color: ${BRAND.dark};">📦 Your order is on the way, ${customerName}!</h2>
        <p style="color: #666; line-height: 1.7; margin: 0 0 24px; font-size: 15px;">
          ${intro}
        </p>

        ${trackingBlock}

        <h3 style="margin: 28px 0 4px; font-size: 16px; color: ${BRAND.dark};">What to expect</h3>
        <p style="color: #666; line-height: 1.7; margin: 0 0 8px; font-size: 14px;">
          Delivery typically takes <strong>${deliveryDays}</strong> from dispatch. Your print is packaged to protect it in transit — please check it carefully when it arrives.
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
          Dispatched: ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      ${emailFooter}
    </div>`;

  return {
    subject: `📦 Your order is on the way (${orderNumber}) — Comic Strip Canvas`,
    html,
    carrierName: viaService ? shownCarrier : singleCarrierName,
  };
}

const isConflict = (err) => {
  const status = err && (err.statusCode || err.response?.statusCode);
  return status === 409 || /revision/i.test((err && err.message) || '');
};

/**
 * Send the dispatch email for one order if, and only if, it is due and nobody
 * else is sending it.
 *
 * @param {object} p
 * @param {string} p.orderId
 * @param {object} p.sanity        @sanity/client with a write token
 * @param {Function} p.getResend   returns a Resend client, or null if no key
 * @param {Function} [p.postDelivery]  defaults to startPostDelivery
 * @returns {Promise<{ sent: boolean, status: number, reason: string, orderNumber?: string }>}
 *   status is the HTTP status a webhook handler should answer with.
 */
export async function sendDispatchEmail({
  orderId, sanity, getResend, postDelivery = startPostDelivery, now = () => Date.now(), log = console,
}) {
  let order;
  let claimed = false;
  for (let attempt = 0; attempt < 4 && !claimed; attempt++) {
    order = await sanity.getDocument(orderId);
    if (!order || order._type !== 'order') return { sent: false, status: 200, reason: 'Not an order document — ignored' };
    const orderNumber = order.orderNumber || order._id;
    if (order.shippingEmailSent === true) {
      log.log(`Order ${orderNumber} shipping email already sent — skipping.`);
      return { sent: false, status: 200, reason: 'Already sent — ignored', orderNumber };
    }
    if (order.status !== 'dispatched' && order.status !== 'delivered') {
      return { sent: false, status: 200, reason: 'Order not dispatched — ignored', orderNumber };
    }
    if (!order.trackingNumber && !trackedParcels(order).length) {
      log.log(`Order ${orderNumber} dispatched but no tracking number yet — skipping email.`);
      return { sent: false, status: 200, reason: 'No tracking number — ignored', orderNumber };
    }
    if (!order.customerEmail) {
      log.error(`Order ${orderNumber} has no customer email — cannot send.`);
      return { sent: false, status: 200, reason: 'No customer email — ignored', orderNumber };
    }
    const claimedAt = order.shippingEmailClaimedAt ? Date.parse(order.shippingEmailClaimedAt) : NaN;
    if (Number.isFinite(claimedAt) && now() - claimedAt < CLAIM_TTL_MS) {
      log.log(`Order ${orderNumber} shipping email is being sent by another call — skipping.`);
      return { sent: false, status: 200, reason: 'Already being sent — ignored', orderNumber };
    }
    try {
      await sanity.patch(orderId).ifRevisionId(order._rev)
        .set({ shippingEmailClaimedAt: new Date(now()).toISOString() }).commit();
      claimed = true;
    } catch (err) {
      if (!isConflict(err)) throw err;
      // Somebody wrote the order in between: read it again and decide again.
    }
  }
  if (!claimed) return { sent: false, status: 500, reason: 'Could not claim the order (kept changing) — will retry' };

  const orderNumber = order.orderNumber || `CSC-${order._id}`;
  const release = () => sanity.patch(orderId).unset(['shippingEmailClaimedAt']).commit().catch((e) =>
    log.error(`order ${orderNumber}: could not release the email claim:`, e?.message || e));

  const resend = getResend();
  if (!resend) {
    // Deliberately not marked as sent, so a later webhook fire retries this
    // once the key is in place -- nothing is lost, it is only deferred.
    log.error(`dispatch-email: RESEND_API_KEY is not set - cannot email ${orderNumber}.`);
    await release();
    return { sent: false, status: 503, reason: 'RESEND_API_KEY is not set on this deploy', orderNumber };
  }

  const viaService = trackedParcels(order).length > 0;
  const { subject, html, carrierName: shownCarrier } = buildDispatchEmail(order, { now: new Date(now()) });
  try {
    // Resend reports a rejected send by RETURNING an error, not by throwing --
    // an invalid key, an unverified sending domain or a bad address all come
    // back this way.
    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
      to: [order.customerEmail],
      subject,
      html,
    });
    if (error) throw new Error(`${error.name || 'Error'}: ${error.message || 'Resend rejected the send'}`);
    log.log(`Shipping email sent for ${orderNumber} to ${order.customerEmail} via ${shownCarrier}`);
  } catch (emailErr) {
    log.error(`Failed to send shipping email for ${orderNumber}:`, emailErr);
    // Don't mark as sent — let a future webhook fire retry the send.
    await release();
    return { sent: false, status: 500, reason: 'Email send failed (will retry)', orderNumber };
  }

  // ── Mark as sent so we never email twice ─────────────────────────────────
  // The hand-dispatch path also writes the auto-detected carrier back, so the
  // Studio reflects what was used. A Sendcloud shipment's carrier was already
  // written from the service's answer and is left alone.
  const mark = { shippingEmailSent: true, shippingEmailSentAt: new Date(now()).toISOString() };
  try {
    const patch = sanity.patch(orderId).set(mark).unset(['shippingEmailClaimedAt']);
    if (!viaService && !order.carrierOverride) patch.set({ carrier: carrierFor(order) });
    await patch.commit();
  } catch (patchErr) {
    log.error(`Email sent but FAILED to mark ${orderNumber} as sent:`, patchErr);
    // One more plain try: the claim still stands either way, and the email
    // has gone, so answer 200 and log rather than invite a duplicate.
    await sanity.patch(orderId).set(mark).commit().catch(() => {});
    return { sent: true, status: 200, reason: 'Sent but flag update failed (logged)', orderNumber };
  }

  // ── Post-delivery sequence + referral code ───────────────────────────────
  // After the shipping email has gone and the order is marked, so neither can
  // ever hold the other up. Runs once per order: the claim and the
  // shippingEmailSent guard above stop any later call from getting this far.
  await postDelivery(order, orderNumber, { sanity, log });

  return { sent: true, status: 200, reason: 'OK', orderNumber };
}

/**
 * Give the buyer their own PAL- friend code (reusing one from an earlier
 * order by the same email) and add them to "CSC - Customers" in MailerLite,
 * which starts the post-delivery automation. Never throws.
 */
export async function startPostDelivery(order, orderNumber, { sanity, log = console }) {
  let referralCode = '';
  try {
    if (process.env.STRIPE_SECRET_KEY) {
      const earlier = await sanity.fetch(
        `*[_type == "order" && lower(customerEmail) == $email && defined(referralCode)][0].referralCode`,
        { email: String(order.customerEmail || '').toLowerCase() }
      );
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
      referralCode = await friendCodeFor(stripe, { email: order.customerEmail, orderNumber, existingCode: earlier || null });
      await sanity.patch(order._id).set({ referralCode }).commit();
    }
  } catch (err) {
    log.error(`Referral code for ${orderNumber} failed:`, err?.message || err);
  }
  const ml = await addShippedCustomer(order, { referralCode });
  if (ml.ok) log.log(`${orderNumber}: added to MailerLite "CSC - Customers"`);
  else log.error(`${orderNumber}: MailerLite customer add ${ml.skipped ? 'skipped' : 'failed'}:`, ml.skipped || ml.status || '', ml.error || '');
}
