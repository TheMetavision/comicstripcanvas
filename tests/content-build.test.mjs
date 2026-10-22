// Content-build debounce: the Sanity webhook (/api/sanity-content-changed),
// the waiter (/api/content-build-background) and the timing rules in
// netlify/functions/_shared/content-build.mjs. @netlify/blobs is an in-memory
// stub with ETags enforced, fetch is faked and the waiter runs on a virtual
// clock, so nothing leaves the machine and nothing really waits.
//
//   npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

globalThis.__blobs = { data: new Map() };
const STUBS = {
  '@netlify/blobs': `
    export function getStore({ name }) {
      const b = globalThis.__blobs;
      const k = (key) => name + '/' + key;
      let n = 0;
      return {
        async getWithMetadata(key) {
          const e = b.data.get(k(key));
          return e ? { data: JSON.parse(e.json), etag: e.etag, metadata: {} } : null;
        },
        async setJSON(key, value, opts = {}) {
          const e = b.data.get(k(key));
          if (opts.onlyIfNew && e) return { modified: false };
          if (opts.onlyIfMatch && (!e || e.etag !== opts.onlyIfMatch)) return { modified: false };
          const etag = 'e' + (++n) + '-' + Math.random();
          b.data.set(k(key), { json: JSON.stringify(value), etag });
          return { modified: true, etag };
        },
      };
    }`,
};
registerHooks({
  resolve(spec, ctx, next) { return spec in STUBS ? { url: `stub:${spec}`, shortCircuit: true } : next(spec, ctx); },
  load(url, ctx, next) { return url.startsWith('stub:') ? { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true } : next(url, ctx); },
});

const SECRET = 'webhook-secret-for-tests-only';
const KEY = 'internal-key-for-tests-only';
const HOOK = 'https://api.netlify.com/build_hooks/abc123TEST';
const ENV = {
  SANITY_REBUILD_WEBHOOK_SECRET: SECRET,
  CONTENT_BUILD_INTERNAL_KEY: KEY,
  NETLIFY_BUILD_HOOK_URL: HOOK,
  URL: 'https://comicstripcanvas.example',
};
let env = { ...ENV };
globalThis.Netlify = { env: { get: (k) => env[k] } };

let calls = [];
let waiterStatus = 202; // or 'throw'
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, method: init.method || 'GET', headers: init.headers || {} });
  if (url.endsWith('/api/content-build-background')) {
    if (waiterStatus === 'throw') throw new Error('ECONNRESET');
    return new Response('', { status: waiterStatus });
  }
  if (url.startsWith(HOOK)) return new Response('', { status: 200 });
  throw new Error(`unexpected fetch ${url}`);
};

const { encodeSignatureHeader } = await import('@sanity/webhook');
const cb = await import('../netlify/functions/_shared/content-build.mjs');
const { default: changed } = await import('../netlify/functions/sanity-content-changed.mts');
const { default: waiter } = await import('../netlify/functions/content-build-background.mts');
const { getStore } = await import('@netlify/blobs');

const {
  decide, classify, recordChange, runWaiter, buildTitle,
  QUIET_MS, MIN_GAP_MS, MAX_WAIT_MS, WAITER_BUDGET_MS, MAX_BUILD_FAILURES, STATE_STORE, STATE_KEY, INTERNAL_HEADER,
} = cb;

const store = () => getStore({ name: STATE_STORE, consistency: 'strong' });
const readState = () => {
  const e = globalThis.__blobs.data.get(`${STATE_STORE}/${STATE_KEY}`);
  return e ? JSON.parse(e.json) : null;
};

beforeEach(() => {
  globalThis.__blobs.data.clear();
  calls = [];
  waiterStatus = 202;
  env = { ...ENV };
});

/** A request signed the way Sanity signs it. */
async function sanityPost(payload, { secret = SECRET, sign = true } = {}) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (sign) headers['sanity-webhook-signature'] = await encodeSignatureHeader(body, Date.now(), secret);
  return new Request('https://comicstripcanvas.example/api/sanity-content-changed', { method: 'POST', headers, body });
}

/**
 * Virtual clock for runWaiter. `events` are [atMs, type] changes that land
 * while the waiter sleeps.
 */
function clock(start, events = []) {
  let t = start;
  const queue = [...events].sort((a, b) => a[0] - b[0]);
  const builds = [];
  const apply = async (until) => {
    while (queue.length && queue[0][0] <= until) {
      const [at, type] = queue.shift();
      await recordChange(store(), { now: at, type });
    }
  };
  return {
    builds,
    now: () => t,
    sleep: async (ms) => { t += ms; await apply(t); },
    triggerBuild: async (title) => { builds.push({ at: t, title }); return { ok: true }; },
    rearm: async () => ({ ok: true }),
    /** Jump to the next queued change (as if the webhook re-armed a waiter then). */
    skipToNext: async () => { if (!queue.length) return false; t = queue[0][0]; await apply(t); return true; },
  };
}

/**
 * What production does across waiters: run one; when it goes idle or hands
 * over, the next change (or the fresh waiter) runs another. Returns outcomes.
 */
async function runAll(c, extra = {}) {
  const outcomes = [];
  for (;;) {
    const r = await runWaiter({ store: store(), ...c, ...extra });
    outcomes.push(r.outcome);
    if (r.outcome === 'handed-over') continue;
    if (!(await c.skipToNext())) return outcomes;
  }
}

// ---------------------------------------------------------------- rules

test('decide: idle with nothing pending', () => {
  assert.deepEqual(decide({ pending: false }, 1e9), { action: 'idle' });
});

test('decide: waits QUIET_MS after the last change, then builds', () => {
  const s = { pending: true, firstPendingAt: 1e9, lastChangeAt: 1e9, lastBuildAt: 0 };
  assert.deepEqual(decide(s, 1e9 + 1000), { action: 'wait', ms: QUIET_MS - 1000 });
  assert.deepEqual(decide(s, 1e9 + QUIET_MS), { action: 'build' });
});

test('decide: never sooner than MIN_GAP_MS after the previous build', () => {
  const s = { pending: true, firstPendingAt: 1e9, lastChangeAt: 1e9, lastBuildAt: 1e9 - 1000 };
  assert.equal(decide(s, 1e9 + QUIET_MS).action, 'wait');
  assert.deepEqual(decide(s, 1e9 - 1000 + MIN_GAP_MS), { action: 'build' });
});

test('decide: a steady stream still builds MAX_WAIT_MS after the first change', () => {
  const s = { pending: true, firstPendingAt: 1e9, lastChangeAt: 1e9 + MAX_WAIT_MS - 1, lastBuildAt: 0 };
  assert.deepEqual(decide(s, 1e9 + MAX_WAIT_MS), { action: 'build' });
});

test('classify: drafts, versions, Sanity/system docs and operational types never build', () => {
  for (const p of [
    { _id: 'drafts.product-x', _type: 'product' },
    { _id: 'versions.r1.product-x', _type: 'product' },
    { _id: 'image-abc', _type: 'sanity.imageAsset' },
    { _id: 'x', _type: 'sanity.assist.task.status' },
    { _id: 'x', _type: 'system.group' },
    { _id: 'x', _type: 'contactSubmission' },
    { _id: 'x', _type: 'order' },
    { _id: 'x', _type: 'orderCounter' },
    { _id: 'x', _type: 'pendingPersonalisation' },
    { _id: 'x', _type: 'artworkChange' },
  ]) assert.equal(classify(p).build, false, JSON.stringify(p));
});

test('classify: published content builds, including types added later', () => {
  assert.deepEqual(classify({ _id: 'product-x', _type: 'product' }), { build: true, type: 'product' });
  assert.deepEqual(classify({ _id: 'x', _type: 'character' }), { build: true, type: 'character' });
  assert.deepEqual(classify({ _id: 'x' }), { build: true, type: 'unknown' }); // delete that lost its type
});

test('the filter documented here is the one on the Sanity webhook', () => {
  assert.equal(cb.WEBHOOK_FILTER,
    '!(_type match "sanity.*") && !(_type match "system.*") && !(_type in ["contactSubmission","order","orderCounter","pendingPersonalisation","artworkChange"])');
});

// ---------------------------------------------------------------- waiter

test('waiter: a 13-product script transaction makes ONE build, 60 s after it', async () => {
  const t0 = 1e12;
  for (let i = 0; i < 13; i++) await recordChange(store(), { now: t0 + i * 10, type: 'product' });
  const c = clock(t0 + 200);
  const r = await runWaiter({ store: store(), ...c });
  assert.equal(r.outcome, 'idle');
  assert.equal(c.builds.length, 1);
  assert.ok(c.builds[0].at >= t0 + 120 + QUIET_MS);
  assert.equal(c.builds[0].title, 'Sanity: 13 changes (product)');
  assert.equal(readState().pending, false);
  assert.equal(readState().armedAt, 0);
});

test('waiter: a change soon after a build waits out MIN_GAP_MS', async () => {
  const t0 = 1e12;
  await recordChange(store(), { now: t0, type: 'faq' });
  const c = clock(t0, [[t0 + QUIET_MS + 30_000, 'product']]);
  await runAll(c);
  assert.equal(c.builds.length, 2);
  assert.ok(c.builds[1].at - c.builds[0].at >= MIN_GAP_MS);
  assert.equal(c.builds[1].title, 'Sanity: 1 change (product)');
});

test('waiter: a script patching every 30 s for 30 min builds every ~10 min, never closer than 5', async () => {
  const t0 = 1e12;
  await recordChange(store(), { now: t0, type: 'product' });
  const events = [];
  for (let at = t0 + 30_000; at <= t0 + 30 * 60_000; at += 30_000) events.push([at, 'product']);
  const c = clock(t0, events);
  await runAll(c);
  // Builds at ~10, ~20, ~30 min plus the trailing one after the last edit:
  // 4, where pointing Sanity at the hook would have made 61.
  assert.ok(c.builds.length >= 3 && c.builds.length <= 5, `${c.builds.length} builds`);
  assert.ok(c.builds[0].at - t0 <= MAX_WAIT_MS + 20_000);
  for (let i = 1; i < c.builds.length; i++) assert.ok(c.builds[i].at - c.builds[i - 1].at >= MIN_GAP_MS);
  assert.ok(c.builds.at(-1).at >= t0 + 30 * 60_000 + QUIET_MS, 'the last edit is built');
  assert.equal(readState().pending, false);
});

test('waiter: hands over to a fresh waiter before its 15-minute limit', async () => {
  const t0 = 1e12;
  await recordChange(store(), { now: t0, type: 'product' });
  const c = clock(t0);
  // A script that never stops: a change lands during every build call, so
  // the waiter is never idle.
  const triggerBuild = async (title) => {
    c.builds.push({ at: c.now(), title });
    await recordChange(store(), { now: c.now() + 1, type: 'product' });
    return { ok: true };
  };
  let rearmed = 0;
  const r = await runWaiter({ store: store(), ...c, triggerBuild, rearm: async () => { rearmed++; return { ok: true }; } });
  assert.equal(r.outcome, 'handed-over');
  assert.equal(rearmed, 1);
  assert.ok(c.now() - t0 >= WAITER_BUDGET_MS);
  assert.ok(readState().armedAt > 0, 'stays armed for the new waiter');
});

test('waiter: a failing build hook is retried, then given up', async () => {
  const t0 = 1e12;
  await recordChange(store(), { now: t0, type: 'product' });
  const c = clock(t0);
  let tries = 0;
  const r = await runWaiter({ store: store(), ...c, triggerBuild: async () => { tries++; return { ok: false, status: 500 }; } });
  assert.equal(r.outcome, 'gave-up');
  assert.equal(tries, MAX_BUILD_FAILURES);
  assert.equal(readState().armedAt, 0, 'disarmed so the next change re-arms');
  assert.equal(readState().pending, true, 'the change is not forgotten');
});

test('buildTitle: counts and types only', () => {
  assert.equal(buildTitle({ changes: 2, types: ['product', 'faq'] }), 'Sanity: 2 changes (product, faq)');
});

// ---------------------------------------------------------------- webhook handler

test('webhook: refuses when not configured', async () => {
  delete env.SANITY_REBUILD_WEBHOOK_SECRET;
  const res = await changed(await sanityPost({ _id: 'product-x', _type: 'product' }));
  assert.equal(res.status, 500);
  assert.equal(readState(), null);
});

test('webhook: rejects a missing or wrong signature', async () => {
  assert.equal((await changed(await sanityPost({ _id: 'p', _type: 'product' }, { sign: false }))).status, 401);
  assert.equal((await changed(await sanityPost({ _id: 'p', _type: 'product' }, { secret: 'wrong' }))).status, 401);
  assert.equal(readState(), null);
  assert.equal(calls.length, 0);
});

test('webhook: GET is not allowed', async () => {
  const res = await changed(new Request('https://comicstripcanvas.example/api/sanity-content-changed'));
  assert.equal(res.status, 405);
});

test('webhook: a contact submission is ignored, nothing recorded or started', async () => {
  const res = await changed(await sanityPost({ _id: 'c1', _type: 'contactSubmission' }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^Ignored/);
  assert.equal(readState(), null);
  assert.equal(calls.length, 0);
});

test('webhook: a product change records it and starts ONE waiter for a burst', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await changed(await sanityPost({ _id: `product-${i}`, _type: 'product' }));
    assert.equal(res.status, 200);
  }
  const s = readState();
  assert.equal(s.pending, true);
  assert.equal(s.changes, 5);
  assert.deepEqual(s.types, ['product']);
  const started = calls.filter((c) => c.url.endsWith('/api/content-build-background'));
  assert.equal(started.length, 1);
  assert.equal(started[0].url, 'https://comicstripcanvas.example/api/content-build-background');
  assert.equal(started[0].headers[INTERNAL_HEADER], KEY);
  assert.equal(calls.filter((c) => c.url.startsWith(HOOK)).length, 0, 'the webhook itself never builds');
});

test('webhook: under netlify dev the waiter is started on localhost', async () => {
  const body = JSON.stringify({ _id: 'product-x', _type: 'product' });
  const sig = await encodeSignatureHeader(body, Date.now(), SECRET);
  await changed(new Request('http://localhost:8888/api/sanity-content-changed', {
    method: 'POST', headers: { 'sanity-webhook-signature': sig }, body,
  }));
  assert.equal(calls[0].url, 'http://localhost:8888/api/content-build-background');
});

test('webhook: if the waiter cannot start, answer 500 and disarm so Sanity retry re-arms', async () => {
  waiterStatus = 'throw';
  const res = await changed(await sanityPost({ _id: 'product-x', _type: 'product' }));
  assert.equal(res.status, 500);
  assert.equal(readState().armedAt, 0);
  assert.equal(readState().pending, true);
  waiterStatus = 202;
  assert.equal((await changed(await sanityPost({ _id: 'product-x', _type: 'product' }))).status, 200);
  assert.equal(calls.filter((c) => c.url.endsWith('/api/content-build-background')).length, 2);
});

// ---------------------------------------------------------------- waiter handler

test('waiter function: forbidden without the internal key', async () => {
  const req = (h) => new Request('https://comicstripcanvas.example/api/content-build-background', { method: 'POST', headers: h, body: '{}' });
  assert.equal((await waiter(req({}))).status, 403);
  assert.equal((await waiter(req({ [INTERNAL_HEADER]: 'nope' }))).status, 403);
  delete env.CONTENT_BUILD_INTERNAL_KEY;
  assert.equal((await waiter(req({ [INTERNAL_HEADER]: '' }))).status, 403);
});

test('waiter function: with nothing pending it returns at once and never builds', async () => {
  const res = await waiter(new Request('https://comicstripcanvas.example/api/content-build-background', {
    method: 'POST', headers: { [INTERNAL_HEADER]: KEY }, body: '{}',
  }));
  assert.equal(res.status, 200);
  assert.equal(calls.filter((c) => c.url.startsWith(HOOK)).length, 0);
});
