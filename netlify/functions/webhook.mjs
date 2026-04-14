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
      // Determine if this is a personalised order
      const isPersonalised = session.metadata?.isPersonalised === 'true';

      const shipping = session.shipping_details?.address || {};
      const customerName = session.shipping_details?.name || session.customer_details?.name || 'Customer';
      const customerEmail = session.customer_details?.email || '';
      const totalAmount = (session.amount_total || 0) / 100;

      let lineItems;
      let personalisationDetails = undefined;
      let itemRows;

      if (isPersonalised) {
        // Personalised order — build from metadata
        const style = session.metadata?.style || '';
        const format = session.metadata?.format || '';
        const size = session.metadata?.size || '';
        const basePrice = parseFloat(session.metadata?.basePrice || '0');
        const artFee = parseFloat(session.metadata?.artFee || '0');
        const imageUrls = JSON.parse(session.metadata?.imageUrls || '[]');

        const styleLabels = { cover: 'Comic Book Cover', icon: 'Comic Book Icon', strip: 'Comic Book Strip' };

        lineItems = [
          {
            _type: 'object',
            _key: `pers-${style}-${Date.now()}`,
            productTitle: `Personalised ${styleLabels[style] || 'Comic Art'}`,
            format,
            size,
            quantity: 1,
            unitPrice: basePrice,
          },
          {
            _type: 'object',
            _key: `artfee-${Date.now()}`,
            productTitle: 'Artwork Fee',
            format: '—',
            size: '—',
            quantity: 1,
            unitPrice: artFee,
          },
        ];

        personalisationDetails = {
          style: styleLabels[style] || style,
          customerTitle: session.metadata?.customerTitle || '',
          captionText: session.metadata?.captionText || '',
          instructions: session.metadata?.instructions || '',
          uploadedImages: imageUrls,
          proofStatus: 'awaiting-proof',
        };

        itemRows = `
          <tr>
            <td style="padding: 8px 12px; border-bottom: 1px solid #333;">Personalised ${styleLabels[style] || 'Comic Art'}</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #333;">${format}</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #333;">${size}</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #333; text-align: center;">1</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #333; text-align: right;">£${basePrice.toFixed(2)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; border-bottom: 1px solid #333;">Artwork Fee</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #333;" colspan="3">—</td>
            <td style="padding: 8px 12px; border-bottom: 1px solid #333; text-align: right;">£${artFee.toFixed(2)}</td>
          </tr>`;
      } else {
        // Standard cart order
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
                <td style="padding: 8px 12px; border-bottom: 1px solid #333;">${item.title}</td>
                <td style="padding: 8px 12px; border-bottom: 1px solid #333;">${FORMAT_LABELS[item.format] || item.format}</td>
                <td style="padding: 8px 12px; border-bottom: 1px solid #333;">${SIZE_LABELS[item.size] || item.size}</td>
                <td style="padding: 8px 12px; border-bottom: 1px solid #333; text-align: center;">${item.quantity}</td>
                <td style="padding: 8px 12px; border-bottom: 1px solid #333; text-align: right;">£${(item.unitPrice * item.quantity).toFixed(2)}</td>
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

      const orderTable = `
        <table style="width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; font-size: 14px;">
          <thead>
            <tr style="background: #1a1a1a; color: #FFF200;">
              <th style="padding: 10px 12px; text-align: left;">Product</th>
              <th style="padding: 10px 12px; text-align: left;">Format</th>
              <th style="padding: 10px 12px; text-align: left;">Size</th>
              <th style="padding: 10px 12px; text-align: center;">Qty</th>
              <th style="padding: 10px 12px; text-align: right;">Price</th>
            </tr>
          </thead>
          <tbody style="color: #333;">
            ${itemRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4" style="padding: 10px 12px; text-align: right; font-weight: bold;">Total:</td>
              <td style="padding: 10px 12px; text-align: right; font-weight: bold; color: #EC008C;">£${totalAmount.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>`;

      const shippingBlock = `
        <div style="background: #f5f5f5; padding: 16px; border-radius: 4px; margin: 16px 0;">
          <strong>Ship to:</strong><br/>
          ${customerName}<br/>
          ${shipping.line1 || ''}${shipping.line2 ? '<br/>' + shipping.line2 : ''}<br/>
          ${shipping.city || ''}${shipping.state ? ', ' + shipping.state : ''}<br/>
          ${shipping.postal_code || ''}<br/>
          ${shipping.country || ''}
        </div>`;

      // ── Send customer confirmation email ──────────────────────
      try {
        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
          to: [customerEmail],
          subject: `Order Confirmed — Comic Strip Canvas`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a;">
              <div style="background: #111111; padding: 24px; text-align: center;">
                <h1 style="color: #FFF200; margin: 0; font-size: 28px; font-family: 'Arial Black', Arial, sans-serif;">COMIC STRIP CANVAS</h1>
                <p style="color: #999; margin: 8px 0 0; font-size: 13px;">Bold Pop Culture Wall Art</p>
              </div>
              
              <div style="padding: 32px 24px;">
                <h2 style="margin: 0 0 8px; font-size: 22px; color: #111;">Thanks for your order, ${customerName}!</h2>
                <p style="color: #666; line-height: 1.6; margin: 0 0 24px;">
                  Your order has been received and is being prepared. ${isPersonalised ? 'Our artists will create a digital proof within 24-48 hours. We won\'t print until you\'ve approved it.' : 'All our products are made to order, so please allow 3-6 working days for dispatch.'}
                </p>
                
                ${orderTable}
                ${shippingBlock}
                
                <p style="color: #666; line-height: 1.6; margin: 24px 0 0;">
                  We'll send you another email when your order has been dispatched with tracking details. If you have any questions, just reply to this email.
                </p>
                
                <p style="color: #999; margin-top: 32px; font-size: 13px;">
                  Payment ID: ${session.payment_intent}<br/>
                  Order placed: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              </div>
              
              <div style="background: #111111; padding: 16px; text-align: center; font-size: 11px; color: #666;">
                <p style="margin: 0;">&copy; 2026 Comic Strip Canvas. All rights reserved.</p>
                <p style="margin: 4px 0 0;"><a href="https://comicstripcanvas.co.uk" style="color: #EC008C;">comicstripcanvas.co.uk</a></p>
              </div>
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
          subject: `${isPersonalised ? '🎨 PERSONALISED ORDER' : 'NEW ORDER'} — £${totalAmount.toFixed(2)} — ${customerName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #1a1a1a;">
              <div style="background: ${isPersonalised ? '#00AEEF' : '#EC008C'}; padding: 16px; text-align: center;">
                <h1 style="color: #fff; margin: 0; font-size: 22px;">${isPersonalised ? '🎨 PERSONALISED ORDER' : 'NEW ORDER RECEIVED'}</h1>
              </div>
              
              <div style="padding: 24px;">
                <h2 style="margin: 0 0 4px;">${customerName}</h2>
                <p style="color: #666; margin: 0 0 20px;">${customerEmail}</p>
                
                ${orderTable}
                ${shippingBlock}

                ${isPersonalised && personalisationDetails ? `
                <div style="margin-top: 20px; padding: 16px; background: #E8F8FF; border-left: 4px solid #00AEEF; border-radius: 4px;">
                  <strong>Personalisation Details:</strong><br/>
                  <strong>Style:</strong> ${personalisationDetails.style}<br/>
                  ${personalisationDetails.customerTitle ? `<strong>Name/Title:</strong> ${personalisationDetails.customerTitle}<br/>` : ''}
                  ${personalisationDetails.captionText ? `<strong>Caption:</strong> ${personalisationDetails.captionText}<br/>` : ''}
                  ${personalisationDetails.instructions ? `<strong>Instructions:</strong> ${personalisationDetails.instructions}<br/>` : ''}
                  ${personalisationDetails.uploadedImages.length > 0 ? `<br/><strong>Uploaded Photos (${personalisationDetails.uploadedImages.length}):</strong><br/>${personalisationDetails.uploadedImages.map((url, i) => `<a href="${url}" style="color: #00AEEF;">Photo ${i + 1}</a>`).join(' | ')}` : ''}
                </div>
                ` : ''}
                
                <div style="margin-top: 20px; padding: 16px; background: #FFF9E6; border-left: 4px solid #FFF200; border-radius: 4px;">
                  <strong>Next steps:</strong><br/>
                  1. Open <a href="https://comicstripcanvas.sanity.studio" style="color: #EC008C;">Sanity Studio</a> to view/manage this order<br/>
                  ${isPersonalised ? '2. Download customer photos and create artwork proof<br/>3. Email proof to customer for approval<br/>4. Once approved, print and dispatch' : '2. Prepare artwork for printing<br/>3. Update order status to "In Production" when started<br/>4. Add tracking number and update to "Dispatched" when shipped'}
                </div>
                
                <p style="color: #999; margin-top: 20px; font-size: 12px;">
                  Stripe Session: ${session.id}<br/>
                  Payment Intent: ${session.payment_intent}
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
      // Still return 200 so Stripe doesn't retry endlessly
      return new Response('Webhook processing error (logged)', { status: 200 });
    }
  }

  return new Response('OK', { status: 200 });
};

export const config = {
  path: '/api/webhook',
};
