/**
 * Product slugs — the rules, tested.
 *
 *   node tools/builder/slug-tests.mjs
 *
 * The assertion this file exists for is section 3: a title can never produce a
 * slug with a capital letter in it. Nine live products had one, each collided
 * with its lower-case twin, and in every pair one product had no reachable URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productSlug, isCanonicalSlug, slugProblem } from '../../netlify/functions/_shared/slug.mjs';
import { redirectLines } from '../../src/integrations/slug-redirects.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* ------------------------------------------------------- 1. the transform */

say('\n1. WHAT A TITLE BECOMES\n');
{
  ok(productSlug('Walter White') === 'walter-white', 'a plain title', productSlug('Walter White'));
  ok(productSlug('Batman & Robin') === 'batman-and-robin', '& is a word, not punctuation', productSlug('Batman & Robin'));
  ok(productSlug("Wayne's World") === 'waynes-world', 'an apostrophe closes up', productSlug("Wayne's World"));
  ok(productSlug('Pelé') === 'pele', 'an accent loses the accent, not the letter', productSlug('Pelé'));
  ok(productSlug('  Mad   Max  ') === 'mad-max', 'runs of space collapse', productSlug('  Mad   Max  '));
  ok(productSlug('E.T.') === 'e-t', 'dots become hyphens', productSlug('E.T.'));
  ok(productSlug('--Grease--') === 'grease', 'hyphens at either end go', productSlug('--Grease--'));
  ok(productSlug('') === 'untitled-design', 'nothing at all still gives a usable slug');
  ok(productSlug(null) === 'untitled-design', 'and so does null');
  ok(!/-$/.test(productSlug('a'.repeat(89) + ' b')), 'the length cap cannot leave a trailing hyphen');
}

/* ------------------------------------------ 2. THE ONE THAT MATTERS */

say('\n2. A CAPITAL LETTER CAN NEVER COME OUT\n');
{
  /* The nine that actually reached production, by the title that produced
     them. Not one may come back with its capital. */
  const LIVE = [
    ['Walter White', 'Walter-white'],
    ['Ed Sheeran', 'Ed-sheeran'],
    ['Muhammad Ali', 'Muhammad-ali'],
    ['Grease', 'Grease'],
    ['The Warriors', 'The-warriors'],
    ['Michael Jordan', 'Michael-jordan'],
    ['Kobe Bryant', 'Kobe-bryant'],
    ['Mad Max', 'Mad-max'],
    ['England World Cup 1966', 'England-world-cup-1966'],
  ];
  for (const [title, wrong] of LIVE) {
    const got = productSlug(title);
    ok(got !== wrong, `"${title}" cannot produce "${wrong}"`, got);
    ok(got === got.toLowerCase(), `"${title}" comes out lower case`, got);
  }
  /* and no title at all can, whatever is thrown at it */
  const NASTY = ['ÄÖÜ', 'ALL CAPS TITLE', 'MiXeD CaSe', 'Ã©Ã¨', '007', 'ZZ Top', 'AC/DC'];
  for (const t of NASTY) {
    const s = productSlug(t);
    ok(s === s.toLowerCase() && /^[a-z0-9-]*$/.test(s), `"${t}" -> "${s}" is lower-case ASCII`);
  }
}

/* --------------------------------------------------- 3. the validator */

say('\n3. WHAT COUNTS AS CANONICAL\n');
{
  ok(isCanonicalSlug('walter-white'), 'a good slug passes');
  ok(!isCanonicalSlug('Walter-white'), 'a capital fails');
  ok(!isCanonicalSlug('-walter'), 'a leading hyphen fails');
  ok(!isCanonicalSlug('walter-'), 'a trailing hyphen fails');
  ok(!isCanonicalSlug('walter--white'), 'a double hyphen fails');
  ok(!isCanonicalSlug('walter white'), 'a space fails');
  ok(!isCanonicalSlug(''), 'empty fails');
  ok(!isCanonicalSlug(null), 'null fails');

  /* every slug currently live must be reachable by this rule, or the fix
     would reject the catalogue it is meant to protect */
  ok(isCanonicalSlug('breakfast-at-tiffany-s'), 'an existing odd-but-valid slug still passes');
  ok(isCanonicalSlug('batmanandrobin'), 'and so does a squashed one');
  ok(isCanonicalSlug('007'), 'and one that is only digits');

  ok(/lower case/.test(slugProblem('Walter-white') || ''), 'the message names the real problem',
    slugProblem('Walter-white'));
  ok(slugProblem('walter-white') === null, 'and says nothing when there is none');
}

/* ----------------------------------------- 4. the schema has not drifted */

say('\n4. THE STUDIO SCHEMA ENFORCES THE SAME RULE\n');
{
  /* The Studio is a separate package and cannot import the module above, so
     the rules are repeated there. This is what stops the copies diverging
     silently: if someone loosens one, this fails. */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '..', '..', 'studio', 'schemas', 'product.ts');
  const src = fs.readFileSync(file, 'utf8');

  ok(/slugify:/.test(src), 'the slug field defines a slugify');
  ok(/toLowerCase\(\)/.test(src), 'which lowercases');
  ok(/\.replace\(\/&\/g, ' and '\)/.test(src), 'and treats & as "and", like the shared rule');
  ok(/normalize\('NFKD'\)/.test(src), 'and strips accents, like the shared rule');
  ok(/custom\(/.test(src), 'the slug field has a custom validator');
  ok(/slug !== slug\.toLowerCase\(\)/.test(src), 'which REJECTS a capital rather than only generating lower case');
  ok(/previousSlugs/.test(src), 'and the schema carries previousSlugs for redirects');
}

/* ------------------------------------------- 5. redirects from a rename */

say('\n5. A RENAME EMITS ITS OWN REDIRECT\n');
{
  const lines = redirectLines([
    { slug: 'walter-white-icon', previousSlugs: ['Walter-white'] },
    { slug: 'ed-sheeran-icon', previousSlugs: ['Ed-sheeran'] },
    { slug: 'nothing-changed', previousSlugs: [] },
  ]);
  ok(lines.length === 2, 'one line per previous slug', String(lines.length));
  ok(lines.includes('/store/Walter-white  /store/walter-white-icon/  301'),
    'pointing the old URL at the new one', lines[1]);
  ok(lines.every((l) => / 301$/.test(l)), 'as a permanent redirect');

  /* the two ways this could produce a broken _redirects */
  const loop = redirectLines([{ slug: 'same', previousSlugs: ['same'] }]);
  ok(loop.length === 0, 'a slug listed as its own previous slug is dropped, not turned into a loop');
  const dupe = redirectLines([
    { slug: 'a', previousSlugs: ['old'] },
    { slug: 'b', previousSlugs: ['old'] },
  ]);
  ok(dupe.length === 1, 'the same old slug twice emits one rule, not an unreachable second', String(dupe.length));

  ok(redirectLines([]).length === 0, 'nothing in, nothing out');
  ok(redirectLines(null).length === 0, 'and null does not throw');
  ok(redirectLines([{ slug: null, previousSlugs: ['x'] }]).length === 0, 'a product with no slug is skipped');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
