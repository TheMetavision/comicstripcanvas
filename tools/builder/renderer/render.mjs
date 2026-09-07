#!/usr/bin/env node
/**
 * Comic Strip Canvas — print renderer
 *
 *   node render.mjs --recipe recipe.json --images ./uploads --out print.png
 *   node render.mjs --recipe recipe.json --preview            (proof mode)
 *
 * The recipe carries the exact SVG the customer approved, with every asset
 * replaced by a token. This script swaps the tokens for full-resolution files
 * and rasterises that same document — so the print file cannot disagree with
 * the proof, because it IS the proof.
 *
 *   {{IMAGE:panel-01}}  the customer's photo for that panel
 *   {{OVERLAY}}         template line art / furniture
 *   {{BACKGROUND}}      template background artwork
 *   {{LOGO}}            publisher logo
 */
import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const RECIPE = path.resolve(arg('--recipe', './recipe.json'));
const IMAGES = path.resolve(arg('--images', './images'));
const ASSETS = path.resolve(arg('--assets', path.join(HERE, 'assets')));
const FONTS = path.resolve(arg('--fonts', path.join(HERE, '_fonts')));
const OUT = path.resolve(arg('--out', './print.png'));
const PREVIEW = process.argv.includes('--preview');

const recipe = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
if (!recipe.svg) {
  console.error('This recipe has no scene attached. Re-export it from a builder ' +
                'version that includes the svg field.');
  process.exit(1);
}

/* ---------------------------------------------------------------- assets --- */
const dataUri = (file) => {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
             : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
};

const findImage = (name) => {
  if (!name) return null;
  const direct = path.join(IMAGES, name);
  if (fs.existsSync(direct)) return direct;
  const stem = name.replace(/\.[^.]+$/, '');
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']) {
    const p = path.join(IMAGES, stem + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

// Template assets, full resolution. Preview mode deliberately keeps whatever the
// builder embedded, so a diff proves the geometry rather than the asset scale.
const templateAsset = (kind) => {
  const map = {
    OVERLAY: { cover: 'comic-cover/overlay.png', 'cover-fullbleed': 'comic-cover/overlay.png' },
    BACKGROUND: { cover: 'comic-cover/background.png' },
    LOGO: { '*': 'csc-logo.png' },
  }[kind] || {};
  const rel = map[recipe.template] || map['*'];
  if (!rel) return null;
  const file = path.join(ASSETS, rel);
  return fs.existsSync(file) ? file : null;
};

/* ------------------------------------------------------------ substitute --- */
const missing = [];
let svg = recipe.svg;

svg = svg.replace(/\{\{IMAGE:([^}]+)\}\}/g, (_, id) => {
  const panel = (recipe.panels || []).find((p) => p.id === id);
  if (panel && panel.placeholder) {
    const which = recipe.template === 'cover' ? 'placeholder-cover.png'
                : recipe.template === 'cover-fullbleed' ? 'placeholder-coverfb.png'
                : 'placeholder.png';
    const ex = path.join(ASSETS, which);
    return fs.existsSync(ex) ? dataUri(ex) : (missing.push(`${id} (example art)`), '');
  }
  const file = findImage(panel && panel.image);
  if (!file) { missing.push(`${id} -> ${panel ? panel.image : 'no entry'}`); return ''; }
  return dataUri(file);
});

for (const kind of ['OVERLAY', 'BACKGROUND', 'LOGO']) {
  const token = new RegExp(`\\{\\{${kind}\\}\\}`, 'g');
  if (!token.test(svg)) continue;
  const file = templateAsset(kind);
  if (!file) { missing.push(kind); svg = svg.replace(token, ''); continue; }
  svg = svg.replace(token, dataUri(file));
}

if (missing.length) console.warn('Missing assets:\n  ' + missing.join('\n  '));

/* -------------------------------------------------------------- render ---- */
const out = recipe.output || {};
const face = out.faceInches || [recipe.canvas.width / 300, recipe.canvas.height / 300];
const wrap = out.wrapInches || 0;
const dpi = Number(arg('--dpi', 300));
const fileIn = out.fileInches || [face[0] + 2 * wrap, face[1] + 2 * wrap];

const vb = /viewBox="([^"]+)"/.exec(svg);
const [, , vw, vh] = vb ? vb[1].split(/\s+/).map(Number) : [0, 0, 1000, 1000];

const forced = Number(arg('--width', 0));
const targetW = forced || (PREVIEW ? Math.round(vw) : Math.round(fileIn[0] * dpi));

const fontFiles = fs.existsSync(FONTS)
  ? fs.readdirSync(FONTS).filter((f) => /\.(ttf|otf)$/i.test(f)).map((f) => path.join(FONTS, f))
  : [];

/* A renderer matches fonts on the family name inside the file, not on whatever
   name a stylesheet gave it. Get that wrong and the print silently comes out in
   a different typeface — so check it rather than trust it. */
function readFamilies(file) {
  const b = fs.readFileSync(file);
  const numTables = b.readUInt16BE(4);
  let nameOff = 0;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (b.toString('ascii', rec, rec + 4) === 'name') nameOff = b.readUInt32BE(rec + 8);
  }
  if (!nameOff) return [];
  const count = b.readUInt16BE(nameOff + 2);
  const strOff = nameOff + b.readUInt16BE(nameOff + 4);
  const out = new Set();
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12;
    const platform = b.readUInt16BE(r), nameId = b.readUInt16BE(r + 6);
    const len = b.readUInt16BE(r + 8), off = b.readUInt16BE(r + 10);
    if (nameId !== 1 && nameId !== 16) continue;
    const raw = b.subarray(strOff + off, strOff + off + len);
    out.add(platform === 3 ? Buffer.from(raw).swap16().toString('utf16le')
                           : raw.toString('latin1'));
  }
  return [...out];
}

const available = new Set(fontFiles.flatMap(readFamilies));
const wanted = new Set([...svg.matchAll(/font-family="([^"]+)"/g)]
  .map((m) => m[1].replace(/^['"]|['"]$/g, '')));
const absent = [...wanted].filter((f) => !available.has(f));
if (absent.length) {
  console.error('Font not available — the render would silently substitute:');
  absent.forEach((f) => console.error(`  wanted "${f}"`));
  console.error(`  loaded: ${[...available].map((f) => `"${f}"`).join(', ') || '(none)'}`);
  process.exit(2);
}

const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: targetW },
  font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Chewy' },
  // print files must be opaque; a transparent edge row would show as white
  // on one press and black on another
  background: arg('--background', '#FFFFFF'),
});
const png = resvg.render();
fs.writeFileSync(OUT, png.asPng());

const mode = PREVIEW ? 'proof' : `${fileIn[0]} × ${fileIn[1]} in @ ${dpi}dpi`;
console.log(`${recipe.template}  ${out.formatLabel || 'poster'}  ${mode}`);
console.log(`  ${png.width} × ${png.height} px  ->  ${OUT}`);
if (wrap) console.log(`  face ${face[0]} × ${face[1]} in, ${wrap}" wrap on every edge`);
