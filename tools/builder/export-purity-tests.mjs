/**
 * Does the exported scene say anything about the screen it was drawn on?
 *
 *   npm run build && node tools/builder/export-purity-tests.mjs
 *
 * exportSVG strips the hit areas, the guides, the slot flags and the resize
 * handles. It did not strip the one that is hardest to see: the SELECTED
 * panel's outline is drawn in the accent colour, and that outline is a real
 * part of a strip -- the black border round each panel -- so it survived the
 * clone wearing whichever colour the selection had given it.
 *
 * Whichever panel happened to be selected when Save was pressed was therefore
 * recorded in the scene, and the press would print that panel's border in
 * cyan. This checks the export is the same document whatever is selected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { JSDOM } = createRequire(path.join(REPO, 'tools/builder/renderer/package.json'))('jsdom');
const DIST = path.join(REPO, 'dist');

let pass = 0, fail = 0;
const REAL = console;
const say = REAL.log.bind(REAL);
const ok = (c, l, e = '') => {
  if (c) { pass++; say(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; say(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const HUSH = { log() {}, error() {}, warn() {}, info() {} };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(DIST, 'store/personalised-strips/index.html'))) {
  say('\nNo dist/ — run "npm run build" first.\n');
  process.exit(1);
}

async function open(slug, tag) {
  const html = fs.readFileSync(path.join(DIST, 'store', slug, 'index.html'), 'utf8');
  const bundle = html.match(/src="\/(_astro\/ProductBuilder\.astro[^"]+\.js)"/)[1];
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: `https://x/store/${slug}?dev`,
    beforeParse(w) {
      class Img {
        constructor() { this.complete = false; this._l = []; }
        set src(v) {
          this._src = v; this.complete = true;
          this.naturalWidth = 1600; this.naturalHeight = 1600;
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
      w.Element.prototype.releasePointerCapture = () => {};
      w.Element.prototype.scrollIntoView = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 1200; } });
      Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 800; } });
      w.document.fonts = { ready: Promise.resolve(), load: () => Promise.resolve() };
      w.console = HUSH;
      w.URL.createObjectURL = () => 'blob:test/photo';
      w.URL.revokeObjectURL = () => {};
      w.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
      w.Element.prototype.getBoundingClientRect = function rect() {
        const r = this.ownerDocument.getElementById('csc-builder-root');
        const board = r && r.querySelector('#board');
        if ((this.id === 'svg' || this.tagName === 'svg') && board) {
          const width = parseFloat(board.style.width) || 0;
          const height = parseFloat(board.style.height) || 0;
          return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height };
        }
        return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      };
    },
  });
  const { window } = dom, doc = window.document;
  for (const k of ['window', 'document', 'Image', 'FileReader', 'XMLSerializer', 'DOMParser',
    'Event', 'MouseEvent', 'CustomEvent', 'localStorage', 'getComputedStyle',
    'URLSearchParams', 'Blob', 'File', 'FormData', 'location', 'navigator', 'URL',
    'HTMLElement', 'SVGElement', 'Element', 'Node', 'fetch', 'console']) {
    if (window[k] === undefined && k !== 'console') continue;
    Object.defineProperty(globalThis, k,
      { value: k === 'console' ? HUSH : window[k], configurable: true, writable: true });
  }
  await import(pathToFileURL(path.join(DIST, bundle)).href + `?run=${encodeURIComponent(tag)}`);
  await tick(200);

  const root = doc.getElementById('csc-builder-root');
  const $ = (id) => root.querySelector('#' + id);
  const svg = doc.getElementById('svg');
  let logged = null;
  const spy = { log: (...a) => { logged = a.join(' '); }, error() {}, warn() {}, info() {} };
  /* The recipe carries the exported SVG, so copying it is how the export gets
     read from outside the closure. */
  const exportOf = async () => {
    const was = Object.getOwnPropertyDescriptor(globalThis, 'console');
    Object.defineProperty(globalThis, 'console', { value: spy, configurable: true, writable: true });
    logged = null;
    $('copy').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick(40);
    if (was) Object.defineProperty(globalThis, 'console', was);
    try { return JSON.parse(logged).svg; } catch { return logged; }
  };
  return { dom, window, doc, root, $, svg, exportOf, close: () => dom.window.close() };
}

/* ─────────────── 1. the strip, which is the one with outlines */

say('\n1. WHATEVER IS SELECTED, THE SAME DOCUMENT\n');
{
  const b = await open('personalised-strips', 'purity');
  try {
    const { svg, window, doc } = b;
    const hits = [...svg.querySelectorAll('.hit')];
    ok(hits.length > 1, 'the strip has several panels', `${hits.length}`);
    const outlines = () => [...svg.querySelectorAll('path[stroke-width="9"]')];
    ok(outlines().length > 0, 'and each has an outline', `${outlines().length}`);

    const exports = [];
    /* Selection happens on POINTERDOWN, not on click: a short tap chooses a
       photo, a drag pans it, and the panel becomes the selected one the
       instant a finger lands. */
    const tap = (el) => {
      const e = new window.Event('pointerdown', { bubbles: true, cancelable: true });
      Object.assign(e, { clientX: 200, clientY: 200, pointerId: 1, isPrimary: true });
      el.dispatchEvent(e);
    };
    const exportsBefore = await b.exportOf();
    ok(!!exportsBefore, 'an export with nothing selected');

    for (let i = 0; i < Math.min(hits.length, 6); i++) {
      tap(hits[i]);
      await tick(60);
      const lit = outlines().filter((o) => (o.getAttribute('stroke') || '').toLowerCase() !== '#000');
      ok(lit.length === 1, `panel ${i + 1}: exactly one outline is lit on screen`,
        lit.length ? lit[0].getAttribute('stroke') : 'none');
      exports.push(await b.exportOf());
    }

    exports.unshift(exportsBefore);      // nothing selected counts too
    const first = exports[0];
    const differing = exports.filter((e) => e !== first).length;
    ok(differing === 0,
      'the exported scene is byte-identical whichever panel is selected',
      `${exports.length} exports, ${differing} differing`);

    /* And nothing in it wears the accent. */
    const accent = (getComputedStyle(b.root).getPropertyValue('--b-accent') || '').trim();
    for (const c of [accent, '#EC008C', '#00AEEF', '#FFF200'].filter(Boolean)) {
      ok(!new RegExp(`stroke="${c}"`, 'i').test(first),
        `no outline is exported in ${c}`);
    }
    ok(/stroke-width="9"/.test(first), 'while the outlines themselves are still there — they are the design');
  } finally { b.close(); }
}

/* ─────────────── 2. the screen furniture that was already stripped */

say('\n2. AND NOTHING ELSE FROM THE SCREEN\n');
{
  const b = await open('personalised-book-covers', 'purity-cover');
  try {
    const out = await b.exportOf();
    for (const [what, re] of [
      ['hit areas', /class="[^"]*\bhit\b/],
      ['guides', /data-role="guide"/],
      ['slot flags', /data-role="slot-flag"/],
      ['resize handles', /data-role="handles"/],
      ["Astro's scoped id", /data-astro-cid-/],
    ]) ok(!re.test(out), `no ${what} in the exported scene`);
    ok(/\{\{IMAGE:|\{\{BACKGROUND\}\}|\{\{OVERLAY\}\}/.test(out),
      'and the artwork is still tokens, not bytes');
  } finally { b.close(); }
}

/* ─────────────── 3. the migration for what was already saved */

say('\n3. PUTTING A STORED OUTLINE BACK TO BLACK\n');
{
  const { unlight } = await import(
    pathToFileURL(path.join(REPO, 'tools/strip-selection-outline.mjs')).href);
  const { litOutlines } = await import(
    pathToFileURL(path.join(REPO, 'tools/builder/selection-outline-audit.mjs')).href);

  const outline = (stroke) => `<path d="M40,40 H360 V560 H40 Z" fill="none" stroke="${stroke}"`
    + ' stroke-width="9" stroke-linejoin="round"/>';
  /* The shape the real stored scene has: twelve panels, one of them selected
     when Save was pressed. pp-620803a0 is exactly this. */
  const strip = '<svg viewBox="0 0 1200 1600">'
    + Array.from({ length: 11 }, () => outline('#000')).join('')
    + outline('#00AEEF')
    + '<path d="M0,0 H10" fill="none" stroke="#00AEEF" stroke-width="3"/>'   // artwork, not an outline
    + '<path d="M0,0 H10" fill="#EC008C"/>'                                  // artwork fill
    + '</svg>';

  const fixed = unlight(strip);
  ok(fixed.changed === 1, 'one lit outline in twelve is changed', `${fixed.changed}`);
  ok(fixed.colours.join() === '#00AEEF', 'and it reports which colour it was', fixed.colours.join());
  ok(litOutlines(fixed.svg).length === 0, 'nothing lit survives');
  ok((fixed.svg.match(/stroke-width="9"/g) || []).length === 12,
    'all twelve outlines are still there — they are the design');
  ok(fixed.svg.includes('stroke="#00AEEF" stroke-width="3"'),
    'a 3-wide accent stroke is artwork and is left alone');
  ok(fixed.svg.includes('<path d="M0,0 H10" fill="#EC008C"/>'),
    'and so is an accent FILL');

  /* Running it twice must not differ from running it once: a migration gets
     re-run, and the second run has to be a no-op rather than a second edit. */
  const again = unlight(fixed.svg);
  ok(again.changed === 0 && again.svg === fixed.svg, 'running it again changes nothing');

  /* A scene already black comes back byte-identical, so a migration over 251
     clean scenes writes 251 times nothing. */
  const clean = '<svg>' + outline('#000') + outline('#000000') + '</svg>';
  const c = unlight(clean);
  ok(c.changed === 0 && c.svg === clean, 'an all-black scene is untouched, byte for byte');

  /* Attribute order is not guaranteed once a scene has been through another
     serialiser. */
  const reversed = '<svg><path stroke-width="9" stroke="#FFF200" d="M0,0" fill="none"/></svg>';
  const r = unlight(reversed);
  ok(r.changed === 1 && r.svg.includes('stroke="#000"'),
    'stroke-width written before stroke is still caught');

  const none = '<svg><path d="M0,0" stroke="none" stroke-width="9"/></svg>';
  ok(unlight(none).changed === 0, 'an unstroked path is already invisible and is left alone');

  for (const bad of [null, undefined, 42, {}]) {
    ok(unlight(bad).changed === 0, `${JSON.stringify(bad) ?? String(bad)} is handled without throwing`);
  }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
