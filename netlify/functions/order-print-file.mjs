import { getStore } from '@netlify/blobs';
import { PRINT_STORE } from './_shared/order-print.mjs';

/**
 * Start / ask about / fetch the print file for one order line.
 *
 * The making is a background job -- 20-26 s for the largest sheet, well past
 * the ten seconds this has. So this is the small, fast half:
 *
 *   POST  ?action=start      hand the job to the renderer, return at once
 *   GET   ?action=status     working | ready | error | absent
 *   GET   ?action=download   the bytes, named so a human can file them
 *
 * Not secret-protected itself, and deliberately so: it lives behind
 * /admin/print-file/... which the Basic Auth edge function guards, and the
 * whole /api/* space is deliberately open because the shop's own pages live
 * there. What it exposes is a picture of artwork the shop sells, addressable
 * only by an order id AND a line key -- but an order id is not a password, so
 * if this ever needs to be private it needs its own secret rather than
 * obscurity. Said out loud here rather than assumed.
 */

const bad = (msg, status = 400) =>
  new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(s) && !s.includes('..');

/* A trigger that failed has to CLEAR the "working" note it just wrote.
   Leaving it is how the page polls for ever on a job that was never started --
   the exact shape of the bug this whole arrangement is meant to avoid. */
async function refuse(store, pending, error) {
  await store.setJSON(`${pending}.state`, { state: 'error', at: new Date().toISOString(), error })
    .catch(() => {});
  return json({ state: 'error', error }, 502);
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'status';
  const orderId = url.searchParams.get('order');
  const lineKey = url.searchParams.get('line');

  if (!isId(orderId) || !isId(lineKey)) return bad('order and line are required');

  const store = getStore(PRINT_STORE);
  const pending = `pending/${orderId}/${lineKey}`;

  if (action === 'start') {
    if (req.method !== 'POST') return bad('start is a POST', 405);

    /* The renderer is ALWAYS asked, even when the note says ready.

       The note points at a key that was right when it was written, and the key
       carries what the artwork was at that moment. Only the renderer reads the
       product and the scene, so only the renderer can tell whether that is
       still the artwork -- short-circuiting here served the old picture for
       ever after a redraw, which is the one thing the key was designed to
       prevent. Asking costs a blob metadata read: the renderer returns "already
       made" without rasterising anything. */
    const wasReady = await store.get(`${pending}.state`, { type: 'json' }).catch(() => null);

    /* BEFORE the trigger, not after. The renderer can finish before the
       trigger call returns -- a small file on a warm container, and every time
       under netlify dev, which runs the background function in the same
       process. Writing "working" afterwards then overwrites the "ready" it had
       already written, and the page polls for ever on a file that exists. */
    await store.setJSON(`${pending}.state`, { state: 'working', at: new Date().toISOString() })
      .catch(() => {});

    /* The host this request arrived on, not the site's configured URL.

       The trigger is same-site by definition, so the incoming host is always
       the right one -- and under netlify dev the configured URL is the live
       domain, so preferring it sends the job to production (or, as here, fails
       to connect at all) while the developer watches a local page say
       "Preparing" for ever. The env vars stay as a fallback for an invocation
       that somehow has no usable host. */
    const origin = `${url.protocol}//${url.host}`
      || process.env.DEPLOY_PRIME_URL || process.env.URL;
    /* AWAITED. A serverless environment is frozen the moment it responds, so a
       trigger that has not completed is suspended mid-flight and the job is
       never started -- the bug studio-save had, which worked in every local
       test because netlify dev is one long-lived process. */
    try {
      const res = await fetch(`${origin}/api/order-print-file-render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, lineKey }),
      });
      if (!res.ok && res.status !== 202) {
        return await refuse(store, pending, `the renderer refused the job (${res.status})`);
      }
    } catch (err) {
      return await refuse(store, pending, `could not reach the renderer: ${err.message}`);
    }

    /* Report what the store says rather than assuming: if the renderer already
       finished, the page should be told so now instead of polling to find out. */
    const now = await store.get(`${pending}.state`, { type: 'json' }).catch(() => null);
    if (now?.state === 'ready' && now.key) {
      const meta = await store.getMetadata(now.key).catch(() => null);
      /* "cached" means this click did not make a new file -- the key it landed
         on already existed. Worth telling the page, which says so. */
      if (meta) {
        return json({
          state: 'ready',
          cached: wasReady?.state === 'ready' && wasReady.key === now.key,
          ...meta.metadata,
        });
      }
    }
    if (now?.state === 'error') return json(now, 200);
    return json({ state: 'working' }, 202);
  }

  if (action === 'status') {
    const state = await store.get(`${pending}.state`, { type: 'json' }).catch(() => null);
    if (!state) return json({ state: 'absent' });
    if (state.state === 'ready' && state.key) {
      const meta = await store.getMetadata(state.key).catch(() => null);
      if (!meta) return json({ state: 'absent' });   // swept, or a stale note
      return json({ state: 'ready', ...meta.metadata });
    }
    return json(state);
  }

  if (action === 'download') {
    const state = await store.get(`${pending}.state`, { type: 'json' }).catch(() => null);
    if (state?.state !== 'ready' || !state.key) return bad('not made yet', 409);
    const blob = await store.get(state.key, { type: 'arrayBuffer' }).catch(() => null);
    if (!blob) return bad('the file is gone', 404);
    const meta = await store.getMetadata(state.key).catch(() => null);
    const name = meta?.metadata?.filename || 'print-file.png';
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': String(blob.byteLength),
        /* Immutable: the key changes when the artwork does, so a cached copy
           is only ever the file that key names. */
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  }

  return bad(`unknown action "${action}"`);
};

// No `path` here. netlify.toml rewrites /api/* to functions by name, and a
// config.path on a function under netlify/functions collides with that rule
// and 404s -- the fault this project has tripped over before.
