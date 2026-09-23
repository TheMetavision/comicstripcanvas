#!/usr/bin/env node
/**
 * The upload's slot behaviour: upsert, order, anchoring, and draft handling.
 *
 *   node tools/mockup/test-upload-slots.mjs
 *
 * Idempotence is the entire reason the keys became fixed, and it is the one
 * property a dry run cannot demonstrate: a dry run against products that have
 * no mockups yet only ever prints "insert". The interesting cases -- running
 * the same upload twice, and running it against a draft somebody has already
 * edited -- need documents that do not exist in the catalogue yet, so they are
 * faked here.
 */
import { NAMES, keyFor, altFor, patchesFor, transactionFor, LISTING_KEY } from './upload.mjs';

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const LISTING = { _type: 'image', _key: 'listing', asset: { _ref: 'image-listing' }, alt: 'the artwork' };
const ID = 'drafts.abc';
const TITLE = 'Walter White';
const ALT = altFor(TITLE);
const ANCHOR = `images[_key=="${LISTING_KEY}"]`;

// 1. A fresh product: one insert, anchored on the listing ENTRY, not on index 0.
{
  const ps = patchesFor(ID, TITLE, [LISTING], { poster: 'image-p1' });
  check('a fresh product gets one insert', ps.length === 1 && ps[0].op === 'insert');
  check('anchored on the listing key, not images[0]',
    ps[0].patch.insert.after === ANCHOR, ps[0].patch.insert.after);
  check('no mutation anywhere addresses images by index',
    !JSON.stringify(ps).includes('images[0]'));
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
  check('the new asset is the one written', ps[0].patch.set[target].asset._ref === 'image-p2');
  check('no insert is emitted on the second run', !ps.some((p) => p.op === 'insert'));
}

// 3. Idempotent: the same input twice gives the same mutations.
{
  const after1 = [LISTING, { _type: 'image', _key: 'mockup-poster', asset: { _ref: 'image-p1' }, alt: ALT }];
  const a = patchesFor(ID, TITLE, after1, { poster: 'image-p1' });
  const b = patchesFor(ID, TITLE, after1, { poster: 'image-p1' });
  check('the operation is idempotent', JSON.stringify(a) === JSON.stringify(b) && a[0].op === 'replace');
}

// 4. All three scenes at once: each anchored on the one before it.
{
  const ps = patchesFor(ID, TITLE, [LISTING], { poster: 'p', room: 'r', studio: 's' });
  check('three scenes give three patches', ps.length === 3);
  check('in canonical order', ps.map((x) => x.name).join(',') === NAMES.join(','),
    ps.map((x) => x.name).join(','));
  check('poster anchors on the listing', ps[0].patch.insert.after === ANCHOR);
  check('room anchors on poster', ps[1].patch.insert.after === 'images[_key=="mockup-poster"]');
  check('studio anchors on room', ps[2].patch.insert.after === 'images[_key=="mockup-room"]');
}

// 5. A gap in the middle: room exists, poster and studio do not.
{
  const existing = [LISTING, { _type: 'image', _key: 'mockup-room', asset: { _ref: 'image-r' }, alt: ALT }];
  const ps = patchesFor(ID, TITLE, existing, { poster: 'p', room: 'r2', studio: 's' });
  check('poster anchors on the listing even when room already exists',
    ps[0].op === 'insert' && ps[0].patch.insert.after === ANCHOR);
  check('room is replaced, not duplicated', ps[1].op === 'replace');
  check('studio anchors on the room that was already there',
    ps[2].patch.insert.after === 'images[_key=="mockup-room"]');
}

// 6. Nothing ever addresses the listing or slot zero by value.
{
  const ps = patchesFor(ID, TITLE, [LISTING], { poster: 'p', room: 'r', studio: 's' });
  // Structurally, not by substring: JSON.stringify escapes the quotes inside
  // images[_key=="listing"], so a string search for it can never match and a
  // negative assertion built on one can never fail.
  const setTargets = ps.flatMap((p) => Object.keys(p.patch.set || {}));
  check('no patch sets images[0] or the listing entry',
    !setTargets.includes('images[0]') && !setTargets.includes(ANCHOR),
    setTargets.join(' ') || '(no set targets)');
  check('every mutation names a mockup key',
    ps.every((p) => JSON.stringify(p.patch).includes('mockup-')));
}

// 7. Only the scenes asked for are written.
{
  const ps = patchesFor(ID, TITLE, [LISTING], { poster: 'p' });
  check('a poster-only run writes only mockup-poster', ps.length === 1 && ps[0].name === 'poster');
  check('keyFor is the documented shape',
    keyFor('room') === 'mockup-room' && keyFor('studio') === 'mockup-studio');
}

// ── Drafts ─────────────────────────────────────────────────────────────────

const PUBLISHED = {
  _id: 'abc',
  _type: 'product',
  title: TITLE,
  category: 'comic-book-icons',
  price: 4999,
  images: [LISTING],
};

// 8. No draft exists: create it from the published document, in the same
//    transaction as the patch, and create it FIRST.
{
  const { mutations } = transactionFor(ID, TITLE, PUBLISHED, null, { poster: 'p' });
  check('a missing draft is created and patched in one transaction', mutations.length === 2);
  check('the create comes first', !!mutations[0].createIfNotExists);
  check('created with the draft id', mutations[0].createIfNotExists._id === ID);
  check('created from the published content, not an empty stub',
    mutations[0].createIfNotExists.title === TITLE
    && mutations[0].createIfNotExists.price === 4999
    && mutations[0].createIfNotExists.category === 'comic-book-icons');
  check('the published images come with it',
    mutations[0].createIfNotExists.images.length === 1
    && mutations[0].createIfNotExists.images[0]._key === LISTING_KEY);
  check('the patch targets the draft', mutations[1].patch.id === ID);
  check('createIfNotExists is used, so a race cannot clobber a real draft',
    !mutations[0].create && !mutations[0].createOrReplace);
}

// 9. A draft already exists, carrying edits nobody here knows about. Those
//    edits must survive: no create, and nothing addressed but mockup keys.
{
  const draft = {
    _id: ID,
    _type: 'product',
    title: 'Walter White (retitled in the Studio)',
    price: 5999,
    subtitle: 'an edit this script has never heard of',
    images: [
      LISTING,
      { _type: 'image', _key: 'extra-shot', asset: { _ref: 'image-extra' }, alt: 'added by hand' },
    ],
  };
  const { mutations } = transactionFor(ID, TITLE, PUBLISHED, draft, { poster: 'p' });
  const json = JSON.stringify(mutations);

  check('an existing draft is not re-created', !mutations.some((m) => m.createIfNotExists));
  check('only the patch is sent', mutations.length === 1 && !!mutations[0].patch);
  check("the draft's unrelated edits are never addressed",
    !json.includes('subtitle') && !json.includes('retitled') && !json.includes('5999'));
  check("an unrelated image the draft carries is never addressed",
    !json.includes('extra-shot') && !json.includes('image-extra'));
  check('the alt is built from the PUBLISHED title, not the draft edit',
    json.includes(altFor(TITLE)));
  check('the insert still anchors on the listing',
    mutations[0].patch.insert.after === ANCHOR, mutations[0].patch.insert.after);
}

// 10. A draft whose images already differ from the published ones: the patch
//     is computed against the DRAFT's array, not the published one.
{
  const draft = {
    _id: ID,
    images: [LISTING, { _type: 'image', _key: 'mockup-poster', asset: { _ref: 'stale' }, alt: ALT }],
  };
  const { ps } = transactionFor(ID, TITLE, PUBLISHED, draft, { poster: 'fresh' });
  check('a mockup already in the draft is replaced, not inserted again',
    ps.length === 1 && ps[0].op === 'replace');
  check('even though the published document has no mockup at all',
    PUBLISHED.images.length === 1);
}

console.log('');
console.log(fails.length ? `  FAILED: ${fails.join(', ')}` : '  all upload-slot checks passed');
process.exit(fails.length ? 1 : 0);
