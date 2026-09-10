import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import sharp from 'sharp';
import { DPI, loadFonts, assertFontsPresent, rasterise } from './_shared/render.mjs';
import { WEB_MASTER, WEB_MASTER_KEY, LISTING_KEY, renderDerivative } from './_shared/derivatives.mjs';

/**
 * Render the print master for a design saved from /admin/studio.
 *
 * studio-save validates, composes the scene, writes the draft and its history
 * entry, and stops. EVERY picture is made here: the print master, the listing
 * image, the web master, the Sanity asset uploads and the images[] writes.
 *
 * That split is not tidiness. A synchronous function has ten seconds in
 * production; composing and rasterising this took ~37s measured locally and
 * returned a 500, so anything that rasterises has to be somewhere with minutes.
 * Here there are fifteen of them.
 *
 * The scene arrives via the blob store rather than the request body, because
 * it carries its artwork inline and is far too big to post around. It is
 * deleted once the print exists: it was only ever a handoff, and keeping a
 * second copy of the same artwork serves no purpose.
 */

const STUDIO_STORE = 'studio';
const LISTING_WIDTH = 1600;

/* A blob id is either a fresh studio id or, when a product is being redrawn,
   the product's own id -- so this can no longer insist on the studio- shape. */
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(s) && !s.includes('..');
const isDocId = (s) => typeof s === 'string' && /^(drafts\.)?[A-Za-z0-9._-]{1,120}$/.test(s);

const sanityClient = () => (process.env.SANITY_WRITE_TOKEN ? createClient({
  projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN, useCdn: false,
}) : null);

/** images[] with one entry set under a fixed key -- replaced, or appended. */
function putImage(images, key, assetId, alt) {
  const list = Array.isArray(images) ? images.slice() : [];
  const entry = { _type: 'image', _key: key, asset: { _type: 'reference', _ref: assetId }, alt };
  const at = list.findIndex((i) => i && i._key === key);
  if (at >= 0) list[at] = entry; else list.push(entry);
  return { images: list, replaced: at >= 0 };
}

export default async (req) => {
  let id = null;
  try {
    const body = await req.json().catch(() => ({}));
    id = body.id;
    const title = body.title || '(untitled)';
    if (!isId(id)) {
      console.error('studio-render: bad or missing id', JSON.stringify(body).slice(0, 200));
      return new Response('Bad id', { status: 400 });
    }

    const store = getStore(STUDIO_STORE);
    const svg = await store.get(`studio/${id}/scene.svg`, { type: 'text' });
    if (!svg) {
      console.error(`studio-render: no scene stored for ${id} — nothing to render`);
      return new Response('No scene', { status: 404 });
    }

    const meta = await store.getMetadata(`studio/${id}/scene.svg`).catch(() => null);
    const printWidth = Number(body.printWidth || meta?.metadata?.printWidth) || 0;
    if (!printWidth) {
      console.error(`studio-render: no print width for ${id}`);
      return new Response('No print width', { status: 400 });
    }

    /* Fonts are not inlined into the scene -- only images are -- so they have to
       be loaded here too, or resvg silently renders the text in something else. */
    const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
    const fonts = await loadFonts(origin);
    assertFontsPresent(svg, fonts.available);

    const print = rasterise(svg, fonts.fontFiles, printWidth);
    const printPng = print.asPng();
    fonts.cleanup();

    /* One rollback. Replacing the artwork on an existing product overwrites the
       only full-resolution copy of what the shop sells, and a redraw that turns
       out wrong is otherwise a door with no handle on the inside. A brand new
       product has no print.png yet, so this costs it nothing. */
    const previous = await store.get(`studio/${id}/print.png`, { type: 'arrayBuffer' }).catch(() => null);
    if (previous) {
      const prevMeta = await store.getMetadata(`studio/${id}/print.png`).catch(() => null);
      await store.set(`studio/${id}/print-prev.png`, previous, {
        metadata: { ...(prevMeta?.metadata || {}), kind: 'print-prev', supersededAt: new Date().toISOString() },
      });
      console.log(`studio-render: kept the previous print master as studio/${id}/print-prev.png`);
    }

    await store.set(`studio/${id}/print.png`, printPng, {
      metadata: { id, kind: 'print', title, width: print.width, height: print.height, dpi: DPI },
    });

    /* ---- the pictures the shop actually shows ---- */
    const listing = rasterise(svg, fonts.fontFiles, LISTING_WIDTH);
    const listingPng = listing.asPng();
    await store.set(`studio/${id}/listing.png`, listingPng, {
      metadata: { id, kind: 'listing', title, width: listing.width, height: listing.height },
    });

    /* Rasterise big enough that fitting to 2000 is a downscale. renderDerivative
       never upscales, so a listing-sized source would quietly leave the web
       master smaller than its name claims. */
    const portrait = listing.height > listing.width;
    const webRasterWidth = Math.ceil(portrait
      ? WEB_MASTER.side * (listing.width / listing.height)
      : WEB_MASTER.side);
    const webSource = rasterise(svg, fonts.fontFiles, webRasterWidth).asPng();
    const { data: webJpeg, info: webInfo } = await renderDerivative(sharp, webSource, WEB_MASTER);

    await store.delete(`studio/${id}/scene.svg`);

    /* ---- attach them ---- */
    const sanity = sanityClient();
    const docId = isDocId(body.docId) ? body.docId : null;
    let attached = 'no document';
    if (sanity && docId) {
      const slug = (title || 'artwork').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'artwork';
      const [listingAsset, webAsset, printAsset] = await Promise.all([
        sanity.assets.upload('image', listingPng, { filename: `${slug}.png`, contentType: 'image/png' }),
        sanity.assets.upload('image', webJpeg, { filename: `${slug}-${WEB_MASTER.side}.jpg`, contentType: 'image/jpeg' }),
        /* printFile is what a human fulfils from. Leaving it pointing at the
           artwork this render just replaced is how the wrong design gets
           printed; the reference it used to hold is in artworkHistory. */
        sanity.assets.upload('file', printPng, { filename: `${slug}-print.png`, contentType: 'image/png' }),
      ]);

      const current = await sanity.getDocument(docId);
      const withListing = putImage(current?.images, LISTING_KEY, listingAsset._id, `${title} — Comic Strip Canvas`);
      const withWeb = putImage(withListing.images, WEB_MASTER_KEY, webAsset._id, `${title} — Comic Strip Canvas`);
      await sanity.patch(docId).set({
        images: withWeb.images,
        printFile: { _type: 'file', asset: { _type: 'reference', _ref: printAsset._id } },
      }).commit();
      attached = `${docId} (listing ${withListing.replaced ? 'replaced' : 'added'}, ` +
        `web ${withWeb.replaced ? 'replaced' : 'added'}, printFile set)`;
    } else if (docId) {
      console.error('studio-render: SANITY_WRITE_TOKEN is not set — the pictures exist but nothing was attached');
    }

    console.log(
      `studio-render: "${title}" ${id} -> print ${print.width} x ${print.height} px ` +
      `(${printPng.length} B) @ ${DPI}dpi, listing ${listing.width}x${listing.height}, ` +
      `web master ${webInfo.width}x${webInfo.height} (${webJpeg.length} B) -> ${attached}`
    );
    return new Response('Rendered', { status: 200 });
  } catch (err) {
    console.error(`studio-render: ${id} failed:`, err.message);
    /* The draft exists with its history entry, so a failure here costs the
       pictures and nothing else -- and on a redraw the product keeps the
       artwork it already had rather than being left half-changed. Re-runnable
       for the same id as long as the scene is still in the store. */
    return new Response('Failed', { status: 500 });
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// studio-save posts to /api/studio-render, which netlify.toml rewrites to this
// function by name -- the same arrangement as render-personalisation.
