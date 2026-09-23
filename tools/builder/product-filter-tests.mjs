/**
 * The store's product search — the rules, tested.
 *
 *   node tools/builder/product-filter-tests.mjs
 *
 * Imports src/scripts/product-filter.js, which is the code the store runs. No
 * DOM and no bundle, for the reason box-link-tests gives: these are strings in
 * and booleans out, and a browser between the test and the answer is three
 * more things that can fail.
 *
 * The assertions that matter are the ones about SCOPE. A category page's grid
 * only ever contains its own products, so a search there must never be able to
 * reach into another category -- and the way to prove that is not to assert
 * the filter is scoped, but to hand it a mixed list and show it still cannot.
 */
import {
  normalise, matchesQuery, matchesCategory, decideVisibility, visibleCount,
} from '../../src/scripts/product-filter.js';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* A stand-in catalogue with all three categories in it.
 *
 * Bruce Lee is in TWO of them on purpose. The real catalogue has 26 titles
 * that exist as both a cover and an icon, so "searching the covers page for
 * Bruce returns nothing" is false against production -- it returns the Bruce
 * Lee COVER, which is correct and must not be mistaken for a leak later.
 * Albert Einstein is the icons-only one, and is what the scope assertions use. */
const CATALOGUE = [
  { title: 'Walter White', category: 'comic-book-covers' },
  { title: 'Ed Sheeran', category: 'comic-book-covers' },
  { title: 'Bruce Lee', category: 'comic-book-covers' },
  { title: 'Bruce Lee', category: 'comic-book-icons' },
  { title: 'Albert Einstein', category: 'comic-book-icons' },
  { title: 'The Rolling Stones', category: 'comic-book-icons' },
  { title: 'Grease', category: 'comic-book-strips' },
  { title: 'Ghostbusters', category: 'comic-book-strips' },
];
const only = (cat) => CATALOGUE.filter((p) => p.category === cat);
const titlesShown = (rows, state) =>
  rows.filter((_, i) => decideVisibility(rows, state)[i]).map((r) => r.title);

/* ------------------------------------------------ 1. what a search matches */

say('\n1. WHAT THE SEARCH MATCHES\n');
{
  ok(matchesQuery('Walter White', 'walter'), 'a title matches its own text, case-insensitively');
  ok(matchesQuery('Walter White', 'WALTER'), 'and the typing case does not matter either');
  ok(matchesQuery('Walter White', 'white'), 'matching is a substring, not a prefix');
  ok(matchesQuery('Walter White', 'ter Wh'), 'including across the middle of the title');
  ok(!matchesQuery('Walter White', 'jordan'), 'and something absent does not match');

  /* Title only. Widening this is a deliberate decision to take in one place,
     and All Products has never done it -- a category page that searched
     descriptions would answer differently for the same typing. */
  ok(!matchesQuery('Walter White', 'breaking bad'),
    'the description is NOT searched — All Products does not, so neither does this');

  ok(matchesQuery('Walter White', ''), 'an empty query matches everything');
  ok(matchesQuery('Walter White', '   '), 'and so does one that is only spaces');
  ok(matchesQuery('Walter White', ' walter '), 'a query is trimmed before it is used');
  ok(matchesQuery(null, ''), 'a missing title does not throw');
  ok(!matchesQuery(null, 'x'), 'and does not match anything either');
}

/* ------------------------------------- 2. a category page sees its own only */

say('\n2. EACH CATEGORY PAGE FILTERS TO ITS OWN PRODUCTS\n');
{
  /* This is the scope assertion, and it is deliberately made the hard way:
     the rows handed in are ONLY that category's, because that is what the
     page renders. A covers page cannot return an icon because an icon is not
     in its grid to return. */
  for (const cat of ['comic-book-covers', 'comic-book-icons', 'comic-book-strips']) {
    const rows = only(cat);
    const shown = titlesShown(rows, { query: '' });
    ok(shown.length === rows.length && rows.every((r) => r.category === cat),
      `${cat}: an empty search shows the whole category and nothing else`,
      `${shown.length} product(s)`);
  }

  /* A term matching an ICONS-ONLY product returns nothing on the COVERS page.
     Verified against the built catalogue as well as this fixture: "einstein"
     and "clockwork" both return 0 of 56 on /store/comic-book-covers. */
  const coversForEinstein = titlesShown(only('comic-book-covers'), { query: 'einstein' });
  ok(coversForEinstein.length === 0,
    'searching the covers page for an icons-only title returns nothing',
    JSON.stringify(coversForEinstein));
  const iconsForEinstein = titlesShown(only('comic-book-icons'), { query: 'einstein' });
  ok(iconsForEinstein.length === 1 && iconsForEinstein[0] === 'Albert Einstein',
    'and the same term on the icons page finds it',
    JSON.stringify(iconsForEinstein));

  /* The reverse, so this is not passing by accident of the fixture. */
  const iconsForWalter = titlesShown(only('comic-book-icons'), { query: 'walter' });
  ok(iconsForWalter.length === 0, 'searching the icons page for a covers-only title returns nothing');
  const stripsForWalter = titlesShown(only('comic-book-strips'), { query: 'walter' });
  ok(stripsForWalter.length === 0, 'and so does the strips page');

  /* And the case that looks like a leak and is not: a title held in BOTH
     categories is found on both pages, because each grid has its own copy.
     26 real titles are like this, so a future reader seeing Bruce Lee on the
     covers page needs to know it was meant. */
  const coversForBruce = titlesShown(only('comic-book-covers'), { query: 'bruce' });
  const iconsForBruce = titlesShown(only('comic-book-icons'), { query: 'bruce' });
  ok(coversForBruce.length === 1 && iconsForBruce.length === 1,
    'a title that exists in two categories is found on both — its own copy each time, not a leak',
    `covers ${JSON.stringify(coversForBruce)}, icons ${JSON.stringify(iconsForBruce)}`);

  /* Clearing the box restores the category, which is the behaviour a customer
     relies on far more often than the search itself. */
  const covers = only('comic-book-covers');
  ok(visibleCount(covers, { query: 'walter' }) === 1, 'a term narrows the covers page to one');
  ok(visibleCount(covers, { query: '' }) === covers.length,
    'and clearing it brings the whole category back', `${covers.length} product(s)`);
}

/* ------------------------------------------ 3. All Products keeps its buttons */

say('\n3. ALL PRODUCTS STILL FILTERS BY CATEGORY TOO\n');
{
  ok(matchesCategory('comic-book-icons', 'all'), '"all" matches every category');
  ok(matchesCategory('comic-book-icons', ''), 'and so does no category at all');
  ok(matchesCategory('comic-book-icons', 'comic-book-icons'), 'an exact category matches');
  ok(!matchesCategory('comic-book-icons', 'comic-book-covers'), 'a different one does not');

  ok(visibleCount(CATALOGUE, { category: 'all' }) === CATALOGUE.length,
    'the All Products grid shows everything by default', String(CATALOGUE.length));
  ok(visibleCount(CATALOGUE, { category: 'comic-book-covers' }) === 3,
    'picking a category narrows it');

  /* The two filters are ANDed, which is what makes covers + an icons-only
     term empty on a grid that does hold that product under another category. */
  ok(visibleCount(CATALOGUE, { category: 'comic-book-covers', query: 'einstein' }) === 0,
    'category and search combine — covers + "einstein" is empty even though the grid holds him as an icon');
  ok(visibleCount(CATALOGUE, { category: 'comic-book-icons', query: 'einstein' }) === 1,
    'and icons + "einstein" finds him');

  /* Both copies of a two-category title survive an unfiltered search, which is
     the All Products page showing the cover AND the icon. */
  ok(visibleCount(CATALOGUE, { category: 'all', query: 'bruce' }) === 2,
    'All Products shows both copies of a title that exists twice');
}

/* --------------------------------------------------- 4. the ordinary edges */

say('\n4. EDGES\n');
{
  ok(normalise('  Walter White  ') === 'walter white', 'normalise trims and lowers');
  ok(normalise(null) === '' && normalise(undefined) === '', 'and survives nothing at all');

  ok(JSON.stringify(decideVisibility([], { query: 'x' })) === '[]', 'an empty grid is empty, not a throw');
  ok(JSON.stringify(decideVisibility(null, {})) === '[]', 'and so is a missing one');
  ok(decideVisibility([{ title: 'A' }], {}).length === 1, 'no state at all means show it');

  /* A row with no category must not vanish on a category page -- it would be a
     product whose grid shows it but whose filter hides it. */
  ok(decideVisibility([{ title: 'A' }], { query: 'a' })[0] === true,
    'a row with no category is still searchable');

  ok(visibleCount(CATALOGUE, { query: 'zzz' }) === 0,
    'a term matching nothing hides everything, which is what turns the empty state on');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
