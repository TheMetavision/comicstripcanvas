/**
 * Put a selected panel's outline back to black in the scenes that stored it lit.
 *
 *   node tools/strip-selection-outline.mjs                     read, decide, print, do nothing
 *   node tools/strip-selection-outline.mjs --apply             write the scenes
 *   node tools/strip-selection-outline.mjs --apply --render     ...and re-render the masters
 *   node tools/strip-selection-outline.mjs --apply --pending    ...and fix personalisation records
 *
 * WHY
 * ---
 * exportSVG() stripped the hit areas, the guides, the slot flags and the resize
 * handles, but not the one mark that is hardest to see: a selected panel's
 * outline is drawn in the accent colour, and the outline element is a real part
 * of a strip -- the black border round each frame -- so it survived the clone
 * still wearing the selection's colour. Whichever panel happened to be selected
 * when Save was pressed went into the saved scene, and would print cyan.
 *
 * Fixed in the builder on fix/export-strips-selection. This is for what was
 * already stored.
 *
 * WHAT IT DOES
 * ------------
 * One thing: sets the stroke back to black on any stroke-width 9 path that is
 * stroked something else. It does not remove the path -- the border is the
 * design -- and it touches nothing else in the scene, so the only pixels that
 * change are the ones that were the wrong colour.
 *
 * A scene's revision is a hash of its own bytes, and the print cache key
 * carries that revision, so rewriting a scene invalidates the cached print by
 * construction rather than by remembering to clear it. Any file still cached
 * under the OLD revision is now unreachable, so it is deleted rather than left
 * to age: it is a 50MB orphan nothing will ever serve.
 *
 * WHAT IT WILL NOT DO WITHOUT BEING TOLD
 * --------------------------------------
 * A personalisation belonging to a real order is the record of what somebody
 * bought. Re-writing one silently edits that record, so an ordered record needs
 * --include-ordered as well, and says so rather than skipping quietly.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const REPO = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(path.join(REPO, 'package.json'));
const { getStore } = require('@netlify/blobs');
const { resolveCredentials } = await import(pathToFileURL(path.join(REPO, 'tools/builder/render-sweep.mjs')).href);
const { litOutlines, sceneFieldsOf } = await import(
  pathToFileURL(path.join(REPO, 'tools/builder/selection-outline-audit.mjs')).href);

/** The colour a panel outline wears when nothing is selected. */
const OUTLINE_REST = '#000';
const OUTLINE_WIDTH = 9;
const SANITY = 'https://lwbwahym.api.sanity.io';

const has = (f) => process.argv.includes(f);
const DRY = has('--dry-run') || !has('--apply');
const RENDER = has('--render');
const PENDING = has('--pending');
const ORDERED = has('--include-ordered');
const say = console.log.bind(console);
const rev = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Black out the lit outlines in one SVG.
 *
 * Only the stroke attribute of a stroke-width 9 path is rewritten, and only
 * when it is not already black: a replace that rewrote every stroke would
 * repaint the artwork.
 */
export function unlight(svg) {
  if (typeof svg !== 'string') return { svg, changed: 0, colours: [] };
  const colours = [];
  let changed = 0;
  const next = svg.replace(/<path\b[^>]*>/gi, (tag) => {
    if (!new RegExp('stroke-width\\s*=\\s*"' + OUTLINE_WIDTH + '"').test(tag)) return tag;
    const m = /\bstroke\s*=\s*"([^"]*)"/i.exec(tag);
    if (!m) return tag;
    const was = m[1].trim();
    if (/^(#000|#000000|none)$/i.test(was)) return tag;
    colours.push(was);
    changed++;
    return tag.replace(/\bstroke\s*=\s*"[^"]*"/i, 'stroke="' + OUTLINE_REST + '"');
  });
  return { svg: next, changed, colours: [...new Set(colours)] };
}

/** The same edit, wherever the scene lives inside a stored record. */
function unlightRecord(doc) {
  const out = Array.isArray(doc) ? [...doc] : { ...doc };
  let changed = 0;
  const colours = [];
  for (const field of sceneFieldsOf(doc)) {
    const name = field[0];
    if (name === 'recipe (raw)' || name === 'recipe (serialised)') continue;  // handled via its own field
    const r = unlight(field[1]);
    if (!r.changed) continue;
    changed += r.changed;
    colours.push(...r.colours);
    if (name === 'sceneSvg') out.sceneSvg = r.svg;
    else if (name === 'svg') out.svg = r.svg;
    else if (name === 'recipe.svg') {
      const p = JSON.parse(doc.recipe);
      p.svg = r.svg;
      out.recipe = JSON.stringify(p);
    }
  }
  return { doc: out, changed, colours: [...new Set(colours)] };
}

async function sanityQuery(query, token) {
  const res = await fetch(SANITY + '/v2021-10-21/data/query/production?query=' + encodeURIComponent(query),
    { headers: { Authorization: 'Bearer ' + token } });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

async function sanityPatch(id, set, token) {
  const res = await fetch(SANITY + '/v2021-10-21/data/mutate/production?returnIds=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ mutations: [{ patch: { id, set } }] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json;
}

/* ───────────────────────────────────────────────────────────
   Everything above is importable on its own -- the tests exercise unlight()
   directly -- so the work itself only runs when this file is the entry point. */

if (import.meta.url !== pathToFileURL(process.argv[1] || '').href) {
  /* Imported for its helpers. Nothing to do. */
} else await main();

async function main() {

if (RENDER && !DRY && !process.env.CSC_INTERNAL_SECRET) {
  say('--render needs CSC_INTERNAL_SECRET in the environment.');
  process.exit(2);
}

const { siteID, token } = resolveCredentials();
if (!siteID || !token) { say('No Netlify credentials — see render-sweep --help.'); process.exit(2); }
const studio = getStore({ name: 'studio', siteID, token, consistency: 'strong' });
const prints = getStore({ name: 'order-prints', siteID, token, consistency: 'strong' });
const sanityToken = process.env.SANITY_WRITE_TOKEN || process.env.SANITY_API_TOKEN || null;

say(DRY ? '\nDRY RUN — reading only. Nothing is written.\n'
  : '\nAPPLYING' + (RENDER ? ', then re-rendering' : ' (no re-render)') + '.\n');

/* ───────── studio scenes */

say('STUDIO SCENES\n');
const { blobs } = await studio.list();
const sceneKeys = blobs.map((b) => b.key).filter((k) => /scene\.(json|svg)$/.test(k));
const cached = (await prints.list()).blobs.map((b) => b.key);

let toChange = 0, clean = 0;
for (const key of sceneKeys) {
  const raw = await studio.get(key, { type: 'text' }).catch(() => null);
  if (raw == null) { say('  ! unreadable: ' + key); continue; }

  /* A .svg scene is the whole document; a .json one carries it in a field. */
  const isSvg = /\.svg$/.test(key);
  let doc = null;
  if (!isSvg) { try { doc = JSON.parse(raw); } catch { say('  ! unparsable: ' + key); continue; } }
  const before = isSvg ? litOutlines(raw) : sceneFieldsOf(doc).flatMap((f) => litOutlines(f[1]));
  if (!before.length) { clean++; continue; }

  const result = isSvg ? unlight(raw) : unlightRecord(doc);
  const body = isSvg ? result.svg : JSON.stringify(result.doc);
  const id = (/^studio\/([^/]+)\//.exec(key) || [])[1];
  const style = (/^studio\/[^/]+\/([^/]+)\//.exec(key) || [])[1] || 'classic';

  toChange++;
  say('  ' + key);
  say('    lit outlines: ' + result.changed + ' in ' + result.colours.join(', ') + ' -> ' + OUTLINE_REST);
  say('    scene rev   : ' + rev(raw) + ' -> ' + rev(body)
    + '  (the print cache key carries this, so the file is rebuilt)');

  /* Everything the master, the listing and the cache would need. */
  const stale = cached.filter((k) => k.includes(rev(raw)));
  say('    re-render   : POST /api/studio-render/' + id + '?style=' + style
    + '  (rebuilds print.png and listing.jpg)');
  say('    stale cached print files to delete: ' + (stale.length || 'none'));
  stale.forEach((k) => say('      ' + k));

  if (DRY) { say('    would write, then re-render.\n'); continue; }

  await studio.set(key, body);
  say('    written.');
  for (const k of stale) { await prints.delete(k); say('    deleted ' + k); }
  if (RENDER) {
    const origin = process.env.CSC_SITE_ORIGIN || 'https://comicstripcanvas.co.uk';
    const res = await fetch(origin + '/api/studio-render/' + encodeURIComponent(id) + '?style=' + style, {
      method: 'POST', headers: { 'X-CSC-Internal-Secret': process.env.CSC_INTERNAL_SECRET },
    });
    say('    re-render asked: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));
  } else {
    say('    re-render NOT asked (pass --render, or press Re-render in the Studio).');
  }
  say('');
}
say('  ' + sceneKeys.length + ' scenes read, ' + clean + ' already black, ' + toChange + ' to change.\n');

/* ───────── personalisations */

say('PERSONALISATION RECORDS\n');
if (!sanityToken) {
  say('  no SANITY_WRITE_TOKEN — not read.\n');
} else {
  const rows = await sanityQuery('*[_type=="pendingPersonalisation"]'
    + '{_id,orderNumber,orderId,status,templateId,printSize,proofUrl,recipe,sceneSvg}', sanityToken);
  let hits = 0;
  for (const r of rows) {
    const lit = sceneFieldsOf(r).flatMap((f) => litOutlines(f[1]));
    if (!lit.length) continue;
    hits++;
    const result = unlightRecord(r);
    const ordered = !!(r.orderNumber || r.orderId);
    say('  ' + r._id + '  [' + r.templateId + ']  status=' + r.status
      + '  order=' + (r.orderNumber || (r.orderId ? '(paid, unnumbered)' : '(none — never bought)')));
    say('    lit outlines: ' + result.changed + ' in ' + result.colours.join(', ') + ' -> ' + OUTLINE_REST);
    say('    rendered proof: ' + (r.proofUrl ? r.proofUrl : 'none — nothing was ever rendered from this scene'));
    const set = {};
    if (result.doc.sceneSvg !== r.sceneSvg) set.sceneSvg = result.doc.sceneSvg;
    if (result.doc.recipe !== r.recipe) set.recipe = result.doc.recipe;
    say('    fields to patch: ' + (Object.keys(set).join(', ') || 'none'));
    if (ordered && !ORDERED) {
      say('    BELONGS TO AN ORDER — left alone. This is the record of what was'
        + ' bought; pass --include-ordered to rewrite it deliberately.\n');
      continue;
    }
    if (DRY || !PENDING) {
      say('    would patch' + (DRY ? '' : ' (pass --pending to include these)')
        + (r.proofUrl ? ', then re-render the proof.' : '; no proof to re-render.') + '\n');
      continue;
    }
    await sanityPatch(r._id, set, sanityToken);
    say('    patched.\n');
  }
  say('  ' + rows.length + ' records read, ' + hits + ' carrying a lit outline.\n');
}

if (DRY) say('Nothing was written. Re-run with --apply (and --render / --pending) to carry it out.');

}
