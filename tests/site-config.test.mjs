// site-config: the committed non-secret settings that replaced Netlify env vars
// (the 4 KB function-environment limit), and their env-var overrides.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_CONFIG, setting } from '../netlify/functions/_shared/site-config.mjs';
import { shippingRequest } from '../netlify/functions/_shared/shipping-client.mjs';
import { sendPurchase } from '../netlify/functions/_shared/ga4-mp.mjs';

test('the committed value is used when the env var is unset or blank', () => {
  assert.equal(setting('SITE_URL', {}), 'https://comicstripcanvas.co.uk');
  assert.equal(setting('TEAM_EMAIL', { TEAM_EMAIL: '   ' }), 'hello@comicstripcanvas.co.uk');
  assert.equal(setting('NOTIFICATION_TO', {}), 'contact@comicstripcanvas.co.uk', 'contact form inbox, not the team one');
  assert.equal(setting('RETURN_POINT_EVRI', {}), 'ASDA Shoebury, North Shoebury Road');
});

test('an env var of the same name still overrides', () => {
  assert.equal(setting('SHIPPING_BRAND', { SHIPPING_BRAND: ' XYZ ' }), 'XYZ');
});

test('an unknown name is a programming error, not a silent undefined', () => {
  assert.throws(() => setting('STRIPE_SECRET_KEY', {}), /unknown setting/);
});

test('nothing in the committed config looks like a secret', () => {
  for (const [k, v] of Object.entries(SITE_CONFIG)) {
    assert.doesNotMatch(k, /SECRET|TOKEN|KEY|PASS/, k);
    assert.doesNotMatch(v, /^(sk|rk|pk|whsec)_|^re_|^ey[A-Za-z0-9]{20,}/, k);
  }
});

test('the shipping client needs only SHIPPING_SECRET from the environment now', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); };
  await shippingRequest('quote-return', { body: {}, env: { SHIPPING_SECRET: 's' }, fetchImpl });
  assert.equal(calls[0].url, 'https://mv-shipping-svc-26.netlify.app/api/quote-return');
  assert.equal(calls[0].init.headers['x-mv-brand'], 'CSC');
  await assert.rejects(shippingRequest('quote-return', { body: {}, env: {}, fetchImpl }), /SHIPPING_SECRET is not set/);
});

test('GA4 needs only GA4_API_SECRET from the environment now', async () => {
  const r = await sendPurchase({ session: { livemode: false }, orderNumber: 'X', lineItems: [], env: {} });
  assert.equal(r.skipped, 'not-configured');
  const r2 = await sendPurchase({ session: { livemode: false }, orderNumber: 'X', lineItems: [], env: { GA4_API_SECRET: 's' } });
  assert.equal(r2.skipped, 'test-mode', 'configured: it got past the id check');
});
