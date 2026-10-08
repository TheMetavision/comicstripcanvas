// Which builder controls each mode hides. Customise mode hides the publisher
// logo box, "Take colours from photo" and the style hint; studio, the photo
// builders and admin (which runs as customer) keep them.
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { hiddenControls } = await import('../src/scripts/builder-locks.js');

test('customise mode hides the logo controls, take-colours-from-photo and the style hint', () => {
  assert.deepEqual(hiddenControls('customise'), { logo: true, sampleColours: true, styleHint: true });
});

test('studio and the photo builders keep all three', () => {
  for (const mode of ['studio', 'customer', 'admin', undefined]) {
    assert.deepEqual(hiddenControls(mode), { logo: false, sampleColours: false, styleHint: false }, String(mode));
  }
});
