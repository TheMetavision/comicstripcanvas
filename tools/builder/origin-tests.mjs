/**
 * Which address the site uses to reach itself, and what it does when that
 * address has a bad few seconds.
 *
 *   node tools/builder/origin-tests.mjs
 *
 * On 24 September comicstripcanvas.co.uk refused roughly half of all
 * connections for about eight minutes while <site>.netlify.app answered every
 * one. Three renders died with "fetch failed" -- the renderer could not reach
 * its own border masks -- and studio-rerender returned 502 because it could not
 * reach the function it was starting. Every one of those fetches was aimed at
 * the custom domain for no reason: nobody sees them.
 *
 * The obvious fix, DEPLOY_PRIME_URL, is a BUILD variable. Netlify's functions
 * documentation lists three read-only variables available at runtime -- URL,
 * SITE_NAME, SITE_ID -- and the deploy URLs are not among them, which is why
 * the `DEPLOY_PRIME_URL || URL` already in two functions had been falling
 * through to URL every time in production.
 */
import { internalOrigin, publicOrigin, fetchWithRetry } from '../../netlify/functions/_shared/origin.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const req = (url) => ({ url });
/** Run with exactly this environment and nothing left over from the last case. */
const withEnv = (env, fn) => {
  const keep = { ...process.env };
  for (const k of ['URL', 'SITE_NAME', 'NETLIFY_DEV', 'NETLIFY_LOCAL']) delete process.env[k];
  Object.assign(process.env, env);
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
};

const PROD = { URL: 'https://comicstripcanvas.co.uk', SITE_NAME: 'comicstripcanvas' };

say('\n1. IN PRODUCTION\n');
{
  const origin = withEnv(PROD, () => internalOrigin(req('https://comicstripcanvas.co.uk/api/studio-render/x')));
  ok(origin === 'https://comicstripcanvas.netlify.app',
    'a request that arrived on the apex still fetches from the deploy', origin);
  ok(!origin.includes('comicstripcanvas.co.uk'),
    'so no custom DNS is in the path of an internal fetch');

  /* A background function is invoked by its own site, so whatever origin the
     trigger chose is the one it sees -- the choice carries down the chain. */
  const downstream = withEnv(PROD,
    () => internalOrigin(req('https://comicstripcanvas.netlify.app/.netlify/functions/studio-render-background')));
  ok(downstream === 'https://comicstripcanvas.netlify.app',
    'and a function started at that origin keeps it', downstream);

  const pub = withEnv(PROD, () => publicOrigin(req('https://comicstripcanvas.netlify.app/api/checkout')));
  ok(pub === 'https://comicstripcanvas.co.uk',
    'while anything a CUSTOMER sees stays on the real domain', pub);
}

say('\n2. DEPLOY PREVIEWS AND BRANCH DEPLOYS\n');
{
  /* SITE_NAME is the production site even on a preview, so preferring it blindly
     would have a preview render with production's template artwork and look as
     though the new artwork worked. */
  const preview = withEnv(PROD,
    () => internalOrigin(req('https://deploy-preview-42--comicstripcanvas.netlify.app/api/studio-render/x')));
  ok(preview === 'https://deploy-preview-42--comicstripcanvas.netlify.app',
    'a preview fetches its OWN assets, not production\'s', preview);

  const branch = withEnv(PROD,
    () => internalOrigin(req('https://feat-thing--comicstripcanvas.netlify.app/api/x')));
  ok(branch === 'https://feat-thing--comicstripcanvas.netlify.app', 'and so does a branch deploy', branch);
}

say('\n3. NETLIFY DEV\n');
{
  /* The trap: a linked project has SITE_NAME set locally too, so without this
     guard `netlify dev` would fetch production's assets and start production's
     functions while the developer watched a local page. */
  const dev = withEnv({ ...PROD, NETLIFY_DEV: 'true' },
    () => internalOrigin(req('http://localhost:8888/api/order-print-file/CSC-1/li_1')));
  ok(dev === 'http://localhost:8888', 'the site under test is the one on this machine', dev);

  const noSite = withEnv({ NETLIFY_DEV: 'true' }, () => internalOrigin(req('http://localhost:8888/api/x')));
  ok(noSite === 'http://localhost:8888', 'with or without a linked site', noSite);

  /* THE ONE THAT MATTERS. This is the environment `netlify dev:exec` was
     measured handing over on this machine: the project's real SITE_NAME and
     the live URL, and NO NETLIFY_DEV at all. A guard that trusted that variable
     would send a developer's local render at production's assets and start
     production's background functions from a laptop. */
  const asMeasured = withEnv(PROD,
    () => internalOrigin(req('http://localhost:8888/api/order-print-file/CSC-1003/li_1')));
  ok(asMeasured === 'http://localhost:8888',
    'and with NETLIFY_DEV unset, which is what netlify dev actually gives you', asMeasured);

  for (const host of ['http://127.0.0.1:8888', 'http://localhost:3999', 'http://[::1]:8888']) {
    const got = withEnv(PROD, () => internalOrigin(req(`${host}/api/x`)));
    ok(got === host, `${host} is recognised as this machine`, got);
  }
}

say('\n4. NOWHERE IN PARTICULAR\n');
{
  const harness = withEnv({ URL: 'https://test.local' }, () => internalOrigin(req('https://somewhere.else/api/x')));
  ok(harness === 'https://test.local',
    'off Netlify entirely — a test or a script — URL still answers', harness);
  const nothing = withEnv({}, () => internalOrigin(req('https://somewhere.else/api/x')));
  ok(nothing === 'https://somewhere.else', 'and failing that, whatever is being served', nothing);
  /* A local request beats both: a handler harness on 127.0.0.1 is this machine
     whatever URL happens to say. */
  const local = withEnv({ URL: 'https://test.local' }, () => internalOrigin(req('http://127.0.0.1:1234/api/x')));
  ok(local === 'http://127.0.0.1:1234', 'but a request from this machine stays on it', local);
  const blind = withEnv({}, () => internalOrigin(undefined));
  ok(blind === 'http://localhost:8888', 'a call with no request at all still returns something usable', blind);
  const broken = withEnv(PROD, () => internalOrigin(req('not a url')));
  ok(broken === 'https://comicstripcanvas.netlify.app',
    'and an unparseable request url does not throw', broken);
}

say('\n5. A BAD FEW SECONDS AT THE EDGE\n');
{
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };

  /* Two refused connections then success: exactly the 24 September shape. */
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    return { ok: true, status: 200 };
  };
  const res = await fetchWithRetry('https://x/asset.png', { fetchImpl: flaky, sleep });
  ok(res.ok && calls === 3, 'a connection refused twice is still fetched', `${calls} attempts`);
  ok(slept.length === 2 && slept[1] > slept[0], 'backing off further each time', JSON.stringify(slept));

  let tries = 0;
  const dead = async () => { tries++; throw new Error('fetch failed'); };
  let threw = null;
  await fetchWithRetry('https://x/a.png', { fetchImpl: dead, sleep }).catch((e) => { threw = e; });
  ok(!!threw && tries === 3, 'but it gives up rather than hanging the render', `${tries} attempts`);
  ok(/fetch failed/.test(threw.message), 'reporting what actually went wrong', threw.message);

  /* A 404 is an answer, not a bad connection. Asking four more times will not
     put the asset there, and a render has minutes for everything. */
  let hits = 0;
  const missing = async () => { hits++; return { ok: false, status: 404 }; };
  const gone = await fetchWithRetry('https://x/nope.png', { fetchImpl: missing, sleep });
  ok(gone.status === 404 && hits === 1, 'a 404 is not retried', `${hits} attempt`);

  let fives = 0;
  const server = async () => { fives++; return { ok: false, status: 503 }; };
  const busy = await fetchWithRetry('https://x/a.png', { fetchImpl: server, sleep });
  ok(fives === 3, 'a 503 is', `${fives} attempts`);
  ok(busy.status === 503, 'and the last response is handed back so the caller can say so', busy.status);
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
