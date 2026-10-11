// /api/newsletter and /api/newsletter-confirm: bot protection and our own
// double opt-in. Everything outside is stubbed -- fetch (Turnstile, MailerLite,
// Resend), @netlify/blobs (in-memory, ETags enforced) and node:dns/promises --
// so nothing leaves the machine.
//
//   npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

globalThis.__blobs = { data: new Map(), down: false, delay: 0 };
globalThis.__dns = { answers: new Map() };
const STUBS = {
  '@netlify/blobs': `
    export function getStore({ name }) {
      const b = globalThis.__blobs;
      const k = (key) => name + '/' + key;
      let n = 0;
      const slow = () => b.delay === 'hang' ? new Promise(() => {}) : b.delay ? new Promise((r) => setTimeout(r, b.delay)) : null;
      return {
        async getWithMetadata(key) {
          await slow();
          if (b.down) throw new Error('blobs unreachable');
          const e = b.data.get(k(key));
          return e ? { data: JSON.parse(e.json), etag: e.etag, metadata: {} } : null;
        },
        async setJSON(key, value, opts = {}) {
          await slow();
          if (b.down) throw new Error('blobs unreachable');
          const e = b.data.get(k(key));
          if (opts.onlyIfNew && e) return { modified: false };
          if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
          const etag = 'e' + (++n) + '-' + Math.random();
          b.data.set(k(key), { json: JSON.stringify(value), etag });
          return { modified: true, etag };
        },
        async delete(key) {
          await slow();
          if (b.down) throw new Error('blobs unreachable');
          b.data.delete(k(key));
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
const blobs = globalThis.__blobs;

// Netlify's runtime global, backed by process.env.
globalThis.Netlify = { env: { get: (k) => process.env[k] } };
const ENV = {
  MAILERLITE_API_KEY: 'ml_test_stub',
  MAILERLITE_GROUP_ID: '424242',
  TURNSTILE_SECRET_KEY: 'ts_test_secret',
  RESEND_API_KEY: 're_test_stub',
  NEWSLETTER_CONFIRM_SECRET: 'confirm-secret-for-tests-only',
  URL: 'https://comicstripcanvas.example',
};

// fetch: Turnstile, MailerLite and Resend.
let calls = [];
let turnstile = { success: true };       // or { throws: true }
let subscriber = null;                   // MailerLite's record for the address, or null (404)
let lookupStatus = null;                 // force the lookup's status
let resendStatus = 200;
let mlCreateStatus = 201;                // or 'throw'
let delays = {};                         // { turnstile, lookup, create, resend }: ms, or 'hang'
/** Wait like a slow server would; an aborted request rejects as fetch does. */
function lag(ms, signal) {
  if (!ms) return null;
  return new Promise((resolve, reject) => {
    const t = ms === 'hang' ? null : setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); });
  });
}
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const call = { url, method: init.method || 'GET', signal: !!init.signal };
  calls.push(call);
  const which = url.includes('challenges.cloudflare.com') ? 'turnstile'
    : url.startsWith('https://connect.mailerlite.com/api/subscribers/') ? 'lookup'
    : url.startsWith('https://connect.mailerlite.com/api/subscribers') ? 'create'
    : url.startsWith('https://api.resend.com') ? 'resend' : '';
  await lag(delays[which], init.signal);
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
    call.ml = JSON.parse(init.body);
    if (mlCreateStatus === 'throw') throw new Error('ECONNRESET');
    return Response.json({ data: { id: '1' } }, { status: mlCreateStatus });
  }
  if (url === 'https://api.resend.com/emails') {
    call.mail = JSON.parse(init.body);
    return Response.json({ id: 'em_1' }, { status: resendStatus });
  }
  throw new Error(`unexpected fetch ${call.method} ${url}`);
};
const mails = () => calls.filter((c) => c.mail).map((c) => c.mail);
const mlWrites = () => calls.filter((c) => c.ml).map((c) => c.ml);
const mlCalls = () => calls.filter((c) => c.url.includes('mailerlite'));

const { default: signup } = await import('../netlify/functions/newsletter.mts');
const { default: confirm } = await import('../netlify/functions/newsletter-confirm.mts');
const { makeToken, readToken, CONFIRM_TTL_MS } = await import('../netlify/functions/_shared/newsletter-token.mjs');

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
const post = async (body, ip = `203.0.113.${++ipSeq}`, context = {}) => {
  const res = await signup(new Request('http://localhost/api/newsletter', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nf-client-connection-ip': ip },
    body: JSON.stringify(body),
  }), context);
  return { status: res.status, body: await res.json() };
};
/** A Netlify context whose waitUntil records the background work. */
const withWaitUntil = () => {
  const pending = [];
  return { pending, waitUntil: (p) => { pending.push(p); } };
};
const elapsed = async (fn) => { const t0 = Date.now(); const out = await fn(); return { ...out, ms: Date.now() - t0 }; };
const ACCEPTED = {
  success: true,
  message: "Thanks! If you're new here, check your inbox for a link to confirm your subscription.",
};
/** The token inside the confirmation link of a sent email. */
const tokenIn = (mail) => decodeURIComponent(mail.text.match(/\/newsletter\/confirm\/\?t=([^\s]+)/)[1]);
const confirmPost = async (t) => {
  const res = await confirm(new Request('https://comicstripcanvas.example/api/newsletter-confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t }),
  }), {});
  return { status: res.status, location: res.headers.get('location') };
};
const sign = (email = 'reader@realmail.example', at = Date.now()) => makeToken(ENV.NEWSLETTER_CONFIRM_SECRET, email, at).token;

beforeEach(() => {
  calls = []; turnstile = { success: true }; subscriber = null; lookupStatus = null;
  resendStatus = 200; mlCreateStatus = 201;
  blobs.data.clear(); blobs.down = false; blobs.delay = 0; delays = {};
  globalThis.__dns.answers.clear();
  Object.assign(process.env, ENV);
});

// ── Signup: our double opt-in ────────────────────────────────────────────

test('a new address gets one branded confirmation email via Resend, and nothing is written to MailerLite', async () => {
  const r = await post(human({ email: '  Reader@RealMail.example ' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, ACCEPTED);
  assert.equal(mlWrites().length, 0, 'MailerLite only looked up');
  const [mail] = mails();
  assert.deepEqual(mail.to, ['reader@realmail.example']);
  assert.equal(mail.from, 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>');
  assert.equal(mail.subject, 'Confirm your subscription — Comic Strip Canvas');
  assert.match(mail.html, /^<!DOCTYPE html>/);
  assert.match(mail.html, /alt="Comic Strip Canvas"/);
  assert.match(mail.html, /max-width:600px/);
  assert.ok(mail.text.length > 50 && !/<[a-z]/i.test(mail.text), 'a plain-text part');
  assert.match(mail.text, /Didn’t sign up\?/);
  assert.match(mail.text, /^https:\/\/comicstripcanvas\.example\/newsletter\/confirm\/\?t=/m, 'link on the site');
});

test('the confirmation email: preheader in real characters, link in both parts, no address in the URL', async () => {
  await post(human());
  const [mail] = mails();
  const pre = mail.html.match(/<div style="display:none[^>]*>([^<]*)<\/div>/)[1];
  assert.ok(pre.length > 20 && !/&[a-z#0-9]+;/i.test(pre), pre);
  const t = tokenIn(mail);
  assert.ok(mail.html.includes(encodeURIComponent(t)), 'same link in the HTML');
  assert.ok(!mail.text.includes('reader') && !mail.text.includes('realmail'), 'the token does not show the address');
  assert.equal(readToken(ENV.NEWSLETTER_CONFIRM_SECRET, t).email, 'reader@realmail.example');
});

test('never sends status "unconfirmed" to MailerLite, on any path', async () => {
  for (const s of [null, { status: 'unconfirmed', groups: [] }, { status: 'active', groups: [{ id: '9' }] }]) {
    subscriber = s;
    await post(human({ email: `n${Math.random()}@realmail.example` }));
  }
  for (const c of calls.filter((c) => c.url.includes('mailerlite'))) {
    assert.ok(!JSON.stringify(c).includes('unconfirmed') || c.method === 'GET', JSON.stringify(c));
  }
  assert.equal(mlWrites().length, 0);
});

test('already active in this brand group: untouched, no email', async () => {
  subscriber = { email: 'reader@realmail.example', status: 'active', groups: [{ id: '424242' }] };
  assert.deepEqual((await post(human())).body, ACCEPTED);
  assert.equal(mails().length, 0);
  assert.equal(mlWrites().length, 0);
});

for (const status of ['unsubscribed', 'bounced', 'junk']) {
  test(`${status === "unsubscribed" ? "an" : "a"} ${status} address gets no confirmation email`, async () => {
    subscriber = { email: 'reader@realmail.example', status, groups: [{ id: '424242' }] };
    assert.deepEqual((await post(human())).body, ACCEPTED);
    assert.equal(mails().length, 0);
    assert.equal(mlWrites().length, 0);
  });
}

test('active on another of the account’s lists only: asked to confirm for this one', async () => {
  subscriber = { email: 'reader@realmail.example', status: 'active', groups: [{ id: '999' }] };
  await post(human());
  assert.equal(mails().length, 1);
  assert.equal(mlWrites().length, 0, 'not added until they confirm');
});

test('every accepted case answers identically, so the list cannot be probed', async () => {
  const answers = [];
  for (const s of [null, { status: 'active', groups: [{ id: '424242' }] }, { status: 'unsubscribed' }, { status: 'bounced' }]) {
    subscriber = s;
    const r = await post(human({ email: `probe${answers.length}@realmail.example` }));
    answers.push(JSON.stringify([r.status, r.body]));
  }
  assert.equal(new Set(answers).size, 1, answers.join('\n'));
});

test('per address: at most 1 confirmation email in 24 hours, from any number of IPs', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await post(human({ email: i % 2 ? 'Victim@RealMail.example' : 'victim@realmail.example' }));
    assert.deepEqual(r.body, ACCEPTED, 'same answer every time');
  }
  assert.equal(mails().length, 1);
  for (const e of blobs.data.values()) {
    const v = JSON.parse(e.json); if (v.hits) { v.hits = v.hits.map((t) => t - 24 * 60 * 60 * 1000 - 1); e.json = JSON.stringify(v); }
  }
  await post(human({ email: 'victim@realmail.example' }));
  assert.equal(mails().length, 2, 'a day later, one more');
});

test('confirmation emails count toward the per-IP limit: 3 an hour, then 429 and nothing sent', async () => {
  const ip = '198.51.100.7';
  for (let i = 0; i < 3; i++) assert.equal((await post(human({ email: `p${i}@realmail.example` }), ip)).status, 200);
  assert.equal(mails().length, 3);
  const over = await post(human({ email: 'p9@realmail.example' }), ip);
  assert.equal(over.status, 429);
  assert.equal(mails().length, 3);
  assert.equal((await post(human({ email: 'other@realmail.example' }), '198.51.100.8')).status, 200, 'another IP is unaffected');
});

test('MailerLite lookup failing: a generic 502 and no email sent blind', async () => {
  lookupStatus = 500;
  const r = await post(human());
  assert.equal(r.status, 502);
  assert.deepEqual(Object.keys(r.body), ['error']);
  assert.equal(mails().length, 0);
});

test('Resend refusing: a generic 502 with no provider detail', async () => {
  resendStatus = 403;
  const r = await post(human());
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'Something went wrong. Please try again.' });
});

test('no NEWSLETTER_CONFIRM_SECRET (or Resend key): closed with a 503, nothing looked up or sent', async () => {
  for (const missing of ['NEWSLETTER_CONFIRM_SECRET', 'RESEND_API_KEY']) {
    calls = [];
    Object.assign(process.env, ENV);
    delete process.env[missing];
    const r = await post(human());
    assert.equal(r.status, 503, missing);
    assert.equal(mlCalls().length + mails().length, 0, missing);
  }
});

// ── Signup: bot signals, Turnstile, IP limit, domains ────────────────────

test('a filled honeypot looks like success and nothing is called at all', async () => {
  assert.deepEqual((await post(human({ csc_nl_extra: 'http://spam.example' }))).body, ACCEPTED);
  assert.equal(calls.length, 0);
});

test('submitted under 3 seconds after the form loaded: looks like success, nothing called', async () => {
  assert.deepEqual((await post(human({ csc_nl_ts_load: now - 900, csc_nl_ts_submit: now }))).body, ACCEPTED);
  assert.equal(calls.length, 0);
});

test('missing timestamps do not trip the timing check (Turnstile covers direct posts)', async () => {
  const body = human();
  delete body.csc_nl_ts_load; delete body.csc_nl_ts_submit;
  assert.equal((await post(body)).status, 200);
  assert.equal(mails().length, 1);
});

test('Turnstile is verified server-side with the secret and the visitor IP', async () => {
  await post(human(), '198.51.100.44');
  assert.deepEqual(calls.find((c) => c.form).form, { secret: 'ts_test_secret', response: 'tok-ok', remoteip: '198.51.100.44' });
});

test('Turnstile: no token 400, rejected 400, unreachable 503, no secret 503 -- never anything sent', async () => {
  const cases = [
    [() => {}, { turnstileToken: '' }, 400],
    [() => { turnstile = { success: false, 'error-codes': ['invalid-input-response'] }; }, {}, 400],
    [() => { turnstile = { throws: true }; }, {}, 503],
    [() => { delete process.env.TURNSTILE_SECRET_KEY; }, {}, 503],
  ];
  for (const [setup, over, status] of cases) {
    calls = []; turnstile = { success: true }; Object.assign(process.env, ENV);
    setup();
    assert.equal((await post(human(over))).status, status);
    assert.equal(mlCalls().length + mails().length, 0);
  }
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

test('Blobs unreachable: the limits step aside and real sign-ups still work', async () => {
  blobs.down = true;
  for (let i = 0; i < 5; i++) assert.equal((await post(human({ email: `b${i}@realmail.example` }), '198.51.100.12')).status, 200);
});

test('disposable and mail-less domains are refused before MailerLite or Resend', async () => {
  globalThis.__dns.answers.set('fresh-alias.example', [{ exchange: 'mail.mailinator.com', priority: 10 }]);
  globalThis.__dns.answers.set('nope.example', dnsError('ENOTFOUND'));
  globalThis.__dns.answers.set('nomx.example', dnsError('ENODATA'));
  globalThis.__dns.answers.set('nullmx.example', [{ exchange: '.', priority: 0 }]);
  for (const [email, re] of [
    ['x@mailinator.com', /disposable/], ['x@sub.guerrillamail.com', /disposable/], ['x@fresh-alias.example', /disposable/],
    ['x@nope.example', /can't receive mail/], ['x@nomx.example', /can't receive mail/], ['x@nullmx.example', /can't receive mail/],
  ]) {
    calls = [];
    const r = await post(human({ email }));
    assert.equal(r.status, 400, email);
    assert.match(r.body.error, re, email);
    assert.equal(mlWrites().length + mails().length, 0, email);
  }
});

test('a DNS failure or timeout is not held against the visitor', async () => {
  globalThis.__dns.answers.set('flaky.example', dnsError('ESERVFAIL'));
  globalThis.__dns.answers.set('slow.example', 'hang');
  for (const d of ['flaky.example', 'slow.example']) {
    calls = [];
    assert.equal((await post(human({ email: `x@${d}` }))).status, 200, d);
    assert.equal(mails().length, 1, d);
  }
});

// ── Latency: limits on every outside call, checks in parallel ────────────

test('every outside call carries a timeout signal', async () => {
  await post(human());
  const outside = calls.filter((c) => /cloudflare|mailerlite|resend/.test(c.url));
  assert.ok(outside.length >= 3, 'turnstile, lookup and resend');
  for (const c of outside) assert.ok(c.signal, c.url);
});

test('the IP limit, MX check and MailerLite lookup run in parallel', async () => {
  blobs.delay = 500; delays.lookup = 1000;
  const { status, ms } = await elapsed(() => post(human()));
  assert.equal(status, 200);
  // In sequence: IP check 2 x 500 + lookup 1000 + address check 2 x 500 = 3000ms+.
  // In parallel the IP check and lookup overlap: about 1000 + 1000 = 2000ms.
  assert.ok(ms < 2600, `took ${ms}ms`);
});

test('Blobs that never answers costs at most ~2.5s a check, and sign-up still works (fails open)', async () => {
  blobs.delay = 'hang';
  const { status, ms } = await elapsed(() => post(human()));
  assert.equal(status, 200);
  assert.equal(mails().length, 1);
  assert.ok(ms < 6000, `took ${ms}ms (two checks, 2.5s budget each)`);
});

test('a hanging Turnstile is cut off at 4s and fails closed (503)', async () => {
  delays.turnstile = 'hang';
  const { status, ms } = await elapsed(() => post(human()));
  assert.equal(status, 503);
  assert.ok(ms >= 3900 && ms < 5000, `took ${ms}ms`);
  assert.equal(mlCalls().length + mails().length, 0);
});

test('a hanging MailerLite lookup is cut off at 4s and fails closed (502), no email', async () => {
  delays.lookup = 'hang';
  const { status, ms } = await elapsed(() => post(human()));
  assert.equal(status, 502);
  assert.ok(ms >= 3900 && ms < 5000, `took ${ms}ms`);
  assert.equal(mails().length, 0);
});

test('with waitUntil, the reply does not wait for the email', async () => {
  delays.resend = 1500;
  const ctx = withWaitUntil();
  const { status, body, ms } = await elapsed(() => post(human(), undefined, ctx));
  assert.equal(status, 200);
  assert.deepEqual(body, ACCEPTED);
  assert.ok(ms < 1000, `replied in ${ms}ms`);
  assert.equal(ctx.pending.length, 1, 'the send was handed to waitUntil');
  assert.equal(await ctx.pending[0], true, 'and completed after the reply');
  assert.equal(mails().length, 1);
});

test('a send that fails or hangs gives the address its slot back, so a retry works', async () => {
  for (const failure of [{ status: 500 }, { hang: true }]) {
    calls = []; blobs.data.clear(); delays = {}; resendStatus = 200;
    if (failure.hang) delays.resend = 'hang'; else resendStatus = failure.status;
    const ctx = withWaitUntil();
    assert.equal((await post(human(), undefined, ctx)).status, 200);
    assert.equal(await ctx.pending[0], false, 'not sent');
    delays = {}; resendStatus = 200;
    await post(human());
    assert.equal(mails().length, failure.hang ? 1 : 2, 'the retry sends straight away');
  }
});

test('without waitUntil a failed send is still reported (502) and the slot given back', async () => {
  resendStatus = 500;
  assert.equal((await post(human())).status, 502);
  resendStatus = 200;
  assert.equal((await post(human())).status, 200);
  assert.equal(mails().length, 2);
});

test('confirm: Blobs that never answers costs ~2.5s and the click still confirms', async () => {
  blobs.delay = 'hang';
  const { location, ms } = await elapsed(() => confirmPost(sign()));
  assert.match(location, /\/newsletter\/confirmed\/$/);
  assert.ok(ms < 3500, `took ${ms}ms`);
});

test('confirm: a hanging MailerLite is cut off at 4s: error page, link given back', async () => {
  delays.create = 'hang';
  const t = sign();
  const { location, ms } = await elapsed(() => confirmPost(t));
  assert.match(location, /r=error$/);
  assert.ok(ms >= 3900 && ms < 5000, `took ${ms}ms`);
  delays = {};
  assert.match((await confirmPost(t)).location, /\/newsletter\/confirmed\/$/, 'the same link works on retry');
});

test('each request logs one timing line with its steps and no visitor data', async () => {
  const lines = [];
  const orig = console.info;
  console.info = (...a) => { lines.push(a.join(' ')); };
  try { await post(human({ email: 'private.person@realmail.example' })); } finally { console.info = orig; }
  const timing = lines.filter((l) => l.includes('timing'));
  assert.equal(timing.length, 1, lines.join('\n'));
  assert.match(timing[0], /total=\d+ms turnstile=\d+ms/);
  for (const step of ['ip', 'mx', 'lookup', 'addr']) assert.match(timing[0], new RegExp(`${step}=\\d+ms`));
  assert.ok(!/private|realmail/.test(lines.join(' ')), 'no address in the logs');
});

test('format and method are still checked', async () => {
  assert.equal((await post(human({ email: 'not-an-email' }))).status, 400);
  assert.equal((await post(human({ email: '' }))).status, 400);
  assert.equal((await signup(new Request('http://localhost/api/newsletter'), {})).status, 405);
});

// ── Confirm ──────────────────────────────────────────────────────────────

test('the emailed link confirms: subscriber created ACTIVE in the brand group, then the You’re in page', async () => {
  await post(human());
  const t = tokenIn(mails()[0]);
  calls = [];
  const r = await confirmPost(t);
  assert.equal(r.status, 303);
  assert.equal(r.location, 'https://comicstripcanvas.example/newsletter/confirmed/');
  assert.deepEqual(mlWrites(), [{ email: 'reader@realmail.example', groups: ['424242'], status: 'active' }]);
});

test('a link works once: the second use writes nothing and says so', async () => {
  const t = sign();
  assert.equal((await confirmPost(t)).location, 'https://comicstripcanvas.example/newsletter/confirmed/');
  calls = [];
  const again = await confirmPost(t);
  assert.equal(again.location, 'https://comicstripcanvas.example/newsletter/link-expired/?r=used');
  assert.equal(mlWrites().length, 0);
});

test('two clicks racing: one subscribe', async () => {
  const t = sign();
  const [a, b] = await Promise.all([confirmPost(t), confirmPost(t)]);
  assert.deepEqual([a.location, b.location].sort(), [
    'https://comicstripcanvas.example/newsletter/confirmed/',
    'https://comicstripcanvas.example/newsletter/link-expired/?r=used',
  ]);
  assert.equal(mlWrites().length, 1);
});

test('expired after 48 hours', async () => {
  const t = sign('reader@realmail.example', Date.now() - CONFIRM_TTL_MS - 1000);
  assert.equal((await confirmPost(t)).location, 'https://comicstripcanvas.example/newsletter/link-expired/?r=expired');
  assert.equal(mlWrites().length, 0);
  const fresh = sign('reader@realmail.example', Date.now() - CONFIRM_TTL_MS + 60_000);
  assert.equal((await confirmPost(fresh)).location, 'https://comicstripcanvas.example/newsletter/confirmed/', 'just inside 48h still works');
});

test('tampered, truncated, foreign-secret or empty tokens are invalid and write nothing', async () => {
  const t = sign();
  const [v, iv, body] = t.split('.');
  const flipped = body.slice(0, -2) + (body.at(-2) === 'A' ? 'B' : 'A') + body.at(-1);
  const foreign = makeToken('some-other-secret', 'reader@realmail.example').token;
  for (const bad of [`${v}.${iv}.${flipped}`, t.slice(0, -6), foreign, '', 'v1..', 'not-a-token']) {
    calls = [];
    assert.equal((await confirmPost(bad)).location, 'https://comicstripcanvas.example/newsletter/link-expired/?r=invalid', bad);
    assert.equal(mlWrites().length, 0);
  }
});

test('a GET (a mail scanner opening the link) subscribes nobody and spends nothing', async () => {
  const t = sign();
  const res = await confirm(new Request(`https://comicstripcanvas.example/api/newsletter-confirm?t=${encodeURIComponent(t)}`), {});
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `https://comicstripcanvas.example/newsletter/confirm/?t=${encodeURIComponent(t)}`);
  assert.equal(calls.length, 0);
  assert.equal(blobs.data.size, 0);
  assert.equal((await confirmPost(t)).location, 'https://comicstripcanvas.example/newsletter/confirmed/', 'the link still works');
});

test('MailerLite failing on confirm: the error page, and the link is given back for a retry', async () => {
  const t = sign();
  for (const failure of [500, 'throw']) {
    mlCreateStatus = failure;
    assert.equal((await confirmPost(t)).location, 'https://comicstripcanvas.example/newsletter/link-expired/?r=error');
  }
  mlCreateStatus = 201;
  assert.equal((await confirmPost(t)).location, 'https://comicstripcanvas.example/newsletter/confirmed/');
});

test('the used-token record holds no subscriber data', async () => {
  await confirmPost(sign('private.person@realmail.example'));
  const stored = [...blobs.data.entries()].map(([k, e]) => k + ' ' + e.json).join('\n');
  assert.ok(!/private|realmail/.test(stored), stored);
});

test('confirm misconfigured (no secret): the error page, nothing written', async () => {
  delete process.env.NEWSLETTER_CONFIRM_SECRET;
  assert.equal((await confirmPost(sign())).location, 'https://comicstripcanvas.example/newsletter/link-expired/?r=error');
  assert.equal(mlWrites().length, 0);
});
