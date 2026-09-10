import { getStore } from '@netlify/blobs';
import { STUDIO_STORE } from './_shared/studio-uploads.mjs';
import { startRender } from './_shared/studio-render-trigger.mjs';

/**
 * Run a studio render again, from the scene already in the store.
 *
 *     POST /api/studio-render/<productId>     X-CSC-Action-Secret: <secret>
 *
 * A save writes three things: the draft, the scene, and the request that starts
 * the renderer. The first two are durable; the third is a network call, and a
 * network call can fail -- which is exactly what happened when studio-save
 * fired its trigger without awaiting it and every render in production was
 * silently never started. The draft and the scene survived all of it, so the
 * work was never lost; there was simply no way to ask for it again without
 * rebuilding the design and saving it a second time.
 *
 * This is that way. It needs nothing from the browser: everything the renderer
 * wants is in studio/<id>/scene.json, including which document to attach the
 * pictures to.
 *
 * Once a render succeeds the renderer deletes the scene, so a 404 here means
 * either it already finished -- look at the product -- or the design is gone
 * and has to be rebuilt. Both are worth saying plainly, so this says which.
 *
 * Secret-protected: it starts real work against a real product, and
 * /api/studio-render itself is internal and unauthenticated.
 */

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

/* Same shape studio-save and studio-render accept: a fresh studio- id, or the
   product's own id when a design was redrawn onto an existing product. */
const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(s) && !s.includes('..');

export default async (req) => {
  const expected = process.env.PERSONALISATION_ACTION_SECRET;
  if (!expected) {
    console.error('studio-rerender: PERSONALISATION_ACTION_SECRET is not set — refusing.');
    return json({ error: 'Re-rendering is not configured on this deploy' }, 503);
  }
  if (!sameSecret(req.headers.get('x-csc-action-secret'), expected)) {
    console.warn('studio-rerender: rejected a call with a bad or missing secret');
    return json({ error: 'Not authorised' }, 401);
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  /* The id is the last path segment. /api/studio-render/<id> reaches this
     function through its own rewrite in netlify.toml, so what arrives is
     /.netlify/functions/studio-rerender/<id>. */
  const id = decodeURIComponent((new URL(req.url).pathname.split('/').filter(Boolean).pop() || '').trim());
  if (!isId(id) || id === 'studio-rerender') {
    return json({ error: 'POST /api/studio-render/<productId> — the product id is missing or not well formed' }, 400);
  }

  const store = getStore(STUDIO_STORE);
  const raw = await store.get(`studio/${id}/scene.json`, { type: 'text' }).catch(() => null);
  if (!raw) {
    /* Tell them WHICH of the two it is. A finished render leaves a print
       master behind; a design that was never saved, or was swept, leaves
       nothing at all. */
    const done = await store.getMetadata(`studio/${id}/print.png`).catch(() => null);
    return json({
      error: done
        ? `Nothing to re-run for ${id}: the render already finished and the print master is in the store. ` +
          `If the product still has no images, the Sanity write is what failed — save it again.`
        : `No stored scene for ${id}. Either the id is wrong, or the design was never saved.`,
      id, rendered: !!done,
    }, 404);
  }

  let job;
  try { job = JSON.parse(raw); }
  catch (err) { return json({ error: `The stored scene for ${id} is not readable: ${err.message}`, id }, 500); }

  /* docId has been in the scene since this bug was fixed. Older scenes predate
     it, and for those the draft is the only place a save has ever written --
     blobs are keyed on the published id and the document write always targets
     the draft -- so this is a derivation, not a guess. */
  const docId = job.docId || `drafts.${id}`;
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;

  const trigger = await startRender({
    origin, id, docId,
    title: job.title || '(untitled)',
    printWidth: job.printWidth,
    replacing: !!job.replacing,
  });

  console.log(`studio-rerender: ${id} -> ${docId}; render trigger POST ${trigger.url} -> ` +
    (trigger.ok ? `${trigger.status}` : `FAILED (${trigger.status || trigger.error})`));

  if (!trigger.ok) {
    return json({
      ok: false, id, docId,
      error: `The renderer would not start (${trigger.status ? `HTTP ${trigger.status}` : trigger.error}). ` +
        `The scene is still stored, so this can be tried again.`,
      trigger: { url: trigger.url, status: trigger.status || null },
    }, 502);
  }

  return json({
    ok: true, id, docId,
    title: job.title || null,
    savedAt: job.savedAt || null,
    print: { width: job.printWidth || null, status: 'rendering' },
    trigger: { url: trigger.url, status: trigger.status },
    note: 'The renderer has the job. Give it a minute, then look at the product.',
  });
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/studio-render/* is rewritten to this function by name in netlify.toml,
// the same arrangement every other function in this directory uses. An inline
// config.path collides with the forced /api/* rewrite and 404s.
