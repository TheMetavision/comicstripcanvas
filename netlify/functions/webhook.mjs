import Stripe from 'stripe';
import { createClient } from '@sanity/client';
import { Resend } from 'resend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
});

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const FORMAT_LABELS = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas (Standard Frame)',
  'canvas-gallery': 'Canvas (Gallery Frame)',
};

const SIZE_LABELS = {
  small: 'Small (12×8")',
  medium: 'Medium (16×12")',
  large: 'Large (24×16")',
};

// Brand constants
const BRAND = {
  logo: 'https://comicstripcanvas.co.uk/logo.png',
  yellow: '#FFF200',
  pink: '#EC008C',
  cyan: '#00AEEF',
  dark: '#111111',
  site: 'https://comicstripcanvas.co.uk',
};

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    try {
      const isPersonalised = session.metadata?.isPersonalised === 'true';

      // Stripe API 2025+ moved shipping details under collected_information
      const shipping =
        session.collected_information?.shipping_details?.address ||
        session.shipping_details?.address ||
        session.customer_details?.address ||
        {};
      const customerName =
        session.collected_information?.shipping_details?.name ||
        session.shipping_details?.name ||
        session.customer_details?.name ||
        'Customer';
      const customerEmail = session.customer_details?.email || '';
      const totalAmount = (session.amount_total || 0) / 100;

      let lineItems;
      let personalisationDetails = undefined;
      let itemRows;

      if (isPersonalised) {
        const style = session.metadata?.style || '';
        const format = session.metadata?.format || '';
        const size = session.metadata?.size || '';
        const basePrice = parseFloat(session.metadata?.basePrice || '0');
        const artFee = parseFloat(session.metadata?.artFee || '0');
        const customerTitle = session.metadata?.customerTitle || '';
        const captionText = session.metadata?.captionText || '';
        const instructions = session.metadata?.instructions || '';

        // Parse photo URLs — stored as comma-separated string in metadata
        const photoUrlsRaw = session.metadata?.photoUrls || '';
        const photoUrls = photoUrlsRaw
          ? photoUrlsRaw.split(', ').map((u) => u.trim()).filter(Boolean)
          : [];

        lineItems = [
          {
            _type: 'object',
            _key: `pers-${Date.now()}`,
            productTitle: `Personalised ${style}`,
            format,
            size,
            quantity: 1,
            unitPrice: basePrice,
          },
          {
            _type: 'object',
            _key: `artfee-${Date.now() + 1}`,
            productTitle: 'Artwork Fee',
            format: '—',
            size: '—',
            quantity: 1,
            unitPrice: artFee,
          },
        ];

        personalisationDetails = {
          style,
          customerTitle,
          captionText,
          instructions,
          uploadedImages: photoUrls,
          proofStatus: 'awaiting-proof',
        };

        itemRows = `
          <tr>
            <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">Personalised ${style}</td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${format}</td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${size}</td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: center;">1</td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: right;">£${basePrice.toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">Artwork Fee</td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #eee;" colspan="3">Custom artwork creation</td>
            <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: right;">£${artFee.toFixed(2)}</td>
          </tr>`;
      } else {
        const cartItems = JSON.parse(session.metadata?.cartItems || '[]');

        lineItems = cartItems.map((item) => ({
          _type: 'object',
          _key: `${item.slug}-${item.format}-${item.size}-${Date.now()}`,
          productTitle: item.title,
          format: FORMAT_LABELS[item.format] || item.format,
          size: SIZE_LABELS[item.size] || item.size,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        }));

        itemRows = cartItems
          .map(
            (item) =>
              `<tr>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${item.title}</td>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${FORMAT_LABELS[item.format] || item.format}</td>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${SIZE_LABELS[item.size] || item.size}</td>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: right;">£${(item.unitPrice * item.quantity).toFixed(2)}</td>
              </tr>`
          )
          .join('');
      }

      // Create order in Sanity
      const orderDoc = {
        _type: 'order',
        stripeSessionId: session.id,
        stripePaymentId: session.payment_intent,
        customerName,
        customerEmail,
        shippingAddress: {
          line1: shipping.line1 || '',
          line2: shipping.line2 || '',
          city: shipping.city || '',
          county: shipping.state || '',
          postcode: shipping.postal_code || '',
          country: shipping.country || '',
        },
        lineItems,
        totalAmount,
        status: 'received',
        isPersonalised,
        createdAt: new Date().toISOString(),
      };

      if (personalisationDetails) {
        orderDoc.personalisationDetails = personalisationDetails;
      }

      await sanity.create(orderDoc);

      console.log(`${isPersonalised ? 'Personalised o' : 'O'}rder created in Sanity for session ${session.id}`);

      // ── Email templates ──────────────────────────────────────
      const emailHeader = `
        <div style="background: ${BRAND.dark}; padding: 32px 24px; text-align: center;">
          <img src="${BRAND.logo}" alt="Comic Strip Canvas" style="max-width: 280px; height: auto; display: block; margin: 0 auto;" />
          <p style="color: #777; margin: 16px 0 0; font-size: 13px; letter-spacing: 1px;">BOLD POP CULTURE WALL ART</p>
        </div>`;

      const emailFooter = `
        <div style="background: ${BRAND.dark}; padding: 24px; text-align: center;">
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
              <th style="padding: 12px 16px; text-align: right; color: ${BRAND.yellow}; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Price</th>
            </tr>
          </thead>
          <tbody style="color: #333;">
            ${itemRows}
          </tbody>
          <tfoot>
            <tr style="background: #f9f9f9;">
              <td colspan="3" style="padding: 14px 16px; text-align: right; font-weight: bold; font-size: 15px;">Shipping:</td>
              <td colspan="2" style="padding: 14px 16px; text-align: right; font-weight: bold; color: #28a745;">FREE UK P&P</td>
            </tr>
            <tr style="background: ${BRAND.dark};">
              <td colspan="3" style="padding: 14px 16px; text-align: right; font-weight: bold; color: #fff; font-size: 16px;">Total:</td>
              <td colspan="2" style="padding: 14px 16px; text-align: right; font-weight: bold; color: ${BRAND.yellow}; font-size: 18px;">£${totalAmount.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>`;

      const shippingBlock = `
        <div style="background: #f8f8f8; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${BRAND.pink};">
          <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #666;">Shipping Address</strong><br/><br/>
          <span style="color: #333; line-height: 1.8;">
            ${customerName}<br/>
            ${shipping.line1 || ''}${shipping.line2 ? '<br/>' + shipping.line2 : ''}<br/>
            ${shipping.city || ''}${shipping.state ? ', ' + shipping.state : ''}<br/>
            ${shipping.postal_code || ''}<br/>
            ${shipping.country || ''}
          </span>
        </div>`;

      // Photo gallery block for personalised orders (team email only)
      const photoGallery = isPersonalised && personalisationDetails?.uploadedImages?.length > 0
        ? `<div style="margin: 20px 0; padding: 20px; background: #f0f9ff; border-radius: 8px; border-left: 4px solid ${BRAND.cyan};">
            <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: ${BRAND.cyan};">Customer Photos (${personalisationDetails.uploadedImages.length})</strong><br/><br/>
            ${personalisationDetails.uploadedImages.map((url, i) => `
              <div style="display: inline-block; margin: 4px;">
                <a href="${url}" target="_blank" style="text-decoration: none;">
                  <img src="${url}?w=150&h=150&fit=crop" alt="Photo ${i + 1}" style="width: 120px; height: 120px; object-fit: cover; border: 2px solid ${BRAND.cyan}; border-radius: 4px;" />
                </a>
              </div>
            `).join('')}
            <br/><br/>
            ${personalisationDetails.uploadedImages.map((url, i) => `<a href="${url}" style="color: ${BRAND.cyan}; margin-right: 12px;">Full-size Photo ${i + 1}</a>`).join('')}
          </div>`
        : '';

      // ── Send customer confirmation email ──────────────────────
      try {
        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
          to: [customerEmail],
          subject: isPersonalised
            ? `🎨 Custom Order Confirmed — Comic Strip Canvas`
            : `Order Confirmed — Comic Strip Canvas`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff;">
              ${emailHeader}
              
              <div style="padding: 32px 24px;">
                <h2 style="margin: 0 0 8px; font-size: 24px; color: ${BRAND.dark};">
                  ${isPersonalised ? '🎨 ' : ''}Thanks for your order, ${customerName}!
                </h2>
                <p style="color: #666; line-height: 1.7; margin: 0 0 24px; font-size: 15px;">
                  ${isPersonalised
                    ? 'Your personalised order has been received! Our artists will create a digital proof within <strong style="color: ' + BRAND.cyan + ';">24-48 hours</strong>. We won\'t print until you\'ve approved it — so keep an eye on your inbox.'
                    : 'Your order has been received and is being prepared. All our products are made to order, so please allow <strong>3-6 working days</strong> for dispatch.'}
                </p>
                
                ${orderTable}
                ${shippingBlock}

                ${isPersonalised ? `
                <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid ${BRAND.cyan};">
                  <strong style="color: ${BRAND.cyan}; font-size: 14px;">What happens next?</strong>
                  <ol style="color: #555; line-height: 2; margin: 12px 0 0; padding-left: 20px;">
                    <li>Our artists review your photos and brief</li>
                    <li>We create a digital proof (24-48 hours)</li>
                    <li>You review and approve (up to 2 revisions included)</li>
                    <li>We print and dispatch (3-6 working days after approval)</li>
                  </ol>
                </div>
                ` : ''}
                
                <p style="color: #888; line-height: 1.6; margin: 24px 0 0; font-size: 13px;">
                  We'll send you another email when your order has been dispatched. If you have any questions, just reply to this email.
                </p>
                
                <p style="color: #aaa; margin-top: 24px; font-size: 12px;">
                  Order ref: ${session.payment_intent}<br/>
                  Placed: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              </div>
              
              ${emailFooter}
            </div>
          `,
        });
        console.log(`Customer confirmation email sent to ${customerEmail}`);
      } catch (emailErr) {
        console.error('Failed to send customer email:', emailErr);
      }

      // ── Send production team notification email ───────────────
      const teamEmail = process.env.TEAM_EMAIL || process.env.EMAIL_FROM || 'orders@comicstripcanvas.co.uk';
      try {
        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
          to: [teamEmail],
          subject: `${isPersonalised ? '🎨 PERSONALISED' : '📦 NEW'} ORDER — £${totalAmount.toFixed(2)} — ${customerName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff;">
              <div style="background: ${isPersonalised ? BRAND.cyan : BRAND.pink}; padding: 20px; text-align: center;">
                <h1 style="color: #fff; margin: 0; font-size: 22px; letter-spacing: 1px;">${isPersonalised ? '🎨 PERSONALISED ORDER' : '📦 NEW ORDER RECEIVED'}</h1>
                <p style="color: rgba(255,255,255,0.8); margin: 6px 0 0; font-size: 13px;">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
              </div>
              
              <div style="padding: 24px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 20px;">
                  <div>
                    <h2 style="margin: 0 0 4px; font-size: 20px;">${customerName}</h2>
                    <p style="color: #666; margin: 0;"><a href="mailto:${customerEmail}" style="color: ${BRAND.pink};">${customerEmail}</a></p>
                  </div>
                  <div style="text-align: right;">
                    <span style="font-size: 28px; font-weight: bold; color: ${isPersonalised ? BRAND.cyan : BRAND.pink};">£${totalAmount.toFixed(2)}</span>
                  </div>
                </div>
                
                ${orderTable}
                ${shippingBlock}

                ${isPersonalised && personalisationDetails ? `
                <div style="margin: 20px 0; padding: 20px; background: #fff9e6; border-radius: 8px; border-left: 4px solid ${BRAND.yellow};">
                  <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #b8860b;">Personalisation Brief</strong><br/><br/>
                  <table style="font-size: 14px; color: #333;">
                    <tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #666;">Style:</td><td style="padding: 4px 0;">${personalisationDetails.style}</td></tr>
                    ${personalisationDetails.customerTitle ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #666;">Name/Title:</td><td style="padding: 4px 0;">${personalisationDetails.customerTitle}</td></tr>` : ''}
                    ${personalisationDetails.captionText ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #666;">Caption:</td><td style="padding: 4px 0;">${personalisationDetails.captionText}</td></tr>` : ''}
                    ${personalisationDetails.instructions ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #666;">Instructions:</td><td style="padding: 4px 0;">${personalisationDetails.instructions}</td></tr>` : ''}
                  </table>
                </div>

                ${photoGallery}
                ` : ''}
                
                <div style="margin-top: 24px; padding: 20px; background: #f0fff0; border-radius: 8px; border-left: 4px solid #28a745;">
                  <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #28a745;">Action Required</strong><br/><br/>
                  <ol style="color: #444; line-height: 2; margin: 0; padding-left: 20px; font-size: 14px;">
                    <li>Open <a href="https://comicstripcanvas.sanity.studio" style="color: ${BRAND.pink}; font-weight: bold;">Sanity Studio</a> to view this order</li>
                    ${isPersonalised
                      ? '<li>Download customer photos from links above</li><li>Create artwork proof and email to customer</li><li>Once approved → print and dispatch</li>'
                      : '<li>Prepare artwork for printing</li><li>Update status to "In Production"</li><li>Add tracking and update to "Dispatched"</li>'}
                  </ol>
                </div>
                
                <p style="color: #aaa; margin-top: 20px; font-size: 11px;">
                  Stripe: ${session.id} | Payment: ${session.payment_intent}
                </p>
              </div>
            </div>
          `,
        });
        console.log(`Team notification sent to ${teamEmail}`);
      } catch (emailErr) {
        console.error('Failed to send team notification:', emailErr);
      }
    } catch (err) {
      console.error('Error processing checkout.session.completed:', err);
      return new Response('Webhook processing error (logged)', { status: 200 });
    }
  }

  return new Response('OK', { status: 200 });
};

export const config = {
  path: '/api/webhook',
};
