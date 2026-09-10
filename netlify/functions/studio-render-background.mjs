import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import sharp from 'sharp';
import { DPI, dataUri, prepareScene, rasterise } from './_shared/render.mjs';
import { STUDIO_STORE, uploadIdFromKey } from './_shared/studio-uploads.mjs';
import { WEB_MASTER, WEB_MASTER_KEY, LISTING_KEY, renderDerivative } from './_shared/derivatives.mjs';

/**
 * Render the print master for a design saved from /admin/studio.
 *
 * studio-save validates, writes the draft and its history entry, and stops.
 * EVERYTHING visual is made here: the scene is composed, then the print master,
 * the listing image, the web master, the Sanity asset uploads and the images[]
 * writes.
 *
 * That split is not tidiness. A synchronous function has ten seconds in
 * production; composing and rasterising this took ~37s measured locally and
 * returned a 500, so anything that rasterises has to be somewhere with minutes.
 * Here there are fifteen of them.
 *
 * What arrives from studio-save is studio/<id>/scene.json: the TOKENISED scene,
 * the recipe, and one blob key per panel pointing at what studio-upload
 * assembled. Composing it means resolving those keys, which is the same
 * {{IMAGE:...}} mechanism the customer pipeline uses -- prepareScene does not
 * care whether a panel's bytes came from a customer's photograph or the shop's
 * own artwork. The scene and the uploads are both deleted once the print
 * exists; they were only ever a handoff, and the print master is the durable
 * copy.
 */

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
  /* Held out here so a failure anywhere below still removes the font directory
     rather than leaving a temp dir behind on a warm container. */
  let cleanupFonts = null;
  try {
    const body = await req.json().catch(() => ({}));
    id = body.id;
    const title = body.title || '(untitled)';
    /* First line, before anything can fail. "Was it even invoked?" was the
       question that took two hours to answer when the trigger was silently
       never sent, and an empty log is the same shape as a crashed one. */
    console.log(`studio-render: invoked for ${id || '(no id)'} ("${title}")`);
    if (!isId(id)) {
      console.error('studio-render: bad or missing id', JSON.stringify(body).slice(0, 200));
      return new Response('Bad id', { status: 400 });
    }

    const store = getStore(STUDIO_STORE);
    const raw = await store.get(`studio/${id}/scene.json`, { type: 'text' });
    if (!raw) {
      console.error(`studio-render: no scene stored for ${id} — nothing to render`);
      return new Response('No scene', { status: 404 });
    }
    const job = JSON.parse(raw);

    const printWidth = Number(body.printWidth || job.printWidth) || 0;
    if (!printWidth) {
      console.error(`studio-render: no print width for ${id}`);
      return new Response('No print width', { status: 400 });
    }

    /* Compose it here, from the same {{IMAGE:...}} tokens the customer pipeline
       resolves. studio-save hands over the tokenised scene and a blob key per
       panel rather than a document with the artwork base64'd into it: one
       20 MB cutout inlines to a 28 MB string, and there is no reason for a
       synchronous function to build that, store it, and have it read straight
       back out again. prepareScene also fetches the full-resolution template
       artwork and checks the fonts, so the print cannot come out in a typeface
       nobody chose. */
    const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
    const keys = job.images || {};
    const scene = await prepareScene({
      sceneSvg: job.svg,
      recipe: job.recipe || {},
      origin,
      imageFor: async (panelId) => {
        const key = keys[panelId];
        if (!uploadIdFromKey(key)) throw new Error(`Panel ${panelId} has no upload key`);
        const buf = await store.get(key, { type: 'arrayBuffer' });
        if (!buf) throw new Error(`The upload for panel ${panelId} is gone from the store (${key})`);
        return dataUri(Buffer.from(buf), key);
      },
    });
    const svg = scene.svg;
    const fontFiles = scene.fontFiles;
    cleanupFonts = scene.cleanup;

    const print = rasterise(svg, fontFiles, printWidth);
    const printPng = print.asPng();

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
    const listing = rasterise(svg, fontFiles, LISTING_WIDTH);
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
    const webSource = rasterise(svg, fontFiles, webRasterWidth).asPng();
    const { data: webJpeg, info: webInfo } = await renderDerivative(sharp, webSource, WEB_MASTER);

    /* Only now. cleanup() deletes the directory the font files are IN, and
       resvg reads them off disk on every rasterise -- calling it after the
       print, as this once did, left the listing and the web master to render
       their text in whatever resvg fell back to. */
    cleanupFonts(); cleanupFonts = null;

    /* ---- attach them ---- */
    const sanity = sanityClient();
    /* The trigger says where to attach; the scene says so too, and either will
       do. Two sources because the trigger body is the thing that can be
       reconstructed wrongly by hand, and the scene is the thing that was
       written at save time and cannot. */
    const docId = isDocId(body.docId) ? body.docId : (isDocId(job.docId) ? job.docId : null);
    if (!isDocId(body.docId) && docId) {
      console.log(`studio-render: no docId in the trigger — using ${docId} from the stored scene`);
    }
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

    /* LAST, and deliberately so. The handoff is what makes this job re-runnable
       -- re-post the same id and it renders and attaches again -- so it must
       outlive every step that can fail, the Sanity uploads included. Deleting
       it before them, as this did, meant a Sanity outage cost the design.
       The uploads go with it: the print master is the durable artefact, and a
       second full-resolution copy under an upload id serves nothing. A delete
       that fails is not worth failing a finished render over; retention sweeps
       the prefix. */
    await store.delete(`studio/${id}/scene.json`)
      .catch((err) => console.warn(`studio-render: could not delete the scene for ${id}: ${err.message}`));
    await Promise.all(Object.values(keys).map(
      (key) => store.delete(key).catch((err) => console.warn(`studio-render: could not delete ${key}: ${err.message}`))
    ));

    console.log(
      `studio-render: "${title}" ${id} -> print ${print.width} x ${print.height} px ` +
      `(${printPng.length} B) @ ${DPI}dpi, listing ${listing.width}x${listing.height}, ` +
      `web master ${webInfo.width}x${webInfo.height} (${webJpeg.length} B) -> ${attached}`
    );
    return new Response('Rendered', { status: 200 });
  } catch (err) {
    if (cleanupFonts) cleanupFonts();
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
//
// /api/studio-render/<id> is a DIFFERENT function, studio-rerender: the
// secret-protected repair route that starts this one again from the stored
// scene. Both rules live in netlify.toml, exact match first.
