/**
 * The cover border: the markup rules, and the colours actually reaching print.
 *
 *   node tools/builder/cover-border-tests.mjs
 *
 * Two halves, and the second is the one that matters.
 *
 * The first is strings in, strings out -- palette resolution and the markup
 * shape -- and needs nothing but the module.
 *
 * The second RASTERISES. That is deliberate and is the test this file exists
 * for. The bug it pins had nothing to do with markup being wrong: the recipe
 * recorded the customer's colours, the preview showed them, and the renderer
 * resolved {{BACKGROUND}} to the original un-recoloured artwork and printed
 * that instead. Every string-level assertion in the world would have passed
 * while the press produced the wrong picture. The only assertion that catches
 * it is reading the pixels of the finished raster and finding the colour that
 * was asked for.
 */
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import fs from 'node:fs';
import {
  COVER_PALETTE, coverPaletteList, resolvePalette, isDefaultPalette,
  borderMarkup, findBackgroundImage, replaceBackgroundWithBorder,
} from '../../src/scripts/cover-border.js';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const MASK_DIR = 'public/builder/templates/cover-border';
const dataUri = (f) => 'data:image/png;base64,' + fs.readFileSync(`${MASK_DIR}/${f}`).toString('base64');

/* ------------------------------------------------- 1. the palette itself */

say('\n1. THE PALETTE, STATED ONCE\n');
{
  ok(coverPaletteList().length === 3, 'three colours: line, and one per region');
  ok(isDefaultPalette(coverPaletteList()), 'the default palette is the default palette');
  ok(isDefaultPalette(null), 'and nothing at all means the default, not a blank border');

  const p = resolvePalette(['#ff0000']);
  ok(p.line === '#ff0000', 'a chosen colour is used');
  ok(p.regionA === COVER_PALETTE.regionA && p.regionB === COVER_PALETTE.regionB,
    'and the ones not chosen fall back rather than coming out undefined');

  ok(resolvePalette(['nonsense', '#00ff00']).line === COVER_PALETTE.line,
    'a value that is not a colour is refused, not rendered');
  ok(!isDefaultPalette(['#101010', '#5c3091', '#76766f']),
    'a customer palette is recognised as not the default');
}

/* --------------------------------------------- 2. finding what to replace */

say('\n2. FINDING THE BACKGROUND IN A SCENE\n');
{
  const scene = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4200 5800">`
    + `<image href="{{BACKGROUND}}" x="-10" y="-20" width="4220" height="5840" preserveAspectRatio="none" data-role="background"/>`
    + `<rect x="0" y="0" width="10" height="10"/></svg>`;
  const f = findBackgroundImage(scene);
  ok(f && f.x === -10 && f.y === -20, 'geometry is read off the element, negatives and all',
    f ? `${f.x},${f.y}` : 'not found');
  ok(f && f.width === 4220 && f.height === 5840, 'including the padding for wrap');

  /* Attribute order is the serialiser's business, not ours. */
  const reordered = `<svg><image data-role="background" width="100" height="200" x="1" y="2" href="{{BACKGROUND}}"/></svg>`;
  const g = findBackgroundImage(reordered);
  ok(g && g.width === 100 && g.y === 2, 'attribute order does not matter', JSON.stringify(g && [g.x, g.y, g.width, g.height]));

  ok(findBackgroundImage('<svg><rect/></svg>') === null, 'a scene with no background is not a crash');
  const fullBleed = replaceBackgroundWithBorder('<svg><rect/></svg>', { colours: null, masks: {} });
  ok(fullBleed.replaced === false && fullBleed.svg === '<svg><rect/></svg>',
    'a full-bleed cover has no background and is returned untouched');
}

/* --------------------------------------------------- 3. the markup shape */

say('\n3. THE MARKUP\n');
{
  const m = borderMarkup({
    x: 0, y: 0, width: 10, height: 20,
    colours: ['#111111', '#222222', '#333333'],
    masks: { line: 'L.png', regionB: 'B.png' },
  });
  ok(/fill="#222222"/.test(m), 'region A is the base fill');
  ok(/fill="#333333"[^>]*mask="url\(#cscBorderB\)"/.test(m), 'region B is masked over it');
  ok(/fill="#111111"[^>]*mask="url\(#cscBorderL\)"/.test(m), 'and the line work over both');
  ok(m.indexOf('#222222') < m.indexOf('#333333') && m.indexOf('#333333') < m.indexOf('#111111'),
    'in that order, because the last one drawn is the one on top');

  const two = borderMarkup({ x: 0, y: 0, width: 1, height: 1, colours: null, masks: { line: 'L', regionB: 'B' }, idSuffix: '2' });
  ok(/id="cscBorderB2"/.test(two), 'ids can be suffixed so two borders cannot collide');
}

/* ------------------------- 4. the pixels that actually come off the press */

say('\n4. WHAT REACHES THE PRINT MASTER\n');
if (!fs.existsSync(`${MASK_DIR}/line.png`)) {
  say('  SKIPPED — masks not generated; run tools/builder/extract-border-layers.mjs');
} else {
  const masks = { line: dataUri('line.png'), regionB: dataUri('region-b.png') };

  /* A scene shaped like the real one, rasterised the way the renderer does. */
  const W = 420, H = 580;
  const sceneFor = (colours) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
      + `<image href="{{BACKGROUND}}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" data-role="background"/>`
      + `</svg>`;
    const out = replaceBackgroundWithBorder(svg, { colours, masks });
    if (!out.replaced) throw new Error('the background was not replaced');
    return out.svg;
  };
  const raster = async (colours) => {
    const png = new Resvg(sceneFor(colours), { fitTo: { mode: 'width', value: W }, background: '#ffffff' }).render().asPng();
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    return { data, w: info.width, h: info.height, ch: info.channels };
  };
  /* How much of the frame is within reach of a colour. Counting rather than
     sampling one pixel: a single coordinate could land on an edge blend and
     prove nothing either way. */
  const share = (img, hex) => {
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let n = 0;
    for (let i = 0; i < img.w * img.h; i++) {
      const j = i * img.ch;
      if (Math.abs(img.data[j] - want[0]) <= 6
        && Math.abs(img.data[j + 1] - want[1]) <= 6
        && Math.abs(img.data[j + 2] - want[2]) <= 6) n++;
    }
    return n / (img.w * img.h);
  };

  const def = await raster(null);
  ok(share(def, COVER_PALETTE.regionA) > 0.2, 'by default region A prints in the artwork\'s own green',
    (100 * share(def, COVER_PALETTE.regionA)).toFixed(1) + '%');
  ok(share(def, COVER_PALETTE.regionB) > 0.2, 'and region B in its yellow',
    (100 * share(def, COVER_PALETTE.regionB)).toFixed(1) + '%');

  /* THE ONE. A recipe asking for purple and grey must print purple and grey. */
  const CHOSEN = ['#101010', '#5c3091', '#76766f'];
  const cust = await raster(CHOSEN);
  const purple = share(cust, '#5c3091'), grey = share(cust, '#76766f');
  ok(purple > 0.2, 'a recipe asking for purple prints PURPLE, not the artwork\'s green',
    (100 * purple).toFixed(1) + '%');
  ok(grey > 0.2, 'and the second region prints the grey it asked for',
    (100 * grey).toFixed(1) + '%');
  ok(share(cust, COVER_PALETTE.regionA) < 0.01 && share(cust, COVER_PALETTE.regionB) < 0.01,
    'with none of the default palette left anywhere in the frame — this is the assertion that '
    + 'would have caught the renderer printing the un-recoloured asset',
    `green ${(100 * share(cust, COVER_PALETTE.regionA)).toFixed(2)}%, yellow ${(100 * share(cust, COVER_PALETTE.regionB)).toFixed(2)}%`);

  /* And the fringe: no pixel may be a colour that is not on a line between two
     of the three chosen ones. That is what a flattened recolour cannot promise. */
  const want = [CHOSEN[0], CHOSEN[1], CHOSEN[2]].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const legal = [];
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      for (let t = 0; t <= 24; t++) {
        const k = t / 24;
        legal.push(want[a].map((v, c) => v + (want[b][c] - v) * k));
      }
    }
  }
  let foreign = 0;
  for (let i = 0; i < cust.w * cust.h; i++) {
    const j = i * cust.ch;
    let best = 1e9;
    for (const c of legal) {
      const d = (cust.data[j] - c[0]) ** 2 + (cust.data[j + 1] - c[1]) ** 2 + (cust.data[j + 2] - c[2]) ** 2;
      if (d < best) best = d;
    }
    if (best > 900) foreign++;
  }
  const pct = 100 * foreign / (cust.w * cust.h);
  ok(pct < 0.05, 'and no pixel is a colour the palette cannot explain — no fringe',
    pct.toFixed(3) + '% unexplained');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
