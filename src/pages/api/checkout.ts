import type { APIRoute } from 'astro';
import Stripe from 'stripe';

export const prerender = false;

const stripeSecret = import.meta.env.STRIPE_SECRET_KEY;
const siteUrl = import.meta.env.PUBLIC_SITE_URL || 'https://comicstripcanvas.co.uk';

// Free postage threshold and standard rate — keep in sync with src/stores/cart.ts
const FREE_SHIPPING_THRESHOLD_PENCE = 5000; // £50.00
const STANDARD_SHIPPING_PENCE = 495; // £4.95

interface IncomingItem {
  productId: string;
  slug: string;
  title: string;
  format: string;
  size: string;
  quantity: number;
  unitPrice: number;
  imageUrl?: string;
}

const FORMAT_LABELS: Record<string, string> = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas (Standard)',
  'canvas-gallery': 'Canvas (Gallery)',
};

const SIZE_LABELS: Record<string, string> = {
  small: 'Small (12x8")',
  medium: 'Medium (16x12")',
  large: 'Large (24x16")',
};

export const POST: APIRoute = async ({ request }) => {
  if (!stripeSecret) {
    return new Response(
      JSON.stringify({ error: 'Stripe is not configured on the server.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: { items?: IncomingItem[] };
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return new Response(
      JSON.stringify({ error: 'Cart is empty.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Sanitise + compute subtotal server-side. Never trust client prices for the
  // shipping decision — we recompute it from what the client sent and refuse
  // anything weird (negative price, zero quantity, etc.). For a hardened build
  // you'd also look up the canonical price from src/data/products PRICES here.
  let subtotalPence = 0;
  for (const item of items) {
    if (
      typeof item.unitPrice !== 'number' ||
      typeof item.quantity !== 'number' ||
      item.unitPrice <= 0 ||
      item.quantity <= 0 ||
      item.quantity > 99
    ) {
      return new Response(
        JSON.stringify({ error: 'Invalid item in cart.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    subtotalPence += Math.round(item.unitPrice * 100) * item.quantity;
  }

  const qualifiesForFreeShipping = subtotalPence >= FREE_SHIPPING_THRESHOLD_PENCE;

  const stripe = new Stripe(stripeSecret);

  const lineItems = items.map((item) => {
    const formatLabel = FORMAT_LABELS[item.format] || item.format;
    const sizeLabel = SIZE_LABELS[item.size] || item.size;
    const productData: {
      name: string;
      description: string;
      metadata: Record<string, string>;
      images?: string[];
    } = {
      name: item.title,
      description: `${formatLabel} \u00b7 ${sizeLabel}`,
      metadata: {
        productId: item.productId,
        slug: item.slug,
        format: item.format,
        size: item.size,
      },
    };
    if (item.imageUrl && /^https?:\/\//.test(item.imageUrl)) {
      productData.images = [item.imageUrl];
    }
    return {
      price_data: {
        currency: 'gbp',
        unit_amount: Math.round(item.unitPrice * 100),
        product_data: productData,
      },
      quantity: item.quantity,
    };
  });

  const shippingOptions = [
    {
      shipping_rate_data: {
        type: 'fixed_amount' as const,
        fixed_amount: {
          amount: qualifiesForFreeShipping ? 0 : STANDARD_SHIPPING_PENCE,
          currency: 'gbp',
        },
        display_name: qualifiesForFreeShipping
          ? 'FREE UK delivery (orders over £50)'
          : 'Standard UK delivery',
        delivery_estimate: {
          minimum: { unit: 'business_day' as const, value: 3 },
          maximum: { unit: 'business_day' as const, value: 7 },
        },
      },
    },
  ];

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ['GB'] },
      shipping_options: shippingOptions,
      success_url: `${siteUrl}/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/store`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[api/checkout] Stripe error:', err);
    return new Response(
      JSON.stringify({ error: err?.message || 'Checkout failed.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
