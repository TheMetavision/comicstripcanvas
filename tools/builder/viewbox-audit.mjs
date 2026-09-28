/**
 * Did any saved scene keep the view zoom instead of the whole sheet?
 *
 *   node --env-file=.env tools/builder/viewbox-audit.mjs
 *
 * THE FAULT. exportSVG cloned the live <svg> and took the exported width and
 * height from it. From the feat/builder-view-zoom deploy until the fix on
 * feat/admin-edit-proof that element carried whatever the VIEW zoom had put
 * there, so a design saved while zoomed in stored the zoomed, panned rectangle
 * as its own viewBox -- a smaller sheet, offset, with the edges of the design
 * outside it. The renderer rasterises the scene it is given, so the print would
 * be that crop.
 *
 * HOW IT IS DETECTED. Not by date. The recipe carries the canvas, the face
 * inches and the wrap, and geom() plus viewBoxFor() are the same functions the
 * builder fits with -- so for every stored scene the correct viewBox can be
 * recomputed and compared with the one actually serialised. A scene whose own
 * numbers disagree with its own recipe is affected whenever it was written.
 * Dates are reported afterwards, as corroboration rather than as the test.
 *
 * The control matters more than usual here: a zoomed scene is the needle, every
 * other scene looks identical to a clean one, and a comparison with a bug in it
 * would report a clean dataset either way. So a real scene is deliberately
 * zoomed and the check has to catch it before any result is believed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(path.join(REPO, 'package.json'));
const { getStore } = require('@netlify/blobs');
const { geom, FIT, viewBoxFor, WRAP } = await import(
  pathToFileURL(path.join(REPO, 'netlify/functions/_shared/print-geometry.mjs')).href);
const { resolveCredentials } = await import(
  pathToFileURL(path.join(REPO, 'tools/builder/render-sweep.mjs')).href);

/* Serialisation rounds, so an exact string comparison would flag every scene.
   A quarter of a canvas unit is far below anything a zoom step produces: the
   smallest step is 1.25x, which moves the width by a fifth of the sheet. */
const TOL = 0.25;

const num = (s) => (s || '').trim().split(/\s+/).map(Number);

/** The four numbers a scene's own root viewBox carries, plus width/height. */
export function rootOf(svg) {
  if (typeof svg !== 'string') return null;
  /* The ROOT element only: a nested <svg> or a <symbol> would otherwise be
     mistaken for it. */
  const m = /<svg\b[^>]*>/i.exec(svg);
  if (!m) return null;
  const tag = m[0];
  const at = (a) => {
    const r = new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
    return r ? r[1] : null;
  };
  const vb = at('viewBox');
  return {
    viewBox: vb, nums: vb ? num(vb) : null,
    width: at('width') ? Number(at('width')) : null,
    height: at('height') ? Number(at('height')) : null,
  };
}

/**
 * What this recipe's scene SHOULD carry, or why it cannot be decided.
 */
export function fitFor(recipe) {
  if (!recipe || typeof recipe !== 'object') return { skip: 'no recipe' };
  const canvas = recipe.canvas;
  const out = recipe.output;
  if (!canvas || !(Number(canvas.width) > 0)) return { skip: 'recipe has no canvas' };
  if (!out || !Array.isArray(out.faceInches)) return { skip: 'recipe has no output size' };
  const fit = FIT[recipe.template];
  if (!fit) return { skip: `unknown template "${recipe.template}"` };
  /* The wrap as the recipe recorded it, cross-checked against the table the
     finish implies -- a disagreement would mean the scene was fitted to numbers
     that no longer describe its finish, which is a different fault and worth
     seeing rather than silently preferring one of them. */
  const wrapRecorded = Number(out.wrapInches) || 0;
  const wrapExpected = WRAP[out.format] ?? null;
  let g;
  try { g = geom(canvas, { w: out.faceInches[0], h: out.faceInches[1] }, fit, wrapRecorded); }
  catch (e) { return { skip: e.message }; }
  return {
    viewBox: viewBoxFor(canvas, g),
    nums: num(viewBoxFor(canvas, g)),
    wrapRecorded,
    wrapMismatch: wrapExpected !== null && Math.abs(wrapExpected - wrapRecorded) > 0.001
      ? `recipe says ${wrapRecorded}in wrap, ${out.format} implies ${wrapExpected}in` : null,
  };
}

/** Compare, and say how far off in terms a person can act on. */
export function verdict(svg, recipe) {
  const root = rootOf(svg);
  const want = fitFor(recipe);
  if (want.skip) return { state: 'unknown', why: want.skip, root };
  if (!root) return { state: 'unknown', why: 'scene has no <svg> root', root };
  if (!root.nums || root.nums.length !== 4 || root.nums.some((n) => !Number.isFinite(n))) {
    return { state: 'unknown', why: `root viewBox is ${JSON.stringify(root.viewBox)}`, root, want };
  }
  const d = root.nums.map((n, i) => n - want.nums[i]);
  const off = d.some((x) => Math.abs(x) > TOL);
  /* The width ratio is the number that says what a customer would actually see:
     0.5 means half the sheet was saved. */
  const shrink = want.nums[2] > 0 ? root.nums[2] / want.nums[2] : null;
  const sizeOff = root.width !== null
    && (Math.abs(root.width - Math.round(want.nums[2])) > 1
      || Math.abs((root.height ?? 0) - Math.round(want.nums[3])) > 1);
  return {
    state: off || sizeOff ? 'AFFECTED' : 'ok',
    root, want, delta: d, shrink, sizeOff,
    why: off
      ? `viewBox ${root.viewBox} vs fit ${want.viewBox}`
      : sizeOff
        ? `width/height ${root.width}x${root.height} vs fit `
          + `${Math.round(want.nums[2])}x${Math.round(want.nums[3])}`
        : null,
    wrapMismatch: want.wrapMismatch,
  };
}

/* ─────────────────────────────────────────────────────── the run */

const out = [];
const say = (t = '') => { out.push(t); console.log(t); };
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function sanityQuery(query, token) {
  const res = await fetch(
    'https://lwbwahym.api.sanity.io/v2021-10-21/data/query/production?query=' + encodeURIComponent(query),
    { headers: { Authorization: 'Bearer ' + token } });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

const { siteID, token } = resolveCredentials();
const sanityToken = process.env.SANITY_WRITE_TOKEN || process.env.SANITY_API_TOKEN || null;
const affected = { pending: [], studio: [] };

/* ───────── 0. the control */
say('\n0. DOES THE CHECK CATCH A ZOOMED SCENE?\n');
{
  /* A cover-shaped scene with honest numbers, then the same one as the bug would
     have saved it: the viewBox the view zoom leaves behind at 200% with a pan. */
  const canvas = { width: 3600, height: 5400 };
  const recipe = {
    template: 'cover', canvas,
    output: { format: 'standard', faceInches: [16, 24], wrapInches: 1.5 },
  };
  const fit = fitFor(recipe);
  const clean = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fit.viewBox}" `
    + `width="${Math.round(fit.nums[2])}" height="${Math.round(fit.nums[3])}"><text>x</text></svg>`;
  const z = fit.nums.map((n, i) => (i < 2 ? n + 400 : n / 2));
  const zoomed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${z.join(' ')}" `
    + `width="${Math.round(z[2])}" height="${Math.round(z[3])}"><text>x</text></svg>`;

  const a = verdict(clean, recipe), b = verdict(zoomed, recipe);
  say(`   a scene saved fitted        -> ${a.state}`);
  say(`   the same scene at 200% + pan -> ${b.state}  ${b.why || ''}`);
  say(`   reported shrink              -> ${b.shrink ? pct(b.shrink) : '—'} of the sheet's width`);
  if (a.state !== 'ok' || b.state !== 'AFFECTED') {
    say('\n   CONTROL FAILED — this audit cannot tell the two apart. Nothing below means anything.');
    process.exit(1);
  }
  say('   control passes: a fitted scene reads ok and a zoomed one is caught.');
}

/* ───────── 1. personalisations */
say('\n1. PENDING PERSONALISATIONS\n');
if (!sanityToken) say('   no SANITY_WRITE_TOKEN — skipped');
else {
  const rows = await sanityQuery('*[_type=="pendingPersonalisation"]{_id,_createdAt,_updatedAt,'
    + 'status,kind,orderNumber,templateId,printSize,outputFormat,recipe,sceneSvg,proofUrl,editCount}'
    + '|order(_createdAt asc)', sanityToken);
  let withScene = 0, unknown = 0;
  const byState = {};
  for (const r of rows) {
    if (typeof r.sceneSvg !== 'string' || !r.sceneSvg.trim()) continue;
    withScene++;
    let recipe = null;
    try { recipe = r.recipe ? JSON.parse(r.recipe) : null; } catch { /* reported as unknown */ }
    const v = verdict(r.sceneSvg, recipe);
    byState[v.state] = (byState[v.state] || 0) + 1;
    if (v.state === 'unknown') { unknown++; say(`   ? ${r._id} — ${v.why}`); }
    if (v.state === 'AFFECTED') affected.pending.push({ ...r, v });
  }
  say(`   ${rows.length} records, ${withScene} carrying a scene`);
  say(`   ${JSON.stringify(byState)}`);
  say(`   AFFECTED: ${affected.pending.length}`);
  for (const a of affected.pending) {
    say(`     ${a._id}  order=${a.orderNumber || '(none)'}  status=${a.status}`
      + `  ${a.kind === 'customise' ? 'customise' : 'personalised'}  saved ${a._updatedAt}`);
    say(`       ${a.v.why}`);
    if (a.v.shrink) say(`       keeps ${pct(a.v.shrink)} of the sheet's width`);
  }
}

/* ───────── 2. studio scenes */
say('\n2. STUDIO SCENES IN BLOBS\n');
if (!siteID || !token) say('   no Netlify credentials — skipped');
else {
  const studio = getStore({ name: 'studio', siteID, token, consistency: 'strong' });
  const { blobs } = await studio.list();
  const keys = blobs.map((b) => b.key).filter((k) => /scene\.(json|svg)$/.test(k));
  const byState = {};
  let read = 0;
  for (const key of keys) {
    const raw = await studio.get(key, { type: 'text' }).catch(() => null);
    if (raw == null) { say(`   ! unreadable: ${key}`); continue; }
    read++;
    let scene = null;
    if (/\.json$/.test(key)) { try { scene = JSON.parse(raw); } catch { /* below */ } }
    const svg = scene ? (scene.svg || scene.recipe?.svg) : raw;
    const recipe = scene ? (scene.recipe || scene) : null;
    const v = verdict(svg, recipe);
    byState[v.state] = (byState[v.state] || 0) + 1;
    if (v.state === 'unknown') say(`   ? ${key} — ${v.why}`);
    if (v.state === 'AFFECTED') affected.studio.push({ key, v, savedAt: scene?.savedAt || null });
  }
  say(`   ${read} scenes read`);
  say(`   ${JSON.stringify(byState)}`);
  say(`   AFFECTED: ${affected.studio.length}`);
  for (const a of affected.studio) {
    say(`     ${a.key}  saved ${a.savedAt || '(unknown)'}`);
    say(`       ${a.v.why}`);
    if (a.v.shrink) say(`       keeps ${pct(a.v.shrink)} of the sheet's width`);
  }
}

/* ───────── 3. what was rendered from anything affected */
say('\n3. RENDERS AND CACHED PRINT FILES\n');
if (!siteID || !token) say('   no Netlify credentials — skipped');
else {
  const ids = new Set(affected.pending.map((a) => a._id));
  const studioIds = new Set(affected.studio.map((a) => (/^studio\/([^/]+)\//.exec(a.key) || [])[1]));
  for (const [name, match] of [
    ['renders', (k) => [...ids].some((id) => k.includes(id))],
    ['order-prints', (k) => [...ids, ...studioIds].some((id) => id && k.includes(id))],
  ]) {
    try {
      const store = getStore({ name, siteID, token, consistency: 'strong' });
      const { blobs } = await store.list();
      const hits = blobs.map((b) => b.key).filter(match);
      say(`   ${name}: ${blobs.length} object(s), ${hits.length} made from an affected scene`);
      hits.forEach((k) => say(`     ${k}`));
    } catch (e) { say(`   ${name}: unavailable (${e.message})`); }
  }
  /* And the studio's own outputs, which are per scene id. */
  if (studioIds.size) {
    const studio = getStore({ name: 'studio', siteID, token, consistency: 'strong' });
    const { blobs } = await studio.list();
    const hits = blobs.map((b) => b.key)
      .filter((k) => /(print|listing|print-prev)\.(png|jpg)$/.test(k)
        && [...studioIds].some((id) => id && k.startsWith(`studio/${id}/`)));
    say(`   studio outputs from affected scenes: ${hits.length}`);
    hits.forEach((k) => say(`     ${k}`));
  } else {
    say('   studio outputs from affected scenes: 0 (no affected studio scene)');
  }
}

say('\nSUMMARY\n');
say(`   personalisations with a non-fit viewBox: ${affected.pending.length}`);
say(`   studio scenes with a non-fit viewBox:    ${affected.studio.length}`);

const report = path.join(REPO, 'tools/builder/print-out/_review/viewbox-audit.txt');
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(report, out.join('\n') + '\n', 'utf8');
say(`\n   written to ${path.relative(REPO, report)}`);
