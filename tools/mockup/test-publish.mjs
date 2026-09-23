#!/usr/bin/env node
/**
 * What publish.mjs will and will not push live.
 *
 *   node tools/mockup/test-publish.mjs
 *
 * This is the one tool in the folder that makes something visible to a
 * customer, and the only thing standing between "a draft exists" and "it goes
 * live" is classify(). So the cases here are the ones that decide that, and the
 * last block proves the check is load-bearing rather than decorative: the same
 * held drafts are run past a deliberately naive classifier -- one that asks
 * only "did the draft gain a mockup", which is the check someone would write
 * if they were not thinking about shared drafts -- and it publishes every one
 * of them.
 */
import { classify, stripSystem, same } from './publish.mjs';

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const LISTING = { _type: 'image', _key: 'listing', asset: { _type: 'reference', _ref: 'image-art' }, alt: 'the artwork' };
const POSTER = { _type: 'image', _key: 'mockup-poster', asset: { _type: 'reference', _ref: 'image-p1' }, alt: 'Walter White lifestyle mockup — Comic Strip Canvas' };

const PUBLISHED = {
  _id: 'abc',
  _rev: 'rev-published',
  _type: 'product',
  _createdAt: '2026-01-01T00:00:00Z',
  _updatedAt: '2026-01-01T00:00:00Z',
  title: 'Walter White',
  slug: { current: 'walter-white-icon' },
  category: 'comic-book-icons',
  price: 4999,
  images: [LISTING],
};

// A draft as upload.mjs leaves it: same everything, plus the poster.
const draftWith = (over = {}) => ({
  ...PUBLISHED,
  _id: 'drafts.abc',
  _rev: 'rev-draft',
  _updatedAt: '2026-09-24T10:00:00Z',
  images: [LISTING, POSTER],
  ...over,
});

// 1. Poster only: publish.
{
  const r = classify(PUBLISHED, draftWith());
  check('a poster-only diff is publishable', r.state === 'publishable', `${r.state} ${r.summary}`);
  check('and it says what it gains', r.gained.join(',') === 'mockup-poster', r.summary);
}

// 2. Poster plus a retitle: held.
{
  const r = classify(PUBLISHED, draftWith({ title: 'Walter White (Heisenberg)' }));
  check('poster + retitle is held', r.state === 'held', `${r.state} ${r.summary}`);
  check('and the summary names the field', /\btitle\b/.test(r.summary), r.summary);
}

// 3. Poster plus a price change: held.
{
  const r = classify(PUBLISHED, draftWith({ price: 5999 }));
  check('poster + price change is held', r.state === 'held', `${r.state} ${r.summary}`);
  check('and the summary names the field', /\bprice\b/.test(r.summary), r.summary);
}

// 4. System-field noise only: publish.
{
  const noisy = draftWith({
    _rev: 'completely-different-rev',
    _updatedAt: '2026-12-31T23:59:59Z',
    _createdAt: '2020-06-06T00:00:00Z',
  });
  const r = classify(PUBLISHED, noisy);
  check('_rev / _updatedAt / _createdAt noise does not hold a draft',
    r.state === 'publishable', `${r.state} ${r.summary}`);
  check('stripSystem removes exactly those four',
    !('_id' in stripSystem(noisy)) && !('_rev' in stripSystem(noisy))
    && !('_createdAt' in stripSystem(noisy)) && !('_updatedAt' in stripSystem(noisy))
    && 'title' in stripSystem(noisy) && 'images' in stripSystem(noisy));
}

// 5. No draft: skipped, not held and not published.
{
  const r = classify(PUBLISHED, null);
  check('no draft is skipped', r.state === 'no-draft', r.state);
  check('and is neither publishable nor held',
    r.state !== 'publishable' && r.state !== 'held');
}

// ── the surrounding cases, because the above are the easy half ─────────────

// 6. Field ORDER is not a difference; a changed nested value is.
{
  const reordered = draftWith({ slug: { current: 'walter-white-icon' } });
  check('field order and key order are not a diff',
    classify(PUBLISHED, reordered).state === 'publishable');
  const resluged = draftWith({ slug: { current: 'walter-white' } });
  const r = classify(PUBLISHED, resluged);
  check('a changed nested value is a diff', r.state === 'held', r.summary);
  check('and the summary names the top-level field', /\bslug\b/.test(r.summary), r.summary);
}

// 7. A non-mockup image added by hand: held.
{
  const extra = { _type: 'image', _key: 'extra', asset: { _type: 'reference', _ref: 'image-x' } };
  const r = classify(PUBLISHED, draftWith({ images: [LISTING, extra, POSTER] }));
  check('a non-mockup image added to the draft is held', r.state === 'held', r.summary);
  check('and the summary says so', /non-mockup/.test(r.summary), r.summary);
}

// 8. A mockup already published, CHANGED in the draft: held, not published.
{
  const live = { ...PUBLISHED, images: [LISTING, POSTER] };
  const corrected = { ...POSTER, asset: { _type: 'reference', _ref: 'image-p2' } };
  const r = classify(live, draftWith({ images: [LISTING, corrected] }));
  check('a re-uploaded mockup over a live one is held, not published',
    r.state === 'held', `${r.state} ${r.summary}`);
  check('and the summary says changed rather than added',
    /changed rather than added/.test(r.summary), r.summary);
}

// 9. A published mockup dropped from the draft: held.
{
  const live = { ...PUBLISHED, images: [LISTING, POSTER] };
  const r = classify(live, draftWith({ images: [LISTING] }));
  check('a published mockup removed in the draft is held', r.state === 'held', r.summary);
  check('and the summary says removed', /removed/.test(r.summary), r.summary);
}

// 10. Identical draft: not published, not held.
{
  const live = { ...PUBLISHED, images: [LISTING, POSTER] };
  const r = classify(live, draftWith({ images: [LISTING, POSTER] }));
  check('a draft matching what is live is neither published nor held',
    r.state === 'identical', r.state);
}

// 11. A field DELETED in the draft counts, not just a changed one.
{
  const noPrice = draftWith();
  delete noPrice.price;
  const r = classify(PUBLISHED, noPrice);
  check('a field deleted in the draft is held', r.state === 'held', r.summary);
  check('and the summary names it', /\bprice\b/.test(r.summary), r.summary);
}

// ── is the check actually doing anything? ──────────────────────────────────
//
// The naive version: publish whenever the draft has a mockup the published
// document has not. No comparison of anything else. If the real classifier
// agreed with this on the held cases, the diff check would be decoration.
const naive = (published, draft) => {
  if (!draft) return 'no-draft';
  const pKeys = new Set((published.images || []).filter((i) => i?._key?.startsWith('mockup-')).map((i) => i._key));
  const gained = (draft.images || []).filter((i) => i?._key?.startsWith('mockup-') && !pKeys.has(i._key));
  return gained.length ? 'publishable' : 'identical';
};

{
  const cases = [
    ['retitle', draftWith({ title: 'Walter White (Heisenberg)' })],
    ['price change', draftWith({ price: 5999 })],
    ['re-slugged', draftWith({ slug: { current: 'walter-white' } })],
    ['hand-added image', draftWith({
      images: [LISTING, { _type: 'image', _key: 'extra', asset: { _type: 'reference', _ref: 'image-x' } }, POSTER],
    })],
    ['deleted field', (() => { const d = draftWith(); delete d.price; return d; })()],
  ];
  let naivePublishes = 0;
  let realHolds = 0;
  for (const [label, draft] of cases) {
    const n = naive(PUBLISHED, draft);
    const r = classify(PUBLISHED, draft).state;
    if (n === 'publishable') naivePublishes += 1;
    if (r === 'held') realHolds += 1;
    check(`without the diff check, "${label}" would go live`,
      n === 'publishable' && r === 'held', `naive=${n} real=${r}`);
  }
  check('the diff check is what catches all of them',
    naivePublishes === cases.length && realHolds === cases.length,
    `naive published ${naivePublishes}/${cases.length}, real held ${realHolds}/${cases.length}`);
}

// A sanity check on the comparator itself, so a broken `same` cannot make the
// whole suite pass by calling everything identical.
{
  check('same() distinguishes values', !same({ a: 1 }, { a: 2 }));
  check('same() ignores key order', same({ a: 1, b: 2 }, { b: 2, a: 1 }));
  check('same() respects array order', !same([1, 2], [2, 1]));
}

console.log('');
console.log(fails.length ? `  FAILED: ${fails.join(', ')}` : '  all publish checks passed');
process.exit(fails.length ? 1 : 0);
