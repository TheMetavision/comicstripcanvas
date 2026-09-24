/**
 * Which address a function should use to reach its OWN site.
 *
 * There are two different answers and they had been treated as one.
 *
 * A link a CUSTOMER will click -- a Stripe return URL, an address in an email
 * -- has to be the public one, the domain on the packaging. That is
 * process.env.URL and it should stay that way.
 *
 * A fetch the SITE makes of itself is a different thing: the renderer pulling
 * its border masks, overlay, logo and fonts, or one function POSTing to start
 * another. Nobody sees that address. Sending it through the custom domain buys
 * nothing and stakes the render on that domain's DNS and CDN edge being healthy
 * at that moment.
 *
 * On 24 September they were not. comicstripcanvas.co.uk was refusing roughly
 * half of all connections for about eight minutes while <site>.netlify.app
 * answered every one. Three renders failed with "fetch failed" -- the renderer
 * could not reach its own assets -- and studio-rerender returned 502 because it
 * could not reach the function it was trying to start. Both were fetching the
 * apex.
 *
 * ── Why SITE_NAME and not DEPLOY_PRIME_URL ─────────────────────────────────
 *
 * The obvious fix is DEPLOY_PRIME_URL or DEPLOY_URL, and it does not work:
 * those are BUILD variables. Netlify's functions documentation lists exactly
 * three read-only variables available to a serverless function at runtime --
 * URL, SITE_NAME and SITE_ID -- and the deploy URLs are not among them. Several
 * functions here already wrote `process.env.DEPLOY_PRIME_URL || process.env.URL`
 * and had been quietly falling through to URL every time, because the first
 * term is undefined in production.
 *
 * SITE_NAME is available, and `https://<SITE_NAME>.netlify.app` is served by
 * Netlify directly with no custom DNS in the path at all.
 */

/** Hosts that are this machine, whatever the environment claims to be. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/** The origin of the request being served, when there is one to read. */
const originOf = (req) => {
  try { return req && req.url ? new URL(req.url).origin : null; }
  catch { return null; }
};

/**
 * Where to fetch this site's own assets, and where to POST to its own
 * functions.
 *
 * @param {Request} [req] the request being served, if this is a handler
 */
export function internalOrigin(req) {
  const here = originOf(req);

  /* Under `netlify dev` the site being tested is the one on this machine, and
     reaching out to production would test the wrong build entirely -- it would
     also START production's background functions from a developer's laptop.

     Decided on the REQUEST, not on an environment variable. `netlify dev`
     injects the project's real SITE_NAME and URL into everything it runs, and
     it does not reliably set NETLIFY_DEV: `netlify dev:exec` was measured
     handing over SITE_NAME="comicstripcanvas" and URL="https://comicstripcanvas.co.uk"
     with NETLIFY_DEV undefined. A request that arrived on localhost cannot have
     come from production, which is a fact about this call rather than a fact
     about how the process happened to be launched. */
  if (here && LOCAL_HOSTS.has(new URL(here).hostname)) return here;
  if (process.env.NETLIFY_DEV === 'true' || process.env.NETLIFY_LOCAL === 'true') {
    return here || process.env.URL || 'http://localhost:8888';
  }

  /* A deploy preview or branch deploy is already on a netlify.app host, and it
     must fetch ITS OWN assets rather than production's -- a preview built to
     test new template artwork would otherwise render with the live artwork and
     look like it worked. This also carries the choice down a chain: a function
     started at this origin sees it as its own request origin. */
  if (here && /\.netlify\.app$/.test(new URL(here).hostname)) return here;

  if (process.env.SITE_NAME) return `https://${process.env.SITE_NAME}.netlify.app`;

  /* No SITE_NAME means this is not running on Netlify -- a test, a script, a
     local handler harness -- so the public URL, then whatever is being served. */
  return process.env.URL || here || 'http://localhost:8888';
}

/** The address to put in front of a customer. Never the deploy's own host. */
export const publicOrigin = (req) =>
  process.env.URL || originOf(req) || 'https://comicstripcanvas.co.uk';

/**
 * Fetch, with a short retry on the failures that are worth retrying.
 *
 * A render is minutes of work that has already been paid for by the time it
 * asks for a font; giving up on the first refused connection throws all of it
 * away. Connection failures and 5xx get another go, because those are the shape
 * of a bad few seconds at an edge. A 404 does not: the asset is not there, and
 * asking four more times will not put it there.
 *
 * Deliberately short -- three attempts, ~0.3s then ~0.9s -- because a
 * background function has fifteen minutes for everything, not for waiting.
 */
export async function fetchWithRetry(url, { attempts = 3, baseDelayMs = 300, fetchImpl = fetch, sleep } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (res.ok || res.status < 500) return res;
      last = new Error(`HTTP ${res.status}`);
      /* A 5xx still has a body and a status the caller may want to report, so
         the LAST one is returned rather than thrown. */
      if (attempt === attempts) return res;
    } catch (err) {
      last = err;
      if (attempt === attempts) throw err;
    }
    await wait(baseDelayMs * Math.pow(3, attempt - 1));
  }
  throw last || new Error(`Could not fetch ${url}`);
}
