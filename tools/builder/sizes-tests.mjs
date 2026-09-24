/**
 * The three sizes: one definition, three copies of it, and how a saved build
 * finds its way back to the right one.
 *
 *   node tools/builder/sizes-tests.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Medium moved from 16x12 to 18x12. The dimensions lived in nine places, and
 * two of them are size TABLES that cannot import anything from each other:
 * src/scripts/product-builder.js (which the site ships) and
 * tools/builder/product-builder.html (the standalone prototype, opened straight
 * in a browser). Everything else now derives from _shared/sizes.mjs, but those
 * two tables can still drift, and drift between them means the prototype and
 * the shipped builder quietly produce different print geometry from the same
 * design. So they are compared here, by parsing both files -- the only way to
 * check a table that is deliberately duplicated.
 *
 * The resume assertions are the other half. The builder used to match a saved
 * recipe back to its size on exact inches, so moving Medium would have reopened
 * every half-finished Medium build at the template default -- the LARGEST size,
 * at Large's price, saying nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SIZE_KEYS, SIZE_INCHES, sizeDim, sizeLabel, sizeLabels,
  builderSizes, resumeSize,
} from '../../netlify/functions/_shared/sizes.mjs';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* ================================================== the shared definition */

say('\n1. THE SHARED TABLE\n');
{
  ok(SIZE_KEYS.join(',') === 'small,medium,large',
    'the keys are small, medium, large in offer order', SIZE_KEYS.join(','));

  /* The point of the change: every size is 3:2, so one 2:3 print master fits
     all three by scaling. A size that is not 3:2 is the bug this guards. */
  for (const key of SIZE_KEYS) {
    const [long, short] = SIZE_INCHES[key];
    ok(Math.abs(long / short - 1.5) < 1e-9,
      `${key} is 3:2 (${long}x${short})`, (long / short).toFixed(4));
  }

  ok(SIZE_INCHES.medium[0] === 18 && SIZE_INCHES.medium[1] === 12,
    'medium is 18x12', SIZE_INCHES.medium.join('x'));
  ok(sizeDim('medium', '×') === '18×12"', 'the functions spelling', sizeDim('medium', '×'));
  ok(sizeDim('medium', 'x') === '18x12"', 'the front-end spelling', sizeDim('medium', 'x'));
  ok(sizeLabel('medium', 'x') === 'Medium (18x12")', 'the full label',
    sizeLabel('medium', 'x'));
  ok(Object.keys(sizeLabels('×')).length === 3, 'the whole table comes back at once');
  ok(sizeDim('nonsense') === '', 'an unknown key gives no dimension rather than "undefined"',
    JSON.stringify(sizeDim('nonsense')));
}

/* ============================================ the two duplicated tables */

say('\n2. THE DUPLICATED SIZES TABLES AGREE\n');

/**
 * Pull a `SIZES = { ... }` object literal out of a source file and read the
 * label/w/h triples out of it, per orientation key. Deliberately textual: the
 * prototype is an HTML file with an inline script and cannot be imported, and
 * running it would need a DOM.
 */
function parseSizes(file) {
  const src = fs.readFileSync(file, 'utf8');
  const at = src.search(/const\s+SIZES\s*=\s*\{/);
  if (at === -1) return null;
  /* Walk braces from the opening one so a nested object cannot end it early. */
  const open = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  const body = src.slice(open, end + 1);
  const out = {};
  for (const m of body.matchAll(/(\w+)\s*:\s*\[([\s\S]*?)\]/g)) {
    const entries = [...m[2].matchAll(/label\s*:\s*'([^']*)'\s*,\s*w\s*:\s*(\d+)\s*,\s*h\s*:\s*(\d+)/g)]
      .map((e) => `${e[1]}|${e[2]}x${e[3]}`);
    if (entries.length) out[m[1]] = entries;
  }
  return out;
}

{
  const htmlFile = path.join(ROOT, 'tools/builder/product-builder.html');
  const jsFile = path.join(ROOT, 'src/scripts/product-builder.js');
  const html = parseSizes(htmlFile);

  ok(!!html, 'the prototype has a readable SIZES table');

  /* The shipped builder derives its table from the module, so the module is
     what the prototype is compared against. If product-builder.js ever goes
     back to a literal table, this picks it up and compares that instead. */
  const jsLiteral = parseSizes(jsFile);
  const derived = {
    strip: builderSizes('landscape'),
    cover: builderSizes('portrait'),
    portrait: builderSizes('portrait'),
    landscape: builderSizes('landscape'),
  };
  const asTriples = (list) => list.map((z) => `${z.label}|${z.w}x${z.h}`);

  /* A derived table still matches `const SIZES = {` but yields no label/w/h
     triples, so "did it parse" has to mean "did it find entries" -- an empty
     object here is a derived table, not a literal one with nothing in it. */
  if (jsLiteral && Object.keys(jsLiteral).length) {
    say('     (product-builder.js has a literal table — comparing it too)');
    for (const key of Object.keys(derived)) {
      ok(JSON.stringify(jsLiteral[key]) === JSON.stringify(asTriples(derived[key])),
        `product-builder.js ${key} matches the module`,
        (jsLiteral[key] || []).join(' / '));
    }
  } else {
    ok(/builderSizes\(/.test(fs.readFileSync(jsFile, 'utf8')),
      'product-builder.js derives its sizes from the shared module');
  }

  for (const key of Object.keys(derived)) {
    const want = asTriples(derived[key]);
    const got = (html || {})[key];
    ok(JSON.stringify(got) === JSON.stringify(want),
      `prototype ${key} matches the module`,
      got ? got.join(' / ') : 'missing');
  }

  /* Orientation is the thing most easily got backwards when copying by hand. */
  ok((html || {}).strip?.[1] === '18 × 12 in|18x12', 'a strip medium is landscape 18x12',
    (html || {}).strip?.[1]);
  ok((html || {}).cover?.[1] === '12 × 18 in|12x18', 'a cover medium is portrait 12x18',
    (html || {}).cover?.[1]);
}

/* ======================================================= resuming a build */

say('\n3. A SAVED BUILD REOPENS AT THE RIGHT SIZE\n');
{
  const strip = builderSizes('landscape');   // 12x8, 18x12, 24x16
  const cover = builderSizes('portrait');   // 8x12, 12x18, 16x24

  /* ---- case 1: the recipe records its key (everything saved from now on) ---- */
  ok(resumeSize({ sizeKey: 'medium', faceInches: [99, 99] }, strip)?.key === 'medium',
    'the recorded key wins, even against a face that matches nothing',
    resumeSize({ sizeKey: 'medium', faceInches: [99, 99] }, strip)?.label);
  ok(resumeSize({ sizeKey: 'small' }, cover)?.key === 'small',
    'and works with no face at all');
  for (const key of SIZE_KEYS) {
    ok(resumeSize({ sizeKey: key }, strip)?.key === key, `key ${key} round-trips`);
  }

  /* ---- case 2: a legacy recipe, saved when Medium was 16x12 ---- */
  ok(resumeSize({ faceInches: [16, 12] }, strip)?.key === 'medium',
    'a 16x12 strip recipe reopens as Medium',
    resumeSize({ faceInches: [16, 12] }, strip)?.label);
  ok(resumeSize({ faceInches: [12, 16] }, cover)?.key === 'medium',
    'a 12x16 cover recipe reopens as Medium',
    resumeSize({ faceInches: [12, 16] }, cover)?.label);
  /* The sizes that did not move must still match exactly, not approximately. */
  ok(resumeSize({ faceInches: [12, 8] }, strip)?.key === 'small',
    'an unchanged Small still lands on Small');
  ok(resumeSize({ faceInches: [16, 24] }, cover)?.key === 'large',
    'an unchanged Large still lands on Large');
  ok(resumeSize({ faceInches: [18, 12] }, strip)?.key === 'medium',
    'and a new-style Medium face matches exactly');

  /* ---- case 3: a face we have never sold falls back to the NEAREST ---- */
  const nearSmall = resumeSize({ faceInches: [11, 7] }, strip);
  ok(nearSmall?.key === 'small', 'an unknown small face picks Small, not Large',
    nearSmall?.label);
  const nearMedium = resumeSize({ faceInches: [17, 11] }, strip);
  ok(nearMedium?.key === 'medium', 'an unknown middling face picks Medium',
    nearMedium?.label);
  const nearLarge = resumeSize({ faceInches: [30, 20] }, strip);
  ok(nearLarge?.key === 'large', 'an unknown huge face picks Large on merit',
    nearLarge?.label);

  /* The regression this function exists for: the old code left T.size alone on
     no match, and the template default is the LARGEST size. */
  const wouldHaveBeenLarge = resumeSize({ faceInches: [16, 12] }, strip);
  ok(wouldHaveBeenLarge?.key !== 'large',
    'a legacy Medium build does NOT silently reopen as Large',
    wouldHaveBeenLarge?.label);

  /* ---- nothing to go on ---- */
  ok(resumeSize({}, strip) === null, 'a recipe with no size information returns null');
  ok(resumeSize({ faceInches: ['x', 2] }, strip) === null, 'as does a nonsense face');
  ok(resumeSize({ faceInches: [12, 8] }, []) === null, 'and an empty size list');
  ok(resumeSize(null, strip) === null, 'and no output at all');

  /* Identity: the builder compares the chosen size to the list with ===, so
     resumeSize has to return a MEMBER of the list it was given. */
  const picked = resumeSize({ faceInches: [16, 12] }, strip);
  ok(strip.includes(picked), 'the size returned is a member of the list passed in');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
