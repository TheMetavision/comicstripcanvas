import { getStore } from '@netlify/blobs';
import type { Config } from '@netlify/edge-functions';
import { checkBasicAuth, runningLocally } from '../edge-lib/basic-auth.mjs';
import { PRINT_STORE, SERVABLE, isSafeId, stateKey } from '../edge-lib/print-download-keys.mjs';

/**
 * GET /admin/api/print-file/download?order=<orderId>&line=<lineKey>
 *     → the finished print file for that order line, streamed from Blobs.
 *
 * WHY AN EDGE FUNCTION
 * --------------------
 * Netlify caps a serverless function's response at 6 MB buffered and 20 MB
 * streamed, and neither is configurable. Print files are nowhere near that.
 * Measured from real masters, every size and finish CSC sells exceeds the
 * buffered cap -- the smallest, an 8x12in poster, is 8.9 MB -- and five of the
 * nine exceed the streamed cap too. A 24x16in gallery canvas from a heavy
 * master came out at 118 MB. So order-print-file.mjs, which read the whole
 * blob into an ArrayBuffer and returned it, could not deliver a single one of
 * the files it had just spent minutes making.
 *
 * Edge functions have no documented response-size limit and can read Blobs.
 * The stream is handed straight to the Response here: the bytes are piped, not
 * touched, so the 50ms CPU budget per request is not spent on them.
 *
 * WHY IT CHECKS AUTH ITSELF
 * -------------------------
 * admin-auth.ts already covers /admin/*, and this is under /admin. But both
 * are declared INLINE, and Netlify runs inline edge functions in alphabetical
 * order by filename -- "admin-auth" before "print-file-download", which is
 * correct today by an accident of the alphabet. Checking here as well means
 * the file is not one rename away from being public.
 *
 * Note it must stay inline for that reason: edge functions declared in
 * netlify.toml run BEFORE inline ones, so moving this into the toml would put
 * it in front of the guard rather than behind it.
 *
 * The start and status actions are unchanged and still live on
 * /admin/api/order-print-file: they answer in JSON, they are small, and a
 * function is the right place for work that has to talk to Sanity.
 */

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export default async function handler(req: Request): Promise<Response> {
  const denied = await checkBasicAuth(req, {
    user: Netlify.env.get('ADMIN_BASIC_USER') || '',
    pass: Netlify.env.get('ADMIN_BASIC_PASS') || '',
    isLocal: runningLocally(Netlify.env),
  });
  if (denied) return denied;

  if (req.method !== 'GET' && req.method !== 'HEAD') return text('Method not allowed', 405);

  const url = new URL(req.url);
  const orderId = url.searchParams.get('order') || '';
  const lineKey = url.searchParams.get('line') || '';
  if (!isSafeId(orderId) || !isSafeId(lineKey)) return text('order and line are required', 400);

  /* STRONG consistency, both reads. The default is eventual, and this store is
     written by the background renderer and read by whoever clicked Download a
     moment later -- which is exactly the case eventual consistency breaks, and
     it broke it: a finished file reported "not made yet" in production. */
  const store = getStore({ name: PRINT_STORE, consistency: 'strong' });

  const state = await store.get(stateKey(orderId, lineKey), { type: 'json' }).catch(() => null) as
    { state?: string; key?: string } | null;
  if (state?.state !== 'ready' || !state.key) {
    return text('not made yet — open the print-file page first', 409);
  }
  if (!SERVABLE.test(state.key)) return text('that file is not downloadable here', 400);

  const meta = await store.getMetadata(state.key).catch(() => null);
  if (!meta) return text('the file is gone', 404);

  const body = await store.get(state.key, { type: 'stream' }).catch(() => null);
  if (!body) return text('the file is gone', 404);

  const name = (meta.metadata as Record<string, unknown>)?.filename as string
    || state.key.split('/').pop()
    || 'print-file.png';

  const headers: Record<string, string> = {
    'Content-Type': 'image/png',
    'Content-Disposition': `attachment; filename="${String(name).replace(/[^A-Za-z0-9._-]/g, '-')}"`,
    /* Immutable: the key changes when the artwork does, so a cached copy is
       only ever the file that key names. Private because it is somebody's
       order. */
    'Cache-Control': 'private, max-age=31536000, immutable',
  };
  /* Only when the stored note actually carries it. A Content-Length that
     disagrees with the body is worse than none: the browser truncates or
     hangs, and the file looks corrupt rather than missing. */
  const bytes = Number((meta.metadata as Record<string, unknown>)?.bytes);
  if (Number.isFinite(bytes) && bytes > 0) headers['Content-Length'] = String(bytes);

  return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers });
}

/* Inline, NOT netlify.toml — see the note above about ordering. */
export const config: Config = { path: '/admin/api/print-file/download' };
