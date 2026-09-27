import type { Config, Context } from '@netlify/edge-functions';
import { checkBasicAuth, runningLocally } from '../edge-lib/basic-auth.mjs';

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
 * studio-save still refuses without CSC_INTERNAL_SECRET, so there are
 * two independent layers and this is not the only one.
 */

/* The check itself lives in ../edge-lib/basic-auth.mjs so that the download
   edge function can make it too. It is outside edge-functions/ because Netlify
   gives everything in here a route, and a shared helper with a route of its
   own is a second front door. */

export default async (request: Request, context: Context) => {
  const denied = await checkBasicAuth(request, {
    user: Netlify.env.get('ADMIN_BASIC_USER') || '',
    pass: Netlify.env.get('ADMIN_BASIC_PASS') || '',
    isLocal: runningLocally(Netlify.env),
  });
  if (denied) return denied;
  return context.next();
};

export const config: Config = { path: '/admin/*' };
