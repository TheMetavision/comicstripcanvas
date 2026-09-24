/**
 * No secret in anything a browser downloads.
 *
 *   node tools/builder/secret-hygiene-tests.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The shared action secret was published. Not theoretically: the 40-character
 * value of PERSONALISATION_ACTION_SECRET was readable in
 * comicstripcanvas.sanity.studio/static/sanity-*.js, six megabytes, HTTP 200,
 * no login -- because Vite inlines SANITY_STUDIO_* at build time and a deployed
 * Studio serves its assets to anyone. The same secret guarded studio-save,
 * studio-upload, studio-rerender, both renderers and two scheduled sweeps.
 *
 * It was fixed by moving everything a human triggers behind /admin's Basic Auth
 * and rotating the server-to-server secret to a new NAME as well as a new
 * value. This file is here so it cannot come back quietly: the mistake was one
 * `import.meta.env` away, it looked exactly like ordinary configuration, and
 * nothing anywhere would have complained.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const SKIP = /node_modules|[\\/]dist[\\/]|[\\/]\.netlify[\\/]|[\\/]\.astro[\\/]|[\\/]\.git[\\/]|[\\/]\.sanity[\\/]|web-out|print-out/;
function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/**
 * The file with its comments removed.
 *
 * This codebase explains itself at length, and the explanations name the thing
 * that went wrong -- personalisationActions.tsx says in prose why it no longer
 * reads SANITY_STUDIO_PERSONALISATION_ACTION_SECRET. Scanning raw text would
 * make those explanations fail the test, which would teach people to delete the
 * explanation rather than keep the fix. What matters is what the CODE does.
 *
 * Deliberately approximate: a string containing "//" is stripped as though it
 * were a comment. That errs towards missing a violation rather than inventing
 * one, so section 3's "the replacement is still read in N files" is what keeps
 * an over-eager strip honest.
 */
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

/** This file quotes the old names to explain them; it is not a user of them. */
const SELF = path.join(ROOT, 'tools/builder/secret-hygiene-tests.mjs');

/* ─────────────────────────────── the Studio bundle is public */

say('\n1. THE STUDIO CARRIES NO SECRET\n');
{
  const studioSrc = walk(path.join(ROOT, 'studio'), /\.(ts|tsx|js|jsx|mjs)$/);
  ok(studioSrc.length > 0, `found ${studioSrc.length} Studio source files`);

  /* Any SANITY_STUDIO_ variable whose name suggests a credential. Everything
     under that prefix is inlined into the public bundle, so the rule is about
     the prefix, not about one variable that happened to be wrong. */
  const offenders = [];
  for (const f of studioSrc) {
    for (const m of code(fs.readFileSync(f, 'utf8')).matchAll(/SANITY_STUDIO_[A-Z0-9_]*/g)) {
      if (/SECRET|TOKEN|KEY|PASSWORD|PASS\b/.test(m[0])) offenders.push(`${rel(f)}: ${m[0]}`);
    }
  }
  ok(offenders.length === 0,
    'no SANITY_STUDIO_* variable names a credential', offenders.join('; '));

  /* And nothing in the Studio sends an internal header, whatever it reads. */
  const senders = studioSrc.filter((f) => /X-CSC-[A-Za-z-]*Secret/i.test(code(fs.readFileSync(f, 'utf8'))));
  ok(senders.length === 0,
    'nothing in the Studio sends an internal secret header', senders.map(rel).join(', '));

  /* The actions must reach the guarded route rather than the open one. */
  const actions = path.join(ROOT, 'studio/actions/personalisationActions.tsx');
  if (fs.existsSync(actions)) {
    const s = fs.readFileSync(actions, 'utf8');
    ok(/\/admin\/personalisation\//.test(s),
      'the personalisation actions open the guarded /admin route');
    ok(!/\/api\/personalisation-action/.test(code(s)),
      'and no longer call the open /api address');
  }
}

/* ─────────────────────────────── the built bundle, if one is present */

say('\n2. THE BUILT BUNDLE, IF IT HAS BEEN BUILT\n');
{
  const dist = path.join(ROOT, 'studio/dist/static');
  if (!fs.existsSync(dist)) {
    say('  SKIP  no studio/dist — run `npx sanity build` in studio/ to check the output too');
  } else {
    const files = fs.readdirSync(dist).filter((f) => /\.(js|mjs)$/.test(f));
    let withHeader = [], withVar = [];
    for (const f of files) {
      const s = fs.readFileSync(path.join(dist, f), 'utf8');
      if (/X-CSC-[A-Za-z-]*Secret/i.test(s)) withHeader.push(f);
      if (/SANITY_STUDIO_[A-Z0-9_]*(SECRET|TOKEN|KEY)/.test(s)) withVar.push(f);
    }
    ok(withHeader.length === 0,
      `no built file sends an internal secret header (${files.length} checked)`,
      withHeader.join(', '));
    ok(withVar.length === 0,
      'and none names a credential variable', withVar.join(', '));
  }
}

/* ─────────────────────────────── the rotation is complete */

say('\n3. THE OLD SECRET IS READ NOWHERE\n');
{
  const src = [
    ...walk(path.join(ROOT, 'netlify'), /\.(mjs|ts|js|mts)$/),
    ...walk(path.join(ROOT, 'src'), /\.(mjs|ts|js|astro)$/),
    ...walk(path.join(ROOT, 'studio'), /\.(ts|tsx|js|mjs)$/),
    ...walk(path.join(ROOT, 'tools/builder'), /\.(mjs|js)$/),
  ];
  const oldVar = [], oldHeader = [];
  for (const f of src) {
    if (f === SELF) continue;
    const s = code(fs.readFileSync(f, 'utf8'));
    if (/(?<!SANITY_STUDIO_)PERSONALISATION_ACTION_SECRET/.test(s)) oldVar.push(rel(f));
    if (/x-csc-action-secret/i.test(s)) oldHeader.push(rel(f));
  }
  ok(oldVar.length === 0, 'nothing reads PERSONALISATION_ACTION_SECRET', oldVar.join(', '));
  ok(oldHeader.length === 0, 'and nothing sends or checks the old header', oldHeader.join(', '));

  /* The replacement is actually used, so the above is not passing because the
     whole mechanism was deleted by accident. */
  const users = src.filter((f) => /CSC_INTERNAL_SECRET/.test(fs.readFileSync(f, 'utf8')));
  ok(users.length >= 8,
    `the replacement is read in ${users.length} files`, users.length < 8 ? users.map(rel).join(', ') : '');
}

/* ─────────────────────────────── the guarded routes stay guarded */

say('\n4. THE HUMAN-TRIGGERED ROUTES ARE UNDER /admin\n');
{
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  for (const route of ['order-print-file', 'personalisation-action']) {
    ok(new RegExp(`from = "/admin/api/${route}"`).test(toml),
      `/admin/api/${route} is routed`);
    ok(new RegExp(`from = "/api/${route}"[\\s\\S]{0,120}status = 404`).test(toml),
      `and the open /api/${route} is closed`);
  }
  /* Each function checks the path itself, because /.netlify/functions/<name>
     stays addressable whatever the redirects say. */
  for (const fn of ['order-print-file.mjs', 'personalisation-action.mjs']) {
    const s = fs.readFileSync(path.join(ROOT, 'netlify/functions', fn), 'utf8');
    ok(/\^\\\/admin\\\//.test(s) || /\/\^\\\/admin/.test(s) || /admin\\\//.test(s),
      `${fn} refuses anything off the guarded path`);
  }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
