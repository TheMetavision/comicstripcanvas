import { createClient } from '@sanity/client';

/**
 * Styling progress: GET /api/personalisation-status/<id>
 *
 * What the builder polls between dropping a photo in and being able to check
 * out, and what a Studio reviewer sees per panel.
 *
 * Same access control as personalisation-proof: the unguessable id IS the
 * control, so anything that is not exactly a pp- id is refused before Sanity
 * is touched, and a malformed id and an unknown one are indistinguishable from
 * outside. Nothing here reveals a photograph -- only per-panel state -- but the
 * response still says which panels exist, so it gets the same treatment.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

const PRIVATE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex',
};

const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: PRIVATE });

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: PRIVATE });
  }

  // /api/personalisation-status/<id> arrives as
  // /.netlify/functions/personalisation-status/<id>
  const { pathname, searchParams } = new URL(req.url);
  const last = pathname.split('/').filter(Boolean).pop();
  const id = isId(last) ? last : (isId(searchParams.get('id')) ? searchParams.get('id') : null);
  if (!id) {
    console.log(`personalisation-status: refusing "${pathname}" — not a well-formed id`);
    return notFound();
  }

  try {
    const doc = await sanity.fetch(
      '*[_id == $id][0]{ photos, styleSize, styleCalls }', { id }
    );
    if (!doc) return notFound();

    const photos = (doc.photos || []).map((p) => ({
      panel: p.panel,
      styleStatus: p.styleStatus || 'pending',
      styleError: p.styleError || null,
      styledWidth: p.styledWidth ?? null,
      styledHeight: p.styledHeight ?? null,
    }));

    /* allDone is false for a document with no photos yet. "Nothing to do" and
       "everything is finished" look the same to a vacuous truth, and the
       builder would take it as permission to check out an empty build. */
    const body = {
      photos,
      allDone: photos.length > 0 && photos.every((p) => p.styleStatus === 'done'),
      anyFailed: photos.some((p) => p.styleStatus === 'failed'),
      styleSize: doc.styleSize || null,
      styleCalls: doc.styleCalls || 0,
    };
    return new Response(req.method === 'HEAD' ? null : JSON.stringify(body), { status: 200, headers: PRIVATE });
  } catch (err) {
    console.error(`personalisation-status: could not read ${id}:`, err.message);
    return notFound();
  }
};

// NOTE: deliberately NO `export const config = { path }` here — routed by the
// forced /api/* rewrite in netlify.toml, which carries the id through as a
// trailing path segment. An inline config.path collides with it and 404s.
