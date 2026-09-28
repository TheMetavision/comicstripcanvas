/**
 * Does the drawing move as far as the finger?
 *
 *   npm run build && node tools/builder/drag-scale-tests.mjs
 *
 * Four places converted a pointer movement into canvas units with
 *
 *     T.canvas.width / svg.getBoundingClientRect().width
 *
 * but sizeBoard() sizes the board to the VIEWBOX extent -- the canvas plus its
 * padding and wrap -- so a screen pixel is a slice of that, not of the canvas.
 * The two differ on every template and finish the shop sells. A cover at
 * poster dragged 8.6% too far; the same cover at gallery 17.2% too short. Only
 * a strip at poster was right, because that is the one case where the padding
 * is zero.
 *
 * This drives the BUILT bundle out of dist/ and drags things: a photograph, a
 * text field, a box, and a resize handle, on every template at every finish.
 * It measures how far each actually moved against how far the pointer did.
 *
 *   --before   put the old expression back at runtime, to show the fault
 *   --verbose  let the builder speak
 *
 * jsdom reports every getBoundingClientRect as zero, so the svg's is computed
 * from the width sizeBoard() actually set -- which is the number a browser
 * would report, and the number the bug is about.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { JSDOM } = createRequire(path.join(REPO, 'tools/builder/renderer/package.json'))('jsdom');

const BEFORE = process.argv.includes('--before');
const LOUD = process.argv.includes('--verbose');
const DIST = path.join(REPO, 'dist');

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);
const REAL = console;
const TALK = LOUD
  ? { log: (...a) => REAL.log('   [b]', ...a), warn: (...a) => REAL.log('   [b?]', ...a),
      error: (...a) => REAL.log('   [b!]', ...a), info() {} }
  : { log() {}, error() {}, warn() {}, info() {} };

/* The three pages, and which templates each offers in its switch. */
/* The switch decides which templates a page offers; its buttons are read at
   runtime rather than listed here, so a renamed template cannot make this
   quietly test nothing. */
const PAGES = ['personalised-strips', 'personalised-book-covers', 'personalised-icons'];
const FINISHES = ['poster', 'standard', 'gallery'];
const DRAG_PX = 120;          // a deliberate, measurable shove

if (!fs.existsSync(path.join(DIST, 'store', 'personalised-strips', 'index.html'))) {
  say('\nNo dist/ — run "npm run build" first.\n');
  process.exit(1);
}

/** A 2x2 PNG, enough for a panel to consider itself filled. */
const PNG_1PX = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAACddGYaAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC';

/**
 * Open one page with the real bundle running, and hand back the levers.
 */
async function open(slug, tag) {
  const pageFile = path.join(DIST, 'store', slug, 'index.html');
  const html = fs.readFileSync(pageFile, 'utf8');
  const bundle = html.match(/src="\/(_astro\/ProductBuilder\.astro[^"]+\.js)"/)?.[1];
  if (!bundle) throw new Error(`no ProductBuilder bundle on ${slug}`);

  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: `https://x/store/${slug}?dev`,
    beforeParse(w) {
      class Img {
        constructor() { this.complete = false; this._l = []; }
        set src(v) {
          this._src = v; this.complete = true;
          this.naturalWidth = 1600; this.naturalHeight = 1600;
          this.width = 1600; this.height = 1600;
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
      /* jsdom implements neither, and the fill path calls both. */
      w.Element.prototype.scrollIntoView = () => {};
      w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {} });
      w.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 1200; } });
      Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 800; } });
      w.document.fonts = { ready: Promise.resolve(), load: () => Promise.resolve() };
      w.console = TALK;
      w.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
      /* jsdom has neither, and place() calls the first for every photo. */
      w.URL.createObjectURL = () => 'blob:test/photo';
      w.URL.revokeObjectURL = () => {};

      /* THE MEASUREMENT. jsdom gives every element a zero rect, so the svg's
         comes from the width sizeBoard() actually set on the board -- which is
         what a browser would report, and the number the whole bug turns on. */
      w.Element.prototype.getBoundingClientRect = function rect() {
        const root = this.ownerDocument.getElementById('csc-builder-root');
        const board = root && root.querySelector('#board');
        const isSvg = this.id === 'svg' || this.tagName === 'svg';
        if (isSvg && board) {
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
    'Event', 'MouseEvent', 'PointerEvent', 'CustomEvent', 'localStorage', 'getComputedStyle',
    'URLSearchParams', 'Blob', 'File', 'FormData', 'location', 'navigator', 'URL',
    'HTMLElement', 'SVGElement', 'Element', 'Node', 'fetch', 'console']) {
    if (window[k] === undefined && k !== 'console') continue;
    Object.defineProperty(globalThis, k,
      { value: k === 'console' ? TALK : window[k], configurable: true, writable: true });
  }

  await import(pathToFileURL(path.join(DIST, bundle)).href + `?run=${encodeURIComponent(tag)}`);
  await new Promise((r) => setTimeout(r, 200));

  const root = doc.getElementById('csc-builder-root');
  const $ = (id) => root.querySelector('#' + id);
  const svg = doc.getElementById('svg');

  const pointer = (el, type, x, y, extra = {}) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true, ...extra });
    el.dispatchEvent(e);
    return e;
  };

  const drag = async (el, from, dx, dy = 0) => {
    pointer(el, 'pointerdown', from.x, from.y);
    await new Promise((r) => setTimeout(r, 0));
    pointer(el, 'pointermove', from.x + dx, from.y + dy);
    await new Promise((r) => setTimeout(r, 0));
    pointer(el, 'pointerup', from.x + dx, from.y + dy);
    await new Promise((r) => setTimeout(r, 0));
  };

  /* The same two numbers the builder reads, from the same places. */
  const unitsPerPx = () => {
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    const w = svg.getBoundingClientRect().width;
    return w > 0 ? vb[2] / w : 1;
  };

  return { dom, window, doc, root, $, svg, drag, pointer, unitsPerPx,
    close: () => dom.window.close() };
}

/* ────────────────────────────────────────────────────────────── run */

const num = (el, a) => Number(el.getAttribute(a));
const pct = (actual, want) => (want === 0 ? (actual === 0 ? 0 : 100) : ((actual - want) / want) * 100);
/** The first coordinate of a path, which is how a moved box shows it moved. */
const firstX = (d) => Number((/[Mm]\s*(-?[\d.]+)/.exec(d || '') || [])[1]);

say(`\n${BEFORE ? 'BEFORE — the canvas-width basis' : 'AFTER — the viewBox basis'}`);
say(`\n  ${'template'.padEnd(18)} ${'finish'.padEnd(9)} ${'photo'.padEnd(8)} ${'text'.padEnd(8)}`
  + ` ${'box'.padEnd(8)} ${'handle px'.padEnd(10)} anchor`);
say(`  ${'-'.repeat(18)} ${'-'.repeat(9)} ${'-'.repeat(8)} ${'-'.repeat(8)} ${'-'.repeat(8)}`
  + ` ${'-'.repeat(10)} ------`);

const worst = { v: 0, where: '' };
const rows = [];

for (const slug of PAGES) {
  /* Which templates this page offers — read off the switch, once. */
  const probe = await open(slug, `${slug}-probe`);
  const labels = [...probe.$('switch').children].map((b) => b.textContent.trim());
  probe.close();

  for (const label of labels) {
    for (const finish of FINISHES) {
      const b = await open(slug, `${slug}-${label}-${finish}-${BEFORE ? 'before' : 'after'}`);
      try {
        const { $, svg, root, drag, window } = b;

        const btn = [...$('switch').children].find((x) => x.textContent.trim() === label);
        btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 70));
        $('fmtSel').value = finish; $('fmtSel').dispatchEvent(new window.Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 70));
        const sizeSel = $('sizeSel');
        sizeSel.value = String(Math.max(0, sizeSel.options.length - 1));
        sizeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 90));

        /* Consent, then a real photograph into the first slot — a seeded
           example is still "empty" and refuses to be panned. */
        const consent = root.querySelector('#consent');   // the checkbox, not the section
        if (consent && !consent.checked) {
          consent.checked = true;
          consent.dispatchEvent(new window.Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 30));
        }
        const picker = root.querySelector('#picker');
        const file = new window.File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        Object.defineProperty(picker, 'files', { value: [file], configurable: true });
        picker.dispatchEvent(new window.Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 160));

        const k = b.unitsPerPx();
        const want = DRAG_PX * k;
        if (LOUD) {
          const bw = svg.getBoundingClientRect().width;
          const hs = [...svg.querySelectorAll('[data-role="handles"] rect')];
          REAL.log(`   [dbg] ${label} ${finish}: viewBox=${svg.getAttribute('viewBox')}`
            + ` rect=${bw.toFixed(1)} k=${k.toFixed(3)} handles=${hs.length}`
            + ` firstW=${hs[0] ? hs[0].getAttribute('width') : '-'}`
            + ` img=${(() => { const i = svg.querySelector('image[data-role="panel"]'); return i ? i.getAttribute('x') + ',' + i.getAttribute('width') : 'none'; })()}`);
        }

        /* ---- 1. the photograph ----
           Zoomed in first. layout() clamps the pan to the slack the photo has
           over its panel, and at zoom 1 a fitted photo has none on one axis --
           so a drag there measures the clamp, not the scale. */
        let photo = NaN;
        const zoomSlider = $('zoom');
        if (zoomSlider) {
          zoomSlider.value = '2';
          zoomSlider.dispatchEvent(new window.Event('input', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 40));
        }
        const img = svg.querySelector('image[data-role="panel"]');
        const hit = svg.querySelector('.hit');
        if (img && hit) {
          const x0 = num(img, 'x');
          await drag(hit, { x: 300, y: 300 }, DRAG_PX);
          const moved = num(img, 'x') - x0;
          if (moved !== 0) photo = pct(moved, want);
        }

        /* text and furniture move only in reposition mode */
        $('reposition').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));

        /* ---- 2. a text field ---- */
        /* layoutText puts no x on <text>: the position is the tspan's x, and
           the centre of the rotate() it always writes. The latter is there
           whatever the wording, so it is what gets measured. */
        const rotX = (el) => Number((/rotate\([^\s)]+\s+(-?[\d.]+)/.exec(el.getAttribute('transform') || '') || [])[1]);
        let text = NaN;
        const t = [...svg.querySelectorAll('text')].find((el) => Number.isFinite(rotX(el)));
        if (t) {
          const x0 = rotX(t);
          await drag(t, { x: 320, y: 320 }, DRAG_PX);
          const moved = rotX(t) - x0;
          if (Number.isFinite(moved) && moved !== 0) text = pct(moved, want);
        }

        /* ---- 3. a box ---- */
        /* boxTransform writes translate(x,y), so a moved box shows it there. */
        const trX = (el) => Number((/translate\(\s*(-?[\d.]+)/.exec(el.getAttribute('transform') || '') || [])[1]);
        let box = NaN;
        const g = [...svg.querySelectorAll('g')].find((el) => Number.isFinite(trX(el)) && el.querySelector('path[d]'));
        if (g) {
          const x0 = trX(g);
          await drag(g, { x: 340, y: 340 }, DRAG_PX);
          const moved = trX(g) - x0;
          if (Number.isFinite(moved) && moved !== 0) box = pct(moved, want);
        }
        $('reposition').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));

        /* ---- 4. the handles: finger-sized, and on the corner ---- */
        let handlePx = NaN, anchor = NaN;
        /* The group also holds an outline round the whole photograph; the
           handles are the small ones. */
        const vbW = Number((svg.getAttribute('viewBox') || '').split(/\s+/)[2]) || Infinity;
        const handles = [...svg.querySelectorAll('[data-role="handles"] rect')]
          .filter((h) => num(h, 'width') < vbW / 4);
        if (handles.length && img) {
          handlePx = Math.max(...handles.map((h) => num(h, 'width') / k));
          const ix = num(img, 'x'), iy = num(img, 'y');
          const iw = num(img, 'width'), ih = num(img, 'height');
          const corners = [[ix, iy], [ix + iw, iy], [ix, iy + ih], [ix + iw, iy + ih]];
          anchor = Math.max(...handles.map((h) => {
            const cx = num(h, 'x') + num(h, 'width') / 2, cy = num(h, 'y') + num(h, 'height') / 2;
            return Math.min(...corners.map(([px, py]) => Math.hypot(cx - px, cy - py)));
          })) / k;
        }

        const f = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—');
        say(`  ${label.padEnd(18)} ${finish.padEnd(9)} ${f(photo).padEnd(8)} ${f(text).padEnd(8)}`
          + ` ${f(box).padEnd(8)} ${(Number.isFinite(handlePx) ? handlePx.toFixed(1) : '—').padEnd(10)}`
          + ` ${Number.isFinite(anchor) ? anchor.toFixed(2) + 'px' : '—'}`);
        rows.push({ label, finish, photo, text, box, handlePx, anchor });

        for (const [what, v] of [['photo', photo], ['text', text], ['box', box]]) {
          if (Number.isFinite(v) && Math.abs(v) > Math.abs(worst.v)) {
            worst.v = v; worst.where = `${label} ${finish} ${what}`;
          }
        }
      } finally { b.close(); }
    }
  }
}

say('');
if (BEFORE) {
  say(`worst drag error: ${worst.v >= 0 ? '+' : ''}${worst.v.toFixed(1)}% (${worst.where})`);
  process.exit(0);
}

/* ─────────────────────────────────────────────────────── the verdicts */

const measured = (key) => rows.filter((r) => Number.isFinite(r[key]));
for (const key of ['photo', 'text', 'box']) {
  const got = measured(key);
  ok(got.length > 0, `${key}: measured on at least one template`, `${got.length} case(s)`);
  const bad = got.filter((r) => Math.abs(r[key]) >= 0.5);
  ok(bad.length === 0, `${key}: follows the pointer everywhere`,
    bad.length ? bad.map((r) => `${r.label} ${r.finish} ${r[key].toFixed(1)}%`).join('; ')
      : `${got.length} case(s), worst ${Math.max(...got.map((r) => Math.abs(r[key]))).toFixed(2)}%`);
}

const hp = rows.filter((r) => Number.isFinite(r.handlePx));
ok(hp.length > 0, 'handles: measured', `${hp.length} case(s)`);
ok(hp.every((r) => Math.abs(r.handlePx - 32) < 1.5),
  'handles: 32 screen pixels wherever the board is, whatever the finish',
  hp.length ? `${Math.min(...hp.map((r) => r.handlePx)).toFixed(1)}–${Math.max(...hp.map((r) => r.handlePx)).toFixed(1)} px` : '');
const an = rows.filter((r) => Number.isFinite(r.anchor));
ok(an.length > 0 && an.every((r) => r.anchor < 1),
  'handles: every one sits on a corner of the photograph',
  an.length ? `worst ${Math.max(...an.map((r) => r.anchor)).toFixed(2)} px` : '');

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
