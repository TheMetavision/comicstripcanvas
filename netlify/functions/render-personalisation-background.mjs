import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { DPI, dataUri, prepareScene, rasterise } from './_shared/render.mjs';

/**
 * Render a paid personalisation to a print file and a proof.
 *
 * This is tools/builder/renderer/render.mjs as a background function. The idea
 * is unchanged: the scene the customer approved carries every asset as a token,
 * and rendering swaps the tokens for full-resolution files and rasterises that
 * same document. Nothing is recalculated, so nothing can drift.
 *
 *   {{IMAGE:panel-01}}  the customer's photo for that panel
 *   {{OVERLAY}}         template line art and furniture
 *   {{BACKGROUND}}      template background artwork
 *   {{LOGO}}            publisher logo
 *
 * A background function because a 24 x 16 in file at 300dpi is a 7200 x 4800
 * raster; that wants time and memory, not a 10-second request budget.
 *
 * One document per invocation. The webhook POSTs { id, orderId, orderNumber }
 * to /api/render-personalisation, which netlify.toml rewrites here.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const PHOTO_STORE = 'personalisation';
const RENDER_STORE = 'renders';
const PROOF_WIDTH = 1200;

// Only these may be rendered. "rendered" is excluded so a repeat delivery does
// not redo work; "draft"/"awaiting_payment" because nothing has been paid for.
const RENDERABLE = new Set(['paid', 'preparing', 'on_hold']);

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

export default async (req, context) => {
  let id = null;
  try {
    const body = await req.json().catch(() => ({}));
    id = body.id;
    if (!isId(id)) {
      console.error('render-personalisation: bad or missing id', JSON.stringify(body).slice(0, 200));
      return new Response('Bad id', { status: 400 });
    }

    const doc = await sanity.getDocument(id);
    if (!doc) {
      console.error(`render-personalisation: ${id} does not exist`);
      return new Response('Unknown', { status: 404 });
    }
    if (!RENDERABLE.has(doc.status)) {
      // Not an error: a repeat webhook delivery, or a build that was never paid
      // for. Say which so it is obvious in the logs why nothing happened.
      console.log(`render-personalisation: skipping ${id} — status is "${doc.status}", ` +
        `only ${[...RENDERABLE].join(', ')} are rendered.`);
      return new Response('Not renderable', { status: 200 });
    }

    await render(id, doc, req);
    return new Response('Rendered', { status: 200 });
  } catch (err) {
    console.error(`render-personalisation: ${id} failed:`, err.message);
    // Park it for a human rather than leaving it looking paid-and-forgotten.
    if (isId(id)) {
      try {
        // Clear the proof too: an earlier render may have left one, and showing a
        // superseded proof as current is worse than showing none.
        await sanity
          .patch(id)
          .set({ status: 'on_hold', renderError: String(err.message).slice(0, 2000) })
          .unset(['proofUrl'])
          .commit();
      } catch (patchErr) {
        console.error(`render-personalisation: could not mark ${id} on hold:`, patchErr.message);
      }
    }
    return new Response('Failed', { status: 500 });
  }
};

async function render(id, doc, req) {
  const recipe = JSON.parse(doc.recipe || '{}');
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;

  /* The photos come out of the blob store; a styled version supersedes the
     original for that panel. This lookup is the only part of rendering that is
     specific to a paid customer build -- everything else is shared with
     studio-save.mjs via _shared/render.mjs. */
  const photos = getStore(PHOTO_STORE);
  const keyFor = (panelId) => {
    const hit = (arr) => (arr || []).find((k) => new RegExp(`/${panelId}\\.[^/.]+$`).test(k));
    return hit(doc.styledKeys) || hit(doc.photoKeys) || null;
  };
  const imageFor = async (panelId) => {
    const key = keyFor(panelId);
    if (!key) throw new Error(`No photo stored for panel ${panelId}`);
    const buf = await photos.get(key, { type: 'arrayBuffer' });
    if (!buf) throw new Error(`Photo blob missing for panel ${panelId} (${key})`);
    return dataUri(buf, key);
  };

  const scene = await prepareScene({ sceneSvg: doc.sceneSvg, recipe, origin, imageFor });

  // Both are produced before anything is written, so a failure never leaves a
  // half-written print file behind.
  const print = rasterise(scene.svg, scene.fontFiles, scene.printWidth);
  const proof = rasterise(scene.svg, scene.fontFiles, PROOF_WIDTH);
  const printPng = print.asPng();
  const proofPng = proof.asPng();

  const renders = getStore(RENDER_STORE);
  await renders.set(`renders/${id}/print.png`, printPng, {
    metadata: { id, kind: 'print', width: print.width, height: print.height, dpi: DPI },
  });
  await renders.set(`renders/${id}/proof.png`, proofPng, {
    metadata: { id, kind: 'proof', width: proof.width, height: proof.height },
  });

  await sanity.patch(id).set({
    status: 'rendered',
    proofUrl: `${origin}/api/personalisation-proof/${id}`,
  }).unset(['renderError']).commit();

  scene.cleanup();

  console.log(
    `render-personalisation: ${id} ${scene.template} ` +
    `${scene.fileInches[0]} x ${scene.fileInches[1]} in @ ${DPI}dpi -> ` +
    `print ${print.width} x ${print.height} px (${printPng.length} B), ` +
    `proof ${proof.width} x ${proof.height} px`
  );
}

// NOTE: deliberately NO `export const config = { path }` here.
// The webhook posts to /api/render-personalisation, which netlify.toml rewrites
// to this function by name. An inline config.path collides with that forced
// rewrite and 404s, exactly as it does for the other functions here.
