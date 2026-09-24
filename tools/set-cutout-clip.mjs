/**
 * Say, in the scene itself, where the Classic cut-out is allowed to stop.
 *
 *   node tools/set-cutout-clip.mjs --dry-run          read, decide, print, do nothing
 *   node tools/set-cutout-clip.mjs --apply            write the scenes
 *   node tools/set-cutout-clip.mjs --apply --render   ...and re-render the masters
 *
 * WHY
 * ---
 * The Classic cover's cut-out is clipped to the whole page, and on a canvas the
 * page includes the wrap -- so a figure that runs past the front face prints
 * down the SIDES of the frame. Whether that happens has, until now, depended on
 * which finish happened to be selected when Save was pressed, because the clip
 * rect was written at that moment and stored. Every scene in the store was
 * saved at poster, where the page and the face are the same box, so they all
 * trim at the face by luck rather than by decision.
 *
 * cutoutClip records the decision. This script writes it, per edge, on the
 * scenes named below, and marks the stored clip rect so the print path
 * recomputes it for whatever finish is ordered instead of carrying the poster
 * one around.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not move anything. All-"face" on a scene saved at poster resolves to
 * the rect already stored, so the printed pixels are identical either way --
 * the dry run says so per scene, and refuses to pretend otherwise. What changes
 * is that the next finish change stops being a coin toss.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const REPO = path.resolve(new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(path.join(REPO, 'package.json'));
const { getStore } = require('@netlify/blobs');

const {
  geom, FIT, CLIP_EDGES, CLIP_TO_FACE, clipAll, cutoutClipRect, normaliseCutoutClip,
} = await import(pathToFileURL(path.join(REPO, 'netlify/functions/_shared/print-geometry.mjs')).href);
const { resolveCredentials } = await import(pathToFileURL(path.join(REPO, 'tools/builder/render-sweep.mjs')).href);

/* The Classic scenes whose cut-out can reach the wrap. Bobby Moore is still a
   draft; its scene is in the store like any other and is migrated with them, so
   that publishing it later does not quietly reintroduce the old behaviour. */
const TARGETS = [
  { name: 'bruce-lee-cover', sceneId: '6CCGmCKjYTHK2Kwkqfatyy' },
  { name: 'walter-white', sceneId: 'studio-c1bcb873045c3da74c2a61da' },
  { name: 'bobby-moore (draft)', sceneId: 'Kd7ExLzuz7PhOLkJ1Ci5qE' },
];
const WANT = clipAll(CLIP_TO_FACE);
const STYLE = 'classic';

const has = (f) => process.argv.includes(f);
const DRY = has('--dry-run') || !has('--apply');
const RENDER = has('--render');
const say = console.log.bind(console);

if (!DRY && !process.env.CSC_INTERNAL_SECRET && RENDER) {
  say('--render needs CSC_INTERNAL_SECRET in the environment.');
  process.exit(2);
}

const { siteID, token } = resolveCredentials();
const studio = getStore({ name: 'studio', siteID, token, consistency: 'strong' });
const sceneKey = (id) => `studio/${id}/${STYLE}/scene.json`;
const legacyKey = (id) => `studio/${id}/scene.json`;

const rectOf = (svg) => {
  const tag = /<clipPath id="clip-art">\s*(<rect[^>]*>)/.exec(svg)?.[1];
  if (!tag) return null;
  const at = (a) => Number(new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1]);
  return { tag, x: at('x'), y: at('y'), width: at('width'), height: at('height') };
};
const round2 = (n) => Math.round(n * 100) / 100;
const show = (r) => (r ? `${round2(r.x)},${round2(r.y)} ${round2(r.width)}x${round2(r.height)}` : 'none');

/** Mark the clip rect and record the per-edge choice on it. */
function markClip(svg, clip, rect) {
  return svg.replace(/<clipPath id="clip-art">\s*<rect([^>]*?)\/?>/, (m, attrs) => {
    let a = attrs.replace(/\s*data-(role|clip-(?:top|right|bottom|left))="[^"]*"/g, '');
    for (const [k, v] of [['x', rect.x], ['y', rect.y], ['width', rect.width], ['height', rect.height]]) {
      a = new RegExp(`\\b${k}\\s*=\\s*"[^"]*"`).test(a)
        ? a.replace(new RegExp(`\\b${k}\\s*=\\s*"[^"]*"`), `${k}="${round2(v)}"`)
        : `${a} ${k}="${round2(v)}"`;
    }
    const marks = CLIP_EDGES.map((e) => ` data-clip-${e}="${clip[e]}"`).join('');
    return `<clipPath id="clip-art"><rect data-role="cutout-clip"${marks}${a}/>`;
  });
}

say(DRY ? '\nDRY RUN — reading only, nothing is written.\n'
  : `\nAPPLYING to ${TARGETS.length} scene(s)${RENDER ? ', then re-rendering' : ' (no re-render)'}.\n`);

let changed = 0, skipped = 0, missing = 0;

for (const t of TARGETS) {
  const key = sceneKey(t.sceneId);
  const raw = await studio.get(key) || await studio.get(legacyKey(t.sceneId));
  if (!raw) {
    say(`${t.name}\n  NOT FOUND at ${key} — nothing to migrate, and nothing assumed.\n`);
    missing++; continue;
  }
  const scene = JSON.parse(raw);
  const recipe = scene.recipe || scene;
  const svg = scene.svg || recipe.svg;
  const C = recipe.canvas;
  const out = recipe.output || {};
  const g = geom(C, { w: out.faceInches?.[0], h: out.faceInches?.[1] }, FIT.cover, out.wrapInches || 0);

  const now = rectOf(svg);
  const want = cutoutClipRect(C, g, WANT);
  const already = normaliseCutoutClip(recipe.cutoutClip);
  const marked = /data-role="cutout-clip"/.test(svg);
  const moves = !now || ['x', 'y', 'width', 'height'].some((k) => Math.abs(now[k] - want[k]) > 0.01);

  say(`${t.name}  (${t.sceneId})`);
  say(`  saved at ${out.format || 'poster'} ${(out.faceInches || []).join('x')}in`
    + `${out.wrapInches ? `, ${out.wrapInches}in wrap` : ''}`);
  say(`  clip now      ${show(now)}${marked ? '  [already marked]' : ''}`);
  say(`  clip after    ${show(want)}   all four edges "${CLIP_TO_FACE}"`);
  say(`  printed pixels ${moves ? 'WOULD MOVE — look at this one before applying' : 'unchanged'}`);

  if (already && CLIP_EDGES.every((e) => already[e] === WANT[e]) && marked) {
    say('  already migrated — skipping.\n');
    skipped++; continue;
  }

  const nextScene = { ...scene };
  const nextRecipe = { ...(scene.recipe || scene), cutoutClip: { ...WANT } };
  if (scene.recipe) nextScene.recipe = nextRecipe; else Object.assign(nextScene, nextRecipe);
  const nextSvg = markClip(svg, WANT, want);
  if (nextSvg === svg) {
    say('  COULD NOT MARK the clip rect — the scene has no <clipPath id="clip-art">. Left alone.\n');
    missing++; continue;
  }
  if (scene.svg) nextScene.svg = nextSvg; else nextScene.recipe.svg = nextSvg;

  const body = JSON.stringify(nextScene);
  const rev = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  say(`  scene rev     ${rev(raw)} -> ${rev(body)}  (the print cache key follows this,`
    + ` so the file is rebuilt rather than served from before)`);

  if (DRY) { say('  would write, then re-render the Classic master.\n'); changed++; continue; }

  await studio.set(key, body);
  say('  written.');
  if (RENDER) {
    const origin = process.env.CSC_SITE_ORIGIN || 'https://comicstripcanvas.co.uk';
    const res = await fetch(`${origin}/api/studio-render/${encodeURIComponent(t.sceneId)}?style=${STYLE}`, {
      method: 'POST',
      headers: { 'X-CSC-Internal-Secret': process.env.CSC_INTERNAL_SECRET },
    });
    say(`  re-render asked: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  } else {
    say('  re-render NOT asked (pass --render, or press Re-render in the Studio).');
  }
  say('');
  changed++;
}

say(`${changed} to change, ${skipped} already done, ${missing} not migrated.`);
if (DRY) say('\nNothing was written. Re-run with --apply (and --render) to carry it out.');
