// /api/newsletter: bot protection and double opt-in. Everything outside is
// stubbed -- fetch (Turnstile, MailerLite), @netlify/blobs (in-memory, with
// ETags enforced) and node:dns/promises -- so nothing leaves the machine.
//
//   npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

globalThis.__blobs = { data: new Map(), down: false };
globalThis.__dns = { answers: new Map() };
const STUBS = {
  '@netlify/blobs': `
    export function getStore() {
      const b = globalThis.__blobs;
      let n = 0;
      return {
        async getWithMetadata(key) {
          if (b.down) throw new Error('blobs unreachable');
          const e = b.data.get(key);
          return e ? { data: JSON.parse(e.json), etag: e.etag, metadata: {} } : null;
        },
        async setJSON(key, value, opts = {}) {
          if (b.down) throw new Error('blobs unreachable');
          const e = b.data.get(key);
          if (opts.onlyIfNew && e) return { modified: false };
          if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
          const etag = 'e' + (++n) + '-' + Math.random();
          b.data.set(key, { json: JSON.stringify(value), etag });
          return { modified: true, etag };
        },
      };
    }`,
  'node:dns/promises': `
    export async function resolveMx(domain) {
      const a = globalThis.__dns.answers.get(domain);
      if (a === undefined) return [{ exchange: 'mx1.mail-host.example', priority: 10 }];
      if (a instanceof Error) throw a;
      if (a === 'hang') return new Promise(() => {});
      return a;
    }`,
};
registerHooks({
  resolve(spec, ctx, next) { return spec in STUBS ? { url: `stub:${spec}`, shortCircuit: true } : next(spec, ctx); },
  load(url, ctx, next) { return url.startsWith('stub:') ? { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true } : next(url, ctx); },
});
const dnsError = (code) => Object.assign(new Error(code), { code });

// Netlify's runtime global, backed by process.env.
globalThis.Netlify = { env: { get: (k) => process.env[k] } };
process.env.MAILERLITE_API_KEY = 'ml_test_stub';
process.env.MAILERLITE_GROUP_ID = '424242';
process.env.TURNSTILE_SECRET_KEY = 'ts_test_secret';

// fetch: Turnstile siteverify and the MailerLite API.
let calls = [];
let turnstile = { success: true };       // or { throws: true }
let subscriber = null;                   // MailerLite's record for the address, or null (404)
let lookupStatus = null;                 // force the GET's status
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const call = { url, method: init.method || 'GET', body: init.body };
  calls.push(call);
  if (url.includes('challenges.cloudflare.com')) {
    call.form = Object.fromEntries(new URLSearchParams(String(init.body)));
    if (turnstile.throws) throw new Error('getaddrinfo ENOTFOUND challenges.cloudflare.com');
    return Response.json(turnstile);
  }
  if (url.startsWith('https://connect.mailerlite.com/api/subscribers/')) {
    if (lookupStatus) return new Response('{"message":"Server Error"}', { status: lookupStatus });
    return subscriber ? Response.json({ data: subscriber }) : new Response('{"message":"Resource not found."}', { status: 404 });
  }
  if (url === 'https://connect.mailerlite.com/api/subscribers' && call.method === 'POST') {
    call.json = JSON.parse(init.body);
    return Response.json({ data: { id: '1', email: call.json.email, status: call.json.status || 'active' } }, { status: 201 });
  }
  throw new Error(`unexpected fetch ${call.method} ${url}`);
};
const mlCreates = () => calls.filter((c) => c.json);
const mlCalls = () => calls.filter((c) => c.url.includes('mailerlite'));

const { default: handler } = await import('../netlify/functions/newsletter.mts');

let ipSeq = 0;
const now = Date.now();
const human = (over = {}) => ({
  email: 'reader@realmail.example',
  turnstileToken: 'tok-ok',
  csc_nl_extra: '',
  csc_nl_ts_load: now - 8000,
  csc_nl_ts_submit: now,
  ...over,
});
const post = async (body, ip = `203.0.113.${++ipSeq}`) => {
  const res = await handler(new Request('http://localhost/api/newsletter', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': ip },
    body: JSON.stringify(body),
  }), {});
  return { status: res.status, body: await res.json() };
};
const ACCEPTED = {
  success: true,
  message: "Thanks! If you're new here, check your inbox for a link to confirm your subscription.",
};

beforeEach(() => {
  calls = []; turnstile = { success: true }; subscriber = null; lookupStatus = null;
  globalThis.__blobs.data.clear(); globalThis.__blobs.down = false;
  globalThis.__dns.answers.clear();
  process.env.TURNSTILE_SECRET_KEY = 'ts_test_secret';
});

// ── Double opt-in ────────────────────────────────────────────────────────

test('a new address is created unconfirmed in the group, so MailerLite sends its confirmation', async () => {
  const r = await post(human({ email: '  Reader@RealMail.example ' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, ACCEPTED);
  const [create] = mlCreates();
  assert.deepEqual(create.json, { email: 'reader@realmail.example', groups: ['424242'], status: 'unconfirmed' });
  assert.ok(calls.some((c) => c.method === 'GET' && c.url.endsWith('/subscribers/reader%40realmail.example')), 'looked up first');
});

test('an active subscriber is never reset to unconfirmed (no confirmation email to them)', async () => {
  subscriber = { email: 'reader@realmail.example', status: 'active', groups: [{ id: '424242' }] };
  assert.deepEqual((await post(human())).body, ACCEPTED);
  assert.equal(mlCreates().length, 0, 'already in the group: nothing written');

  calls = [];
  subscriber = { email: 'reader@realmail.example', status: 'active', groups: [{ id: '999' }] };
  await post(human());
  const [add] = mlCreates();
  assert.deepEqual(add.json, { email: 'reader@realmail.example', groups: ['424242'] }, 'added to the group, status left alone');
});

for (const status of ['unconfirmed', 'unsubscribed', 'bounced', 'junk']) {
  test(`an existing ${status} subscriber gets nothing: no re-sent confirmation, no resubscribe`, async () => {
    subscriber = { email: 'reader@realmail.example', status, groups: [] };
    const r = await post(human());
    assert.deepEqual(r.body, ACCEPTED, 'same answer as a new address');
    assert.equal(mlCreates().length, 0);
  });
}

test('every accepted case answers identically, so the list cannot be probed', async () => {
  const answers = [];
  for (const s of [null, { status: 'active', groups: [{ id: '424242' }] }, { status: 'unconfirmed' }, { status: 'unsubscribed' }]) {
    subscriber = s;
    const r = await post(human());
    answers.push(JSON.stringify([r.status, r.body]));
  }
  assert.equal(new Set(answers).size, 1, answers.join('\n'));
});

test('MailerLite lookup failing: a generic 502 and nothing created blind', async () => {
  lookupStatus = 500;
  const r = await post(human());
  assert.equal(r.status, 502);
  assert.deepEqual(Object.keys(r.body), ['error']);
  assert.equal(mlCreates().length, 0);
});

// ── Honeypot and time on page ────────────────────────────────────────────

test('a filled honeypot looks like success and nothing is called at all', async () => {
  const r = await post(human({ csc_nl_extra: 'http://spam.example' }));
  assert.deepEqual(r.body, ACCEPTED);
  assert.equal(calls.length, 0);
});

test('submitted under 3 seconds after the form loaded: looks like success, nothing called', async () => {
  const r = await post(human({ csc_nl_ts_load: now - 900, csc_nl_ts_submit: now }));
  assert.deepEqual(r.body, ACCEPTED);
  assert.equal(calls.length, 0);
});

test('missing timestamps do not trip the timing check (Turnstile covers direct posts)', async () => {
  const body = human();
  delete body.csc_nl_ts_load; delete body.csc_nl_ts_submit;
  assert.equal((await post(body)).status, 200);
  assert.equal(mlCreates().length, 1);
});

// ── Turnstile ────────────────────────────────────────────────────────────

test('Turnstile is verified server-side with the secret and the visitor IP', async () => {
  await post(human(), '198.51.100.44');
  const verify = calls.find((c) => c.form);
  assert.deepEqual(verify.form, { secret: 'ts_test_secret', response: 'tok-ok', remoteip: '198.51.100.44' });
});

test('no token: 400 and MailerLite is never called', async () => {
  const r = await post(human({ turnstileToken: '' }));
  assert.equal(r.status, 400);
  assert.equal(mlCalls().length, 0);
});

test('a token Cloudflare rejects: 400, nothing subscribed', async () => {
  turnstile = { success: false, 'error-codes': ['invalid-input-response'] };
  const r = await post(human());
  assert.equal(r.status, 400);
  assert.equal(mlCalls().length, 0);
});

test('siteverify unreachable: 503, never fails open', async () => {
  turnstile = { throws: true };
  const r = await post(human());
  assert.equal(r.status, 503);
  assert.equal(mlCalls().length, 0);
});

test('no Turnstile secret configured: the endpoint is closed (503), not open', async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  const r = await post(human());
  assert.equal(r.status, 503);
  assert.equal(calls.length, 0);
});

// ── Per-IP rate limit ────────────────────────────────────────────────────

test('per IP: 3 sign-ups an hour, the 4th is a 429 and MailerLite is not called', async () => {
  const ip = '198.51.100.7';
  for (let i = 0; i < 3; i++) assert.equal((await post(human({ email: `p${i}@realmail.example` }), ip)).status, 200);
  calls = [];
  const over = await post(human({ email: 'p9@realmail.example' }), ip);
  assert.equal(over.status, 429);
  assert.equal(mlCalls().length, 0);
  assert.equal((await post(human({ email: 'other@realmail.example' }), '198.51.100.8')).status, 200, 'another IP is unaffected');
});

test('per IP: after an hour the same IP can sign up again; keys are hashed', async () => {
  const ip = '198.51.100.9';
  for (let i = 0; i < 3; i++) await post(human({ email: `w${i}@realmail.example` }), ip);
  assert.equal((await post(human(), ip)).status, 429);
  const keys = [...globalThis.__blobs.data.keys()].join(' ');
  assert.ok(!keys.includes('198.51.100.9'), keys);
  for (const e of globalThis.__blobs.data.values()) {
    const v = JSON.parse(e.json); v.hits = v.hits.map((t) => t - 60 * 60 * 1000 - 1); e.json = JSON.stringify(v);
  }
  assert.equal((await post(human({ email: 'later@realmail.example' }), ip)).status, 200);
});

test('bot-signal requests (honeypot, too fast, bad token) do not use up the IP allowance', async () => {
  const ip = '198.51.100.11';
  for (let i = 0; i < 4; i++) {
    await post(human({ csc_nl_extra: 'x' }), ip);
    await post(human({ csc_nl_ts_load: now - 10 }), ip);
    await post(human({ turnstileToken: '' }), ip);
  }
  assert.equal((await post(human(), ip)).status, 200);
});

test('Blobs unreachable: the limit steps aside and real sign-ups still work', async () => {
  globalThis.__blobs.down = true;
  for (let i = 0; i < 5; i++) assert.equal((await post(human({ email: `b${i}@realmail.example` }), '198.51.100.12')).status, 200);
});

// ── Domain checks (MX) ───────────────────────────────────────────────────

test('known disposable domains are refused before any DNS or MailerLite call', async () => {
  for (const email of ['x@mailinator.com', 'x@yopmail.fr', 'x@sub.guerrillamail.com']) {
    calls = [];
    const r = await post(human({ email }));
    assert.equal(r.status, 400, email);
    assert.match(r.body.error, /disposable/);
    assert.equal(mlCalls().length, 0);
  }
});

test('a domain whose mail servers belong to a disposable service is refused', async () => {
  globalThis.__dns.answers.set('fresh-alias.example', [{ exchange: 'mail.mailinator.com', priority: 10 }]);
  const r = await post(human({ email: 'x@fresh-alias.example' }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /disposable/);
});

test('domains that cannot receive mail are refused: no such domain, no MX, null MX', async () => {
  globalThis.__dns.answers.set('nope.example', dnsError('ENOTFOUND'));
  globalThis.__dns.answers.set('nomx.example', dnsError('ENODATA'));
  globalThis.__dns.answers.set('nullmx.example', [{ exchange: '', priority: 0 }]);
  globalThis.__dns.answers.set('nullmx2.example', [{ exchange: '.', priority: 0 }]);
  for (const d of ['nope.example', 'nomx.example', 'nullmx.example', 'nullmx2.example']) {
    calls = [];
    const r = await post(human({ email: `x@${d}` }));
    assert.equal(r.status, 400, d);
    assert.match(r.body.error, /can't receive mail/);
    assert.equal(mlCalls().length, 0, d);
  }
});

test('a DNS failure or timeout is not held against the visitor', async () => {
  globalThis.__dns.answers.set('flaky.example', dnsError('ESERVFAIL'));
  globalThis.__dns.answers.set('slow.example', 'hang');
  for (const d of ['flaky.example', 'slow.example']) {
    calls = [];
    assert.equal((await post(human({ email: `x@${d}` }))).status, 200, d);
    assert.equal(mlCreates().length, 1, d);
  }
});

// ── The rest ─────────────────────────────────────────────────────────────

test('format and method are still checked', async () => {
  assert.equal((await post(human({ email: 'not-an-email' }))).status, 400);
  assert.equal((await post(human({ email: '' }))).status, 400);
  const res = await handler(new Request('http://localhost/api/newsletter'), {});
  assert.equal(res.status, 405);
});
