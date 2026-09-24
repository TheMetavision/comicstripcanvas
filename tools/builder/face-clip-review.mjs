/**
 * Does what the operator SEES match what the press GETS?
 *
 *   npm run build                                   (dist/ is the thing tested)
 *   node tools/builder/face-clip-review.mjs         [--product <blob id>]
 *
 * Two independent routes to the same picture, put side by side:
 *
 *   preview   the real ProductBuilder bundle out of dist/, driven headlessly
 *             with Bruce Lee's stored design loaded and a finish chosen --
 *             the document on screen when somebody presses Add to basket
 *
 *   print     that same stored scene through reprojectScene(), which is what
 *             order-print-file does when the order comes in
 *
 * They must agree pixel for pixel. The clip that decides how much of the
 * cut-out reaches the wrap is computed twice, once on each route, and this is
 * the only place the two are ever compared.
 *
 * Runs against the live Blobs store, so it needs credentials and is a review
 * script rather than part of the offline suite. Crops land in
 * tools/builder/print-out/_review/face-clip/ (gitignored).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const require = createRequire(path.join(REPO, 'package.json'));
const { getStore } = require('@netlify/blobs');
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');
/* jsdom is the print renderer's own dependency, not the site's. */
const { JSDOM } = createRequire(path.join(REPO, 'tools/builder/renderer/package.json'))('jsdom');

const {
  geom, FIT, reprojectScene, printPixels, wrapInchesFor,
  CLIP_EDGES, CLIP_TO_FACE, clipAll, cutoutClipRect,
} = await import(pathToFileURL(path.join(REPO, 'netlify/functions/_shared/print-geometry.mjs')).href);
const { faceFor } = await import(pathToFileURL(path.join(REPO, 'netlify/functions/_shared/print-file.mjs')).href);
const { prepareScene } = await import(pathToFileURL(path.join(REPO, 'netlify/functions/_shared/render.mjs')).href);
const { resolveCredentials } = await import(pathToFileURL(path.join(REPO, 'tools/builder/render-sweep.mjs')).href);

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const ID = arg('--product', '6CCGmCKjYTHK2Kwkqfatyy');          // bruce-lee-cover
const DIST = path.join(REPO, 'dist');
const OUT = path.join(REPO, 'tools/builder/print-out/_review/face-clip');
const FONTS = path.join(REPO, 'tools/builder/renderer/_fonts');
/* The shop builds a customise page per product, already carrying data-mode and
   the product id -- so the fixture is the page a customer lands on, not a
   generic builder with attributes bent to look like one. */
const PAGE = (() => {
  const store = path.join(DIST, 'store');
  if (!fs.existsSync(store)) return null;
  for (const slug of fs.readdirSync(store)) {
    const file = path.join(store, slug, 'customise', 'index.html');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(`data-product-id="${ID}"`)) return file;
  }
  return null;
})();
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

if (!PAGE) throw new Error(`no customise page for ${ID} in ${DIST} — run "npm run build" first`);
fs.mkdirSync(OUT, { recursive: true });
const fontFiles = fs.readdirSync(FONTS).map((f) => path.join(FONTS, f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = console.log.bind(console);
/* The bundle talks to the console when a design fails to load; swallowing that
   turns a broken fixture into a silent 80% pixel difference. */
const LOUD = process.argv.includes('--verbose');
const REAL = console;
const TALK = LOUD
  ? { log: (...a) => REAL.log('   [builder]', ...a), error: (...a) => REAL.log('   [builder!]', ...a),
      warn: (...a) => REAL.log('   [builder?]', ...a), info() {} }
  : { log() {}, error() {}, warn() {}, info() {} };

/* ───────────────────────────────────────────────────── the stored design */

const { siteID, token } = resolveCredentials();
const studio = getStore({ name: 'studio', siteID, token, consistency: 'strong' });
const scene = JSON.parse(await studio.get(`studio/${ID}/classic/scene.json`));
const recipe = scene.recipe || scene;
const C = recipe.canvas;
const storedSvg = scene.svg || recipe.svg;

let artBuf = await studio.get(`studio/${ID}/classic/art/art.png`, { type: 'arrayBuffer' });
let artMime = 'image/png';
if (!artBuf) { artBuf = await studio.get(`studio/${ID}/classic/art/art.jpg`, { type: 'arrayBuffer' }); artMime = 'image/jpeg'; }
if (!artBuf) throw new Error(`no artwork stored for ${ID}`);
const art = Buffer.from(artBuf);
const artMeta = await sharp(art).metadata();
const artUri = `data:${artMime};base64,${art.toString('base64')}`;

const savedGeom = geom(C, { w: recipe.output.faceInches[0], h: recipe.output.faceInches[1] },
  FIT.cover, recipe.output.wrapInches || 0);

say(`\nBruce Lee, Classic cover — stored at ${recipe.output.format || 'poster'} `
  + `${recipe.output.faceInches.join('x')}in, artwork ${artMeta.width}x${artMeta.height}\n`);

/* ─────────────────────────── route 1: the builder that ships, driven headlessly */

/**
 * Load the design into the real bundle and read back the document on screen.
 * Assets are inlined from dist/, which is also what the print route is served
 * from, so anything that differs afterwards is geometry and not artwork.
 */
async function preview({ finish, sizeIndex, cutoutClip }) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const bundle = html.match(/src="\/(_astro\/ProductBuilder\.astro[^"]+\.js)"/)?.[1];
  if (!bundle) throw new Error(`no ProductBuilder bundle referenced by ${path.relative(DIST, PAGE)}`);

  const payload = {
    productId: ID,
    style: 'classic',
    template: recipe.template || 'cover',
    recipe: { ...recipe, ...(cutoutClip ? { cutoutClip } : {}) },
    panels: { art: artUri },
  };
  /* An absent field must mean absent, not "set to today's behaviour". */
  if (!cutoutClip) delete payload.recipe.cutoutClip;

  const asked = [];
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: `https://x${'/' + path.relative(DIST, path.dirname(PAGE)).split(path.sep).join('/')}/?style=classic`,
    beforeParse(w) {
      /* Report the artwork's REAL shape. The 20-case harness can use a square
         stub because both its routes see the same stub; here the print route
         reads the actual file, so a lie about the aspect would move the panel
         on one side only and the diff would be measuring the lie. */
      class Img {
        constructor() { this.complete = false; this._l = []; }
        set src(v) {
          this._src = v; this.complete = true;
          const real = typeof v === 'string' && v.startsWith(`data:${artMime}`);
          this.naturalWidth = real ? artMeta.width : 1600;
          this.naturalHeight = real ? artMeta.height : 1600;
          this.width = this.naturalWidth; this.height = this.naturalHeight;
          /* Both ways of listening: the upload path uses addEventListener,
             the customise path assigns onload, and a stub that honours only
             one leaves the other awaiting a promise that never settles. */
          queueMicrotask(() => { this._l.forEach((f) => f()); if (this.onload) this.onload(); });
        }
        get src() { return this._src; }
        addEventListener(t, f) { if (t === 'load') this._l.push(f); }
        removeEventListener() {}
      }
      w.Image = Img;
      w.SVGElement.prototype.getComputedTextLength = () => 1;
      w.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 9, height: 9 });
      w.Element.prototype.setPointerCapture = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 1200; } });
      Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 800; } });
      w.document.fonts = { ready: Promise.resolve(), load: () => Promise.resolve() };
      w.fetch = async (url) => { asked.push(String(url)); return String(url).includes('/api/customise-scene/')
        ? { ok: true, status: 200, json: async () => payload }
        : { ok: false, status: 404, json: async () => ({ error: 'not stubbed' }) }; };
      w.console = TALK;
    },
  });

  let restore = () => {};
  try {
  const { window } = dom, doc = window.document;
  const root = doc.getElementById('csc-builder-root');
  if (root.dataset.mode !== 'customise')
    throw new Error(`${path.relative(DIST, PAGE)} is not the customise island`);

  /* The bundle is an ES module graph reading `document`, `location` and friends
     off the global scope, so the page has to be lent to Node's globals.
     `fetch` and `console` are handed back afterwards -- leaving the stubbed
     fetch in place makes the PRINT route pull its border masks through the
     builder's 404 stub, which reads as a missing asset rather than as this
     function's doing. The DOM globals stay: the bundle schedules work on
     Node's own timers, which window.close() cannot cancel, and a stray one
     firing into an undefined `document` takes the process down. */
  const BORROWED = ['window', 'document', 'Image', 'FileReader', 'XMLSerializer', 'DOMParser',
    'Event', 'MouseEvent', 'CustomEvent', 'localStorage', 'getComputedStyle',
    'URLSearchParams', 'Blob', 'File', 'FormData', 'location', 'navigator', 'URL',
    'HTMLElement', 'SVGElement', 'Element', 'Node', 'fetch', 'console'];
  const HAND_BACK = ['fetch', 'console'];
  const was = new Map(HAND_BACK.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  restore = () => { for (const [k, d] of was) if (d) Object.defineProperty(globalThis, k, d); };
  for (const k of BORROWED)
    Object.defineProperty(globalThis, k,
      { value: k === 'console' ? TALK : window[k], configurable: true, writable: true });

  await import(pathToFileURL(path.join(DIST, bundle)).href + `?run=${finish}-${sizeIndex}-${cutoutClip ? 'face' : 'absent'}`);
  await sleep(400);                                    // the stubbed fetch, then fillLocked

  if (LOUD) REAL.log('   [asked]', JSON.stringify(asked));
  const $ = (id) => root.querySelector('#' + id);
  const fire = (el, t) => el.dispatchEvent(new window.Event(t, { bubbles: true }));
  $('fmtSel').value = finish; fire($('fmtSel'), 'change');
  await sleep(120);
  $('sizeSel').value = String(sizeIndex); fire($('sizeSel'), 'change');
  await sleep(160);

  const live = doc.getElementById('svg').cloneNode(true);
  live.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  /* Hit targets and the face guide are operator furniture; exportSVG drops
     them too, so they are not part of what is bought. */
  live.querySelectorAll('.hit,[data-role="guide"]').forEach((e) => e.remove());

  const assets = {};
  for (const im of live.querySelectorAll('image')) {
    const href = im.getAttribute('href') || '';
    if (!href.startsWith('/builder/')) continue;
    const file = path.join(DIST, href);
    assets[im.getAttribute('data-role') || path.basename(href)] = file;
    im.setAttribute('href',
      `data:${MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,`
      + fs.readFileSync(file).toString('base64'));
  }
  const v = live.getAttribute('viewBox').split(/\s+/).map(Number);
  live.setAttribute('width', Math.round(v[2]));
  live.setAttribute('height', Math.round(v[3]));
  const out = new window.XMLSerializer().serializeToString(live);
  return { svg: out, assets, viewBox: v };
  } finally { restore(); }
}

/* ─────────────────────────────── route 2: what order-print-file would send */

/* prepareScene pulls the border masks, the overlay, the logo and the fonts off
   the deployed site, so give it the build under test rather than a copy of the
   assets that could drift from it. Same bytes the preview inlined. */
const serveDist = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (LOUD) REAL.log('   [404]', req.url, '->', file);
      res.writeHead(404).end('no'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
});

/** Mark the stored clip rect the way the migration does. */
const setClip = (svg, clip) => (clip ? svg.replace(
  /<clipPath id="clip-art">\s*<rect([^>]*?)\/?>/,
  (m, attrs) => {
    const keep = attrs.replace(/\s*data-(role|clip-\w+)="[^"]*"/g, '');
    const marks = CLIP_EDGES.map((e) => ` data-clip-${e}="${clip[e]}"`).join('');
    return `<clipPath id="clip-art"><rect data-role="cutout-clip"${marks}${keep}/>`;
  }) : svg);

async function printRoute({ finish, sizeKey, cutoutClip, origin }) {
  const to = geom(C, faceFor(sizeKey, 'portrait'), FIT.cover, wrapInchesFor(finish));
  const { svg: moved } = reprojectScene(setClip(storedSvg, cutoutClip), C, savedGeom, to);
  const prepared = await prepareScene({
    sceneSvg: moved, recipe, origin, imageFor: async () => artUri,
  });
  prepared.cleanup();
  return { svg: prepared.svg, to };
}

/* ───────────────────────────────────────────────────────────── comparison */

/** The rect the art is actually clipped to, whichever route produced it. */
const clipOf = (svg) => {
  const tag = /<clipPath id="clip-art">\s*(<rect[^>]*>)/.exec(svg)?.[1];
  if (!tag) return null;
  const at = (a) => Number(new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1]);
  return { x: at('x'), y: at('y'), width: at('width'), height: at('height') };
};
const sameRect = (a, b) => a && b && ['x', 'y', 'width', 'height']
  .every((k) => Math.abs(a[k] - b[k]) < 1);
const rectStr = (r) => (r ? `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}` : 'none');

const raster = (svg, W) => new Resvg(svg, {
  fitTo: { mode: 'width', value: W },
  font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Chewy' },
  background: '#FFFFFF',
}).render().asPng();

async function compare(label, a, b, W) {
  const A = await sharp(raster(a, W)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(raster(b, W)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (A.info.width !== B.info.width || A.info.height !== B.info.height) {
    say(`  ${label.padEnd(34)} SIZE MISMATCH ${A.info.width}x${A.info.height} vs ${B.info.width}x${B.info.height}`);
    return { ok: false, pct: 100 };
  }
  const { width: w, height: h, channels: ch } = A.info;
  let diff = 0, worst = 0;
  for (let i = 0; i < A.data.length; i += ch) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A.data[i + k] - B.data[i + k]));
    worst = Math.max(worst, d);
    if (d > 10) diff++;
  }
  const pct = diff / (w * h) * 100;
  say(`  ${label.padEnd(34)} ${(w + 'x' + h).padEnd(12)} ${String(diff).padStart(9)} px  ${pct.toFixed(4)}%  worst ${worst}`);
  return { ok: pct <= 0.01, pct };
}

/** How much of the cut-out lands in the wrap, measured against the same scene
 *  rendered without it -- colour-blind, so a dark figure on a dark burst counts. */
async function inWrap(svg, to, W) {
  const A = await sharp(raster(svg, W)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const B = await sharp(raster(svg.replace(new RegExp(artUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ''), W))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = A.info;
  const band = Math.round(to.wrapPx * (w / (C.width + 2 * to.dx)));
  if (band <= 0) return { total: 0, left: 0, top: 0, right: 0, bottom: 0 };
  const e = { left: 0, top: 0, right: 0, bottom: 0 };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= band && x < w - band && y >= band && y < h - band) continue;
    const i = (y * w + x) * ch;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A.data[i + k] - B.data[i + k]));
    if (d > 12) { if (x < band) e.left++; else if (x >= w - band) e.right++; else if (y < band) e.top++; else e.bottom++; }
  }
  return { ...e, total: e.left + e.top + e.right + e.bottom };
}

async function crops(slug, svg, W) {
  const png = raster(svg, W);
  await sharp(png).png().toFile(path.join(OUT, `${slug}.png`));
  const meta = await sharp(png).metadata();
  const c = Math.min(900, Math.floor(Math.min(meta.width, meta.height) / 2));
  for (const [n, p] of Object.entries({
    'top-left': { left: 0, top: 0 },
    'top-right': { left: meta.width - c, top: 0 },
    'bottom-left': { left: 0, top: meta.height - c },
    'bottom-right': { left: meta.width - c, top: meta.height - c },
  })) await sharp(png).extract({ ...p, width: c, height: c }).png().toFile(path.join(OUT, `${slug}-${n}.png`));
}

/* ──────────────────────────────────────────────────────────────────── run */

const SIZE_INDEX = 2;                                   // Large
const SIZE_KEY = 'large';
const W = 1400;                                         // both routes rasterise alike
let fails = 0;
const { server, origin } = await serveDist();
process.on('unhandledRejection', (e) => REAL.log('   [rejected]', e && e.stack || e));

for (const setting of [null, clipAll(CLIP_TO_FACE)]) {
  const name = setting ? 'cutoutClip all "face"' : 'cutoutClip absent (today)';
  say(`\n${name}`);
  say(`  ${'case'.padEnd(34)} ${'size'.padEnd(12)} ${'differing'.padStart(9)}`);
  for (const finish of ['poster', 'standard', 'gallery']) {
    const p = await preview({ finish, sizeIndex: SIZE_INDEX, cutoutClip: setting });
    const { svg: q, to } = await printRoute({ finish, sizeKey: SIZE_KEY, cutoutClip: setting, origin });
    if (process.argv.includes('--dump')) {
      const tag = `${finish}-${setting ? 'face' : 'absent'}`;
      fs.writeFileSync(path.join(OUT, `${tag}.preview.svg`), p.svg);
      fs.writeFileSync(path.join(OUT, `${tag}.print.svg`), q);
      await sharp(raster(p.svg, W)).png().toFile(path.join(OUT, `${tag}.preview.png`));
    }
    const r = await compare(`${finish} — preview vs print`, p.svg, q, W);
    const pc = clipOf(p.svg), qc = clipOf(q);
    const agree = sameRect(pc, qc);
    if (!agree) fails++;
    say(`  ${''.padEnd(34)} clip: preview ${rectStr(pc)} | print ${rectStr(qc)}`
      + `  ${agree ? 'AGREE' : 'DIFFER'}`);
    const wrap = await inWrap(q, to, W);
    say(`  ${''.padEnd(34)} cut-out in the wrap: ${wrap.total}`
      + ` (L${wrap.left} T${wrap.top} R${wrap.right} B${wrap.bottom})`);
    if (!agree && pc && qc && pc.width < qc.width) say(`  ${''.padEnd(34)} `
      + `the preview clipped tighter than the print — the builder read this panel `
      + `as a framed photo, not a cut-out (see the note at the foot of this file)`);
    await crops(`${finish}-${setting ? 'face' : 'absent'}`, q, W);
  }
}

say(`\ncrops in ${path.relative(REPO, OUT)}`);
say(fails ? `\n${fails} case(s) disagree.` : '\nEvery case agrees: what is previewed is what is printed.');
process.exit(fails ? 1 : 0);
