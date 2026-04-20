export const prerender = false;

import type { APIRoute } from 'astro';
import { getSecret } from 'astro:env/server';
import Stripe from 'stripe';

const FORMAT_LABELS: Record<string, string> = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas (Standard Frame)',
  'canvas-gallery': 'Canvas (Gallery Frame)',
};

const SIZE_LABELS: Record<string, string> = {
  small: 'Small (12×8")',
  medium: 'Medium (16×12")',
  large: 'Large (24×16")',
};

const PRICES: Record<string, Record<string, number>> = {
  poster: { small: 9.99, medium: 12.99, large: 16.99 },
  'canvas-standard': { small: 26.99, medium: 31.99, large: 44.99 },
  'canvas-gallery': { small: 28.99, medium: 33.99, large: 46.99 },
};

const STYLE_CONFIG: Record<string, { label: string; fee: number }> = {
  cover: { label: 'Comic Book Cover', fee: 10 },
  icon: { label: 'Comic Book Icon', fee: 10 },
  strip: { label: 'Comic Book Strip', fee: 25 },
  'comic-book-cover': { label: 'Comic Book Cover', fee: 10 },
  'comic-book-icon': { label: 'Comic Book Icon', fee: 10 },
  'comic-book-strip': { label: 'Comic Book Strip', fee: 25 },
};

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const stripeKey = getSecret('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    const stripe = new Stripe(stripeKey);

    const body = await request.json();
    const style = body.style || '';
    const format = body.format || '';
    const size = body.size || '';
    const customerTitle = body.customerTitle || '';
    const captionText = body.captionText || '';
    const instructions = body.instructions || '';
    const photoUrls: string[] = body.photoUrls || [];

    if (!style || !format || !size) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: style, format, and size are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const styleConfig = STYLE_CONFIG[style] || { label: style, fee: 10 };
    const basePrice = PRICES[format]?.[size] || 9.99;

    const siteUrl = getSecret('SITE_URL') || getSecret('URL') || 'https://comicstripcanvas.co.uk';

    // Stripe metadata values must be strings under 500 chars
    // Store photo URLs as comma-separated, truncated if needed
    const photoUrlsMeta = photoUrls.join(', ').substring(0, 490);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
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
              description: 'Custom artwork creation and proofing',
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
        style: styleConfig.label,
        format: FORMAT_LABELS[format] || format,
        size: SIZE_LABELS[size] || size,
        customerTitle: customerTitle || '',
        captionText: captionText || '',
        instructions: instructions || '',
        basePrice: String(basePrice),
        artFee: String(styleConfig.fee),
        photoCount: String(photoUrls.length),
        photoUrls: photoUrlsMeta,
      },
      success_url: `${siteUrl}/personalise-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/personalise`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Personalisation error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to process submission' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
