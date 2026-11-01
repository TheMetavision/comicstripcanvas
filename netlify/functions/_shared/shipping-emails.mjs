/**
 * The Sendcloud flow's emails: the team's notices (label ready, problems,
 * returns), and the two a customer gets about a return (the label, or a
 * polite no).
 *
 * The customer's "on the way" email is NOT here -- it is the existing branded
 * dispatch email, in dispatch-email.mjs, sent once whichever path ships.
 *
 * The team address is the one webhook.mjs sends new-order notices to:
 * TEAM_EMAIL, else the committed team address (_shared/site-config.mjs). Never the customer's address,
 * and the collection point a return goes to is only ever named to the team.
 */
import { emailHeader, button, EMAIL_BRAND } from './email.mjs';
import { carrierName } from './parcel-bands.mjs';
import { setting } from './site-config.mjs';

export const STUDIO = 'https://comicstripcanvas.sanity.studio';
export const studioLink = (id, type) => `${STUDIO}/intent/edit/id=${encodeURIComponent(id)};type=${type}`;

/** Where the admin pages are. The label links go through /admin Basic Auth. */
export const adminOrigin = () => process.env.URL || 'https://comicstripcanvas.co.uk';
export const labelLink = (labelId) => `${adminOrigin()}/admin/shipping/label/${encodeURIComponent(labelId)}`;

export const teamAddress = () => setting('TEAM_EMAIL');
export const fromAddress = () => process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `£${(Number(n) || 0).toFixed(2)}`;
const testTag = () => (['true', '1', 'yes'].includes(String(process.env.SHIPPING_TEST_MODE || '').toLowerCase()) ? '[TEST] ' : '');

/** Resend reports a refusal by returning an error, so both shapes become { ok, error }. */
export async function sendEmail(resend, message) {
  if (!resend) return { ok: false, error: 'RESEND_API_KEY is not set' };
  try {
    const { error } = await resend.emails.send({ from: fromAddress(), ...message });
    if (error) return { ok: false, error: `${error.name || 'Error'}: ${error.message || 'Resend rejected the send'}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

const wrap = (inner) => `
  <div style="font-family: ${EMAIL_BRAND.sans}; max-width: 640px; margin: 0 auto; background: #ffffff;">
    ${emailHeader}
    <div style="padding: 28px 24px; color: #333; font-size: 15px; line-height: 1.6;">${inner}</div>
  </div>`;

const plainWrap = (inner) => `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #222; max-width: 680px;">${inner}</div>`;

const table = (rows) => `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse: collapse; border-color: #ddd; font-size: 13px; margin: 12px 0;">${rows}</table>`;

/* ------------------------------------------------------------------ team: outbound */

export function labelReadyEmail(order, parcels) {
  const rows = `<tr style="background:#f3f3f3"><th>Parcel</th><th>Band</th><th>Carrier / option</th><th>Quoted</th><th>Tracking</th><th>Label</th></tr>`
    + parcels.map((p) => `<tr>
      <td>${esc(p.parcelRef)}</td><td>${esc(p.band)}</td>
      <td>${esc(carrierName(p.carrier))}<br><span style="color:#777">${esc(p.option || '')}</span></td>
      <td>${p.quotedPrice != null ? money(p.quotedPrice) : '—'}</td>
      <td>${esc(p.trackingNumber || '—')}</td>
      <td><a href="${esc(labelLink(p.labelId))}"><strong>Print label</strong></a></td></tr>`).join('');
  return {
    to: [teamAddress()],
    subject: `${testTag()}🏷️ Label ready — ${order.orderNumber} (${parcels.length} parcel${parcels.length === 1 ? '' : 's'})`,
    html: plainWrap(`
      <h2 style="margin:0 0 8px">Label${parcels.length === 1 ? '' : 's'} ready for ${esc(order.orderNumber)}</h2>
      <p>${esc(order.customerName || '')} — ${esc([order.shippingAddress?.city, order.shippingAddress?.postcode].filter(Boolean).join(', '))}</p>
      ${table(rows)}
      <p>The customer has <strong>not</strong> been emailed. They get the dispatch email with tracking at the first carrier scan.</p>
      <p>The label links ask for the admin password. <a href="${esc(studioLink(order._id, 'order'))}">Open the order in the Studio</a>.</p>`),
  };
}

export function shipmentProblemEmail(order, reason) {
  return {
    to: [teamAddress()],
    subject: `${testTag()}⚠ Shipping problem — ${order.orderNumber || order._id}`,
    html: plainWrap(`
      <h2 style="margin:0 0 8px">No label for ${esc(order.orderNumber || order._id)}</h2>
      <p>The order is marked <strong>Exception</strong> and nothing more will happen until you change it.</p>
      <p style="background:#fff3f3;border-left:4px solid #c00;padding:10px 12px;white-space:pre-wrap">${esc(reason)}</p>
      <p>Fix the parcel plan (or the band set-up on the shipping service), then set Shipment status back to
      <strong>Ready to ship</strong> to try again. Parcels that already have a label are not bought twice.</p>
      <p><a href="${esc(studioLink(order._id, 'order'))}">Open the order in the Studio</a></p>`),
  };
}

export function parcelAlertEmail(order, parcel, event, kind) {
  const what = kind === 'returned_to_sender' ? 'is being returned to sender' : 'has a delivery problem';
  return {
    to: [teamAddress()],
    subject: `${testTag()}⚠ ${order.orderNumber}: parcel ${parcel?.parcelRef || ''} ${what}`,
    html: plainWrap(`
      <h2 style="margin:0 0 8px">${esc(order.orderNumber)}: parcel ${esc(parcel?.parcelRef || '?')} ${what}</h2>
      ${table(`
        <tr><th align="left">Status</th><td>${esc(event.status || '')} (${esc(event.statusCode ?? '')})</td></tr>
        <tr><th align="left">Carrier says</th><td>${esc(event.carrierStatus || '—')}</td></tr>
        <tr><th align="left">Tracking</th><td>${event.trackingUrl ? `<a href="${esc(event.trackingUrl)}">${esc(event.trackingNumber || 'link')}</a>` : esc(event.trackingNumber || '—')}</td></tr>
        <tr><th align="left">Customer</th><td>${esc(order.customerName || '')} &lt;${esc(order.customerEmail || '')}&gt;</td></tr>
        <tr><th align="left">At</th><td>${esc(event.at || '')}</td></tr>`)}
      <p>Nothing has been sent to the customer about this.</p>
      <p><a href="${esc(studioLink(order._id, 'order'))}">Open the order in the Studio</a></p>`),
  };
}

/* ------------------------------------------------------------------ team: returns */

const returnLinesTable = (ret) => table(
  `<tr style="background:#f3f3f3"><th>Item</th><th>Format / size</th><th>Qty</th><th>Price</th></tr>`
  + (ret.lines || []).map((l) => `<tr><td>${esc(l.productTitle)}</td><td>${esc([l.format, l.size].filter(Boolean).join(' / '))}</td>
    <td>${esc(l.quantity)}</td><td>${money((l.unitPrice || 0) * (l.quantity || 1))}</td></tr>`).join(''));

export function newReturnEmail(ret) {
  return {
    to: [teamAddress()],
    subject: `${testTag()}↩️ Return request ${ret.returnNumber} — ${ret.customerName || ''}${ret.deliveryDateUnknown ? ' — ⚠ delivery date unknown' : ''}`,
    html: plainWrap(`
      <h2 style="margin:0 0 8px">Return request ${esc(ret.returnNumber)}</h2>
      <p>Order <strong>${esc(ret.orderNumber)}</strong> — ${esc(ret.customerName || '')} &lt;${esc(ret.customerEmail || '')}&gt;</p>
      ${returnLinesTable(ret)}
      <p><strong>Reason:</strong> ${esc(ret.reasonLabel || ret.reason || '')}</p>
      ${ret.customerNotes ? `<p><strong>Notes:</strong></p><p style="white-space:pre-wrap;background:#f7f7f7;padding:8px 10px">${esc(ret.customerNotes)}</p>` : ''}
      ${ret.deliveryDateUnknown
        ? '<p style="background:#fff8e1;border-left:4px solid #f0a500;padding:10px 12px"><strong>Delivery date unknown.</strong> This order has no recorded delivery, so the 14-day window could not be checked. Judge it yourself before approving.</p>'
        : `<p>Delivered ${esc(ret.deliveredAt ? new Date(ret.deliveredAt).toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) : '')}; the 14-day window runs to ${esc(ret.windowEndsOn || '')}.</p>`}
      <p>Approve or reject it in the Studio. Approving buys the return label and emails it to the customer; the return postage is deducted from their refund (refunds stay manual in Stripe).</p>
      <p><a href="${esc(studioLink(ret._id, 'returnRequest'))}">Open the return in the Studio</a></p>`),
  };
}

export function returnProblemEmail(ret, reason) {
  return {
    to: [teamAddress()],
    subject: `${testTag()}⚠ Return ${ret.returnNumber || ret._id}: no label sent`,
    html: plainWrap(`
      <h2 style="margin:0 0 8px">No return label for ${esc(ret.returnNumber || ret._id)}</h2>
      <p style="background:#fff3f3;border-left:4px solid #c00;padding:10px 12px;white-space:pre-wrap">${esc(reason)}</p>
      <p>The customer has not been emailed. Fix it in the Studio (a band, usually) and the label is tried again when you save the band or set the status back to Approved.</p>
      <p><a href="${esc(studioLink(ret._id, 'returnRequest'))}">Open the return in the Studio</a></p>`),
  };
}

export function returnAlertEmail(ret, event, kind) {
  const what = kind === 'returned_to_sender' ? 'is going back to the customer' : 'has a carrier problem';
  return {
    to: [teamAddress()],
    subject: `${testTag()}⚠ Return ${ret.returnNumber || ret._id} ${what}`,
    html: plainWrap(`
      <h2 style="margin:0 0 8px">Return ${esc(ret.returnNumber || ret._id)} ${what}</h2>
      ${table(`
        <tr><th align="left">Status</th><td>${esc(event?.status || '')} (${esc(event?.statusCode ?? '')})</td></tr>
        <tr><th align="left">Carrier says</th><td>${esc(event?.carrierStatus || '—')}</td></tr>
        <tr><th align="left">Tracking</th><td>${event?.trackingUrl ? `<a href="${esc(event.trackingUrl)}">${esc(ret.trackingNumber || 'link')}</a>` : esc(ret.trackingNumber || '—')}</td></tr>
        <tr><th align="left">Customer</th><td>${esc(ret.customerName || '')} &lt;${esc(ret.customerEmail || '')}&gt;</td></tr>`)}
      <p>Nothing has been sent to the customer about this.</p>
      <p><a href="${esc(studioLink(ret._id, 'returnRequest'))}">Open the return in the Studio</a></p>`),
  };
}

/**
 * Which point a return went to. The shipping service knows the Sendcloud ids;
 * these optional env vars let the email name the actual place for whoever is
 * collecting. Team email only -- never shown to a customer.
 */
export function collectionPoint(carrier) {
  const s = String(carrier || '').toLowerCase();
  if (s.startsWith('inpost')) return setting('RETURN_POINT_INPOST');
  if (s.startsWith('hermes') || s.startsWith('evri')) return setting('RETURN_POINT_EVRI');
  if (s.startsWith('ups')) return setting('RETURN_POINT_UPS');
  return `the ${carrierName(carrier)} return point set on the shipping service`;
}

export function returnReadyEmail(ret, event) {
  return {
    to: [teamAddress()],
    subject: `${testTag()}📬 Return ${ret.returnNumber} is ready to collect — ${carrierName(ret.carrier)}`,
    html: plainWrap(`
      <h2 style="margin:0 0 8px">Return ${esc(ret.returnNumber)} is waiting to be collected</h2>
      <p><strong>Collect from:</strong> ${esc(collectionPoint(ret.carrier))}</p>
      ${table(`
        <tr><th align="left">Carrier</th><td>${esc(carrierName(ret.carrier))}</td></tr>
        <tr><th align="left">Tracking</th><td>${event?.trackingUrl ? `<a href="${esc(event.trackingUrl)}">${esc(ret.trackingNumber || 'link')}</a>` : esc(ret.trackingNumber || '—')}</td></tr>
        <tr><th align="left">Status</th><td>${esc(event?.status || '')}</td></tr>`)}
      ${returnLinesTable(ret)}
      <p>Mark it Received in the Studio once you have it, and refund in Stripe${ret.freeLabel ? '' : ` less the ${ret.postageDeduction != null ? money(ret.postageDeduction) : 'label cost (see Sendcloud: the service gave no price)'} return postage`}.</p>
      <p><a href="${esc(studioLink(ret._id, 'returnRequest'))}">Open the return in the Studio</a></p>`),
  };
}

/* ------------------------------------------------------------------ customer: returns */

const p = (s) => `<p style="margin: 0 0 14px;">${s}</p>`;

export function returnLabelEmail(ret, { pdf, instructions, postage }) {
  const deduction = ret.freeLabel ? '' : `<p style="margin: 18px 0; padding: 14px 16px; background: #fff9e6; border-left: 4px solid ${EMAIL_BRAND.yellow};"><strong>${
    postage != null ? `${money(postage)} return postage will be deducted from your refund.` : 'The cost of this return label will be deducted from your refund.'}</strong></p>`;
  const items = (ret.lines || []).map((l) => `<li>${esc(l.productTitle)} — ${esc([l.format, l.size].filter(Boolean).join(', '))} × ${esc(l.quantity)}</li>`).join('');
  return {
    to: [ret.customerEmail],
    subject: `${testTag()}Your return label — ${ret.returnNumber} — Comic Strip Canvas`,
    attachments: [{ filename: `return-label-${String(ret.returnNumber || 'label').replace(/[^\w-]/g, '')}.pdf`, content: pdf.toString('base64') }],
    html: wrap(`
      <h2 style="margin: 0 0 12px; font-size: 24px; color: ${EMAIL_BRAND.dark};">Your return label is attached</h2>
      ${p(`Hi ${esc(ret.customerName || 'there')}, we've approved your return for order <strong>${esc(ret.orderNumber)}</strong>. Your label is attached to this email as a PDF.`)}
      <ul style="margin: 0 0 14px; padding-left: 20px;">${items}</ul>
      <h3 style="margin: 22px 0 8px; font-size: 16px;">How to send it</h3>
      <div style="white-space: pre-wrap; background: #f7f7f7; padding: 14px 16px; border-radius: 6px; margin: 0 0 14px;">${esc(instructions || '')}</div>
      ${ret.trackingNumber ? p(`Tracking number: <strong style="font-family: 'Courier New', monospace;">${esc(ret.trackingNumber)}</strong>`) : ''}
      ${deduction}
      ${ret.freeLabel
        ? p("This label is free: you don't pay anything to send it back.")
        : p('Please return the item unused and in its original packaging. We refund within 14 days of receiving it back.')}
      ${p('Any questions, just reply to this email.')}
      <p style="color: #aaa; margin-top: 24px; font-size: 12px;">Return reference: <strong style="color: ${EMAIL_BRAND.pink};">${esc(ret.returnNumber)}</strong></p>`),
  };
}

export function returnDeclinedEmail(ret) {
  return {
    to: [ret.customerEmail],
    subject: `${testTag()}About your return request ${ret.returnNumber} — Comic Strip Canvas`,
    html: wrap(`
      <h2 style="margin: 0 0 12px; font-size: 24px; color: ${EMAIL_BRAND.dark};">About your return request</h2>
      ${p(`Hi ${esc(ret.customerName || 'there')}, thank you for getting in touch about order <strong>${esc(ret.orderNumber)}</strong>.`)}
      ${p("We're sorry, but we aren't able to accept this return:")}
      <div style="white-space: pre-wrap; background: #f7f7f7; padding: 14px 16px; border-radius: 6px; margin: 0 0 14px;">${esc(ret.rejectionReason || '')}</div>
      ${p('If your item arrived faulty, damaged or not as described, your rights are not affected — just reply to this email with your order number and some photos, and we\'ll put it right.')}
      ${p('If you have any other questions, reply to this email and we\'ll be happy to help.')}
      <div style="margin: 22px 0;">${button(EMAIL_BRAND.site, 'Visit the shop')}</div>
      <p style="color: #aaa; margin-top: 24px; font-size: 12px;">Return reference: ${esc(ret.returnNumber)}</p>`),
  };
}
