// contact.mts: the Turnstile check has a hard time limit and still fails
// closed. fetch is stubbed, so nothing reaches Cloudflare.
//
//   npm test
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let mode = 'pass';   // 'pass' | 'reject' | 'hang' | 'slow' | 'down'
let calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), signal: !!init.signal, body: String(init.body) });
  if (mode === 'down') throw new Error('getaddrinfo ENOTFOUND challenges.cloudflare.com');
  if (mode === 'hang' || mode === 'slow') {
    await new Promise((resolve, reject) => {
      const t = mode === 'slow' ? setTimeout(resolve, 300) : null;
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); });
    });
  }
  return Response.json(mode === 'reject' ? { success: false, 'error-codes': ['invalid-input-response'] } : { success: true });
};

const { verifyTurnstile, TURNSTILE_TIMEOUT_MS } = await import('../netlify/functions/contact.mts');

beforeEach(() => { mode = 'pass'; calls = []; });

test('a pass passes, and the call carries a timeout signal', async () => {
  assert.deepEqual(await verifyTurnstile('secret', 'tok', '198.51.100.1'), { ok: true });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].signal);
  assert.match(calls[0].body, /remoteip=198\.51\.100\.1/);
});

test('a rejected token is the visitor’s problem: 400', async () => {
  mode = 'reject';
  const v = await verifyTurnstile('secret', 'tok', '198.51.100.1');
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
});

test('a slow but answering Cloudflare is waited for', async () => {
  mode = 'slow';
  assert.deepEqual(await verifyTurnstile('secret', 'tok'), { ok: true });
});

test('a hanging Cloudflare is cut off at the limit and fails closed (503)', async () => {
  mode = 'hang';
  assert.equal(TURNSTILE_TIMEOUT_MS, 4000);
  const t0 = Date.now();
  const v = await verifyTurnstile('secret', 'tok');
  const ms = Date.now() - t0;
  assert.equal(v.ok, false);
  assert.equal(v.status, 503);
  assert.ok(ms >= 3900 && ms < 5000, `took ${ms}ms`);
});

test('an unreachable Cloudflare still fails closed (503)', async () => {
  mode = 'down';
  const v = await verifyTurnstile('secret', 'tok');
  assert.equal(v.status, 503);
});
