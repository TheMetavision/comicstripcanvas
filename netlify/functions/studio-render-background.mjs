import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import sharp from 'sharp';
import { DPI, dataUri, memoryNote, prepareScene, rasterise } from './_shared/render.mjs';
import { STUDIO_STORE, uploadIdFromKey } from './_shared/studio-uploads.mjs';
import { WEB_MASTER, renderDerivative, setListingImage, recordDisplacedListing } from './_shared/derivatives.mjs';

/**
 * Render the print master for a design saved from /admin/studio.
 *
 * studio-save validates, writes the draft and its history entry, and stops.
 * EVERYTHING visual is made here: the scene is composed, then the print master,
 * the one web image the shop shows, the Sanity asset uploads and the images[]
 * write.
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

/* A blob id is either a fresh studio id or, when a product is being redrawn,
   the product's own id -- so this can no longer insist on the studio- shape. */
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(s) && !s.includes('..');
const isDocId = (s) => typeof s === 'string' && /^(drafts\.)?[A-Za-z0-9._-]{1,120}$/.test(s);

const sanityClient = () => (process.env.SANITY_WRITE_TOKEN ? createClient({
  projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN, useCdn: false,
}) : null);

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
       never sent, and an empty log is the same shape as a crashed one.
       The memory goes with it because the second failure was the container
       being killed for allocating -- there is no exception to catch when that
       happens, so the size it had has to be written down before the work
       starts or it cannot be read afterwards. */
    console.log(`studio-render: invoked for ${id || '(no id)'} ("${title}") — ${memoryNote()}`);
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

    /* ---- the picture the shop actually shows ---- */
    /* ONE web image, not two. This used to rasterise the scene twice more: a
       1600px PNG stored as images[_key="listing"] and a 2000px JPEG stored as
       images[_key="web-master"], which put two near-identical pictures of the
       same artwork next to each other in the product gallery. The JPEG wins on
       every count -- larger, sRGB-converted, a twentieth of the bytes -- so it
       is the only one now, and it keeps the "listing" key so nothing reading
       images[0] or querying by key has to change.

       The 1600px pass went with it. Its blob, studio/<id>/listing.png, had no
       reader anywhere in the repo; it existed to become the Sanity asset that
       no longer exists. The 2000px JPEG is written to the store in its place,
       under a name that matches what is in it.

       Still RASTERISED at web size rather than downscaled from the print, which
       is measured rather than assumed -- see the note that used to live here,
       now in the commit for chore/single-listing-image. A small rasterise
       allocates a small surface; a sharp downscale has to materialise a decoded
       4800 x 7199 first, and this function has been killed once already for
       what it allocates. Dropping a pass makes that strictly better. */
    const portrait = print.height > print.width;
    const webRasterWidth = Math.ceil(portrait
      ? WEB_MASTER.side * (print.width / print.height)
      : WEB_MASTER.side);
    const webSource = rasterise(svg, fontFiles, webRasterWidth).asPng();
    const { data: listingJpeg, info: listingInfo } = await renderDerivative(sharp, webSource, WEB_MASTER);

    /* Only now. cleanup() deletes the directory the font files are IN, and
       resvg reads them off disk on every rasterise -- calling it after the
       print, as this once did, left the web image to render its text in
       whatever resvg fell back to. */
    cleanupFonts(); cleanupFonts = null;

    await store.set(`studio/${id}/listing.jpg`, listingJpeg, {
      metadata: { id, kind: 'listing', title, width: listingInfo.width, height: listingInfo.height },
    });

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
      const [listingAsset, printAsset] = await Promise.all([
        sanity.assets.upload('image', listingJpeg, {
          filename: `${slug}-${WEB_MASTER.side}.jpg`, contentType: 'image/jpeg',
        }),
        /* printFile is what a human fulfils from. Leaving it pointing at the
           artwork this render just replaced is how the wrong design gets
           printed; the reference it used to hold is in artworkHistory. */
        sanity.assets.upload('file', printPng, { filename: `${slug}-print.png`, contentType: 'image/png' }),
      ]);

      /* This is also the migration, in two directions. A product rendered before
         the keys were collapsed carries a near-identical "web-master" entry and
         setListingImage drops it; a hand-curated product has no listing entry at
         all, and its images[0] -- the picture the whole site shows -- is taken
         over rather than appended after, because appending would leave the old
         one on display and the new render invisible at the end of the array.
         Whatever was in that slot is written into the history entry studio-save
         already made, so there is a way back to it. */
      const current = await sanity.getDocument(docId);
      const listing = setListingImage(current?.images, listingAsset._id, `${title} — Comic Strip Canvas`);
      const history = recordDisplacedListing(current?.artworkHistory, listing.displaced, {
        by: 'studio', ownEntry: true,
      });

      const patch = {
        images: listing.images,
        printFile: { _type: 'file', asset: { _type: 'reference', _ref: printAsset._id } },
      };
      if (history.recorded) patch.artworkHistory = history.history;
      await sanity.patch(docId).set(patch).commit();

      attached = `${docId} (images[0] ${listing.mode === 'displaced' ? 'TAKEN OVER from a curated image' : listing.mode === 'first' ? 'added' : 'replaced'}` +
        `${listing.removedLegacy ? ', stale web-master removed' : ''}, printFile set)`;
      if (listing.mode === 'displaced') {
        console.warn(`studio-render: ${docId} had no listing entry — images[0] (${listing.displaced}) ` +
          `is no longer the product image; recorded as prevListingAssetId for rollback`);
      }
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
      `(${printPng.length} B) @ ${DPI}dpi, listing ${listingInfo.width}x${listingInfo.height} ` +
      `(${listingJpeg.length} B jpeg) -> ${attached}`
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

/* Memory, and ONLY memory. THIS is the declaration that works.
   netlify.toml asks for the same 3gb and is ignored: a real build emits
   memory: 3072 into the manifest for this function, which has both, and no
   memory field at all for style-photo-background, which has only the toml
   entry. The previous attempt lived solely in netlify.toml, was silently
   dropped, and this function ran at the 1024 MB default until a render was
   killed mid-rasterise with an empty log and no print file.

   NOTE THE ABSENCE OF `path`. A config.path here collides with the forced
   /api/* rewrite in netlify.toml and 404s the function; that rule is why this
   file carried no config block at all until now. memory does not touch
   routing, so it is safe where path is not. */
export const config = { memory: '3gb' };

// NOTE: deliberately NO `path` in the config above.
// studio-save posts to /api/studio-render, which netlify.toml rewrites to this
// function by name -- the same arrangement as render-personalisation.
//
// /api/studio-render/<id> is a DIFFERENT function, studio-rerender: the
// secret-protected repair route that starts this one again from the stored
// scene. Both rules live in netlify.toml, exact match first.
