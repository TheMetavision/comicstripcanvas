import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { STUDIO_STORE } from './_shared/studio-uploads.mjs';
import {
  CLASSIC, FULL_BLEED, STYLES, styleOr, sceneKey, artWebKey, resolveCustomiseFee,
} from './_shared/artwork-styles.mjs';

/**
 * The design behind a stock product, for a customer to put their own wording on.
 *
 *   GET /api/customise-scene/<productId>?style=classic|fullbleed
 *       -> { template, recipe, sceneSvg, panels: { <id>: url }, ... }
 *
 *   GET /api/customise-scene/<productId>/<style>/art/<panelId>
 *       -> the artwork itself, screen-sized
 *
 * Public and read-only, because the thing it hands out is the picture the shop
 * is already selling on the same page. Nothing here writes, nothing here takes
 * a key off the caller, and the only ids it will look at are a product's own
 * and a panel named by that product's stored scene.
 *
 * WHERE THE SCENE COMES FROM. studio-render keeps it: every save writes
 * studio/<id>/<style>/scene.json, and the render rewrites it to point at a
 * durable copy of the artwork under the same prefix. Before that change the
 * scene and its uploads were deleted the moment the print master existed,
 * which is why this endpoint could not have been written then.
 *
 * WHAT THE BUILDER DOES WITH IT. Not what you might expect: it does not display
 * this SVG. It rebuilds the design from the RECIPE on the same template the
 * studio drew it on, which is what makes every existing control work on it --
 * the text fields, the colour pickers, the live preview, the draft, the
 * thumbnail. The SVG is sent anyway because it is the record of what was
 * actually drawn, and comparing the two is how you would catch the day they
 * stop agreeing.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  useCdn: false,
});

const isProductId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(s) && !s.includes('..');
const isPanelId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);

/* The URL says "fullbleed"; the document field is "fullBleed". Accept either
   and anything a person might type, because this one is in a query string a
   human can see and will eventually edit by hand. */
function readStyle(raw) {
  const v = String(raw || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (v === 'fullbleed') return FULL_BLEED;
  if (v === 'classic' || v === '') return CLASSIC;
  return null;
}

const json = (body, status = 200, cache = 'public, max-age=60') =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': status === 200 ? cache : 'no-store' },
  });

const notFound = (why) => {
  if (why) console.log(`customise-scene: ${why}`);
  return json({ error: 'Not found' }, 404);
};

/** Which scene id each style was rendered from, and what it costs to customise. */
const PRODUCT_QUERY = `*[_type == "product" && _id == $id][0]{
  _id, title, "slug": slug.current, category, customiseFee,
  classicSceneId,
  "fullBleedSceneId": fullBleed.sceneId
}`;

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }

  /* /api/customise-scene/<id>[/<style>/art/<panel>] arrives as
     /.netlify/functions/customise-scene/<...>. */
  const url = new URL(req.url);
  const segs = url.pathname.split('/').filter(Boolean);
  const at = segs.indexOf('customise-scene');
  const rest = at >= 0 ? segs.slice(at + 1) : [];
  const productId = rest[0] ? decodeURIComponent(rest[0]) : '';
  if (!isProductId(productId)) return notFound(`refusing "${url.pathname}" — not a product id`);

  /* The artwork route: .../<style>/art/<panel>. Everything else on this prefix
     is the scene itself. */
  const wantsArt = rest.length === 4 && rest[2] === 'art';
  const style = readStyle(wantsArt ? rest[1] : url.searchParams.get('style'));
  if (!style) return notFound(`unknown style on "${url.pathname}"`);

  try {
    const product = await sanity.fetch(PRODUCT_QUERY, { id: productId });
    if (!product) return notFound(`no published product ${productId}`);

    const sceneId = style === FULL_BLEED ? product.fullBleedSceneId : product.classicSceneId;
    if (!sceneId || !isProductId(sceneId)) {
      /* Not an error anybody needs to act on: most products were never drawn in
         the studio, and the page only offers the button when they were. */
      return json({ error: 'This design cannot be customised', productId, style }, 404);
    }

    const store = getStore(STUDIO_STORE);

    if (wantsArt) {
      const panel = decodeURIComponent(rest[3]);
      if (!isPanelId(panel)) return notFound('bad panel id');
      /* The key is BUILT from ids this function has already validated, never
         taken from the request. */
      const bytes = await store.get(artWebKey(sceneId, style, panel), { type: 'arrayBuffer' });
      if (!bytes) return notFound(`no web artwork for ${sceneId}/${style}/${panel}`);
      return new Response(req.method === 'HEAD' ? null : Buffer.from(bytes), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          /* The artwork for a given product and style is immutable: a redraw
             writes a new scene and the page reloads it. A year is safe and
             this is the one request in the flow that moves real bytes. */
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    const raw = await store.get(sceneKey(sceneId, style), { type: 'text' });
    if (!raw) return json({ error: 'This design cannot be customised', productId, style }, 404);
    const job = JSON.parse(raw);

    /* Only the panels the scene actually names, and only as URLs on this
       function. The blob keys stay on the server: a customer's save says which
       PANEL it wants, never which blob, and personalise-save resolves that
       against this same scene. */
    const panels = {};
    for (const panelId of Object.keys(job.images || {})) {
      if (!isPanelId(panelId)) continue;
      panels[panelId] = `/api/customise-scene/${encodeURIComponent(productId)}/` +
        `${style === FULL_BLEED ? 'fullbleed' : 'classic'}/art/${encodeURIComponent(panelId)}`;
    }
    if (!Object.keys(panels).length) return notFound(`scene for ${sceneId} names no panels`);

    return json({
      productId,
      title: product.title,
      slug: product.slug,
      style,
      sceneId,
      template: job.recipe?.template || null,
      recipe: job.recipe || null,
      sceneSvg: job.svg || null,
      panels,
      /* In pence, RESOLVED here rather than handed over raw: almost no product
         carries a customiseFee of its own, and a null would leave the builder
         to invent a price or charge nothing. Checkout resolves the same field
         through the same function, so what the basket shows and what the card
         is charged come from one rule. */
      customiseFee: resolveCustomiseFee(product.customiseFee).pence,
    });
  } catch (err) {
    console.error(`customise-scene: ${productId} (${style}) failed:`, err.message);
    return json({ error: 'Could not load this design' }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }` here — routed by the
// forced /api/* rewrite in netlify.toml, which carries the rest of the path
// through. An inline config.path collides with it and 404s.
