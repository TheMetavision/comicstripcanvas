import { getStore } from '@netlify/blobs';
import type { Config, Context } from '@netlify/edge-functions';
import { sanityQuery } from '../edge-lib/sanity-read.mjs';
import { PHOTO_STORE, SERVABLE_PHOTO, isPanelId, isPersonalisationId } from '../edge-lib/image-keys.mjs';
import { docIdFor } from '../functions/_shared/pp-id.mjs';

/**
 * GET /api/personalisation-photo/<id>/<panel>[?variant=cutout]
 *     → that panel's styled photograph, or its background-removed PNG,
 *       streamed from Blobs.
 *
 * WHY: the function read the whole blob into an ArrayBuffer and returned it,
 * and a serverless response is capped at 6 MB buffered — not raisable.
 *
 * This looked like a near miss and is not one. Every cutout in the store was
 * measured: the largest is 5.04 MB, which reads as a megabyte of headroom. But
 * a cutout is a PNG that keeps its alpha, and what makes those 22 files small
 * is that most of each frame was REMOVED — transparency costs almost nothing
 * to encode. Take the largest styled photograph actually stored (3000x4000,
 * 3.98 MB as a JPEG) and cut out a subject that fills the frame, so there is no
 * transparent area to compress, and the PNG is 28.13 MB. At the largest cutout
 * dimensions seen in the store, 3392x5056, it is 43.49 MB.
 *
 * So this route could already fail today, on a tightly-cropped portrait, past
 * the buffered cap by a factor of five and past the streamed cap too. The
 * 5.5 MB ceiling on what a customer may upload is not a ceiling on the PNG
 * made from it.
 *
 * ACCESS IS UNCHANGED, and this file is careful about it because the thing it
 * hands out is a customer's photograph:
 *
 *   · the unguessable pp- id is the access control, as before
 *   · anything not shaped like a pp- id is refused before the store is touched
 *   · a malformed id and an unknown one are both a bare 404, so the one cannot
 *     be told from the other
 *   · the panel is read from the DOCUMENT, never built into a key from the URL
 *   · the same private, no-store, noindex headers
 *
 * The read needs a token. pendingPersonalisation documents live at
 * pendingPersonalisation.<ref>, a dotted _id that anonymous reads cannot see, so
 * this route reads with SANITY_READ_TOKEN (a Viewer token: it can read, never
 * write). Without it the edge steps aside and the function answers the same
 * request with its own server-side token -- buffered, so back under the 6 MB
 * cap described above. Set SANITY_READ_TOKEN before deploying.
 *
 * (Before the dotted ids, the read needed no credentials: the documents were
 * public, and the unguessable id was all that stood in front of them.)
 *
 * The function it replaces handed SANITY_WRITE_TOKEN to its client to run this
 * same query, so the edge holds strictly less than the function did.
 *
 * Anything that is not a GET or HEAD for a well-formed id falls through to the
 * function untouched.
 */

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });

const PHOTO_QUERY = `*[_id == $id][0]{ photos }`;

export default async function handler(req: Request, context: Context): Promise<Response> {
  const url = new URL(req.url);
  const segs = url.pathname.split('/').filter(Boolean);

  /* Same two shapes the function accepts: trailing path segments, or the pair
     in the query string. */
  let id: string | null = null, panel: string | null = null;
  if (segs.length >= 2 && isPersonalisationId(segs[segs.length - 2]) && isPanelId(segs[segs.length - 1])) {
    id = segs[segs.length - 2];
    panel = segs[segs.length - 1];
  } else if (isPersonalisationId(url.searchParams.get('id') || '')
    && isPanelId(url.searchParams.get('panel') || '')) {
    id = url.searchParams.get('id');
    panel = url.searchParams.get('panel');
  }

  /* Not ours to answer — let the function deal with it, including the 405 for
     a method it does not take. */
  if (!id || !panel) return context.next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return context.next();

  const token = Netlify.env.get('SANITY_READ_TOKEN') || '';
  if (!token) return context.next();

  const doc = await sanityQuery(PHOTO_QUERY, { id: docIdFor(id) }, { token });
  const row = (doc?.photos || []).find((p: { panel?: string }) => p?.panel === panel);
  if (!row || row.styleStatus !== 'done' || !row.styledKey) {
    /* Not an error: this is the normal answer while styling is in flight, and
       the builder polls the status endpoint rather than this one. */
    return notFound();
  }

  /* ?variant=cutout asks for the background-removed PNG. 404 until it exists,
     which is normal on every template except the standard cover, and on a
     cover whose cutout the quality gate refused -- the caller falls back to
     the styled image, which is always there. */
  const wantCutout = url.searchParams.get('variant') === 'cutout';
  const key = wantCutout ? row.cutoutKey : row.styledKey;
  if (!key || !SERVABLE_PHOTO.test(key)) return notFound();

  const store = getStore({ name: PHOTO_STORE, consistency: 'strong' });
  const body = await store.get(key, { type: 'stream' }).catch(() => null);
  if (!body) {
    console.error(`personalisation-photo: ${id} ${panel} is done but its blob is gone (${key})`);
    return notFound();
  }

  return new Response(req.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': wantCutout ? 'image/png' : 'image/jpeg',
      // a customer's photograph: never held by a shared cache, never indexed
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

/* Both shapes: the trailing-segment form the builder uses, and the bare path
   with the pair in the query string, which the function also accepts. A splat
   alone would not match the second. */
export const config: Config = {
  path: ['/api/personalisation-photo', '/api/personalisation-photo/*'],
};
