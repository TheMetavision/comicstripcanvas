import type { Config, Context } from '@netlify/edge-functions';

/**
 * HTTP Basic Auth in front of /admin/*.
 *
 * An edge function rather than a Basic-Auth line in _headers. That directive is
 * a Pro-plan feature, and where it is not supported it is treated as an ordinary
 * custom header and echoed to the caller -- which publishes the password instead
 * of asking for it. The local CLI does exactly that, so the rule could not even
 * be tested before deploying. This works on any plan, is enforced by netlify
 * dev, and sends nothing back but a challenge.
 *
 * Declaring `path` here is correct and is not the rule this project keeps
 * tripping over: a SERVERLESS function under netlify/functions must not set
 * config.path, because it collides with the forced /api/* rewrite in
 * netlify.toml and 404s. Edge functions are routed separately and declare their
 * own path by design.
 *
 * /api/* is deliberately untouched. Every function lives there -- the customer
 * builder's uploads and status polls, the Studio's actions, the Stripe webhook
 * -- and a password on any of it would break the shop. This guards the page;
 * studio-save still refuses without PERSONALISATION_ACTION_SECRET, so there are
 * two independent layers and this is not the only one.
 */

const REALM = 'Comic Strip Canvas admin';

const challenge = () =>
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
async function sameSecret(given: string, expected: string): Promise<boolean> {
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

export default async (request: Request, context: Context) => {
  const user = Netlify.env.get('ADMIN_BASIC_USER') || '';
  const pass = Netlify.env.get('ADMIN_BASIC_PASS') || '';

  /* netlify dev sets NETLIFY_DEV; a real deploy reports its context instead.
     Unset credentials are a convenience locally and a fault anywhere else. */
  const isLocal = Netlify.env.get('NETLIFY_DEV') === 'true'
    || Netlify.env.get('CONTEXT') === 'dev';

  if (!user || !pass) {
    if (isLocal) return context.next();
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

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return challenge();          // not valid base64; nothing to compare
  }

  // Only the FIRST colon separates them, so a password may contain colons.
  const at = decoded.indexOf(':');
  if (at < 0) return challenge();
  const givenUser = decoded.slice(0, at);
  const givenPass = decoded.slice(at + 1);

  /* Both are always checked -- no && short-circuit -- so a wrong username and
     a wrong password take the same path and the same time. */
  const okUser = await sameSecret(givenUser, user);
  const okPass = await sameSecret(givenPass, pass);
  if (!(okUser && okPass)) return challenge();

  return context.next();
};

export const config: Config = { path: '/admin/*' };
