import { getStore } from '@netlify/blobs';

/**
 * Serve a rendered proof: GET /api/personalisation-proof/<id>
 *
 * The proof lives in the renders blob store, which is not publicly readable, so
 * something has to hand it out. Both the proof email and the Studio need to load
 * it with no login, so the id IS the access control: 128 bits of randomness from
 * personalise-save, unguessable, and never listed anywhere public.
 *
 * That places the whole weight of access control on the id being well formed, so
 * anything that is not exactly a pp- id is refused before the store is touched --
 * no path segments, no traversal, no wildcards reaching the key.
 *
 * A proof is a customer's photograph. It must not be cached by a shared proxy
 * and must not be indexed.
 */

const RENDER_STORE = 'renders';
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

  // /api/personalisation-proof/<id> arrives as /.netlify/functions/personalisation-proof/<id>
  const { pathname, searchParams } = new URL(req.url);
  const last = pathname.split('/').filter(Boolean).pop();
  const id = isId(last) ? last : (isId(searchParams.get('id')) ? searchParams.get('id') : null);

  if (!id) {
    console.log(`personalisation-proof: refusing "${pathname}" — not a well-formed id`);
    return notFound();
  }

  try {
    const proof = await getStore(RENDER_STORE).get(`renders/${id}/proof.png`, {
      type: 'arrayBuffer',
    });
    if (!proof) {
      console.log(`personalisation-proof: no proof rendered for ${id}`);
      return notFound();
    }

    return new Response(req.method === 'HEAD' ? null : proof, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(proof.byteLength),
        // a customer's photograph: never held by a shared cache, never indexed
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (error) {
    console.error(`personalisation-proof: could not read the proof for ${id}:`, error.message);
    return notFound();
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/personalisation-proof/<id> is routed by the forced /api/* redirect in
// netlify.toml (/api/* -> /.netlify/functions/:splat), which carries the id
// through as a trailing path segment. An inline config.path collides with that
// forced rewrite and 404s, as it does for every other function here.
