// The new functions' DEFAULT exports -- what Netlify actually runs -- called
// with a real Request. The handler logic is tested with fakes elsewhere; this
// is the guard against the class of fault tools/builder/handler-tests.mjs
// was written for: a module that imports or wires up wrongly, which no test of
// the inner function would ever load. Nothing here reaches the network: every
// path taken stops at a switch or a signature check.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const saved = { ...process.env };
const restore = () => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); };

test('every new function module loads and exports a handler', async () => {
  for (const f of ['shipping-dispatch-background', 'shipping-return-background', 'shipping-event', 'shipping-label', 'returns', 'order-shipped', 'sanity-orders-webhook']) {
    const mod = await import(`../netlify/functions/${f}.mjs`);
    assert.equal(typeof mod.default, 'function', f);
    assert.equal(mod.config?.path, undefined, `${f} must not set config.path`);
  }
});

test('switched off, each answers without touching anything', async () => {
  delete process.env.SHIPPING_ENABLED;
  try {
    const post = (url, body = '{}') => new Request(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    const dispatch = (await import('../netlify/functions/shipping-dispatch-background.mjs')).default;
    const ret = (await import('../netlify/functions/shipping-return-background.mjs')).default;
    const returns = (await import('../netlify/functions/returns.mjs')).default;
    const label = (await import('../netlify/functions/shipping-label.mjs')).default;
    const event = (await import('../netlify/functions/shipping-event.mjs')).default;

    assert.match(await (await dispatch(post('https://x/api/shipping-dispatch'))).text(), /not enabled/);
    assert.match(await (await ret(post('https://x/api/shipping-return'))).text(), /not enabled/);
    assert.equal((await returns(post('https://x/api/returns', JSON.stringify({ action: 'lookup' })))).status, 404);
    assert.equal((await label(new Request('https://x/admin/shipping/label/123'))).status, 404);
    // Unsigned: refused before the switch is even read.
    assert.equal((await event(post('https://x/api/shipping-event'))).status, 401);
  } finally { restore(); }
});

test('the label proxy refuses anything that did not come in under /admin/', async () => {
  process.env.SHIPPING_ENABLED = 'true';
  try {
    const label = (await import('../netlify/functions/shipping-label.mjs')).default;
    assert.equal((await label(new Request('https://x/.netlify/functions/shipping-label/123'))).status, 404);
    assert.equal((await label(new Request('https://x/api/shipping-label/123'))).status, 404);
    assert.equal((await label(new Request('https://x/admin/shipping/label/..%2F..%2Fsecret'))).status, 400);
  } finally { restore(); }
});
