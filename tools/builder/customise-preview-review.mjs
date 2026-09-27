/**
 * Does the customise preview clip where the print clips?
 *
 *   npm run build
 *   node tools/builder/customise-preview-review.mjs [--before]
 *
 * Two routes to the same picture, as in face-clip-review:
 *
 *   preview  the real ProductBuilder bundle out of dist/, driven headlessly on
 *            the product's own customise page, with /api/customise-scene
 *            stubbed to return exactly what the function returns
 *   print    the same stored scene through reprojectScene(), which is what
 *            order-print-file does when the order comes in
 *
 * --before reproduces the OLD rule so the two can be photographed side by
 * side. It does not rebuild the old bundle: it tells the scene it is a full
 * picture, which is precisely what the old variantOf() concluded when it found
 * no cutoutUrl, and it lands on the same rect the old build was measured
 * producing -- 397,378 3411x5000, the template's art window. It changes
 * nothing on disk.
 *
 * Needs credentials and a build; screenshots land in
 * tools/builder/print-out/_review/customise-preview/ (gitignored).
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
const { JSDOM } = createRequire(path.join(REPO, 'tools/builder/renderer/package.json'))('jsdom');

const { geom, FIT, reprojectScene, wrapInchesFor } =
  await import(pathToFileURL(path.join(REPO, 'netlify/functions/_shared/print-geometry.mjs')).href);
const { faceFor } = await import(pathToFileURL(path.join(REPO, 'netlify/functions/_shared/print-file.mjs')).href);
const { prepareScene } = await import(pathToFileURL(path.join(REPO, 'netlify/functions/_shared/render.mjs')).href);
const { resolveCredentials } = await import(pathToFileURL(path.join(REPO, 'tools/builder/render-sweep.mjs')).href);
const { storedClipRect } = await import(pathToFileURL(path.join(REPO, 'src/scripts/customise-variant.js')).href);

const BEFORE = process.argv.includes('--before');
const LOUD = process.argv.includes('--verbose');
const DIST = path.join(REPO, 'dist');
const OUT = path.join(REPO, 'tools/builder/print-out/_review/customise-preview');
const FONTS = path.join(REPO, 'tools/builder/renderer/_fonts');
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
const W = 1200;
const SIZE_INDEX = 2, SIZE_KEY = 'large';
const FINISHES = ['poster', 'standard', 'gallery'];

fs.mkdirSync(OUT, { recursive: true });
const fontFiles = fs.readdirSync(FONTS).map((f) => path.join(FONTS, f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = console.log.bind(console);
const REAL = console;
const HUSH = { log() {}, error() {}, warn() {}, info() {} };
const TALK = LOUD
  ? { log: (...a) => REAL.log('   [builder]', ...a), warn: (...a) => REAL.log('   [builder?]', ...a),
      error: (...a) => REAL.log('   [builder!]', ...a), info() {} }
  : HUSH;

const { siteID, token } = resolveCredentials();
const studio = getStore({ name: 'studio', siteID, token, consistency: 'strong' });

/* ───────────────────────────────────────────────── serving dist to prepareScene */

const serveDist = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
});

/* ────────────────────────────────────────────────────── reading a design */

async function designOf(sceneId) {
  const raw = await studio.get(`studio/${sceneId}/classic/scene.json`);
  if (!raw) throw new Error(`no classic scene for ${sceneId}`);
  const scene = JSON.parse(raw);
  const recipe = scene.recipe || scene;
  let artBuf = await studio.get(`studio/${sceneId}/classic/art/art.png`, { type: 'arrayBuffer' });
  let artMime = 'image/png';
  if (!artBuf) {
    artBuf = await studio.get(`studio/${sceneId}/classic/art/art.jpg`, { type: 'arrayBuffer' });
    artMime = 'image/jpeg';
  }
  if (!artBuf) throw new Error(`no artwork for ${sceneId}`);
  const art = Buffer.from(artBuf);
  return {
    sceneId, recipe, svg: scene.svg || recipe.svg,
    canvas: recipe.canvas, art, artMime,
    artMeta: await sharp(art).metadata(),
    artUri: `data:${artMime};base64,${art.toString('base64')}`,
    savedGeom: geom(recipe.canvas,
      { w: recipe.output.faceInches[0], h: recipe.output.faceInches[1] },
      FIT.cover, recipe.output.wrapInches || 0),
  };
}

/** The customise page for a scene id, as the build produced it. */
const pageFor = (sceneId) => {
  const store = path.join(DIST, 'store');
  for (const slug of fs.readdirSync(store)) {
    const file = path.join(store, slug, 'customise', 'index.html');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(`data-product-id="${sceneId}"`)) return file;
  }
  return null;
};

/* ───────────────────────────────── route 1: the bundle that ships */

async function preview(design, { finish, page, payloadOverride, tag }) {
  const html = fs.readFileSync(page, 'utf8');
  const bundle = html.match(/src="\/(_astro\/ProductBuilder\.astro[^"]+\.js)"/)?.[1];
  if (!bundle) throw new Error(`no ProductBuilder bundle in ${path.relative(DIST, page)}`);

  /* Exactly the shape /api/customise-scene returns. */
  const payload = payloadOverride || {
    productId: design.sceneId, style: 'classic',
    template: design.recipe.template || 'cover',
    recipe: design.recipe,
    sceneSvg: design.svg,
    panels: { art: design.artUri },
  };

  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: `https://x/${path.relative(DIST, path.dirname(page)).split(path.sep).join('/')}/?style=classic`,
    beforeParse(w) {
      class Img {
        constructor() { this.complete = false; this._l = []; }
        set src(v) {
          this._src = v; this.complete = true;
          const real = typeof v === 'string' && v.startsWith(`data:${design.artMime}`);
          this.naturalWidth = real ? design.artMeta.width : 1600;
          this.naturalHeight = real ? design.artMeta.height : 1600;
          this.width = this.naturalWidth; this.height = this.naturalHeight;
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
      w.fetch = async (url) => (String(url).includes('/api/customise-scene/')
        ? { ok: true, status: 200, json: async () => payload }
        : { ok: false, status: 404, json: async () => ({ error: 'not stubbed' }) });
      w.console = TALK;
    },
  });

  const { window } = dom, doc = window.document;
  const root = doc.getElementById('csc-builder-root');
  if (root.dataset.mode !== 'customise') throw new Error(`${path.relative(DIST, page)} is not the customise island`);

  const HAND_BACK = ['fetch', 'console'];
  const was = new Map(HAND_BACK.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  const restore = () => { for (const [k, d] of was) if (d) Object.defineProperty(globalThis, k, d); };
  for (const k of ['window', 'document', 'Image', 'FileReader', 'XMLSerializer', 'DOMParser',
    'Event', 'MouseEvent', 'CustomEvent', 'localStorage', 'getComputedStyle',
    'URLSearchParams', 'Blob', 'File', 'FormData', 'location', 'navigator', 'URL',
    'HTMLElement', 'SVGElement', 'Element', 'Node', 'fetch', 'console']) {
    Object.defineProperty(globalThis, k,
      { value: k === 'console' ? TALK : window[k], configurable: true, writable: true });
  }

  try {
    /* A UNIQUE query per run, or the module is served from cache and never
       executes again -- which looks exactly like a builder that failed to
       draw. The synthesised case reuses another case's scene id, so the id
       alone is not unique. */
    await import(pathToFileURL(path.join(DIST, bundle)).href
      + `?run=${encodeURIComponent(tag)}-${finish}-${BEFORE ? 'before' : 'after'}`);
    await sleep(420);

    const $ = (id) => root.querySelector('#' + id);
    const fire = (el, t) => el.dispatchEvent(new window.Event(t, { bubbles: true }));
    $('fmtSel').value = finish; fire($('fmtSel'), 'change');
    await sleep(140);
    $('sizeSel').value = String(SIZE_INDEX); fire($('sizeSel'), 'change');
    await sleep(180);

    const live = doc.getElementById('svg').cloneNode(true);
    live.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    live.querySelectorAll('.hit,[data-role="guide"]').forEach((e) => e.remove());
    const assets = {};
    for (const im of live.querySelectorAll('image')) {
      const href = im.getAttribute('href') || '';
      if (!href.startsWith('/builder/')) continue;
      const file = path.join(DIST, href);
      assets[im.getAttribute('data-role') || path.basename(href)] = file;
      im.setAttribute('href', `data:${MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,`
        + fs.readFileSync(file).toString('base64'));
    }
    const v = live.getAttribute('viewBox').split(/\s+/).map(Number);
    live.setAttribute('width', Math.round(v[2]));
    live.setAttribute('height', Math.round(v[3]));
    return { svg: new window.XMLSerializer().serializeToString(live), assets };
  } finally { restore(); }
}

/* ────────────────────────────── route 2: what the press receives */

async function printRoute(design, { finish, origin, svgOverride }) {
  const to = geom(design.canvas, faceFor(SIZE_KEY, 'portrait'), FIT.cover, wrapInchesFor(finish));
  const { svg } = reprojectScene(svgOverride || design.svg, design.canvas, design.savedGeom, to);
  const prepared = await prepareScene({
    sceneSvg: svg, recipe: design.recipe, origin, imageFor: async () => design.artUri,
  });
  prepared.cleanup();
  return { svg: prepared.svg, to };
}

/* ──────────────────────────────────────────────────────── comparing */

const raster = (svg, width) => new Resvg(svg, {
  fitTo: { mode: 'width', value: width },
  font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Chewy' },
  background: '#FFFFFF',
}).render().asPng();

const clipOf = (svg) => storedClipRect(svg);
const rectStr = (r) => (r ? `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}` : 'none');
const same = (a, b) => !!a && !!b && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 1);

const rawOf = async (svg) =>
  sharp(raster(svg, W)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

/**
 * WHERE THE FIGURE IS, rather than what colour everything came out.
 *
 * Comparing the two renders whole answers the wrong question. The preview
 * composites the cover border from the SCREEN masks and prepareScene from the
 * -print ones, so large flat areas differ in hue by a few levels on every
 * cover ever made -- nothing to do with this bug, and it swamps the thing
 * being measured.
 *
 * So each route is rendered twice, with the artwork and without it, and the
 * difference between those two is that route's figure: exactly the pixels the
 * clip decides. Comparing the two footprints asks the question the bug was
 * about and is blind to everything else.
 */
async function footprints(withArt, withoutArt) {
  const [a, b] = await Promise.all([rawOf(withArt), rawOf(withoutArt)]);
  const { width, height, channels } = a.info;
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < a.data.length; i += channels, p++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i + k] - b.data[i + k]));
    mask[p] = d > 12 ? 1 : 0;
  }
  return { mask, width, height };
}

const stripArt = (svg, artUri) =>
  svg.split(artUri).join('').replace(/\{\{IMAGE:art\}\}/g, '');

async function compareFootprints(previewSvg, printSvg, artUri) {
  const p = await footprints(previewSvg, stripArt(previewSvg, artUri));
  const q = await footprints(printSvg, stripArt(printSvg, artUri));
  if (p.width !== q.width || p.height !== q.height) return { pct: 100, note: 'size mismatch' };
  let only = 0, both = 0;
  for (let i = 0; i < p.mask.length; i++) {
    if (p.mask[i] && q.mask[i]) both++;
    else if (p.mask[i] || q.mask[i]) only++;
  }
  const px = p.width * p.height;
  return { pct: only / px * 100, only, both, px, previewPx: p.mask.reduce((n, v) => n + v, 0),
    printPx: q.mask.reduce((n, v) => n + v, 0) };
}

/* ──────────────────────────────────────────────────────────── run */

const { server, origin } = await serveDist();
let fails = 0;

const CASES = [
  { name: 'bruce-lee-cover', sceneId: '6CCGmCKjYTHK2Kwkqfatyy', shots: true },
  { name: 'walter-white', sceneId: 'studio-c1bcb873045c3da74c2a61da' },
  { name: 'full-picture (synthesised)', sceneId: '6CCGmCKjYTHK2Kwkqfatyy', fullPicture: true },
];

say(`\n${BEFORE ? 'BEFORE — the old rule' : 'AFTER — the scene declares itself'}\n`);
say(`  ${'case'.padEnd(34)} ${'preview clip'.padEnd(22)} ${'print clip'.padEnd(22)} figure shared`);
say(`  ${'-'.repeat(34)} ${'-'.repeat(22)} ${'-'.repeat(22)} ------`);

for (const c of CASES) {
  const design = await designOf(c.sceneId);
  const page = pageFor(c.sceneId);
  if (!page) { say(`  ${c.name}: no customise page in dist — skipped`); continue; }

  /* A Full picture cover is not in the catalogue, so one is made: the same
     design with its clip set back to the art window and no cutoutClip, which
     is exactly what a styled scene looks like. */
  let use = design, payloadOverride = null;

  /* The old rule, for the photographs: no cutoutUrl meant "styled", which
     clipped to the art window whatever the scene had been saved with. */
  if (BEFORE && !c.fullPicture) {
    const { cutoutClip, ...recipe } = design.recipe;
    payloadOverride = {
      productId: design.sceneId, style: 'classic', template: recipe.template || 'cover',
      recipe: { ...recipe, imageVariant: 'styled' }, sceneSvg: design.svg,
      panels: { art: design.artUri },
    };
  }

  if (c.fullPicture) {
    const WINDOW = { x: 397, y: 378, width: 3411, height: 5000 };
    const svg = design.svg.replace(/<clipPath id="clip-art">\s*<rect[^>]*\/?>/,
      `<clipPath id="clip-art"><rect x="${WINDOW.x}" y="${WINDOW.y}" width="${WINDOW.width}" height="${WINDOW.height}"/>`);
    const { cutoutClip, ...recipe } = design.recipe;
    use = { ...design, svg, recipe: { ...recipe, imageVariant: 'styled' } };
    payloadOverride = {
      productId: design.sceneId, style: 'classic', template: 'cover',
      recipe: use.recipe, sceneSvg: svg, panels: { art: design.artUri },
    };
  }

  for (const finish of FINISHES) {
    const p = await preview(use, { finish, page, payloadOverride, tag: c.name });
    const q = await printRoute(use, { finish, origin });
    const pc = clipOf(p.svg), qc = clipOf(q.svg);
    const agree = same(pc, qc);
    const fp = await compareFootprints(p.svg, q.svg, use.artUri);
    /* The CLIP is the thing this branch fixed, and it must be identical.
       The footprint corroborates it, to within the edge: the two routes
       composite the cover border from different mask files, so the figure's
       outline lands a sub-pixel apart and a long perimeter costs a percent. */
    const shared = fp.printPx ? (fp.both / Math.max(fp.previewPx, fp.printPx)) * 100 : 0;
    const ok = agree && shared >= 97;
    if (!ok) fails++;
    say(`  ${`${c.name} ${finish}`.padEnd(34)} ${rectStr(pc).padEnd(22)} ${rectStr(qc).padEnd(22)}`
      + ` ${shared.toFixed(2)}%  ${ok ? 'AGREE' : 'DIFFER'}`);
    if (LOUD || !ok) say(`  ${''.padEnd(34)} figure: preview ${fp.previewPx} px, print ${fp.printPx} px,`
      + ` shared ${fp.both}, disagreeing ${fp.only}`);

    if (c.shots) {
      const tag = `bruce-lee-${finish}-${BEFORE ? 'before' : 'after'}`;
      await sharp(raster(p.svg, 900)).png().toFile(path.join(OUT, `${tag}-preview.png`));
      await sharp(raster(q.svg, 900)).png().toFile(path.join(OUT, `${tag}-print.png`));
    }
  }
}

server.close();
say(`\nscreenshots in ${path.relative(REPO, OUT)}`);
say(fails ? `\n${fails} case(s) disagree.` : '\nEvery case agrees: the preview clips where the print clips.');
process.exit(fails ? 1 : 0);
