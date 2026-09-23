#!/usr/bin/env node
/**
 * The upload's slot behaviour: upsert, order, and leaving the listing alone.
 *
 *   node tools/mockup/test-upload-slots.mjs
 *
 * Idempotence is the entire reason the keys became fixed, and it is the one
 * property a dry run cannot demonstrate: a dry run against products that have
 * no mockups yet only ever prints "insert". The interesting case -- running the
 * same upload twice -- needs a document that already carries a slot, which is
 * exactly what this fakes.
 */
import { NAMES, keyFor, altFor, patchesFor } from './upload.mjs';

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const LISTING = { _type: 'image', _key: 'listing', asset: { _ref: 'image-listing' }, alt: 'the artwork' };
const ID = 'drafts.abc';
const TITLE = 'Walter White';
const ALT = altFor(TITLE);

// 1. A fresh product: one insert, anchored on images[0].
{
  const ps = patchesFor(ID, TITLE, [LISTING], { poster: 'image-p1' });
  check('a fresh product gets one insert', ps.length === 1 && ps[0].op === 'insert');
  check('anchored after images[0]', ps[0].patch.insert.after === 'images[0]');
  check('keyed mockup-poster', ps[0].patch.insert.items[0]._key === 'mockup-poster');
  check('alt matches the strip-mockups contract',
    /lifestyle mockup/i.test(ps[0].patch.insert.items[0].alt), ps[0].patch.insert.items[0].alt);
}

// 2. The same product again: replace in place, not a second copy.
{
  const existing = [LISTING, { _type: 'image', _key: 'mockup-poster', asset: { _ref: 'image-old' }, alt: ALT }];
  const ps = patchesFor(ID, TITLE, existing, { poster: 'image-p2' });
  check('a second run replaces rather than inserts', ps.length === 1 && ps[0].op === 'replace');
  const target = Object.keys(ps[0].patch.set)[0];
  check('addressed by key, so position does not matter',
    target === 'images[_key=="mockup-poster"]', target);
  check('the new asset is the one written',
    ps[0].patch.set[target].asset._ref === 'image-p2');
  check('no insert is emitted on the second run',
    !ps.some((p) => p.op === 'insert'));
}

// 3. Running twice in a row produces the same document state: the second
//    pass over an already-patched array must be a pure replace.
{
  const after1 = [LISTING, { _type: 'image', _key: 'mockup-poster', asset: { _ref: 'image-p1' }, alt: ALT }];
  const a = patchesFor(ID, TITLE, after1, { poster: 'image-p1' });
  const b = patchesFor(ID, TITLE, after1, { poster: 'image-p1' });
  check('the operation is idempotent', JSON.stringify(a) === JSON.stringify(b) && a[0].op === 'replace');
}

// 4. All three scenes at once, on a fresh product: poster, room, studio, each
//    anchored on the one before it so the order holds.
{
  const ps = patchesFor(ID, TITLE, [LISTING], { poster: 'p', room: 'r', studio: 's' });
  check('three scenes give three patches', ps.length === 3);
  check('in canonical order', ps.map((x) => x.name).join(',') === NAMES.join(','),
    ps.map((x) => x.name).join(','));
  check('poster anchors on images[0]', ps[0].patch.insert.after === 'images[0]');
  check('room anchors on poster', ps[1].patch.insert.after === 'images[_key=="mockup-poster"]');
  check('studio anchors on room', ps[2].patch.insert.after === 'images[_key=="mockup-room"]');
}

// 5. A gap in the middle: room exists, poster and studio do not. The new
//    poster still goes after images[0], and studio after room.
{
  const existing = [LISTING, { _type: 'image', _key: 'mockup-room', asset: { _ref: 'image-r' }, alt: ALT }];
  const ps = patchesFor(ID, TITLE, existing, { poster: 'p', room: 'r2', studio: 's' });
  check('poster inserts after images[0] even when room already exists',
    ps[0].op === 'insert' && ps[0].patch.insert.after === 'images[0]');
  check('room is replaced, not duplicated', ps[1].op === 'replace');
  check('studio anchors on the room that was already there',
    ps[2].patch.insert.after === 'images[_key=="mockup-room"]');
}

// 6. Nothing ever addresses the listing or slot zero by value.
{
  const ps = patchesFor(ID, TITLE, [LISTING], { poster: 'p', room: 'r', studio: 's' });
  const json = JSON.stringify(ps);
  check('no patch sets images[0] or the listing entry',
    !/"set":\{"images\[0\]/.test(json) && !/images\[_key=="listing"\]/.test(json));
  check('every mutation names a mockup key',
    ps.every((p) => JSON.stringify(p.patch).includes('mockup-')));
}

// 7. Only the scenes asked for are written.
{
  const ps = patchesFor(ID, TITLE, [LISTING], { poster: 'p' });
  check('a poster-only run writes only mockup-poster',
    ps.length === 1 && ps[0].name === 'poster');
  check('keyFor is the documented shape',
    keyFor('room') === 'mockup-room' && keyFor('studio') === 'mockup-studio');
}

console.log('');
console.log(fails.length ? `  FAILED: ${fails.join(', ')}` : '  all upload-slot checks passed');
process.exit(fails.length ? 1 : 0);
