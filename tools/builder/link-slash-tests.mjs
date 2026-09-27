/**
 * Does any internal link send a visitor through a redirect?
 *
 *   npm run build && node tools/builder/link-slash-tests.mjs
 *
 * Astro builds every page as a directory with an index.html, so a page lives at
 * /store/bruce-lee-cover/ and Netlify answers /store/bruce-lee-cover with a 301
 * to the slashed form. That redirect works, which is why it went unnoticed: the
 * visitor arrives, just a round trip later.
 *
 * Two reasons it is worth not doing. A 301 carries NO Cache-Control here, and
 * browsers may cache a permanent redirect indefinitely -- so every slash-less
 * URL a visitor touches becomes an entry in their browser that nobody can
 * revoke, and it long outlives any change to the site's URL shapes. And it is a
 * whole extra request on every click, before the page starts.
 *
 * The check is mechanical rather than a list of known paths: an href needs a
 * trailing slash exactly when dist holds a directory with an index.html at that
 * path. Files, /api/ routes and off-site links are not pages and are left alone.
 *
 * Skipped with a message when there is no dist, so it does not fail a checkout
 * that has not been built.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve(new URL('../../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  say('\nNo dist/ — run "npm run build" first. Skipping.\n');
  process.exit(0);
}

/** Every built page. */
const pages = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) pages.push(p);
  }
})(DIST);

/** Is this path a page — a directory in dist holding an index.html? */
const isPage = (p) => fs.existsSync(path.join(DIST, p, 'index.html'));
/* Asked of the build rather than of the spelling: .webmanifest is a file and
   .co.uk is not, and no extension rule gets both right. */
const isFile = (p) => {
  try { return fs.statSync(path.join(DIST, p)).isFile(); } catch { return false; }
};

const offenders = new Map();
let linksChecked = 0;
for (const file of pages) {
  const html = fs.readFileSync(file, 'utf8');
  for (const m of html.matchAll(/(?:href|action)="(\/[^"]*)"/g)) {
    const [target] = m[1].split(/[?#]/);
    linksChecked++;
    if (target === '/' || target.endsWith('/')) continue;
    if (isFile(target)) continue;
    if (target.startsWith('/api/') || target.startsWith('/.netlify/')) continue;
    if (!isPage(target)) continue;                                  // not a page: a 404 or a route
    if (!offenders.has(target)) offenders.set(target, new Set());
    offenders.get(target).add(path.relative(DIST, file).split(path.sep).join('/'));
  }
}

say(`\n${pages.length} built page(s), ${linksChecked} internal link(s)\n`);

ok(offenders.size === 0,
  'no internal link points at a page without its trailing slash',
  offenders.size ? `${offenders.size} target(s) would redirect` : '');
if (offenders.size) {
  for (const [target, files] of [...offenders].sort((a, b) => b[1].size - a[1].size).slice(0, 15)) {
    say(`        ${target}  (${files.size} page(s), e.g. ${[...files][0]})`);
  }
}

/* The same question for the addresses handed to search engines: a canonical
   that redirects is a canonical pointing somewhere other than itself. */
const badCanonical = new Set();
for (const file of pages) {
  const html = fs.readFileSync(file, 'utf8');
  for (const m of html.matchAll(/rel="canonical" href="https:\/\/[^/]+(\/[^"]*)"/g)) {
    const [target] = m[1].split(/[?#]/);
    if (target === '/' || target.endsWith('/')) continue;
    if (isFile(target)) continue;
    if (isPage(target)) badCanonical.add(target);
  }
}
ok(badCanonical.size === 0, 'and no canonical URL redirects to itself',
  badCanonical.size ? [...badCanonical].slice(0, 5).join(', ') : '');

/* A link to somewhere that is not a page at all is a 404 with a nice colour
   scheme. /personalised was one, linked from all three category pages. */
const dead = new Map();
for (const file of pages) {
  const html = fs.readFileSync(file, 'utf8');
  for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
    const [target] = m[1].split(/[?#]/);
    if (target === '/' || isFile(target)) continue;
    if (target.startsWith('/api/') || target.startsWith('/.netlify/') || target.startsWith('/admin/')) continue;
    const clean = target.endsWith('/') ? target.slice(0, -1) : target;
    if (!clean || isPage(clean)) continue;
    if (!dead.has(target)) dead.set(target, new Set());
    dead.get(target).add(path.relative(DIST, file).split(path.sep).join('/'));
  }
}
ok(dead.size === 0, 'and every internal link goes somewhere that exists',
  dead.size ? [...dead.keys()].slice(0, 5).join(', ') : '');
if (dead.size) for (const [t, files] of dead) say(`        ${t}  (${files.size} page(s), e.g. ${[...files][0]})`);

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
