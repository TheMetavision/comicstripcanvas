import Stripe from 'stripe';
import { createClient } from '@sanity/client';
import { PRICES } from './_shared/catalog.mjs';
import { sizeLabels } from './_shared/sizes.mjs';
import {
  CLASSIC, FULL_BLEED, isStyle, styleLabel, resolveCustomiseFee,
} from './_shared/artwork-styles.mjs';

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

// Built on first use, not at import. `new Stripe()` throws without a key, and
// at module scope that throw lands at IMPORT time -- before the handler exists
// -- so the browser gets an opaque 500 with no JSON body and no log line from
// this function, on the one request that matters most. Memoised, so warm
// containers still reuse one client. Matches webhook.mjs, order-shipped.mjs and
// personalisation-action.mjs.
let stripeClient;
function getStripe() {
  if (stripeClient) return stripeClient;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
  });
  return stripeClient;
}

const FORMAT_LABELS = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas (Standard Frame)',
  'canvas-gallery': 'Canvas (Gallery Frame)',
};

/* Derived, not spelled out: see _shared/sizes.mjs. This is the text that
   becomes the Stripe line description. */
const SIZE_LABELS = sizeLabels('×');

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

  const stripe = getStripe();
  if (!stripe) {
    console.error('checkout: STRIPE_SECRET_KEY is not set — cannot create a session.');
    return new Response(JSON.stringify({ error: 'Payments are not configured on this deploy' }), {
      status: 503,
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

    /* Which artwork style each line is for, and whether the product actually
       has it. The price is the same either way -- a full-bleed print is the
       same paper and the same ink -- so this changes nothing about what is
       charged. What it changes is which file gets printed, which is why it is
       checked here against Sanity rather than believed: a line asking for a
       style the product does not have would reach the webhook, find no print
       file, and become an order nobody can fulfil. */
    const styleSlugs = [...new Set(items.map((i) => i.slug).filter(Boolean))];
    let hasFullBleed = {};
    if (styleSlugs.length) {
      const rows = await sanity.fetch(
        '*[_type == "product" && slug.current in $slugs]{ "slug": slug.current, ' +
        '"fullBleed": defined(fullBleed.printFile.asset) }',
        { slugs: styleSlugs }
      );
      hasFullBleed = Object.fromEntries(rows.map((r) => [r.slug, !!r.fullBleed]));
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

    /* WHICH KIND of build each line is, asked of the build itself.

       A customised stock design and a personalised one both carry a pp- id on
       the line, and they are priced from different fields -- £5 to put your own
       wording on the shop's artwork, £10 for artwork made from your photographs.
       The browser is not asked which: it would be the one number in the basket
       a customer could choose for themselves. One query for the whole basket,
       and the document says what it is. */
    const buildIds = [...new Set(items.map((i) => i.personalisationId).filter(isPersonalisationId))];
    let buildById = {};
    if (buildIds.length) {
      const rows = await sanity.fetch(
        '*[_type == "pendingPersonalisation" && _id in $ids]{ _id, kind, productId, artworkStyle, ' +
        '"customiseFee": *[_type == "product" && _id == ^.productId][0].customiseFee }',
        { ids: buildIds }
      );
      buildById = Object.fromEntries(rows.map((r) => [r._id, r]));
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

      /* Default Classic, always. Every line written before this existed says
         nothing, and saying nothing has to keep meaning the style the product
         has always been sold in. */
      item.artworkStyle = isStyle(item.artworkStyle) ? item.artworkStyle : CLASSIC;
      if (item.artworkStyle === FULL_BLEED && !hasFullBleed[item.slug]) {
        console.warn(`checkout: refused a full-bleed line for "${item.slug}", which has no full-bleed print file`);
        return new Response(JSON.stringify({ error: 'That artwork style is not available for this product' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }

      item.fee = 0;
      if (item.personalisationId) {
        if (!isPersonalisationId(item.personalisationId)) {
          return new Response(JSON.stringify({ error: 'Invalid personalisation reference' }), {
            status: 400, headers: { 'Content-Type': 'application/json' },
          });
        }
        const build = buildById[item.personalisationId];
        item.buildKind = build?.kind === 'customise' ? 'customise' : 'personalised';

        /* A customised design is priced in PENCE on the product, and almost no
           product carries a value of its own -- the field arrived with the
           feature and nobody has filled it in. An ABSENT fee is therefore the
           ordinary case and resolves to the shared default; a PRESENT one that
           is not a whole number of pence above zero is somebody having typed
           something wrong, and that is still refused rather than guessed at.

           The endpoint that priced the basket line resolves the same field
           through the same function, so the two cannot disagree. */
        let fee;
        if (item.buildKind === 'customise') {
          const resolved = resolveCustomiseFee(build?.customiseFee);
          if (resolved.bad) {
            console.error(
              `customiseFee on the product behind build ${item.personalisationId} is ` +
              `${JSON.stringify(build?.customiseFee)}, which is not a price — refusing.`
            );
            return new Response(JSON.stringify({ error: 'This product is not priced yet. Please contact us.' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
          fee = resolved.pence / 100;
        } else {
          fee = feeBySlug[item.slug];
          // Refuse rather than undercharge: a missing fee would silently sell
          // bespoke artwork at the plain print price. There is no default for
          // this one -- a personalisation fee is set on all three products.
          if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) {
            console.error(`No personalisationFee on product "${item.slug}" — refusing to undercharge.`);
            return new Response(JSON.stringify({ error: 'This personalised product is not priced yet. Please contact us.' }), {
              status: 400, headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        item.fee = fee;
        /* The style is the build's, not the browser's: a customised design was
           made from one of the two styles and the order has to say which. */
        if (item.buildKind === 'customise' && isStyle(build?.artworkStyle)) {
          item.artworkStyle = build.artworkStyle;
        }
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

    const siteUrl = process.env.URL || process.env.SITE_URL || 'https://comicstripcanvas.co.uk';

    // Build Stripe line items
    const lineItems = items.map((item) => ({
      price_data: {
        currency: 'gbp',
        product_data: {
          name: item.title,
          // The basket's own thumbnail. Derived here from the id, never read
          // off the request: this URL is handed to Stripe, which fetches it
          // server-side, so a client-supplied one would be an open request
          // relay. Deriving gives byte-for-byte the URL the basket shows.
          // Stripe tolerates a 404 here (the snapshot is best-effort), so an
          // absent thumbnail costs the line its picture and nothing more.
          ...(item.personalisationId
            ? { images: [`${siteUrl}/api/personalisation-thumb/${item.personalisationId}`] }
            : {}),
          /* The style is named on the Stripe page too, not just in metadata.
             It is the one thing about the line a customer cannot infer from
             the title, and the last screen before they pay is where a wrong
             choice is still cheap to fix. Only when there is a choice to
             have got wrong: "Classic cover" on the 292 products that have no
             second style is noise. */
          description: [
            `${FORMAT_LABELS[item.format] || item.format} — ${SIZE_LABELS[item.size] || item.size}`,
            hasFullBleed[item.slug] ? styleLabel(item.artworkStyle) : null,
            item.fee
              ? `includes £${item.fee.toFixed(2)} ${item.buildKind === 'customise' ? 'customising' : 'personalisation'}`
              : null,
          ].filter(Boolean).join(' — '),
          metadata: {
            productId: item.productId,
            slug: item.slug,
            format: item.format,
            size: item.size,
            /* Read back by the webhook, which resolves it to the print file
               that goes on the order. Stamped on every line, including the
               Classic ones, so an order never has to guess what a blank means. */
            artworkStyle: item.artworkStyle,
            // the webhook reads this back to mark the build paid and render it
            ...(item.personalisationId
              ? {
                personalisationId: item.personalisationId,
                personalisationFee: String(item.fee),
                // What the webhook needs to tell the two apart on the order.
                buildKind: item.buildKind || 'personalised',
              }
              : {}),
          },
        },
        unit_amount: Math.round(item.unitPrice * 100),
      },
      quantity: item.quantity,
    }));

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
