import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import sharp from 'sharp';
import { DPI, dataUri, memoryNote, prepareScene, rasterise } from './_shared/render.mjs';
import { STUDIO_STORE, uploadIdFromKey } from './_shared/studio-uploads.mjs';
import { WEB_MASTER, renderDerivative, setListingImage, recordDisplacedListing } from './_shared/derivatives.mjs';
import {
  CLASSIC, FULL_BLEED, styleOr, styleLabel,
  sceneKey, printKey, prevPrintKey, listingKey, legacySceneKey, legacyPrintKey,
  artKey, artWebKey, isArtKey, ART_WEB_SIDE, CUSTOMISE_FEE_DEFAULT,
} from './_shared/artwork-styles.mjs';

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
    console.log(`studio-render: invoked for ${id || '(no id)'} ("${title}") ` +
      `[${styleLabel(body.style)}] — ${memoryNote()}`);
    if (!isId(id)) {
      console.error('studio-render: bad or missing id', JSON.stringify(body).slice(0, 200));
      return new Response('Bad id', { status: 400 });
    }

    const store = getStore(STUDIO_STORE);
    /* The trigger says which slot; the scene says so too. Either will do, and
       the legacy path is the third answer: a save that was in flight when this
       deploy landed wrote studio/<id>/scene.json with no style in it, and that
       is a Classic save by definition -- it predates there being another. */
    const asked = styleOr(body.style);
    let sceneAt = sceneKey(id, asked);
    let raw = await store.get(sceneAt, { type: 'text' });
    if (!raw) {
      sceneAt = legacySceneKey(id);
      raw = await store.get(sceneAt, { type: 'text' });
      if (raw) console.log(`studio-render: ${id} read a pre-styles scene at ${sceneAt}`);
    }
    if (!raw) {
      console.error(`studio-render: no scene stored for ${id} (${asked}) — nothing to render`);
      return new Response('No scene', { status: 404 });
    }
    const job = JSON.parse(raw);
    const style = styleOr(job.style || body.style);

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
    /* Kept, because this artwork is now wanted twice: once to compose the print
       below, and again months later when a customer opens the same design in
       the builder to put their own wording on it. The bytes are already in
       hand here, so keeping them costs a write rather than a second read. */
    const sources = new Map();
    const scene = await prepareScene({
      sceneSvg: job.svg,
      recipe: job.recipe || {},
      origin,
      imageFor: async (panelId) => {
        const key = keys[panelId];
        /* Either shape: a fresh upload from a save, or the durable copy this
           function wrote the last time it ran. A re-render of a product whose
           uploads have long since been swept reads the second. */
        if (!uploadIdFromKey(key) && !isArtKey(key)) {
          throw new Error(`Panel ${panelId} has no usable artwork key`);
        }
        const buf = await store.get(key, { type: 'arrayBuffer' });
        if (!buf) throw new Error(`The artwork for panel ${panelId} is gone from the store (${key})`);
        const bytes = Buffer.from(buf);
        sources.set(panelId, { bytes, key });
        return dataUri(bytes, key);
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
    /* The Classic slot also looks at the pre-styles path, because that is
       where every product rendered before today has its print master -- and a
       redraw with no rollback copy is exactly the case this exists for. */
    const printAt = printKey(id, style);
    let previousAt = printAt;
    let previous = await store.get(printAt, { type: 'arrayBuffer' }).catch(() => null);
    if (!previous && style === CLASSIC) {
      previousAt = legacyPrintKey(id);
      previous = await store.get(previousAt, { type: 'arrayBuffer' }).catch(() => null);
    }
    if (previous) {
      const prevMeta = await store.getMetadata(previousAt).catch(() => null);
      await store.set(prevPrintKey(id, style), previous, {
        metadata: { ...(prevMeta?.metadata || {}), kind: 'print-prev', style, supersededAt: new Date().toISOString() },
      });
      console.log(`studio-render: kept the previous print master as ${prevPrintKey(id, style)}`);
    }

    await store.set(printAt, printPng, {
      metadata: { id, style, kind: 'print', title, width: print.width, height: print.height, dpi: DPI },
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

    await store.set(listingKey(id, style), listingJpeg, {
      metadata: { id, style, kind: 'listing', title, width: listingInfo.width, height: listingInfo.height },
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
      const alt = `${title} — Comic Strip Canvas`;
      const printRef = { _type: 'file', asset: { _type: 'reference', _ref: printAsset._id } };

      if (style === FULL_BLEED) {
        /* A slot of its own, and nothing else on the document is touched.
           images[] stays exactly as it is -- that array IS the Classic style
           and its gallery -- so a full-bleed redraw cannot displace a curated
           picture, and there is no images[0] surgery to do. What it can
           displace is the previous full-bleed image, so that is what gets
           recorded for the rollback. */
        const displaced = current?.fullBleed?.listingImage?.asset?._ref || null;
        const history = recordDisplacedListing(current?.fullBleed?.artworkHistory, displaced, {
          by: 'studio', ownEntry: true,
        });
        const patch = {
          'fullBleed.listingImage': {
            _type: 'image', asset: { _type: 'reference', _ref: listingAsset._id }, alt,
          },
          'fullBleed.printFile': printRef,
          'fullBleed.sceneId': id,
        };
        if (history.recorded) patch['fullBleed.artworkHistory'] = history.history;
        /* A product that has just gained a scene has just become customisable,
           so it needs a price for it. setIfMissing, never set: a product priced
           by hand keeps its number, and this only fills the blank. */
        await sanity.patch(docId)
          .setIfMissing({ fullBleed: {}, customiseFee: CUSTOMISE_FEE_DEFAULT })
          .set(patch).commit();
        attached = `${docId} (fullBleed.listingImage ${displaced ? 'replaced' : 'set'}, fullBleed.printFile set)`;
      } else {
        /* This is also the migration, in two directions. A product rendered before
           the keys were collapsed carries a near-identical "web-master" entry and
           setListingImage drops it; a hand-curated product has no listing entry at
           all, and its images[0] -- the picture the whole site shows -- is taken
           over rather than appended after, because appending would leave the old
           one on display and the new render invisible at the end of the array.
           Whatever was in that slot is written into the history entry studio-save
           already made, so there is a way back to it. */
        const listing = setListingImage(current?.images, listingAsset._id, alt);
        const history = recordDisplacedListing(current?.artworkHistory, listing.displaced, {
          by: 'studio', ownEntry: true,
        });

        const patch = {
          images: listing.images,
          printFile: printRef,
          classicSceneId: id,
        };
        if (history.recorded) patch.artworkHistory = history.history;
        // Same here: a scene is what makes a product customisable, so this is
        // the moment it needs a fee. An existing one is left alone.
        await sanity.patch(docId)
          .setIfMissing({ customiseFee: CUSTOMISE_FEE_DEFAULT })
          .set(patch).commit();

        attached = `${docId} (images[0] ${listing.mode === 'displaced' ? 'TAKEN OVER from a curated image' : listing.mode === 'first' ? 'added' : 'replaced'}` +
          `${listing.removedLegacy ? ', stale web-master removed' : ''}, printFile set)`;
        if (listing.mode === 'displaced') {
          console.warn(`studio-render: ${docId} had no listing entry — images[0] (${listing.displaced}) ` +
            `is no longer the product image; recorded as prevListingAssetId for rollback`);
        }
      }
    } else if (docId) {
      console.error('studio-render: SANITY_WRITE_TOKEN is not set — the pictures exist but nothing was attached');
    }

    /* ---- the artwork, kept under the product rather than the upload ---- */
    /* The upload keys are a transport buffer that retention sweeps a day later,
       so a scene pointing at them is a scene that stops working. Each panel is
       copied under the product's own prefix, at two sizes, and the scene is
       rewritten to name the copies. Nothing sweeps this prefix.

       The web copy exists so /api/customise-scene can stream something to a
       phone without resizing anything at request time. It is made here because
       sharp is already in this bundle and the pixels are already decoded. */
    const durable = {};
    for (const [panelId, src] of sources) {
      const ext = (String(src.key).split('.').pop() || 'png').toLowerCase().slice(0, 5);
      const full = artKey(id, style, panelId, ext);
      const web = artWebKey(id, style, panelId);
      if (src.key !== full) {
        await store.set(full, src.bytes, {
          metadata: { id, style, panel: panelId, kind: 'art', title },
        });
      }
      try {
        const small = await sharp(src.bytes)
          .resize(ART_WEB_SIDE, ART_WEB_SIDE, { fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        await store.set(web, small, {
          metadata: { id, style, panel: panelId, kind: 'art-web', title, side: ART_WEB_SIDE },
        });
      } catch (err) {
        /* A missing web copy costs the customise builder its picture, not this
           render its print file. Say so and carry on. */
        console.warn(`studio-render: no web copy of ${panelId} for ${id}: ${err.message}`);
      }
      durable[panelId] = full;
    }

    /* The scene is KEPT now, rewritten to point at the copies. It used to be
       deleted the moment the print existed, because the print was the only
       durable thing anybody wanted; the design itself is now a thing customers
       reopen, so it stays. Re-running a render for the same id still works --
       better than before, since it no longer depends on uploads that may have
       been swept. */
    await store.set(sceneKey(id, style), JSON.stringify({
      ...job, id, docId, style, images: durable, renderedAt: new Date().toISOString(),
    }), {
      metadata: { id, docId, style, kind: 'scene', title, printWidth, dpi: DPI, rendered: 'true' },
    });
    /* The legacy path, if that is where this one was read from, does go: it is
       the same scene at an older address and keeping both would leave two
       answers to "which scene is this product's". */
    if (sceneAt !== sceneKey(id, style)) {
      await store.delete(sceneAt)
        .catch((err) => console.warn(`studio-render: could not tidy ${sceneAt}: ${err.message}`));
    }

    /* The uploads go, as they always did. The print master and now the durable
       artwork are what outlive the save; a third full-resolution copy under an
       upload id serves nothing, and retention would sweep it anyway. */
    await Promise.all(Object.values(keys).filter((key) => uploadIdFromKey(key)).map(
      (key) => store.delete(key).catch((err) => console.warn(`studio-render: could not delete ${key}: ${err.message}`))
    ));

    console.log(
      `studio-render: "${title}" ${id} [${styleLabel(style)}] -> print ${print.width} x ${print.height} px ` +
      `(${printPng.length} B) @ ${DPI}dpi -> ${printAt}, listing ${listingInfo.width}x${listingInfo.height} ` +
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
