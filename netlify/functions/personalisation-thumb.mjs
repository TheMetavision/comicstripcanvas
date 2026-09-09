import { getStore } from '@netlify/blobs';

/**
 * Serve a basket thumbnail: GET /api/personalisation-thumb/<id>
 *
 * The builder snapshots its live preview on Add to basket and stores it beside
 * the customer's photos, at personalisation/<id>/thumb.jpg. The photo store is
 * not publicly readable, so something has to hand it out -- for the basket
 * drawer, and for Stripe, which fetches the line-item image server-side.
 *
 * Same shape and same reasoning as personalisation-proof.mjs: the id IS the
 * access control -- 128 bits of randomness from personalise-save, unguessable,
 * never listed anywhere public -- so anything that is not exactly a pp- id is
 * refused before the store is touched. No path segments, no traversal, no
 * wildcards reaching the key.
 *
 * The thumbnail is a composite of a customer's photographs. It must not be
 * cached by a shared proxy and must not be indexed. Stripe fetches it once at
 * session create and serves its own copy, so no-store costs nothing there.
 */

const PHOTO_STORE = 'personalisation';
const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

// Refuse and reveal nothing: a malformed id and an unknown one look identical
// from outside, so this cannot be used to probe which ids exist.
const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });

export default async (req, context) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' },
    });
  }

  // /api/personalisation-thumb/<id> arrives as /.netlify/functions/personalisation-thumb/<id>
  const { pathname, searchParams } = new URL(req.url);
  const last = pathname.split('/').filter(Boolean).pop();
  const id = isId(last) ? last : (isId(searchParams.get('id')) ? searchParams.get('id') : null);

  if (!id) {
    console.log(`personalisation-thumb: refusing "${pathname}" — not a well-formed id`);
    return notFound();
  }

  try {
    const thumb = await getStore(PHOTO_STORE).get(`personalisation/${id}/thumb.jpg`, {
      type: 'arrayBuffer',
    });
    if (!thumb) {
      // Not an error: the snapshot is best-effort, and a build whose snapshot
      // failed simply falls back to the generic product image in the basket.
      console.log(`personalisation-thumb: no thumbnail stored for ${id}`);
      return notFound();
    }

    return new Response(req.method === 'HEAD' ? null : thumb, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(thumb.byteLength),
        // a customer's photographs: never held by a shared cache, never indexed
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (error) {
    console.error(`personalisation-thumb: could not read the thumbnail for ${id}:`, error.message);
    return notFound();
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/personalisation-thumb/<id> is routed by the forced /api/* redirect in
// netlify.toml (/api/* -> /.netlify/functions/:splat), which carries the id
// through as a trailing path segment. An inline config.path collides with that
// forced rewrite and 404s, as it does for every other function here.
