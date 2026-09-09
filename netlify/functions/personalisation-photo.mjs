import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';

/**
 * The styled photograph for one panel:
 *   GET /api/personalisation-photo/<id>/<panel>
 *
 * 404 until that panel's styling is done. The builder shows it in place of the
 * raw photo once it exists, and the Studio uses it to check likeness before
 * approving.
 *
 * This one really does hand out a customer's photograph, so it gets exactly the
 * treatment personalisation-proof gets: the unguessable id is the access
 * control, anything not shaped like a pp- id is refused before the store is
 * touched, a malformed id and an unknown one are indistinguishable, and the
 * bytes are never cached by a shared proxy or indexed.
 *
 * The panel is read from the document rather than built into a key from the
 * URL. A panel segment that reached the blob store directly would be a path
 * traversal waiting to happen; going through the document means only keys we
 * wrote can ever be fetched.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const PHOTO_STORE = 'personalisation';
const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);
const isPanel = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s);

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' },
    });
  }

  // /api/personalisation-photo/<id>/<panel> arrives as
  // /.netlify/functions/personalisation-photo/<id>/<panel>
  const { pathname, searchParams } = new URL(req.url);
  const segs = pathname.split('/').filter(Boolean);
  let id = null, panel = null;
  if (segs.length >= 2 && isId(segs[segs.length - 2]) && isPanel(segs[segs.length - 1])) {
    id = segs[segs.length - 2];
    panel = segs[segs.length - 1];
  } else if (isId(searchParams.get('id')) && isPanel(searchParams.get('panel'))) {
    id = searchParams.get('id');
    panel = searchParams.get('panel');
  }
  if (!id || !panel) {
    console.log(`personalisation-photo: refusing "${pathname}" — not a well-formed id/panel pair`);
    return notFound();
  }

  try {
    const doc = await sanity.fetch('*[_id == $id][0]{ photos }', { id });
    const row = (doc?.photos || []).find((p) => p.panel === panel);
    if (!row || row.styleStatus !== 'done' || !row.styledKey) {
      // Not an error: this is the normal answer while styling is in flight, and
      // the builder polls the status endpoint rather than this one to find out.
      return notFound();
    }

    const blob = await getStore(PHOTO_STORE).get(row.styledKey, { type: 'arrayBuffer' });
    if (!blob) {
      console.error(`personalisation-photo: ${id} ${panel} is done but its blob is gone (${row.styledKey})`);
      return notFound();
    }

    return new Response(req.method === 'HEAD' ? null : blob, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(blob.byteLength),
        // a customer's photograph: never held by a shared cache, never indexed
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (err) {
    console.error(`personalisation-photo: could not read ${id} ${panel}:`, err.message);
    return notFound();
  }
};

// NOTE: deliberately NO `export const config = { path }` here — routed by the
// forced /api/* rewrite in netlify.toml, which carries id and panel through as
// trailing path segments. An inline config.path collides with it and 404s.
