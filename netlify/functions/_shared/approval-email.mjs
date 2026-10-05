import { Resend } from 'resend';
import { emailHeader, button, EMAIL_BRAND } from './email.mjs';
import { docIdFor } from './pp-id.mjs';
import { FULL_BLEED, STYLE_LABEL, isStyle, styleForTemplate } from './artwork-styles.mjs';

/**
 * "The customer has approved their proof" — to the team, once per approval.
 *
 * Sent by personalisation-approve.mjs after the click has been recorded, and
 * only then. Once per approval is enforced there rather than here: the approve
 * token is spent in the same patch that moves the build to in_production, so a
 * second click finds no token and never reaches this. Nothing here can make
 * that click send twice.
 *
 * Best-effort by construction, like the other team emails: the customer has
 * already approved by the time this runs, and a Resend outage must cost the
 * email and nothing else. Never throws.
 *
 * Everything the email says is read from the BUILD, not the order line. Order
 * lines do not record which build they belong to, so in an order with two
 * personalised items a line cannot be matched to its build -- but the build
 * knows its own template, size and finish exactly. The order supplies only
 * what the build cannot: the customer's name.
 */

let resendClient;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/** Sanity's own deep link: opens the document whatever the desk structure is. */
const STUDIO = 'https://comicstripcanvas.sanity.studio';
const studioLink = (docId, type) => `${STUDIO}/intent/edit/id=${encodeURIComponent(docId)};type=${type}`;

/** The builder's outputFormat, in the words the order lines use. */
const FINISH_LABEL = {
  poster: 'Poster Print',
  standard: 'Canvas (Standard Frame)',
  gallery: 'Canvas (Gallery Frame)',
};

const TEMPLATE_PRODUCT = {
  cover: 'Personalised comic book cover',
  'cover-fullbleed': 'Personalised comic book cover',
  strip: 'Personalised comic strip',
  'icon-portrait': 'Personalised comic icon',
  'icon-landscape': 'Personalised comic icon',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * What the email says about a build, worked out from the document alone.
 * Exported for the tests.
 */
export function describeApproval(doc) {
  const customising = doc.kind === 'customise';
  const product = customising
    ? `Customised: ${doc.productTitle || doc.productId || 'stock design'}`
    : (TEMPLATE_PRODUCT[doc.templateId] || doc.templateId || 'Personalised design');
  /* A customised design records which of the product's two styles it was made
     from; a personalised one is drawn by its template. */
  const style = customising && isStyle(doc.artworkStyle)
    ? doc.artworkStyle
    : styleForTemplate(doc.templateId);
  return {
    orderNumber: doc.order?.orderNumber || doc.orderNumber || null,
    customerName: doc.order?.customerName || null,
    product,
    size: doc.printSize || 'unknown size',
    finish: FINISH_LABEL[doc.outputFormat] || doc.outputFormat || 'unknown finish',
    style: style === FULL_BLEED ? STYLE_LABEL[FULL_BLEED] : 'Classic',
    editCount: typeof doc.editCount === 'number' ? doc.editCount : 0,
  };
}

export function approvalSubject(d) {
  return `✅ PROOF APPROVED — ${d.orderNumber || 'no order number'} — ${d.customerName || 'unknown customer'}`;
}

export function approvalHtml({ id, d, proofUrl, adminUrl, orderUrl, approvedAt }) {
  const row = (label, value, shade) => `
              <tr>
                <td style="padding: 8px 12px;${shade ? ' background: #f5f5f5;' : ''} color: #666; width: 38%;">${label}</td>
                <td style="padding: 8px 12px;${shade ? ' background: #f5f5f5;' : ''} color: #111;">${value}</td>
              </tr>`;
  const edited = d.editCount > 0
    ? `<strong style="color: ${EMAIL_BRAND.pink};">Edited by us</strong> &mdash; ${d.editCount} time${d.editCount === 1 ? '' : 's'}`
    : 'No &mdash; the customer&rsquo;s own design';
  const when = approvedAt.replace('T', ' ').slice(0, 16) + ' UTC';

  return `
        <div style="font-family: ${EMAIL_BRAND.sans}; max-width: 640px; margin: 0 auto; background: #ffffff;">
          ${emailHeader}
          <div style="padding: 32px 24px;">
            <h2 style="margin: 0 0 8px; font-size: 22px; color: ${EMAIL_BRAND.dark};">
              Proof approved &mdash; ready for production
            </h2>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              ${esc(d.customerName || 'The customer')} clicked Approve on their proof. The build is now
              <strong>in production</strong>, and the picture below is exactly what they approved.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                   style="width: 100%; margin: 0 0 22px; border-collapse: collapse; font-family: ${EMAIL_BRAND.sans}; font-size: 14px;">
              ${row('Order', esc(d.orderNumber || 'no order number'), true)}
              ${row('Product', esc(d.product), false)}
              ${row('Size / finish', `${esc(d.size)} &mdash; ${esc(d.finish)}`, true)}
              ${row('Style', esc(d.style), false)}
              ${row('Edited by us?', edited, true)}
              ${row('Approved', when, false)}
              ${row('Build', `<span style="font-family: monospace;">${esc(id)}</span>`, true)}
            </table>
            ${proofUrl ? `
            <p style="margin: 0 0 22px; text-align: center;">
              <a href="${esc(proofUrl)}"><img src="${esc(proofUrl)}" alt="The approved proof" width="280"
                   style="display: inline-block; width: 280px; max-width: 100%; height: auto; border: 4px solid #000000;" /></a>
            </p>` : ''}
            ${button(adminUrl, 'Open the personalisation')}
            ${orderUrl ? `
            <p style="color: #444; line-height: 1.7; margin: 22px 0 0; font-size: 15px; text-align: center;">
              <a href="${esc(orderUrl)}" style="color: ${EMAIL_BRAND.pink}; font-weight: bold;">The order in the Studio</a>
            </p>` : ''}
          </div>
        </div>`;
}

/**
 * @param {object} opts
 * @param {object} opts.sanity  a client that can read dotted ids
 * @param {string} opts.id      the build ref (pp-...)
 * @param {string} opts.approvedAt  ISO time the approval was recorded
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function notifyProofApproved({ sanity, id, approvedAt = new Date().toISOString() }) {
  try {
    const resend = getResend();
    if (!resend) {
      console.warn(`personalisation-approve: ${id} approved but RESEND_API_KEY is not set — no team email`);
      return { sent: false, reason: 'no RESEND_API_KEY' };
    }

    const doc = await sanity.fetch(
      `*[_id == $id][0]{ _id, kind, templateId, printSize, outputFormat, artworkStyle, productId,
         editCount, orderId, orderNumber, proofUrl,
         "productTitle": *[_type == "product" && _id == ^.productId][0].title,
         "order": *[_type == "order" && _id == ^.orderId][0]{ orderNumber, customerName } }`,
      { id: docIdFor(id) }
    );
    if (!doc) return { sent: false, reason: 'build not found' };

    const d = describeApproval(doc);
    const site = process.env.URL || EMAIL_BRAND.site;
    const to = process.env.TEAM_EMAIL || process.env.EMAIL_FROM || 'orders@comicstripcanvas.co.uk';

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
      to: [to],
      subject: approvalSubject(d),
      html: approvalHtml({
        id,
        d,
        /* The proof, not the basket thumbnail: the proof is the render the
           customer was emailed and approved, and the basket thumbnail can
           still be their pre-edit snapshot. */
        proofUrl: doc.proofUrl || `${site}/api/personalisation-proof/${id}`,
        adminUrl: `${site}/admin/personalisation/${id}`,
        orderUrl: doc.orderId ? studioLink(doc.orderId, 'order') : null,
        approvedAt,
      }),
    });
    if (error) {
      // Resend reports a rejected send by returning an error, not by throwing.
      const msg = typeof error === 'string' ? error : error.message || 'unknown';
      console.warn(`personalisation-approve: WARN team email for ${id} rejected by Resend: ${msg}`);
      return { sent: false, reason: `resend rejected the send: ${msg}` };
    }
    console.log(`personalisation-approve: team notified of ${id} (${d.orderNumber || 'no order number'}) at ${to}`);
    return { sent: true };
  } catch (err) {
    console.warn(`personalisation-approve: WARN team email for ${id} failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}
