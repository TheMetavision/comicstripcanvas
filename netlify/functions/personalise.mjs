import Stripe from 'stripe';
import { createClient } from '@sanity/client';

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

const PRICES = {
  poster: { small: 9.99, medium: 12.99, large: 16.99 },
  'canvas-standard': { small: 26.99, medium: 31.99, large: 44.99 },
  'canvas-gallery': { small: 28.99, medium: 33.99, large: 46.99 },
};

const ART_FEES = {
  cover: 10,
  icon: 10,
  strip: 25,
};

const STYLE_LABELS = {
  cover: 'Comic Book Cover',
  icon: 'Comic Book Icon',
  strip: 'Comic Book Strip',
};

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await req.formData();

    const style = formData.get('style') || '';
    const format = formData.get('format') || '';
    const size = formData.get('size') || '';
    const customerTitle = formData.get('customerTitle') || '';
    const captionText = formData.get('captionText') || '';
    const instructions = formData.get('instructions') || '';
    const customerEmail = formData.get('email') || '';
    const customerName = formData.get('name') || '';

    // Validate required fields
    if (!style || !format || !size || !customerEmail) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Upload images to Sanity
    const imageUrls = [];
    const files = formData.getAll('photos');

    for (const file of files) {
      if (file && file instanceof File && file.size > 0) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const asset = await sanity.assets.upload('image', buffer, {
          filename: file.name,
          contentType: file.type,
        });
        imageUrls.push(asset.url);
      }
    }

    // Calculate pricing
    const basePrice = PRICES[format]?.[size] || 9.99;
    const artFee = ART_FEES[style] || 10;
    const total = basePrice + artFee;

    // Create Stripe checkout session for personalised order
    const siteUrl = process.env.URL || process.env.SITE_URL || 'https://comicstripcanvas.co.uk';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: customerEmail,
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: `Personalised ${STYLE_LABELS[style] || 'Comic Art'}`,
              description: `${FORMAT_LABELS[format] || format} — ${SIZE_LABELS[size] || size}`,
            },
            unit_amount: Math.round(basePrice * 100),
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: `Artwork Fee — ${STYLE_LABELS[style] || 'Custom'}`,
              description: 'Custom artwork creation and proofing',
            },
            unit_amount: Math.round(artFee * 100),
          },
          quantity: 1,
        },
      ],
      shipping_address_collection: {
        allowed_countries: ['GB', 'IE', 'US', 'CA', 'AU', 'NZ', 'FR', 'DE', 'ES', 'IT', 'NL', 'BE'],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: 'gbp' },
            display_name: 'Free UK P&P',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 10 },
            },
          },
        },
      ],
      metadata: {
        isPersonalised: 'true',
        style,
        format: FORMAT_LABELS[format] || format,
        size: SIZE_LABELS[size] || size,
        customerTitle,
        captionText,
        instructions,
        imageUrls: JSON.stringify(imageUrls),
        basePrice: String(basePrice),
        artFee: String(artFee),
      },
      success_url: `${siteUrl}/personalise-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/personalise`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Personalisation submission error:', error);
    return new Response(JSON.stringify({ error: 'Failed to process submission' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = {
  path: '/api/personalise',
};
