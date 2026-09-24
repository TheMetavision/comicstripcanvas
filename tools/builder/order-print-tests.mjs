/**
 * Which product an order line was for, and which lines may raise an alarm.
 *
 *   node tools/builder/order-print-tests.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every order in the dataset was placed before the webhook stamped anything
 * onto a line. Those lines record a title and two labels a human reads, and
 * nothing a machine can act on -- so "this line has no print file" says nothing
 * whatever about the product, and treating it as a fault put a red warning on
 * all fourteen of them, and on the Bob Marley icon in CSC-1003, whose product
 * has both a master and a saved design.
 *
 * Two rules come out of that, and both are here because both are shared: the
 * renderer and the Studio panel have to agree about which product a line was
 * for, and the line preview and the Needs attention list have to agree about
 * which lines may complain.
 *
 * The lookups are injected, so these are the RULES under test rather than
 * Sanity. The renderer passes a server client, the panel passes the Studio's.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  isStamped, isFeeLine, isLegacyBuildLine, isStockLine,
  slugCandidates, resolveLineProduct,
} from '../../netlify/functions/_shared/order-print.mjs';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* The shop as these tests see it. Three products share the title "Bob Marley",
   which is not a contrivance -- it is what is published today. */
const CATALOGUE = {
  'bob-marley-icon': { slug: 'bob-marley-icon', title: 'Bob Marley', master: 'https://cdn/bmi.png', fbMaster: null },
  'bob-marley-cover': { slug: 'bob-marley-cover', title: 'Bob Marley', master: null, fbMaster: null },
  'bob-marley': { slug: 'bob-marley', title: 'Bob Marley', master: 'https://cdn/bm.png', fbMaster: null },
  'billie-eilish-strip': { slug: 'billie-eilish-strip', title: 'Billie Eilish', master: null, fbMaster: null },
  'the-warriors': { slug: 'the-warriors', title: 'The Warriors', master: 'https://cdn/tw.png', fbMaster: null },
};
let reads = [];
const bySlug = async (slug) => { reads.push(slug); return CATALOGUE[slug] || null; };
const byTitle = async (title) => Object.values(CATALOGUE)
  .filter((p) => p.title === title).map((p) => ({ slug: p.slug }));

const resolve = (line, lineKey) => resolveLineProduct({ line, lineKey, bySlug, byTitle });

/* ───────────────────────────────── which lines may complain */

say('\n1. WHICH LINES WERE STAMPED\n');
{
  const historic = { productTitle: 'Bob Marley', format: 'Poster Print', size: 'Large (24×16")' };
  const stamped = { ...historic, sizeKey: 'large', formatKey: 'poster', productSlug: 'bob-marley-icon' };

  ok(isStamped(historic) === false, 'a line from before the stamping is not stamped');
  ok(isStamped(stamped) === true, 'one written by the current webhook is');
  ok(isStamped({ productSlug: 'x' }) === false,
    'productSlug alone is not the mark — the webhook only sets it when the cart carried one');
  ok(isStamped(null) === false && isStamped(undefined) === false,
    'and nothing is not a stamped line');

  /* The rule the line preview uses, and the one the Needs attention filter
     spells in GROQ. They have to say the same thing. */
  const alarms = (line) => !line.printFile && !line.buildKind && Boolean(line.sizeKey);
  ok(alarms(historic) === false, 'a historic line with no file raises NO alarm');
  ok(alarms(stamped) === true, 'a stamped line with no file DOES');
  ok(alarms({ ...stamped, printFile: 'https://cdn/x.png' }) === false,
    'a stamped line that has its file does not');
  ok(alarms({ ...stamped, buildKind: 'personalised' }) === false,
    'and a built line never does — it prints from its own proof');

  ok(isFeeLine({ format: '—', size: '—' }) === true, 'the artwork fee is not a printable line');
  ok(isFeeLine({ format: 'Poster Print', size: 'Large (24×16")' }) === false,
    'a real line is');

  /* The old personalise flow recorded no buildKind, so these look like stock
     lines and are not. Ten of the fourteen orders are made of them. */
  const legacy = { productTitle: 'Personalised Comic Book Icon', format: 'Poster Print', size: 'Small (12×8")' };
  ok(isLegacyBuildLine(legacy, 'pers-1779895073637') === true,
    'a pers- line is a build, not a stock line');
  ok(isLegacyBuildLine(legacy, 'pers-icon-1776727958831') === true,
    'including the one keyed pers-icon-');
  ok(isLegacyBuildLine(
    { productTitle: 'Bob Marley', format: 'Poster Print', size: 'Large (24×16")' },
    'bob-marley-icon-poster-large-1') === false,
  'and a stock line is not');
  ok(isStockLine(legacy, 'pers-1779895073637') === false,
    'so no product is hunted for it');
  ok(isStockLine(
    { productTitle: 'Bob Marley', format: 'Poster Print', size: 'Large (24×16")' },
    'bob-marley-icon-poster-large-1') === true,
  'while a real stock line is looked up');
  ok(isStockLine({ productTitle: 'Bob Marley' }, 'bob-marley-icon-poster-large-1') === false,
    'a line carrying no format and no size is left alone, deliberately');
  ok(isStockLine({ format: '—', size: '—' }, 'artfee-1') === false, 'and the fee is not');
  ok(isStockLine({ buildKind: 'personalised' }, 'gizmo-classic-poster-small-0') === false,
    'nor a modern built line');
}

/* ───────────────────────────── the Studio filter says the same thing */

say('\n2. THE NEEDS ATTENTION FILTER AGREES WITH THE PREVIEW\n');
{
  const config = fs.readFileSync(path.join(ROOT, 'studio/sanity.config.ts'), 'utf8');
  const order = fs.readFileSync(path.join(ROOT, 'studio/schemas/order.ts'), 'utf8');
  ok(/!defined\(printFile\)/.test(config) && /!defined\(buildKind\)/.test(config)
    && /defined\(sizeKey\)/.test(config),
  'the desk filter excludes built lines AND unstamped ones');
  ok(/Boolean\(sizeKey\)/.test(order),
    'and the line preview gates its warning on the same stamp');
}

/* ─────────────────────────────────── which product a line was for */

say('\n3. RESOLVING A HISTORIC LINE\n');
{
  reads = [];
  /* The real key off CSC-1003. There is no slug on the line; the key is the
     only evidence, and it is <slug>-<format>-<size>-<index>. */
  const line = { productTitle: 'Bob Marley', format: 'Poster Print', size: 'Large (24×16")' };
  const got = await resolve(line, 'bob-marley-icon-poster-large-1');

  ok(got.product?.slug === 'bob-marley-icon',
    'the icon on CSC-1003 resolves from its line key', got.product?.slug || got.error);
  ok(got.by === 'key', 'by the key rather than the title', got.by);
  ok(got.product?.master === 'https://cdn/bmi.png',
    'and offers that product’s current master', got.product?.master);

  /* THE point of stripping longest-first. "bob-marley" is also a product, and
     shortest-first would have found it -- a different picture, same title,
     entirely plausible. */
  ok(reads.indexOf('bob-marley-icon') < reads.indexOf('bob-marley')
    || !reads.includes('bob-marley'),
  'the longer slug is tried before the shorter one', reads.join(' → '));

  const { candidates } = slugCandidates({}, 'bob-marley-icon-poster-large-1');
  ok(candidates[0] === 'bob-marley-icon-poster-large'
    && candidates.includes('bob-marley-icon'),
  'candidates come longest first', candidates.slice(0, 3).join(', '));
}

say('\n4. A HISTORIC LINE WHOSE PRODUCT HAS NO MASTER\n');
{
  const line = { productTitle: 'Billie Eilish', format: 'Poster Print', size: 'Small (12×8")' };
  const got = await resolve(line, 'billie-eilish-strip-poster-small-0');
  ok(got.product?.slug === 'billie-eilish-strip', 'the product still resolves',
    got.product?.slug || got.error);
  ok(got.product?.master === null,
    'and it genuinely has no master — the one case worth saying so about');
}

say('\n5. AN AMBIGUOUS TITLE REFUSES\n');
{
  /* A key that names no product, so the title is all that is left -- and three
     products share it. */
  const line = { productTitle: 'Bob Marley', format: 'Poster Print', size: 'Large (24×16")' };
  const got = await resolve(line, 'pers-1779895073637');
  ok(!got.product, 'nothing is chosen', got.product?.slug);
  ok(got.reason === 'ambiguous', 'and it says why', got.reason);
  ok((got.candidates || []).length === 3, 'naming all three', (got.candidates || []).join(', '));
  ok(/does not say which/.test(got.error || ''), 'in words a human can act on', got.error);
}

say('\n6. A STAMPED LINE IS AUTHORITATIVE\n');
{
  const line = {
    productTitle: 'Bob Marley', productSlug: 'bob-marley-cover',
    sizeKey: 'large', formatKey: 'poster',
  };
  const got = await resolve(line, 'bob-marley-cover-classic-poster-large-0');
  ok(got.product?.slug === 'bob-marley-cover', 'its own slug wins', got.product?.slug);
  ok(got.by === 'slug', 'and is used as such', got.by);

  /* A wrong slug must FAIL rather than fall back to the title -- the title is
     shared by three products and falling back would silently pick one. */
  reads = [];
  const bad = await resolve(
    { productTitle: 'Bob Marley', productSlug: 'bob-marley-gone', sizeKey: 'large' },
    'bob-marley-icon-poster-large-1');
  ok(!bad.product, 'a slug that names nothing resolves to nothing', bad.product?.slug);
  ok(bad.reason === 'missing' && /bob-marley-gone/.test(bad.error || ''),
    'and says which slug was wrong', bad.error);
  ok(reads.length === 1,
    'without quietly trying the key or the title instead', reads.join(', '));
}

say('\n7. NOTHING TO GO ON\n');
{
  const got = await resolve({ format: 'Poster Print' }, '');
  ok(!got.product && got.reason === 'missing',
    'a line with no slug, no usable key and no title resolves to nothing', got.error);
  const fee = await resolve({ productTitle: 'Artwork Fee', format: '—', size: '—' }, 'artfee-1779895073638');
  ok(!fee.product, 'and the artwork fee matches no product', fee.error);
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
