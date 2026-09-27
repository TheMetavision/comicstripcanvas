import { getStore } from '@netlify/blobs';
import type { Config, Context } from '@netlify/edge-functions';
import { sanityQuery } from '../edge-lib/sanity-read.mjs';
import { STUDIO_STORE, artWebPath, isPanelId, isProductId, readStyle } from '../edge-lib/image-keys.mjs';

/**
 * GET /api/customise-scene/<productId>/<style>/art/<panelId>
 *     → the shop's artwork for that panel, screen-sized, streamed from Blobs.
 *
 * Everything else on /api/customise-scene/* falls through untouched to the
 * function, which still answers the JSON scene. Edge functions run before
 * serverless functions and before rewrites, so context.next() carries a
 * non-artwork request down the same chain it took before this existed.
 *
 * WHY: the function read the whole blob into an ArrayBuffer and returned it,
 * and a serverless response is capped at 6 MB buffered — a limit that cannot
 * be raised. All 250 of these were measured: the largest is 4.56 MB and the
 * mean 3.81 MB. Rendering one from the heaviest master in the store gives
 * 4.66 MB, so ART_WEB_SIDE = 1600 does hold the size down and this is the
 * safer of the two routes by some way.
 *
 * It is still about a megabyte from a limit nobody watches, on a file whose
 * size is decided by how busy an artist's picture is. Streaming costs nothing
 * and removes the ceiling instead of leaving it to be discovered.
 *
 * Access is unchanged, and deliberately so: this is public, read-only, and
 * hands out the picture the shop is already showing on the same page. The
 * product id is validated, the style is read the same forgiving way, the panel
 * id is validated, and the key is BUILT from ids this function has checked --
 * never taken from the caller.
 */

const notFound = (why: string) => {
  if (why) console.log(`customise-scene-art: ${why}`);
  return new Response(JSON.stringify({ error: 'Not found' }, null, 1), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

const PRODUCT_QUERY = `*[_type == "product" && _id == $id][0]{
  classicSceneId,
  "fullBleedSceneId": fullBleed.sceneId
}`;

export default async function handler(req: Request, context: Context): Promise<Response> {
  const url = new URL(req.url);
  const segs = url.pathname.split('/').filter(Boolean);
  const at = segs.indexOf('customise-scene');
  const rest = at >= 0 ? segs.slice(at + 1) : [];

  /* Only the artwork route. The scene JSON, and anything else that lands on
     this prefix, is the function's to answer exactly as before. */
  if (!(rest.length === 4 && rest[2] === 'art')) return context.next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return context.next();

  const productId = decodeURIComponent(rest[0] || '');
  if (!isProductId(productId)) return notFound(`refusing "${url.pathname}" — not a product id`);
  const style = readStyle(rest[1]);
  if (!style) return notFound(`unknown style on "${url.pathname}"`);
  const panel = decodeURIComponent(rest[3] || '');
  if (!isPanelId(panel)) return notFound('bad panel id');

  const product = await sanityQuery(PRODUCT_QUERY, { id: productId });
  if (!product) return notFound(`no published product ${productId}`);
  const sceneId = style === 'fullBleed' ? product.fullBleedSceneId : product.classicSceneId;
  if (!sceneId || !isProductId(sceneId)) return notFound(`${productId} has no scene for ${style}`);

  /* Strong, like the print download: this store is written by the renderer and
     read by a customer opening the builder, and the default is eventual. */
  const store = getStore({ name: STUDIO_STORE, consistency: 'strong' });
  const key = artWebPath(sceneId, style, panel);
  const body = await store.get(key, { type: 'stream' }).catch(() => null);
  if (!body) return notFound(`no web artwork for ${sceneId}/${style}/${panel}`);

  return new Response(req.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      /* Unchanged from the function: the artwork for a product and style is
         immutable, because a redraw writes a new scene and the page reloads. */
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/* Inline, like the others. Edge functions declared in netlify.toml run before
   inline ones, and nothing here needs to jump the queue. */
export const config: Config = { path: '/api/customise-scene/*' };
