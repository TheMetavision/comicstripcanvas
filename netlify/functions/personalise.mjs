import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
  'comic-book-cover': 10,
  'comic-book-icon': 10,
  'comic-book-strip': 25,
};

const STYLE_LABELS = {
  'comic-book-cover': 'Comic Book Cover',
  'comic-book-icon': 'Comic Book Icon',
  'comic-book-strip': 'Comic Book Strip',
};

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let style, format, size, customerTitle, captionText, instructions;

    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      style = formData.get('style') || '';
      format = formData.get('format') || '';
      size = formData.get('size') || '';
      customerTitle = formData.get('customerTitle') || '';
      captionText = formData.get('captionText') || '';
      instructions = formData.get('instructions') || '';
    } else {
      const body = await req.json();
      style = body.style || '';
      format = body.format || '';
      size = body.size || '';
      customerTitle = body.customerTitle || '';
      captionText = body.captionText || '';
      instructions = body.instructions || '';
    }

    if (!style || !format || !size) {
      return new Response(JSON.stringify({ error: 'Missing required fields: style, format, and size are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Calculate pricing
    const basePrice = PRICES[format]?.[size] || 9.99;
    const artFee = ART_FEES[style] || 10;

    const siteUrl = process.env.URL || process.env.SITE_URL || 'https://comicstripcanvas.co.uk';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
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
        allowed_countries: ['GB'],
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
        style: STYLE_LABELS[style] || style,
        format: FORMAT_LABELS[format] || format,
        size: SIZE_LABELS[size] || size,
        customerTitle: customerTitle || '',
        captionText: captionText || '',
        instructions: instructions || '',
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
    console.error('Personalisation error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Failed to process submission' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = {
  path: '/api/personalise',
};
