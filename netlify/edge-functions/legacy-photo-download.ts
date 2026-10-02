import { getStore } from '@netlify/blobs';
import type { Config } from '@netlify/edge-functions';
import { checkBasicAuth, runningLocally } from '../edge-lib/basic-auth.mjs';
import {
  CONTENT_TYPES, LEGACY_PHOTO_KEY, LEGACY_PHOTO_PATH, LEGACY_PHOTO_STORE,
} from '../edge-lib/legacy-photo-keys.mjs';

/**
 * GET /admin/api/legacy-photo/<sha256>.<ext>
 *     → a customer photo from the old upload flow, from private Blobs.
 *
 * These used to be public cdn.sanity.io URLs (see edge-lib/legacy-photo-keys.mjs).
 * Now they are behind the same Basic Auth as the rest of /admin, checked here
 * rather than relied on from admin-auth.ts, exactly as print-file-download does.
 *
 *   · the key must be a bare content hash, so nothing from the URL becomes a path
 *   · private, no-store, noindex: a customer's photograph, never shared-cached
 *   · unknown and malformed keys are the same bare 404
 */

const text = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });

export default async function handler(req: Request): Promise<Response> {
  const denied = await checkBasicAuth(req, {
    user: Netlify.env.get('ADMIN_BASIC_USER') || '',
    pass: Netlify.env.get('ADMIN_BASIC_PASS') || '',
    isLocal: runningLocally(Netlify.env),
  });
  if (denied) return denied;

  if (req.method !== 'GET' && req.method !== 'HEAD') return text('Method not allowed', 405);

  const key = new URL(req.url).pathname.slice(LEGACY_PHOTO_PATH.length);
  if (!LEGACY_PHOTO_KEY.test(key)) return text('Not found', 404);

  const store = getStore({ name: LEGACY_PHOTO_STORE, consistency: 'strong' });
  const body = await store.get(key, { type: 'stream' }).catch(() => null);
  if (!body) return text('Not found', 404);

  const ext = key.split('.').pop() as keyof typeof CONTENT_TYPES;
  return new Response(req.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

/* Inline, NOT netlify.toml, for the same ordering reason as print-file-download. */
export const config: Config = { path: '/admin/api/legacy-photo/*' };
