import Stripe from 'stripe';
import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import { emailHeader } from './_shared/email.mjs';
import { FULL_BLEED, styleOr, styleLabel } from './_shared/artwork-styles.mjs';
import { sizeLabels } from './_shared/sizes.mjs';
import { deleteBuild } from './_shared/delete-build.mjs';

// Same trap as the Resend client below: `new Stripe()` throws without a key,
// and at module scope that throw lands at IMPORT time, so Stripe would get an
// opaque 500 and retry the delivery forever with nothing in the logs to say
// why. Memoised. Mirrors getStripe() below.
let stripeClient;
function getStripe() {
  if (stripeClient) return stripeClient;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
  });
  return stripeClient;
}

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

// Built on first use, not at import. `new Resend()` throws when RESEND_API_KEY
// is absent, and at module scope that throw happens at IMPORT time -- before
// the handler exists -- so the platform surfaces an opaque 500 with no log line
// from this function. Deferring it turns the same condition into something
// readable. Memoised, so warm containers still reuse one client. Mirrors
// the getResend() helper above.
let resendClient;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const FORMAT_LABELS = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas (Standard Frame)',
  'canvas-gallery': 'Canvas (Gallery Frame)',
};

/* Derived, not spelled out: see _shared/sizes.mjs. The label is what gets
   written onto the order line, so an order placed before Medium moved keeps
   saying 16x12 -- that is what it was sold as. */
const SIZE_LABELS = sizeLabels('×');

// Brand constants
const BRAND = {
  yellow: '#FFF200',
  pink: '#EC008C',
  cyan: '#00AEEF',
  dark: '#111111',
  site: 'https://comicstripcanvas.co.uk',
  studio: 'https://comicstripcanvas.sanity.studio',
  studioPersonalisations: 'https://comicstripcanvas.sanity.studio/structure/personalisations',
};

const ORDER_COUNTER_ID = 'orderCounter';

/**
 * Mark every personalised build on a paid session, and kick off its render.
 *
 * checkout.mjs stamps personalisationId onto each personalised line item's
 * product metadata, so the builds are recoverable from the session with no
 * metadata size limit. Exported so it can be exercised on its own.
 */
export async function settlePersonalisations({ session, orderId, orderNumber, lineItems, deps }) {
  const { sanity: db = sanity, fetch: http = fetch, siteUrl = process.env.URL
    || process.env.SITE_URL || 'https://comicstripcanvas.co.uk' } = deps || {};

  const ids = [...new Set(
    (lineItems || [])
      .map((li) => li.price?.product?.metadata?.personalisationId)
      .filter(Boolean)
  )];
  if (!ids.length) return [];

  const results = [];
  for (const id of ids) {
    try {
      await db
        .patch(id)
        .set({ status: 'paid', stripeSessionId: session.id, orderId, orderNumber })
        .commit();
    } catch (err) {
      // Never fail the order for this: the payment is taken and the order
      // exists. Surface it loudly instead so it can be picked up by hand.
      console.error(`Could not mark personalisation ${id} paid:`, err.message);
      results.push({ id, marked: false, rendered: false, error: err.message });
      continue;
    }

    // The renderer does not exist yet. Ask for it anyway so the wiring is real,
    // and say so plainly when it is not there rather than failing silently.
    let rendered = false;
    try {
      const res = await http(`${siteUrl}/api/render-personalisation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, orderId, orderNumber }),
      });
      rendered = res.ok;
      if (res.status === 404) {
        console.log(`Render for ${id} not triggered: /api/render-personalisation returned 404 (function not deployed yet).`);
      } else if (!res.ok) {
        console.error(`Render for ${id} failed: ${res.status}`);
      }
    } catch (err) {
      console.error(`Could not reach the render function for ${id}:`, err.message);
    }
    results.push({ id, marked: true, rendered });
  }
  return results;
}

/**
 * Atomically allocate the next order number, e.g. "CSC-1001".
 * Uses a Sanity transaction with a patch precondition so two simultaneous
 * orders can never receive the same number.
 */
async function getNextOrderNumber() {
  // Ensure the counter document exists (no-op if it already does).
  await sanity.createIfNotExists({
    _id: ORDER_COUNTER_ID,
    _type: 'orderCounter',
    lastOrderNumber: 1000,
  });

  // Retry loop in case of a concurrent write collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const counter = await sanity.getDocument(ORDER_COUNTER_ID);
    const current = counter?.lastOrderNumber || 1000;
    const next = current + 1;

    try {
      await sanity
        .patch(ORDER_COUNTER_ID, {
          // Only apply if nobody else has changed it since we read it.
          ifRevisionID: counter._rev,
        })
        .set({ lastOrderNumber: next })
        .commit();
      return `CSC-${next}`;
    } catch (err) {
      // Revision mismatch — someone else incremented it. Retry.
      if (attempt === 4) throw err;
    }
  }
  throw new Error('Could not allocate order number after 5 attempts');
}

// ── Shared fulfilment ──────────────────────────────────
// Runs for a PAID session. Invoked by checkout.session.completed (when the
// session is already paid) and by checkout.session.async_payment_succeeded
// (delayed methods like Klarna, once the payment clears). Idempotent via the
// deterministic order _id, so it is safe from either path or on a retry.
async function fulfilOrder(session) {
  // Non-null: the handler refuses the request before ever getting here.
  const stripe = getStripe();
      // ── Idempotency guard (C3) ───────────────────────────────
      // Stripe may deliver the same event more than once. Use a deterministic
      // order _id derived from the session id, and bail out before ANY side
      // effect (order-number increment, pending delete, email sends) if an
      // order for this session already exists.
      const orderId = `order-${session.id}`;
      const alreadyProcessed = await sanity.getDocument(orderId);
      if (alreadyProcessed) {
        console.log(`Duplicate webhook for session ${session.id} — order ${alreadyProcessed.orderNumber} already exists. Skipping.`);
        return new Response('Already processed', { status: 200 });
      }

      // The old /personalise flow announces itself in session metadata. Builder
      // lines do not -- each carries personalisationId on its own line item -- so
      // this flag selects the old code path and nothing else.
      const legacyPersonalised = session.metadata?.isPersonalised === 'true';
      let builderPersonalised = false;

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
      const customerEmail = (session.customer_details?.email || '').trim();
      const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail);
      const totalAmount = (session.amount_total || 0) / 100;

      // Real shipping cost from the Stripe session (pence -> pounds).
      const shippingPence = session.shipping_cost?.amount_total || 0;
      const shippingCost = shippingPence / 100;
      const shippingLabel =
        shippingPence === 0 ? 'FREE UK P&P' : `£${shippingCost.toFixed(2)}`;
      const shippingColor = shippingPence === 0 ? '#28a745' : '#333333';

      let lineItems;
      let personalisationDetails = undefined;
      let itemRows;
      let personalisationRef = '';
      /* Lines that are selling stock artwork but resolved no print file. The
         order is still created and the customer still gets their confirmation
         -- they have paid and we owe them the print -- but whoever fulfils it
         has nothing to download, so it is said plainly at the top of the team
         email and the order is pulled out in the Studio. Collected here rather
         than recomputed from lineItems later so the email and the console
         warning cannot disagree about which lines are affected. */
      const missingPrint = [];
      // Track whether this is specifically a Comic Book Strip order, so the
      // email copy can be tailored (no Name/Title or Caption references).
      let isStrip = false;

      if (legacyPersonalised) {
        const style = session.metadata?.style || '';
        const format = session.metadata?.format || '';
        const size = session.metadata?.size || '';
        const basePrice = parseFloat(session.metadata?.basePrice || '0');
        const artFee = parseFloat(session.metadata?.artFee || '0');
        isStrip = style.toLowerCase().includes('strip');

        // Fetch the full personalisation brief from the pending document.
        // This carries ALL photo URLs with no length limit.
        personalisationRef = session.metadata?.personalisationRef || '';
        let pending = null;
        if (personalisationRef) {
          try {
            pending = await sanity.getDocument(personalisationRef);
          } catch (err) {
            console.error(`Could not fetch pending personalisation ${personalisationRef}:`, err.message);
          }
        }

        const customerTitle = pending?.customerTitle || '';
        const captionText = pending?.captionText || '';
        const instructions = pending?.instructions || '';
        const photoUrls = Array.isArray(pending?.uploadedImages) ? pending.uploadedImages : [];

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
        // H5: rebuild line items from the Stripe session itself rather than from
        // session metadata (capped at 500 chars/key, which breaks on large carts).
        // checkout.mjs stamps productId/slug/format/size onto each line item's
        // product metadata and the title onto its name, so everything is
        // recoverable here with no size limit. limit:100 (Stripe defaults to 10).
        const stripeItems = await stripe.checkout.sessions.listLineItems(session.id, {
          expand: ['data.price.product'],
          limit: 100,
        });

        // An order is personalised if anything in it was built in the builder,
        // whatever the session metadata does or does not say.
        builderPersonalised = stripeItems.data.some(
          (li) => li.price?.product?.metadata?.personalisationId
        );

        const stdItems = stripeItems.data.map((li) => {
          const meta = li.price?.product?.metadata || {};
          return {
            slug: meta.slug || '',
            title: li.price?.product?.name || li.description || 'Item',
            format: meta.format || '',
            size: meta.size || '',
            quantity: li.quantity || 1,
            unitPrice: (li.price?.unit_amount || 0) / 100,
            /* Absent on anything ordered before the second style existed, and
               on every line of a product that only has one. Classic either
               way -- that is what those orders were. */
            artworkStyle: styleOr(meta.artworkStyle),
            /* A build id on the line means the artwork is the CUSTOMER'S, and
               the print file for it is the one their own render produces --
               not the stock product's, which is a different picture with the
               shop's wording on it. */
            personalisationId: meta.personalisationId || null,
            buildKind: meta.buildKind || (meta.personalisationId ? 'personalised' : null),
          };
        });

        /* Resolve the print file for each line NOW, while the order is being
           written, and store the URL on it.

           A reference would be tidier and would be wrong: the product's artwork
           can be replaced next week, and an order that points at "whatever this
           product's print file is today" would quietly start describing a
           different picture from the one somebody paid for. The URL is a
           snapshot of what was bought. Sanity keeps the asset either way, so
           the link stays good.

           One query for the whole order. A failure here must not fail the
           order: the line is still correct about its style, and a picker can
           open the product. */
        const printBySlug = {};
        try {
          const slugs = [...new Set(stdItems.map((i) => i.slug).filter(Boolean))];
          if (slugs.length) {
            const rows = await sanity.fetch(
              '*[_type == "product" && slug.current in $slugs]{ "slug": slug.current, ' +
              '"classic": printFile.asset->url, "fullBleed": fullBleed.printFile.asset->url, ' +
              /* The listing image the customer was looking at, per style, as an
                 asset id rather than a URL. Snapshotted onto the line below so a
                 later artwork replacement cannot quietly change what we agreed
                 to send: a new upload is a new asset, and this id still points
                 at the picture that was bought. */
              '"classicListing": images[0].asset._ref, ' +
              '"fullBleedListing": fullBleed.listingImage.asset._ref }',
              { slugs }
            );
            for (const r of rows) printBySlug[r.slug] = r;
          }
        } catch (err) {
          console.error('webhook: could not resolve print files for the order:', err.message);
        }

        lineItems = stdItems.map((item, idx) => {
          /* Only for a line that is selling the shop's own artwork. A
             personalised or customised line is fulfilled from the render that
             belongs to its build, and stamping the stock file here would put a
             plausible, wrong picture in front of whoever prints it. */
          const printFile = item.personalisationId
            ? null
            : (printBySlug[item.slug]?.[item.artworkStyle] || null);
          if (!printFile && !item.personalisationId) {
            console.warn(
              `webhook: no ${item.artworkStyle} print file for "${item.slug}" — ` +
              'the order line will name the style but carry no file'
            );
            missingPrint.push({ title: item.title, style: styleLabel(item.artworkStyle) });
          }
          /* Snapshotted for every line, built or not: a customised line is
             fulfilled from its own render, but the listing image is still what
             the customer was shown and is still worth pinning. */
          const listingRef = printBySlug[item.slug]?.[
            item.artworkStyle === FULL_BLEED ? 'fullBleedListing' : 'classicListing'
          ] || null;
          return {
            _type: 'object',
            /* The style is part of the key: two lines of the same product in
               the same format and size are now a real possibility, and they
               are different orders to fulfil. */
            _key: `${item.slug || 'item'}-${item.artworkStyle}-${item.format}-${item.size}-${idx}`,
            productTitle: item.title,
            format: FORMAT_LABELS[item.format] || item.format,
            size: SIZE_LABELS[item.size] || item.size,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            artworkStyle: item.artworkStyle,
            ...(printFile ? { printFile } : {}),
            ...(listingRef
              ? {
                listingImageRef: {
                  _type: 'image',
                  asset: { _type: 'reference', _ref: listingRef },
                },
              }
              : {}),
            ...(item.buildKind ? { buildKind: item.buildKind } : {}),
          };
        });

        itemRows = stdItems
          .map(
            (item) =>
              `<tr>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${item.title}${
                  item.artworkStyle === FULL_BLEED
                    ? `<br><span style="font-size: 12px; color: #777;">${styleLabel(item.artworkStyle)}</span>`
                    : ''
                }</td>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${FORMAT_LABELS[item.format] || item.format}</td>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee;">${SIZE_LABELS[item.size] || item.size}</td>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
                <td style="padding: 12px 16px; border-bottom: 1px solid #eee; text-align: right;">£${(item.unitPrice * item.quantity).toFixed(2)}</td>
              </tr>`
          )
          .join('');
      }

      const isPersonalised = legacyPersonalised || builderPersonalised;

      // Allocate the human-readable order number. If allocation fails, throw so
      // the outer handler returns 500 and Stripe retries — the idempotency guard
      // makes the retry safe, and we never issue a non-sequential number.
      const orderNumber = await getNextOrderNumber();

      // Create order in Sanity (deterministic _id = idempotency key)
      const orderDoc = {
        _id: orderId,
        _type: 'order',
        orderNumber,
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
        shippingCost,
        totalAmount,
        status: 'received',
        isPersonalised,
        shippingEmailSent: false,
        createdAt: new Date().toISOString(),
        paidAt: new Date().toISOString(),
      };

      if (personalisationDetails) {
        orderDoc.personalisationDetails = personalisationDetails;
      }

      if (!emailLooksValid) {
        orderDoc.notifyError = 'No valid customer email on the Stripe session — confirmation not sent.';
      }

      try {
        await sanity.create(orderDoc);
      } catch (err) {
        // 409 = a concurrent delivery already created this order. Treat as
        // already-processed: don't re-send emails or delete anything twice.
        if (err?.statusCode === 409 || /already exist/i.test(err?.message || '')) {
          console.log(`Concurrent duplicate for session ${session.id} — order already created. Skipping.`);
          return new Response('Already processed', { status: 200 });
        }
        throw err; // real failure → outer catch → 500 → Stripe retries
      }

      console.log(`${isPersonalised ? 'Personalised o' : 'O'}rder ${orderNumber} created in Sanity for session ${session.id}`);

      /* The old flow deleted the pending document here, because it had just
         copied everything it held onto the order and the document was spent.

         A BUILDER BUILD MUST NOT BE DELETED HERE, and this is why the same
         line is not simply re-pointed at the new ids: the build is not a copy
         of anything, it is the source the print file is rendered FROM, and the
         render has not run yet when this line is reached. settlePersonalisations
         below marks each build `paid` instead, which is in retention's
         PROTECTED set, so it survives until it has been rendered, approved and
         dispatched -- and retention collects it then.

         Nothing reaches this line any longer: personalisationRef comes only
         from session metadata that the deleted /personalise endpoint used to
         set. Left as a comment rather than as an `if` that can never be true,
         because the next person to read it deserves the reason rather than the
         wreckage. */

      // Builder-made lines: mark each build paid and start its render. Runs after
      // the order is persisted so a retry can never render against no order.
      try {
        const paidLines = await stripe.checkout.sessions.listLineItems(session.id, {
          expand: ['data.price.product'],
          limit: 100,
        });
        const settled = await settlePersonalisations({
          session, orderId, orderNumber, lineItems: paidLines.data,
        });
        if (settled.length) {
          console.log(`Settled ${settled.length} personalisation(s) for ${orderNumber}: `
            + settled.map((s) => `${s.id}=${s.marked ? 'paid' : 'FAILED'}/${s.rendered ? 'render queued' : 'no render'}`).join(', '));
        }
      } catch (err) {
        console.error('Could not settle personalisations for', session.id, err.message);
      }

      // ── Email templates ──────────────────────────────────────
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
              <td colspan="2" style="padding: 14px 16px; text-align: right; font-weight: bold; color: ${shippingColor};">${shippingLabel}</td>
            </tr>
            <tr style="background: ${BRAND.dark};">
              <td colspan="3" style="padding: 14px 16px; text-align: right; font-weight: bold; color: #fff; font-size: 16px;">Total:</td>
              <td colspan="2" style="padding: 14px 16px; text-align: right; font-weight: bold; color: ${BRAND.yellow}; font-size: 18px;">£${totalAmount.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>`;

      /* Team email only, and first in the body. A line with no print file looks
         completely normal everywhere else -- the product has a listing image,
         checkout took the money, the confirmation went out -- so the only place
         it can be caught is here, before anyone starts packing it. */
      const missingPrintBlock = missingPrint.length
        ? `<div style="background: #fdecea; padding: 18px 20px; border-bottom: 3px solid #d32f2f;">
            <strong style="font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #b71c1c;">
              ⚠ Print file missing &mdash; ${missingPrint.length === 1 ? 'this order cannot be printed yet' : `${missingPrint.length} lines cannot be printed yet`}
            </strong>
            <div style="margin-top: 12px;">
              ${missingPrint
                .map(
                  (m) =>
                    `<p style="margin: 4px 0; font-size: 15px; font-weight: bold; color: #b71c1c;">PRINT FILE MISSING &mdash; ${m.title} (${m.style})</p>`
                )
                .join('')}
            </div>
            <p style="margin: 12px 0 0; font-size: 13px; color: #611a15; line-height: 1.6;">
              The customer has paid and their confirmation has been sent. There is no
              file to download for the line${missingPrint.length === 1 ? '' : 's'} above &mdash; the product
              carries no high-res print file for that artwork style. Produce the artwork, attach it
              to the product in the Studio, then print. This order is listed under
              <a href="${BRAND.studio}" style="color: #b71c1c; font-weight: bold;">Orders &rarr; Needs attention</a>.
            </p>
          </div>`
        : '';

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
            <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: ${BRAND.cyan};">Customer Photos (${personalisationDetails.uploadedImages.length})${isStrip ? ' — IN PANEL ORDER 1→12' : ''}</strong><br/><br/>
            ${personalisationDetails.uploadedImages.map((url, i) => `
              <div style="display: inline-block; margin: 4px; text-align: center;">
                <a href="${url}" target="_blank" style="text-decoration: none;">
                  <img src="${url}?w=150&h=150&fit=crop" alt="Photo ${i + 1}" style="width: 120px; height: 120px; object-fit: cover; border: 2px solid ${BRAND.cyan}; border-radius: 4px;" />
                </a>
                <div style="font-size: 11px; color: ${BRAND.cyan}; font-weight: bold; margin-top: 4px;">${isStrip ? `Panel ${i + 1}` : `Photo ${i + 1}`}</div>
              </div>
            `).join('')}
            <br/><br/>
            ${personalisationDetails.uploadedImages.map((url, i) => `<a href="${url}" style="color: ${BRAND.cyan}; margin-right: 12px;">Full-size ${isStrip ? `Panel ${i + 1}` : `Photo ${i + 1}`}</a>`).join('')}
          </div>`
        : '';

      // Record an email-delivery failure on the order so it's visible in Studio.
      // Never throws — a failed patch is logged, not propagated.
      const flagOrderError = async (field, message) => {
        try {
          await sanity.patch(orderId).set({ [field]: message }).commit();
        } catch (patchErr) {
          console.error(`Could not record ${field} on order ${orderId}:`, patchErr.message);
        }
      };

      // ── Send customer confirmation email ──────────────────────
      // Personalised orders get a Strip-aware intro line — strips don't mention
      // Name/Title or Caption because those fields aren't collected for strips.
      const customerIntroText = !isPersonalised
        ? 'Your order has been received and is being prepared. All our products are made to order, so please allow <strong>3-6 working days</strong> for dispatch, plus 1-2 working days for delivery.'
        : isStrip
        ? 'Your personalised comic strip order has been received! Our artists will arrange your 12 photos across the strip panels, then print and dispatch your order within <strong style="color: ' + BRAND.cyan + ';">7-10 working days</strong>, plus 1-2 working days for delivery.'
        : 'Your personalised order has been received! Our artists will create your custom artwork, then print and dispatch your order within <strong style="color: ' + BRAND.cyan + ';">7-10 working days</strong>, plus 1-2 working days for delivery.';

      if (emailLooksValid) {
      try {
        const resend = getResend();
        if (!resend) throw new Error('RESEND_API_KEY is not set on this deploy');
        const { error } = await resend.emails.send({
          from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
          to: [customerEmail],
          subject: isPersonalised
            ? `🎨 Custom Order Confirmed (${orderNumber}) — Comic Strip Canvas`
            : `Order Confirmed (${orderNumber}) — Comic Strip Canvas`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff;">
              ${emailHeader}
              
              <div style="padding: 32px 24px;">
                <h2 style="margin: 0 0 8px; font-size: 24px; color: ${BRAND.dark};">
                  ${isPersonalised ? '🎨 ' : ''}Thanks for your order, ${customerName}!
                </h2>
                <p style="color: #666; line-height: 1.7; margin: 0 0 24px; font-size: 15px;">
                  ${customerIntroText}
                </p>
                
                ${orderTable}
                ${shippingBlock}

                <p style="color: #888; line-height: 1.6; margin: 24px 0 0; font-size: 13px;">
                  We'll send you another email when your order has been dispatched. If you have any questions, just reply to this email.
                </p>
                
                <p style="color: #aaa; margin-top: 24px; font-size: 12px;">
                  Order number: <strong style="color: ${BRAND.pink};">${orderNumber}</strong><br/>
                  Placed: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              </div>
              
              ${emailFooter}
            </div>
          `,
        });
        if (error) {
          console.error('Resend returned an error for customer email:', error);
          await flagOrderError('customerEmailError', `${error.name || 'Error'}: ${error.message || 'unknown'}`);
        } else {
          console.log(`Customer confirmation email sent to ${customerEmail}`);
        }
      } catch (emailErr) {
        console.error('Failed to send customer email:', emailErr);
        await flagOrderError('customerEmailError', emailErr?.message || String(emailErr));
      }
      } else {
        console.error(`Skipping customer email for order ${orderNumber} — missing/invalid address.`);
      }

      // ── Send production team notification email ───────────────
      const teamEmail = process.env.TEAM_EMAIL || process.env.EMAIL_FROM || 'orders@comicstripcanvas.co.uk';
      try {
        const resend = getResend();
        if (!resend) throw new Error('RESEND_API_KEY is not set on this deploy');
        const { error } = await resend.emails.send({
          from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
          to: [teamEmail],
          subject: `${isPersonalised ? '🎨 PERSONALISED' : '📦 NEW'} ORDER ${orderNumber} — £${totalAmount.toFixed(2)} — ${customerName}`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #ffffff;">
              <div style="background: ${isPersonalised ? BRAND.cyan : BRAND.pink}; padding: 20px; text-align: center;">
                <h1 style="color: #fff; margin: 0; font-size: 22px; letter-spacing: 1px;">${isPersonalised ? '🎨 PERSONALISED ORDER' : '📦 NEW ORDER RECEIVED'}</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 6px 0 0; font-size: 15px; font-weight: bold;">${orderNumber}</p>
                <p style="color: rgba(255,255,255,0.8); margin: 4px 0 0; font-size: 13px;">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
              </div>
              ${missingPrintBlock}
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
                    ${!isStrip && personalisationDetails.customerTitle ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #666;">Name/Title:</td><td style="padding: 4px 0;">${personalisationDetails.customerTitle}</td></tr>` : ''}
                    ${!isStrip && personalisationDetails.captionText ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #666;">Caption:</td><td style="padding: 4px 0;">${personalisationDetails.captionText}</td></tr>` : ''}
                    ${personalisationDetails.instructions ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #666;">${isStrip ? 'Notes:' : 'Instructions:'}</td><td style="padding: 4px 0;">${personalisationDetails.instructions}</td></tr>` : ''}
                    ${isStrip ? `<tr><td style="padding: 4px 12px 4px 0; font-weight: bold; color: #666;">Panel Order:</td><td style="padding: 4px 0;">Photos appear in upload order — Panel 1 to Panel 12, left-to-right, top-to-bottom.</td></tr>` : ''}
                  </table>
                </div>

                ${photoGallery}
                ` : ''}
                
                <div style="margin-top: 24px; padding: 20px; background: #f0fff0; border-radius: 8px; border-left: 4px solid #28a745;">
                  <strong style="font-size: 13px; text-transform: uppercase; letter-spacing: 1px; color: #28a745;">Action Required</strong><br/><br/>
                  ${builderPersonalised ? `
                  <p style="color: #444; line-height: 1.7; margin: 0; font-size: 14px;">
                    This order was built by the customer in the product builder. Their approved
                    layout, photos and notes are on the
                    <a href="${BRAND.studioPersonalisations}" style="color: ${BRAND.pink}; font-weight: bold;">Personalisations</a>
                    entry in the Studio (Needs attention). The print file is produced by the render
                    job and appears on the same entry once ready &mdash; nothing to prepare by hand.
                  </p>` : `
                  <ol style="color: #444; line-height: 2; margin: 0; padding-left: 20px; font-size: 14px;">
                    <li>Open <a href="${BRAND.studio}" style="color: ${BRAND.pink}; font-weight: bold;">Sanity Studio</a> to view this order</li>
                    ${isPersonalised
                      ? '<li>Download customer photos from links above</li><li>Create the custom artwork from the brief</li><li>Print and dispatch, then add tracking and update status to "Dispatched"</li>'
                      : '<li>Prepare artwork for printing</li><li>Update status to "In Production"</li><li>Add tracking and update to "Dispatched"</li>'}
                  </ol>`}
                </div>
                
                <p style="color: #aaa; margin-top: 20px; font-size: 11px;">
                  ${orderNumber} | Stripe: ${session.id} | Payment: ${session.payment_intent}
                </p>
              </div>
            </div>
          `,
        });
        if (error) {
          console.error('Resend returned an error for team email:', error);
          await flagOrderError('teamEmailError', `${error.name || 'Error'}: ${error.message || 'unknown'}`);
        } else {
          console.log(`Team notification sent to ${teamEmail}`);
        }
      } catch (emailErr) {
        console.error('Failed to send team notification:', emailErr);
        await flagOrderError('teamEmailError', emailErr?.message || String(emailErr));
      }

  return new Response('OK', { status: 200 });
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // A 503 rather than a 200: nothing has been recorded yet, so Stripe should
  // keep the event and redeliver it once the deploy is configured properly.
  const stripe = getStripe();
  if (!stripe) {
    console.error('Stripe webhook: STRIPE_SECRET_KEY is not set — cannot verify or fulfil.');
    return new Response(
      JSON.stringify({ error: 'STRIPE_SECRET_KEY is not set on this deploy' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
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

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      // H3: only fulfil PAID sessions. Delayed methods (Klarna, bank debits)
      // fire 'completed' while still unpaid, then 'async_payment_succeeded'
      // once the payment clears — so we must not fulfil an unpaid one here.
      if (session.payment_status !== 'paid') {
        console.log(`Session ${session.id} completed but unpaid (payment_status: ${session.payment_status}). Awaiting async_payment_succeeded.`);
        return new Response('Awaiting payment', { status: 200 });
      }
      return await fulfilOrder(session);
    }

    if (event.type === 'checkout.session.async_payment_succeeded') {
      // Delayed payment has cleared — fulfil now (idempotent with 'completed').
      return await fulfilOrder(event.data.object);
    }

    if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object;
      console.error(`Async payment failed for session ${session.id} (${session.customer_details?.email || 'no email'}). No order created.`);
      return new Response('Payment failed — no fulfilment', { status: 200 });
    }

    if (event.type === 'checkout.session.expired') {
      /* An abandoned checkout. The photographs are the customer's and they are
         not coming back for them, so they go now rather than sitting until the
         thirty-day sweep notices.

         Resolved from the LINE ITEMS, the same way fulfilOrder finds them.
         This used to read session.metadata.personalisationRef, which only the
         deleted /personalise endpoint ever set -- so from the day the builder
         replaced it this handler has quietly done nothing at all, and every
         abandoned build has waited out the full thirty days instead. */
      const session = event.data.object;
      let ids = [];
      try {
        const lines = await stripe.checkout.sessions.listLineItems(session.id, {
          limit: 100, expand: ['data.price.product'],
        });
        ids = [...new Set(
          (lines?.data || [])
            .map((l) => l.price?.product?.metadata?.personalisationId)
            .filter(Boolean)
        )];
      } catch (err) {
        console.error(`Expired session ${session.id}: could not read its line items:`, err.message);
      }

      /* And the old field, still honoured: an order placed through the old flow
         cannot arrive any more, but reading one costs nothing and throwing it
         away would be the same mistake this handler is being fixed for. */
      const legacyRef = session.metadata?.personalisationRef;
      if (legacyRef && !ids.includes(legacyRef)) ids.push(legacyRef);

      for (const id of ids) {
        try {
          /* Blobs first, then the document. A failure here leaves the whole
             build intact for retention rather than half of it for nobody. */
          const { blobs } = await deleteBuild(id, { sanity });
          console.log(
            `Expired session ${session.id} — deleted pending personalisation ${id} `
            + `and ${blobs.length} blob(s)`
          );
        } catch (err) {
          console.error(
            `Could not delete pending personalisation ${id} on expiry (left for retention):`,
            err.message
          );
        }
      }
      if (!ids.length) console.log(`Expired session ${session.id} — no personalisation to delete.`);
      return new Response('Expired session handled', { status: 200 });
    }
  } catch (err) {
    console.error(`Error processing ${event?.type}:`, err);
    // 500 → Stripe retries; the idempotency guard inside fulfilOrder keeps retries safe.
    return new Response('Webhook processing error — will retry', { status: 500 });
  }

  return new Response('OK', { status: 200 });
};

// NOTE: no `export const config = { path }`. Routed by the forced /api/* redirect
// in netlify.toml (/api/* -> /.netlify/functions/:splat). This is the STRIPE webhook;
// Stripe must POST to https://comicstripcanvas.co.uk/api/webhook (the redirect sends it
// to /.netlify/functions/webhook). An inline config.path collides and 404s.
