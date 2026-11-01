import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Stripe rejects consent_collection.promotions for UK accounts with a 400
// ("not available in your country"), which broke every checkout from
// 13 Oct 2026. Keep the parameter out of the session.
test('checkout session does not send consent_collection', () => {
  const src = readFileSync(new URL('../netlify/functions/checkout.mjs', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(/consent_collection\s*:/.test(code), false);
});
