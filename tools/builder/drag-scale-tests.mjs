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
/* Bound to the real console up front. Each page hands its own console to the
   bundle and never takes it back, so anything logging through the global would
   disappear into the hush after the first one opens. */
const REAL = console;
const say = REAL.log.bind(REAL);
const ok = (c, l, e = '') => {
  if (c) { pass++; say(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; say(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
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
/* Fit, and two magnifications either side of the range. */
const ZOOMS = BEFORE ? [1] : [1, 2, 4];

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
    for (const zoom of ZOOMS) {
      const b = await open(slug, `${slug}-${label}-${finish}-${zoom}-${BEFORE ? 'before' : 'after'}`);
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

        /* THE VIEW. Zoom in with the buttons, then shove the view off centre
           so the pan is not zero either -- a drag measured only at the middle
           of a centred view would pass with the pan arithmetic inverted. */
        for (let i = 0; i < Math.round((zoom - 1) / 0.25); i++) {
          $('viewIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 40));
        const vbZoomed = svg.getAttribute('viewBox');
        let panned = null;
        if (zoom > 1) {
          await drag(svg, { x: 200, y: 200 }, -60, -45);   // empty board: pans the view
          panned = svg.getAttribute('viewBox') !== vbZoomed;
        }
        const shown = Number(($('viewPct').textContent || '').replace('%', ''));
        const vbNow = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
        const fitW = vbNow[2] * zoom;

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
        say(`  ${label.padEnd(18)} ${finish.padEnd(9)} ${(zoom * 100 + '%').padEnd(6)} ${f(photo).padEnd(8)} ${f(text).padEnd(8)}`
          + ` ${f(box).padEnd(8)} ${(Number.isFinite(handlePx) ? handlePx.toFixed(1) : '—').padEnd(10)}`
          + ` ${Number.isFinite(anchor) ? anchor.toFixed(2) + 'px' : '—'}`);
        rows.push({ label, finish, zoom, shown, photo, text, box, handlePx, anchor,
          panned, vbW: vbNow[2], fitW });

        for (const [what, v] of [['photo', photo], ['text', text], ['box', box]]) {
          if (Number.isFinite(v) && Math.abs(v) > Math.abs(worst.v)) {
            worst.v = v; worst.where = `${label} ${finish} ${what}`;
          }
        }
      } finally { b.close(); }
    }
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
/* The view really did what the buttons said. */
ok(rows.every((r) => r.shown === r.zoom * 100),
  'the readout matches the magnification asked for',
  [...new Set(rows.map((r) => `${r.shown}%`))].join(', '));
const zr = rows.filter((r) => r.zoom > 1);
ok(zr.length > 0 && zr.every((r) => Math.abs(r.vbW * r.zoom - r.fitW) < 1),
  'the viewBox narrows in step with the zoom', `${zr.length} zoomed case(s)`);
ok(zr.length > 0 && zr.every((r) => r.panned === true),
  'and a drag on empty board moves it',
  `${zr.filter((r) => r.panned).length}/${zr.length} panned`);

const an = rows.filter((r) => Number.isFinite(r.anchor));
ok(an.length > 0 && an.every((r) => r.anchor < 1),
  'handles: every one sits on a corner of the photograph',
  an.length ? `worst ${Math.max(...an.map((r) => r.anchor)).toFixed(2)} px` : '');


/* ───────────── two fingers: whose gesture is it? ───────────── */

say('\n  TWO FINGERS\n');
{
  const b = await open('personalised-book-covers', 'two-finger');
  try {
    const { $, svg, root, window, pointer } = b;
    $('fmtSel').value = 'gallery'; $('fmtSel').dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 70));
    const consent = root.querySelector('#consent');
    if (consent && !consent.checked) {
      consent.checked = true;
      consent.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    const picker = root.querySelector('#picker');
    Object.defineProperty(picker, 'files', {
      value: [new window.File([new Uint8Array([1])], 'p.png', { type: 'image/png' })], configurable: true });
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 160));

    /* Zoom the VIEW in, so there is something to pan. */
    $('viewIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    $('viewIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    $('viewIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    $('viewIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    const hit = svg.querySelector('.hit');
    const img = () => svg.querySelector('image[data-role="panel"]');
    const imgW = () => Number(img().getAttribute('width'));
    const vb = () => svg.getAttribute('viewBox');

    /* ---- A. two fingers ON the photograph: its pinch, untouched ----

       The HAND has to be put down first, and that is new. Zooming in now picks
       the Hand up, and while it is out it owns every drag on the board -- which
       is the whole point of it, and is asserted the other way round two blocks
       down. This block is about the editing gesture, so it edits. */
    const handBtn = $('viewHand');
    ok(handBtn.getAttribute('aria-pressed') === 'true',
      'zooming in picked the Hand up', handBtn.getAttribute('aria-pressed'));
    handBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    ok(handBtn.getAttribute('aria-pressed') === 'false', 'and it can be put down again');

    const vbA = vb(), wA = imgW();
    pointer(hit, 'pointerdown', 300, 300, { pointerId: 1 });
    pointer(hit, 'pointerdown', 340, 340, { pointerId: 2 });
    await new Promise((r) => setTimeout(r, 0));
    pointer(hit, 'pointermove', 260, 260, { pointerId: 1 });
    pointer(hit, 'pointermove', 380, 380, { pointerId: 2 });   // spread: zoom the photo in
    await new Promise((r) => setTimeout(r, 0));
    pointer(hit, 'pointerup', 260, 260, { pointerId: 1 });
    pointer(hit, 'pointerup', 380, 380, { pointerId: 2 });
    await new Promise((r) => setTimeout(r, 30));

    ok(imgW() > wA, 'a pinch ON the photograph still zooms the photograph',
      `${wA.toFixed(0)} -> ${imgW().toFixed(0)} units`);
    ok(vb() === vbA, 'and leaves the view exactly where it was');

    /* ---- A2. the same pinch with the Hand out: nothing happens to the photo ---- */
    {
      handBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      ok(handBtn.getAttribute('aria-pressed') === 'true', 'the Hand is picked up again');
      const wBefore = imgW();
      pointer(hit, 'pointerdown', 300, 300, { pointerId: 21 });
      pointer(hit, 'pointerdown', 340, 340, { pointerId: 22 });
      await new Promise((r) => setTimeout(r, 0));
      pointer(hit, 'pointermove', 260, 260, { pointerId: 21 });
      pointer(hit, 'pointermove', 380, 380, { pointerId: 22 });
      await new Promise((r) => setTimeout(r, 0));
      pointer(hit, 'pointerup', 260, 260, { pointerId: 21 });
      pointer(hit, 'pointerup', 380, 380, { pointerId: 22 });
      await new Promise((r) => setTimeout(r, 30));
      ok(imgW() === wBefore,
        'a pinch on the photograph does NOT zoom it while the Hand is out',
        `${wBefore.toFixed(0)} -> ${imgW().toFixed(0)} units`);
      /* And back down, so B and everything after it is the old behaviour. */
      handBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    }

    /* ---- B. two fingers on empty board: the view pans ---- */
    const vbB = vb(), wB = imgW();
    pointer(svg, 'pointerdown', 120, 120, { pointerId: 11 });
    pointer(svg, 'pointerdown', 160, 140, { pointerId: 12 });
    await new Promise((r) => setTimeout(r, 0));
    pointer(svg, 'pointermove', 80, 90, { pointerId: 11 });     // both the same way: a drag
    pointer(svg, 'pointermove', 120, 110, { pointerId: 12 });
    await new Promise((r) => setTimeout(r, 0));
    pointer(svg, 'pointerup', 80, 90, { pointerId: 11 });
    pointer(svg, 'pointerup', 120, 110, { pointerId: 12 });
    await new Promise((r) => setTimeout(r, 30));

    ok(vb() !== vbB, 'two fingers on empty board pan the view', `${vbB} -> ${vb()}`);
    ok(Math.abs(imgW() - wB) < 0.5, 'and do not touch the photograph', `${wB.toFixed(0)} units`);

    /* ---- C. one finger on empty board, zoomed: also pans ---- */
    const vbC = vb();
    await b.drag(svg, { x: 200, y: 200 }, -40, -30);
    ok(vb() !== vbC, 'and so does one finger, once the view is zoomed');

    /* ---- D. Fit puts it back, and locks the pan ---- */
    $('viewFit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    ok($('viewPct').textContent.trim() === '100%', 'Fit returns to 100%', $('viewPct').textContent);
    const vbFit = vb();
    await b.drag(svg, { x: 200, y: 200 }, -60, -60);
    ok(vb() === vbFit, 'and at Fit there is nothing to pan');

    /* ---- E2. Ctrl and the wheel ---- */
    {
      $('viewFit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      const plain = new window.Event('wheel', { bubbles: true, cancelable: true });
      Object.assign(plain, { deltaY: -100, clientX: 300, clientY: 300, ctrlKey: false });
      svg.dispatchEvent(plain);
      await new Promise((r) => setTimeout(r, 20));
      ok($('viewPct').textContent.trim() === '100%',
        'a plain wheel is left for the page to scroll', $('viewPct').textContent);
      ok(!plain.defaultPrevented, 'and is not swallowed');

      const zoomWheel = new window.Event('wheel', { bubbles: true, cancelable: true });
      Object.assign(zoomWheel, { deltaY: -100, clientX: 300, clientY: 300, ctrlKey: true });
      svg.dispatchEvent(zoomWheel);
      await new Promise((r) => setTimeout(r, 20));
      ok($('viewPct').textContent.trim() === '125%',
        'ctrl and the wheel zooms a quarter at a time', $('viewPct').textContent);
      ok(zoomWheel.defaultPrevented, 'and stops the browser zooming the page too');

      const out = new window.Event('wheel', { bubbles: true, cancelable: true });
      Object.assign(out, { deltaY: 100, clientX: 300, clientY: 300, ctrlKey: true });
      svg.dispatchEvent(out);
      await new Promise((r) => setTimeout(r, 20));
      ok($('viewPct').textContent.trim() === '100%', 'and back out again', $('viewPct').textContent);
    }

    /* ---- E. a size change comes back to Fit ---- */
    $('viewIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    ok($('viewPct').textContent.trim() !== '100%', 'zoomed again for the next one');
    const sizeSel = $('sizeSel');
    sizeSel.value = String(sizeSel.options.length > 1 ? 0 : 0);
    sizeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 90));
    ok($('viewPct').textContent.trim() === '100%',
      'changing the print size puts the view back to Fit', $('viewPct').textContent);
  } finally { b.close(); }
}


/* ───────────── what it looks like ───────────── */

{
  const sharp = createRequire(path.join(REPO, 'package.json'))('sharp');
  const { Resvg } = createRequire(path.join(REPO, 'package.json'))('@resvg/resvg-js');
  const OUT = path.join(REPO, 'tools/builder/print-out/_review/zoom');
  fs.mkdirSync(OUT, { recursive: true });
  const fontDir = path.join(REPO, 'tools/builder/renderer/_fonts');
  const fontFiles = fs.existsSync(fontDir)
    ? fs.readdirSync(fontDir).map((f) => path.join(fontDir, f)) : [];
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

  const b = await open('personalised-book-covers', 'shots');
  try {
    const { $, svg, root, window } = b;
    $('fmtSel').value = 'gallery'; $('fmtSel').dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 70));
    const consent = root.querySelector('#consent');
    if (consent && !consent.checked) {
      consent.checked = true;
      consent.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    const picker = root.querySelector('#picker');
    Object.defineProperty(picker, 'files', {
      value: [new window.File([new Uint8Array([1])], 'p.png', { type: 'image/png' })], configurable: true });
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 160));

    const shoot = async (name) => {
      const live = svg.cloneNode(true);
      live.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      live.querySelectorAll('.hit').forEach((el) => el.remove());
      for (const im of live.querySelectorAll('image')) {
        const href = im.getAttribute('href') || '';
        if (href.startsWith('/builder/')) {
          const file = path.join(DIST, href);
          if (fs.existsSync(file)) {
            im.setAttribute('href', `data:${MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,`
              + fs.readFileSync(file).toString('base64'));
            continue;
          }
        }
        /* The photograph is a blob: url in here; a flat colour stands in for it
           so the frame shows where it sits rather than nothing at all. */
        if (!href.startsWith('data:')) im.removeAttribute('href');
      }
      const vb = (live.getAttribute('viewBox') || '').split(/\s+/).map(Number);
      live.setAttribute('width', Math.round(vb[2]));
      live.setAttribute('height', Math.round(vb[3]));
      const png = new Resvg(new window.XMLSerializer().serializeToString(live), {
        fitTo: { mode: 'width', value: 700 },
        font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Chewy' },
        background: '#0B0B0B',
      }).render().asPng();
      await sharp(png).png().toFile(path.join(OUT, `${name}.png`));
    };

    await shoot('cover-gallery-100');
    for (let i = 0; i < 4; i++) $('viewIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    ok($('viewPct').textContent.trim() === '200%', 'stepped to 200% in quarters', $('viewPct').textContent);
    await shoot('cover-gallery-200');
    for (let i = 0; i < 8; i++) $('viewIn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    ok($('viewPct').textContent.trim() === '400%', 'and stops at 400%', $('viewPct').textContent);
    /* Off centre, so the screenshot shows a pan as well as a zoom. */
    await b.drag(svg, { x: 300, y: 300 }, -120, -90);
    await shoot('cover-gallery-400-panned');
    say(`\n  screenshots in ${path.relative(REPO, OUT)}`);
  } finally { b.close(); }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
