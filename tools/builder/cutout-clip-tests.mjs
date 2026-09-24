/**
 * How much of the wrap the Classic cover's cut-out may use.
 *
 *   node tools/builder/cutout-clip-tests.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A canvas wraps the picture round the stretcher bars. The Classic cover's
 * cut-out is clipped to the whole page rather than the art window -- running a
 * figure off the page is the effect the template is imitating -- and the whole
 * page includes the wrap, so the part beyond the front face prints down the
 * SIDES of the frame.
 *
 * Whether that happened turned out to depend on which finish was selected when
 * Save was pressed, which is not a decision anybody made. Every stored Classic
 * scene was saved at poster, where the page and the face are the same box, so
 * their prints trim at the face by coincidence; save the same design with a
 * canvas finish chosen and the figure bleeds. cutoutClip replaces the
 * coincidence with a setting.
 *
 * The rendering assertions below are the point of the file. They render each
 * scene TWICE -- with the cutout and without it -- and diff the wrap band, so
 * "is the figure in the wrap" is measured rather than inferred from colours.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(path.join(ROOT, 'package.json'));
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');

import {
  geom, FIT, reprojectScene, CLIP_EDGES, CLIP_TO_FACE, CLIP_TO_WRAP,
  clipAll, normaliseCutoutClip, cutoutClipRect, faceBox, pageBox,
} from '../../netlify/functions/_shared/print-geometry.mjs';
import { faceFor } from '../../netlify/functions/_shared/print-file.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const CANVAS = { width: 4200, height: 5800, dpi: 200 };     // TEMPLATES.cover
const POSTER = geom(CANVAS, faceFor('large', 'portrait'), FIT.cover, 0);
const GALLERY = geom(CANVAS, faceFor('large', 'portrait'), FIT.cover, 2.5);

/* ─────────────────────────────────────────── the setting itself */

say('\n1. READING THE SETTING\n');
{
  ok(normaliseCutoutClip(undefined) === null, 'absent is null, not a default');
  ok(normaliseCutoutClip(null) === null, 'and so is null');
  ok(normaliseCutoutClip({}) === null, 'an object naming no edge is still absent');
  ok(normaliseCutoutClip({ top: 'nonsense' }) === null,
    'and so is one naming only rubbish');

  const partial = normaliseCutoutClip({ bottom: CLIP_TO_WRAP });
  ok(partial && partial.bottom === CLIP_TO_WRAP, 'an edge that was set is kept');
  ok(partial && CLIP_EDGES.filter((e) => e !== 'bottom').every((e) => partial[e] === CLIP_TO_FACE),
    'and the edges nobody set take the safe answer, not the bleeding one');

  const all = clipAll(CLIP_TO_WRAP);
  ok(CLIP_EDGES.every((e) => all[e] === CLIP_TO_WRAP), 'clipAll sets every edge');
  ok(normaliseCutoutClip(all) !== null,
    'all-wrap is a REAL setting, distinct from absent — one recomputes, the other never touches anything');
}

/* ─────────────────────────────────────────── the rect it produces */

say('\n2. THE RECT, EDGE BY EDGE\n');
{
  const face = faceBox(CANVAS, GALLERY), page = pageBox(CANVAS, GALLERY);
  ok(page.left < face.left && page.top < face.top
    && page.right > face.right && page.bottom > face.bottom,
  'at gallery the page is outside the face on all four edges',
  `face L${face.left.toFixed(0)} page L${page.left.toFixed(0)}`);

  const allFace = cutoutClipRect(CANVAS, GALLERY, clipAll(CLIP_TO_FACE));
  ok(Math.abs(allFace.x - face.left) < 0.01
    && Math.abs(allFace.x + allFace.width - face.right) < 0.01,
  'all "face" gives exactly the face');

  const allWrap = cutoutClipRect(CANVAS, GALLERY, clipAll(CLIP_TO_WRAP));
  ok(Math.abs(allWrap.x - page.left) < 0.01
    && Math.abs(allWrap.y + allWrap.height - page.bottom) < 0.01,
  'all "wrap" gives exactly the page');

  const mixed = cutoutClipRect(CANVAS, GALLERY, {
    top: CLIP_TO_FACE, right: CLIP_TO_FACE, bottom: CLIP_TO_WRAP, left: CLIP_TO_FACE,
  });
  ok(Math.abs(mixed.y - face.top) < 0.01, 'mixed: the top stops at the face');
  ok(Math.abs(mixed.y + mixed.height - page.bottom) < 0.01,
    'and the bottom carries on to the page');
  ok(Math.abs(mixed.x - face.left) < 0.01 && Math.abs(mixed.x + mixed.width - face.right) < 0.01,
    'with the sides untouched');

  /* A poster has no wrap, so the two boxes coincide and the setting is inert.
     That is why every stored scene, all saved at poster, is face-clipped. */
  const pFace = cutoutClipRect(CANVAS, POSTER, clipAll(CLIP_TO_FACE));
  const pWrap = cutoutClipRect(CANVAS, POSTER, clipAll(CLIP_TO_WRAP));
  ok(JSON.stringify(pFace) === JSON.stringify(pWrap),
    'on a poster "face" and "wrap" are the same box — there is no wrap to reach');
}

/* ─────────────────────────────────── re-projection: recompute, never scale */

say('\n3. RE-PROJECTION RECOMPUTES IT\n');

const clipRectOf = (svg) => {
  const m = /<rect\b[^>]*\bdata-role="cutout-clip"[^>]*>/.exec(svg)
    || /<clipPath id="clip-art">\s*(<rect[^>]*>)/.exec(svg)?.slice(1);
  const tag = Array.isArray(m) ? m[0] : m;
  if (!tag) return null;
  const at = (a) => Number(new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`).exec(tag)[1]);
  return { x: at('x'), y: at('y'), width: at('width'), height: at('height') };
};

const sceneWith = ({ clip, markers = true, cutoutBox, savedGeom }) => {
  const rect = clip
    ? cutoutClipRect(CANVAS, savedGeom, clip)
    : { x: -savedGeom.dx, y: -savedGeom.dy, width: CANVAS.width + 2 * savedGeom.dx, height: CANVAS.height + 2 * savedGeom.dy };
  const data = markers && clip
    ? CLIP_EDGES.map((e) => ` data-clip-${e}="${clip[e]}"`).join('') + ' data-role="cutout-clip"'
    : '';
  const b = cutoutBox;
  return '<svg xmlns="http://www.w3.org/2000/svg" '
    + `viewBox="${-savedGeom.dx} ${-savedGeom.dy} ${CANVAS.width + 2 * savedGeom.dx} ${CANVAS.height + 2 * savedGeom.dy}" `
    + `width="${Math.round(CANVAS.width + 2 * savedGeom.dx)}" height="${Math.round(CANVAS.height + 2 * savedGeom.dy)}">`
    + `<rect data-role="bg-colour" x="${-savedGeom.ex}" y="${-savedGeom.ey}" `
    + `width="${CANVAS.width + 2 * savedGeom.ex}" height="${CANVAS.height + 2 * savedGeom.ey}" fill="#1f7a68"/>`
    + `<defs><clipPath id="clip-art"><rect${data} x="${rect.x}" y="${rect.y}" `
    + `width="${rect.width}" height="${rect.height}"/></clipPath></defs>`
    + '<g clip-path="url(#clip-art)">'
    + `<image data-role="panel" data-panel="art" preserveAspectRatio="none" href="{{IMAGE:art}}" `
    + `x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}"/></g></svg>`;
};

/* A cutout that overruns every face edge, so each edge has something to trim. */
const OVERRUN = (() => {
  const f = faceBox(CANVAS, GALLERY);
  const pad = 500;
  return { x: f.left - pad, y: f.top - pad, width: (f.right - f.left) + 2 * pad, height: (f.bottom - f.top) + 2 * pad };
})();

{
  /* Saved at GALLERY with all "face": the print must land on the face box of
     the finish being PRINTED, not the one it was saved at. */
  const svg = sceneWith({ clip: clipAll(CLIP_TO_FACE), cutoutBox: OVERRUN, savedGeom: GALLERY });
  const toPoster = reprojectScene(svg, CANVAS, GALLERY, POSTER);
  const want = cutoutClipRect(CANVAS, POSTER, clipAll(CLIP_TO_FACE));
  const got = clipRectOf(toPoster.svg);
  ok(Math.abs(got.x - want.x) < 0.02 && Math.abs(got.width - want.width) < 0.02,
    'gallery → poster recomputes to the poster face', `${got.x.toFixed(1)} vs ${want.x.toFixed(1)}`);
  ok(toPoster.changed.includes('cutout-clip'), 'and says it did so');

  /* The dependence this removes: saved at poster, printed at gallery. */
  const savedPoster = sceneWith({ clip: clipAll(CLIP_TO_FACE), cutoutBox: OVERRUN, savedGeom: POSTER });
  const toGallery = reprojectScene(savedPoster, CANVAS, POSTER, GALLERY).svg;
  const wantG = cutoutClipRect(CANVAS, GALLERY, clipAll(CLIP_TO_FACE));
  const gotG = clipRectOf(toGallery);
  ok(Math.abs(gotG.x - wantG.x) < 0.02, 'poster → gallery recomputes to the gallery face');

  const wrapScene = sceneWith({ clip: clipAll(CLIP_TO_WRAP), cutoutBox: OVERRUN, savedGeom: POSTER });
  const wrapOut = clipRectOf(reprojectScene(wrapScene, CANVAS, POSTER, GALLERY).svg);
  const wantW = cutoutClipRect(CANVAS, GALLERY, clipAll(CLIP_TO_WRAP));
  ok(Math.abs(wrapOut.x - wantW.x) < 0.02 && Math.abs(wrapOut.width - wantW.width) < 0.02,
    'all "wrap" recomputes to the gallery PAGE', `${wrapOut.width.toFixed(0)} vs ${wantW.width.toFixed(0)}`);
}

say('\n4. A SCENE WITHOUT THE FIELD IS NOT TOUCHED\n');
{
  /* The promise behind "absent": every Classic scene in the store predates this
     field, and their prints must not move by a pixel until somebody sets it. */
  const svg = sceneWith({ clip: null, markers: false, cutoutBox: OVERRUN, savedGeom: POSTER });
  const before = clipRectOf(svg);
  const after = clipRectOf(reprojectScene(svg, CANVAS, POSTER, GALLERY).svg);
  ok(JSON.stringify(before) === JSON.stringify(after),
    'the clip rect comes out exactly as it went in',
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  ok(!reprojectScene(svg, CANVAS, POSTER, GALLERY).changed.includes('cutout-clip'),
    'and re-projection does not claim to have moved it');
}

/* ───────────────────────────────────────────────── rendered, per edge */

say('\n5. RENDERED: WHAT REACHES THE WRAP\n');

const RED = 'data:image/png;base64,' + (await sharp({
  create: { width: 64, height: 64, channels: 4, background: { r: 220, g: 30, b: 40, alpha: 1 } },
}).png().toBuffer()).toString('base64');

async function figureInWrap(clip) {
  const saved = sceneWith({ clip, cutoutBox: OVERRUN, savedGeom: POSTER });
  const { svg } = reprojectScene(saved, CANVAS, POSTER, GALLERY);
  const W = 1050;                                    // 21 in wide sheet, 50 px/in
  const raster = (s) => new Resvg(s, { fitTo: { mode: 'width', value: W }, background: '#FFFFFF' })
    .render().asPng();
  const withCut = await sharp(raster(svg.replace('{{IMAGE:art}}', RED))).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const without = await sharp(raster(svg.replace('{{IMAGE:art}}', ''))).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const w = withCut.info.width, h = withCut.info.height, ch = withCut.info.channels;
  const band = Math.round(2.5 * (W / 21));
  const e = { left: 0, top: 0, right: 0, bottom: 0 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= band && x < w - band && y >= band && y < h - band) continue;
    const i = (y * w + x) * ch;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(withCut.data[i + k] - without.data[i + k]));
    if (d > 12) {
      if (x < band) e.left++; else if (x >= w - band) e.right++;
      else if (y < band) e.top++; else e.bottom++;
    }
  }
  return { ...e, total: e.left + e.top + e.right + e.bottom };
}

{
  const allFace = await figureInWrap(clipAll(CLIP_TO_FACE));
  ok(allFace.total === 0, 'all "face": NO cutout pixel is in the wrap',
    `L${allFace.left} T${allFace.top} R${allFace.right} B${allFace.bottom}`);

  const allWrap = await figureInWrap(clipAll(CLIP_TO_WRAP));
  ok(allWrap.left > 0 && allWrap.top > 0 && allWrap.right > 0 && allWrap.bottom > 0,
    'all "wrap": the figure reaches the wrap on every edge',
    `L${allWrap.left} T${allWrap.top} R${allWrap.right} B${allWrap.bottom}`);

  const mixed = await figureInWrap({
    top: CLIP_TO_FACE, right: CLIP_TO_FACE, bottom: CLIP_TO_WRAP, left: CLIP_TO_FACE,
  });
  ok(mixed.bottom > 0, 'mixed: the bottom bleeds, which is the effect worth keeping',
    `B${mixed.bottom}`);
  ok(mixed.top === 0 && mixed.left === 0 && mixed.right === 0,
    'and the other three are trimmed',
    `L${mixed.left} T${mixed.top} R${mixed.right}`);
}

/* ────────────────────────────────── the cached file must not be reused */

say('\n6. SETTING IT INVALIDATES THE CACHED PRINT\n');
{
  /* order-print-file names the finished file after what it was made from, and
     for a scene that is a hash of the scene's own bytes. So the question is
     only whether setting the field changes those bytes -- if it did not, an
     order re-rendered after the migration would hand back the file made
     before it. */
  const { createHash } = await import('node:crypto');
  const { sourceId, printKeyFor } = await import('../../netlify/functions/_shared/order-print.mjs');
  const rev = (json) => createHash('sha256').update(json).digest('hex').slice(0, 16);

  const before = JSON.stringify({ recipe: { template: 'cover' }, svg: sceneWith({ clip: null, markers: false, cutoutBox: OVERRUN, savedGeom: POSTER }) });
  const after = JSON.stringify({ recipe: { template: 'cover', cutoutClip: clipAll(CLIP_TO_FACE) }, svg: sceneWith({ clip: clipAll(CLIP_TO_FACE), cutoutBox: OVERRUN, savedGeom: POSTER }) });

  const keyFor = (json) => printKeyFor({
    orderId: 'CSC-1003', lineKey: 'li_1', sizeKey: 'large', finish: 'gallery',
    style: 'classic', source: sourceId({ sceneRev: rev(json) }),
  });
  ok(rev(before) !== rev(after), 'the scene hashes differently once the field is set');
  ok(keyFor(before) !== keyFor(after),
    'so the print lands under a different key and is rebuilt, not served from cache');
  ok(keyFor(before) === keyFor(before), 'and an unchanged scene keeps its key');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
