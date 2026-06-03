import Stripe from 'stripe';
import { createClient } from '@sanity/client';
import { PRICES } from './_shared/catalog.mjs';

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

// Resolve the chosen style to its label + artwork fee. Uses the same
// `includes()` convention as the webhook, so singular/plural/prefixed variants
// ('strip', 'comic-book-strip', 'comic-book-strips') all resolve correctly and
// can't drift. Returns null for an unrecognised style (→ rejected below).
function resolveStyle(style) {
  const s = String(style).toLowerCase();
  if (s.includes('strip')) return { label: 'Comic Book Strip', fee: 25 };
  if (s.includes('icon')) return { label: 'Comic Book Icon', fee: 10 };
  if (s.includes('cover')) return { label: 'Comic Book Cover', fee: 10 };
  return null;
}

// Keep in sync with checkout.mjs
const FREE_SHIPPING_THRESHOLD_PENCE = 5000; // £50.00
const STANDARD_SHIPPING_PENCE = 495;        // £4.95

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const style = body.style || '';
    const format = body.format || '';
    const size = body.size || '';
    const customerTitle = body.customerTitle || '';
    const captionText = body.captionText || '';
    const instructions = body.instructions || '';
    const photoUrls = Array.isArray(body.photoUrls) ? body.photoUrls : [];

    if (!style || !format || !size) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: style, format, and size are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const styleConfig = resolveStyle(style);
    if (!styleConfig) {
      return new Response(
        JSON.stringify({ error: 'Invalid style' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const basePrice = PRICES[format]?.[size];
    if (basePrice === undefined) {
      return new Response(
        JSON.stringify({ error: 'Invalid product format or size' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const subtotalPence = Math.round(basePrice * 100) + Math.round(styleConfig.fee * 100);
    const qualifiesForFreeShipping = subtotalPence >= FREE_SHIPPING_THRESHOLD_PENCE;

    const siteUrl = process.env.URL || process.env.SITE_URL || 'https://comicstripcanvas.co.uk';

    // ── Write the full personalisation brief to Sanity FIRST ──────────────
    // This carries ALL photo URLs with no length limit. Only the document _id
    // travels through Stripe metadata.
    const pendingDoc = await sanity.create({
      _type: 'pendingPersonalisation',
      style: styleConfig.label,
      customerTitle,
      captionText,
      instructions,
      uploadedImages: photoUrls,
      createdAt: new Date().toISOString(),
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'klarna'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: `Personalised ${styleConfig.label}`,
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
              name: `Artwork Fee — ${styleConfig.label}`,
              description: 'Custom artwork creation',
            },
            unit_amount: Math.round(styleConfig.fee * 100),
          },
          quantity: 1,
        },
      ],
      shipping_address_collection: {
        allowed_countries: ['GB'],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: {
              amount: qualifiesForFreeShipping ? 0 : STANDARD_SHIPPING_PENCE,
              currency: 'gbp',
            },
            display_name: qualifiesForFreeShipping
              ? 'FREE UK delivery (orders over £50)'
              : 'Standard UK delivery',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 8 },
              maximum: { unit: 'business_day', value: 12 },
            },
          },
        },
      ],
      metadata: {
        isPersonalised: 'true',
        personalisationRef: pendingDoc._id,
        style: styleConfig.label,
        format: FORMAT_LABELS[format] || format,
        size: SIZE_LABELS[size] || size,
        basePrice: String(basePrice),
        artFee: String(styleConfig.fee),
      },
      success_url: `${siteUrl}/personalise-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/personalise`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Personalisation error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to process submission' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/personalise is routed by the forced /api/* redirect in netlify.toml
// (/api/* -> /.netlify/functions/:splat). An inline config.path collides with
// that forced rewrite and 404s, so we rely on the redirect like contact does.
