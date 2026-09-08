import Stripe from 'stripe';
import { createClient } from '@sanity/client';
import { PRICES } from './_shared/catalog.mjs';

// Read-only: the dataset is public, so no token is needed here and none is
// given. Fees are content, not code -- they live on the product document so
// they can be changed without a deploy.
const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  useCdn: false,
});

const isPersonalisationId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
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

// Stripe's minimum chargeable amount for GBP.
const STRIPE_MIN_PENCE = 30; // £0.30

// Free postage threshold and standard rate — keep in sync with src/stores/cart.ts
const FREE_SHIPPING_THRESHOLD_PENCE = 5000; // £50.00
const STANDARD_SHIPPING_PENCE = 495;        // £4.95

export default async (req, context) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { items } = await req.json();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: 'Cart is empty' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // A personalised line carries the id of the build it was made from. The
    // artwork fee for it comes off that product's document in Sanity, in one
    // query for the whole basket -- never from the client, and never hard-coded.
    const personalisedSlugs = [...new Set(
      items.filter((i) => i.personalisationId).map((i) => i.slug).filter(Boolean)
    )];
    let feeBySlug = {};
    if (personalisedSlugs.length) {
      const rows = await sanity.fetch(
        '*[_type == "product" && slug.current in $slugs]{ "slug": slug.current, personalisationFee }',
        { slugs: personalisedSlugs }
      );
      feeBySlug = Object.fromEntries(rows.map((r) => [r.slug, r.personalisationFee]));
    }

    // Server-authoritative pricing (H1): never trust the client's unitPrice.
    // Each line's price comes from the PRICES table, looked up by format+size,
    // plus the artwork fee for a personalised build.
    let subtotalPence = 0;
    for (const item of items) {
      const canonical = PRICES[item.format]?.[item.size];
      if (canonical === undefined) {
        return new Response(JSON.stringify({ error: 'Invalid product format or size' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      item.fee = 0;
      if (item.personalisationId) {
        if (!isPersonalisationId(item.personalisationId)) {
          return new Response(JSON.stringify({ error: 'Invalid personalisation reference' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        const fee = feeBySlug[item.slug];
        // Refuse rather than undercharge: a missing fee would silently sell
        // bespoke artwork at the plain print price.
        if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) {
          console.error(`No personalisationFee on product "${item.slug}" — refusing to undercharge.`);
          return new Response(JSON.stringify({ error: 'This personalised product is not priced yet. Please contact us.' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        item.fee = fee;
      }
      if (
        typeof item.quantity !== 'number' ||
        !Number.isInteger(item.quantity) ||
        item.quantity <= 0 ||
        item.quantity > 99
      ) {
        return new Response(JSON.stringify({ error: 'Invalid quantity' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // override anything the client sent; the fee rides on the same line so
      // quantity, totals and the free-postage threshold all stay consistent
      item.unitPrice = canonical + item.fee;
      subtotalPence += Math.round(item.unitPrice * 100) * item.quantity;
    }

    const qualifiesForFreeShipping = subtotalPence >= FREE_SHIPPING_THRESHOLD_PENCE;

    // M5: never hand Stripe a total below its minimum (would 500 at session create).
    const totalPence = subtotalPence + (qualifiesForFreeShipping ? 0 : STANDARD_SHIPPING_PENCE);
    if (totalPence < STRIPE_MIN_PENCE) {
      return new Response(JSON.stringify({ error: 'Order total is below the minimum we can process' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build Stripe line items
    const lineItems = items.map((item) => ({
      price_data: {
        currency: 'gbp',
        product_data: {
          name: item.title,
          description: item.fee
            ? `${FORMAT_LABELS[item.format] || item.format} — ${SIZE_LABELS[item.size] || item.size} — includes £${item.fee.toFixed(2)} personalisation`
            : `${FORMAT_LABELS[item.format] || item.format} — ${SIZE_LABELS[item.size] || item.size}`,
          metadata: {
            productId: item.productId,
            slug: item.slug,
            format: item.format,
            size: item.size,
            // the webhook reads this back to mark the build paid and render it
            ...(item.personalisationId
              ? { personalisationId: item.personalisationId, personalisationFee: String(item.fee) }
              : {}),
          },
        },
        unit_amount: Math.round(item.unitPrice * 100),
      },
      quantity: item.quantity,
    }));

    const siteUrl = process.env.URL || process.env.SITE_URL || 'https://comicstripcanvas.co.uk';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'klarna'],
      mode: 'payment',
      line_items: lineItems,
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
              minimum: { unit: 'business_day', value: 4 },
              maximum: { unit: 'business_day', value: 8 },
            },
          },
        },
      ],
      success_url: `${siteUrl}/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/store`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    return new Response(JSON.stringify({ error: 'Failed to create checkout session' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// NOTE: no `export const config = { path }`. Routed by the forced /api/* redirect
// in netlify.toml (/api/* -> /.netlify/functions/:splat). An inline config.path
// collides with that forced rewrite and 404s. Front end calls /api/checkout.
