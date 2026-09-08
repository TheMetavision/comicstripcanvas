import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { DPI, dataUri, prepareScene, rasterise } from './_shared/render.mjs';

/**
 * Turn a design built in the Studio-mode builder into a draft catalogue product.
 *
 * The shop builds a piece at /admin/studio exactly as a customer would, then
 * saves it here. The scene is composed through the same code path as a paid
 * customer build (see _shared/render.mjs) and produces two things:
 *
 *   listing image  1600px, rendered here, uploaded to Sanity, attached to the
 *                  product, and returned in the response
 *   print master   full resolution, rendered by studio-render-background
 *
 * The print is deferred because it cannot be done inside a synchronous
 * function's budget: a 4800 x 7200 raster measured at ~20s locally and the
 * first version of this timed out at 30s. That is the same reason the customer
 * flow renders in a background function. The listing render is a ninth of the
 * area and comfortably fast, so the caller still gets a real image and a
 * working Studio link in one request.
 *
 * The product is created as an unpublished draft, so nothing appears on the
 * site until someone opens it in the Studio and publishes it.
 *
 * NOTE ON SANITY ASSETS: the standing rule is that customer photographs never
 * enter Sanity's asset library. That is not what this uploads. The listing
 * image is rendered catalogue artwork for a product the shop is selling, which
 * is precisely what the asset library is for. The source photographs stay in
 * the browser in studio mode and are not persisted anywhere.
 */

const STUDIO_STORE = 'studio';
const LISTING_WIDTH = 1600;
const STUDIO_HOST = 'https://comicstripcanvas.sanity.studio';

/** Which catalogue a template belongs in. */
const CATEGORY = {
  'cover': 'comic-book-covers',
  'cover-fullbleed': 'comic-book-covers',
  'icon-portrait': 'comic-book-icons',
  'icon-landscape': 'comic-book-icons',
  'strip': 'comic-book-strips',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const newId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'studio-' + [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
};

const slugify = (s) =>
  s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'untitled-design';

let sanityClient;
function getSanity() {
  if (sanityClient) return sanityClient;
  if (!process.env.SANITY_WRITE_TOKEN) return null;
  sanityClient = createClient({
    projectId: 'lwbwahym',
    dataset: 'production',
    apiVersion: '2026-04-11',
    token: process.env.SANITY_WRITE_TOKEN,
    useCdn: false,
  });
  return sanityClient;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expected = process.env.PERSONALISATION_ACTION_SECRET;
  if (!expected) {
    console.error('studio-save: PERSONALISATION_ACTION_SECRET is not set — refusing.');
    return json({ error: 'Saving is not configured on this deploy' }, 503);
  }
  if (!sameSecret(req.headers.get('x-csc-action-secret'), expected)) {
    console.warn('studio-save: rejected a call with a bad or missing secret');
    return json({ error: 'Not authorised' }, 401);
  }

  const sanity = getSanity();
  if (!sanity) return json({ error: 'SANITY_WRITE_TOKEN is not set on this deploy' }, 503);

  if (!(req.headers.get('content-type') || '').includes('multipart/form-data')) {
    return json({ error: 'Content-Type must be multipart/form-data' }, 400);
  }

  let form;
  try { form = await req.formData(); } catch { return json({ error: 'Could not read the upload' }, 400); }

  const title = (form.get('title') || '').toString().trim();
  if (!title) return json({ error: 'A product title is required' }, 400);

  const sceneSvg = (form.get('sceneSvg') || '').toString();
  let recipe;
  try { recipe = JSON.parse((form.get('recipe') || '').toString()); }
  catch { return json({ error: 'Recipe is not valid JSON' }, 400); }
  if (!recipe || !recipe.template) return json({ error: 'Recipe is missing its template' }, 400);

  const category = CATEGORY[recipe.template];
  if (!category) return json({ error: `No catalogue category for template "${recipe.template}"` }, 400);

  // The photos arrive with the request and are never written anywhere: they are
  // read into the scene and dropped when this handler returns.
  const images = new Map();
  for (const [field, value] of form.entries()) {
    if (!field.startsWith('image:') || typeof value === 'string') continue;
    const panelId = field.slice('image:'.length);
    const buf = Buffer.from(await value.arrayBuffer());
    images.set(panelId, dataUri(buf, value.name || 'photo.jpg'));
  }
  if (!images.size) return json({ error: 'No images were supplied' }, 400);

  const id = newId();
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;

  let scene;
  try {
    scene = await prepareScene({
      sceneSvg,
      recipe,
      origin,
      imageFor: async (panelId) => images.get(panelId),
    });
  } catch (err) {
    console.error('studio-save: could not prepare the scene:', err.message);
    return json({ error: err.message }, 400);
  }

  try {
    const listing = rasterise(scene.svg, scene.fontFiles, LISTING_WIDTH);
    const listingPng = listing.asPng();

    const store = getStore(STUDIO_STORE);
    await store.set(`studio/${id}/listing.png`, listingPng, {
      metadata: { id, kind: 'listing', title, width: listing.width, height: listing.height },
    });

    /* The composed scene, with its artwork already inlined, is handed to the
       background renderer so it does not have to be given the source images a
       second time. It holds no more than the print master it produces. */
    await store.set(`studio/${id}/scene.svg`, scene.svg, {
      metadata: { id, kind: 'scene', title, printWidth: scene.printWidth, dpi: DPI },
    });

    const asset = await sanity.assets.upload('image', listingPng, {
      filename: `${slugify(title)}.png`,
      contentType: 'image/png',
    });

    // A `drafts.` id is what "draft" means in Sanity: the document exists and is
    // editable in the Studio, but nothing is published to the site until someone
    // presses Publish.
    const doc = await sanity.create({
      _id: `drafts.${id}`,
      _type: 'product',
      title,
      slug: { _type: 'slug', current: slugify(title) },
      category,
      isPersonalised: false,
      images: [{
        _type: 'image',
        _key: 'listing',
        asset: { _type: 'reference', _ref: asset._id },
        alt: `${title} — Comic Strip Canvas`,
      }],
    });

    scene.cleanup();

    // Fire and forget: the print master is not needed to answer this request,
    // and a background function has the minutes it takes.
    const printWidth = scene.printWidth;
    fetch(`${origin}/api/studio-render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title, printWidth }),
    }).catch((err) => console.error(`studio-save: could not start the print render for ${id}:`, err.message));

    const studioUrl = `${STUDIO_HOST}/intent/edit/id=${id};type=product/`;
    console.log(
      `studio-save: "${title}" -> ${doc._id} (${category}), ` +
      `listing ${listing.width} x ${listing.height} px, ` +
      `print ${printWidth}px wide queued`
    );
    return json({
      ok: true,
      id,
      title,
      category,
      studioUrl,
      listing: { width: listing.width, height: listing.height, assetId: asset._id },
      print: { width: printWidth, status: 'rendering' },
    });
  } catch (err) {
    scene.cleanup();
    console.error('studio-save: failed:', err.message);
    return json({ error: err.message }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/studio-save is routed by the forced /api/* redirect in netlify.toml,
// like every other function in this directory.
