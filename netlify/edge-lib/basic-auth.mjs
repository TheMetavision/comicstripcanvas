/**
 * The /admin Basic Auth check, as something more than one edge function can do.
 *
 * It lives OUTSIDE netlify/edge-functions/ deliberately: anything in that
 * directory is treated as an edge function and given a route of its own, and a
 * shared helper with a route is a second front door.
 *
 * Extracted from admin-auth.ts rather than written again beside it. Two copies
 * of a password check is two things to keep in step, and the one that drifts is
 * always the copy nobody is looking at.
 *
 * Returns null when the request may proceed, and the Response to send when it
 * may not — so a caller reads as:
 *
 *     const denied = await checkBasicAuth(request, creds);
 *     if (denied) return denied;
 */

const REALM = 'Comic Strip Canvas admin';

export const challenge = () =>
  new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

/* Compare through SHA-256 rather than byte-by-byte on the raw values. Digests
   are always 32 bytes, so the comparison cannot leak the length of the real
   password the way an early length check would, and the loop below has no
   branch that ends it early. */
export async function sameSecret(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * @param {Request} request
 * @param {{ user?: string, pass?: string, isLocal?: boolean }} creds
 * @returns {Promise<Response|null>} null to allow, a Response to refuse
 */
export async function checkBasicAuth(request, { user, pass, isLocal = false } = {}) {
  if (!user || !pass) {
    /* Unset credentials are a convenience locally and a fault anywhere else. */
    if (isLocal) return null;
    /* Not a 401: there is no password that would work, so inviting one would
       be a lie. Not a pass-through either -- that is how /admin ends up open
       because somebody forgot a variable. */
    return new Response('admin auth not configured', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const header = request.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (!encoded || scheme.toLowerCase() !== 'basic') return challenge();

  let decoded;
  try {
    decoded = atob(encoded);
  } catch {
    return challenge();          // not valid base64; nothing to compare
  }

  // Only the FIRST colon separates them, so a password may contain colons.
  const at = decoded.indexOf(':');
  if (at < 0) return challenge();

  /* Both are always checked -- no && short-circuit -- so a wrong username and
     a wrong password take the same path and the same time. */
  const okUser = await sameSecret(decoded.slice(0, at), user);
  const okPass = await sameSecret(decoded.slice(at + 1), pass);
  return okUser && okPass ? null : challenge();
}

/** netlify dev sets NETLIFY_DEV; a real deploy reports its context instead. */
export const runningLocally = (env) =>
  env.get('NETLIFY_DEV') === 'true' || env.get('CONTEXT') === 'dev';
