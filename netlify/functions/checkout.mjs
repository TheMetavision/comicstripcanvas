import Stripe from 'stripe';

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

    // Build Stripe line items
    const lineItems = items.map((item) => ({
      price_data: {
        currency: 'gbp',
        product_data: {
          name: item.title,
          description: `${FORMAT_LABELS[item.format] || item.format} — ${SIZE_LABELS[item.size] || item.size}`,
          metadata: {
            productId: item.productId,
            slug: item.slug,
            format: item.format,
            size: item.size,
          },
        },
        unit_amount: Math.round(item.unitPrice * 100), // Convert to pence
      },
      quantity: item.quantity,
    }));

    // Store cart data in metadata for the webhook
    const cartMeta = items.map((item) => ({
      productId: item.productId,
      slug: item.slug,
      title: item.title,
      format: item.format,
      size: item.size,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    }));

    const siteUrl = process.env.URL || process.env.SITE_URL || 'https://comicstripcanvas.co.uk';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
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
              minimum: { unit: 'business_day', value: 3 },
              maximum: { unit: 'business_day', value: 6 },
            },
          },
        },
      ],
      metadata: {
        cartItems: JSON.stringify(cartMeta),
      },
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

export const config = {
  path: '/api/checkout',
};
