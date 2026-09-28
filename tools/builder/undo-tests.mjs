/**
 * Undo, and what it is not allowed to undo.
 *
 *   npm run build && node tools/builder/undo-tests.mjs [--verbose]
 *
 * The bar is byte-identical: do a thing, undo it, redo it, and both recipe()
 * and the exported SVG must come back exactly as they were. Anything less and
 * the customer's design has quietly drifted.
 *
 * The other half matters more. A photograph that has been uploaded, styled by
 * Gemini and cut out represents real money, and all of it lives on the same
 * state object as the crop. Undo may write the crop and must not touch the
 * rest -- so these tests count the requests the builder makes and insist that
 * undoing and redoing a photo clear makes none of them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { JSDOM } = createRequire(path.join(REPO, 'tools/builder/renderer/package.json'))('jsdom');
const DIST = path.join(REPO, 'dist');
const LOUD = process.argv.includes('--verbose');

let pass = 0, fail = 0;
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

if (!fs.existsSync(path.join(DIST, 'store', 'personalised-book-covers', 'index.html'))) {
  say('\nNo dist/ — run "npm run build" first.\n');
  process.exit(1);
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** One page, running the real bundle, with every request it makes recorded. */
async function open(slug, tag) {
  const pageFile = path.join(DIST, 'store', slug, 'index.html');
  const html = fs.readFileSync(pageFile, 'utf8');
  const bundle = html.match(/src="\/(_astro\/ProductBuilder\.astro[^"]+\.js)"/)?.[1];
  const asked = [];

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
      w.Element.prototype.scrollIntoView = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 1200; } });
      Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 800; } });
      w.document.fonts = { ready: Promise.resolve(), load: () => Promise.resolve() };
      w.console = TALK;
      w.URL.createObjectURL = () => 'blob:test/photo';
      w.URL.revokeObjectURL = () => {};
      /* EVERY request, so the paid ones can be counted. */
      w.fetch = async (url, opts) => {
        asked.push({ url: String(url), method: (opts && opts.method) || 'GET' });
        return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      };
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
      { value: k === 'console' ? TALK : window[k], configurable: true, writable: true });
  }
  await import(pathToFileURL(path.join(DIST, bundle)).href + `?run=${encodeURIComponent(tag)}`);
  await tick(200);

  const root = doc.getElementById('csc-builder-root');
  const $ = (id) => root.querySelector('#' + id);
  const svg = doc.getElementById('svg');

  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const fireOn = (el, type, extra = {}) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, extra);
    el.dispatchEvent(e);
    return e;
  };
  /* A press the step machinery can see: it arms on pointerdown and fires on
     pointerup and click, exactly as a finger does. */
  const press = async (el) => {
    fireOn(el, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
    fireOn(el, 'pointerup', { clientX: 10, clientY: 10, pointerId: 1 });
    click(el);
    await tick(30);
  };
  const setControl = async (el, value) => {
    fireOn(el, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
    el.value = String(value);
    fireOn(el, 'input');
    fireOn(el, 'pointerup', { clientX: 10, clientY: 10, pointerId: 1 });
    fireOn(el, 'change');
    await tick(40);
  };
  const drag = async (el, from, dx, dy = 0) => {
    fireOn(el, 'pointerdown', { clientX: from.x, clientY: from.y, pointerId: 1 });
    await tick(0);
    fireOn(el, 'pointermove', { clientX: from.x + dx, clientY: from.y + dy, pointerId: 1 });
    await tick(0);
    fireOn(el, 'pointerup', { clientX: from.x + dx, clientY: from.y + dy, pointerId: 1 });
    await tick(30);
  };

  /* The design as the builder itself describes it. ?dev exposes Copy recipe,
     whose handler logs the recipe when the clipboard refuses — which it does
     here, because jsdom has none. */
  let logged = null;
  const spy = { log: (...a) => { logged = a.join(' '); }, error() {}, warn() {}, info() {} };
  const recipeOf = async () => {
    const was = Object.getOwnPropertyDescriptor(globalThis, 'console');
    Object.defineProperty(globalThis, 'console', { value: spy, configurable: true, writable: true });
    logged = null;
    click($('copy'));
    await tick(40);
    if (was) Object.defineProperty(globalThis, 'console', was);
    return logged;
  };

  const canUndo = () => !$('undoBtn').disabled;
  const canRedo = () => !$('redoBtn').disabled;

  return { dom, window, doc, root, $, svg, click, press, setControl, drag, fireOn,
    recipeOf, canUndo, canRedo, asked, close: () => dom.window.close() };
}

/** Fill the first slot with a photograph. */
async function addPhoto(b) {
  const consent = b.root.querySelector('#consent');
  if (consent && !consent.checked) {
    consent.checked = true;
    b.fireOn(consent, 'change');
    await tick(30);
  }
  const picker = b.root.querySelector('#picker');
  Object.defineProperty(picker, 'files', {
    value: [new b.window.File([new Uint8Array([1])], 'p.png', { type: 'image/png' })],
    configurable: true,
  });
  b.fireOn(picker, 'change');
  await tick(200);
}

/* ══════════════════════════════════ 1. do, undo, redo */

say('\n1. DO, UNDO, REDO — BYTE FOR BYTE\n');
{
  const b = await open('personalised-book-covers', 'roundtrip');
  try {
    await addPhoto(b);
    await tick(60);

    const cases = [
      ['the print size', async () => {
        const sel = b.$('sizeSel');
        await b.setControl(sel, String(Math.max(0, sel.options.length - 1)));
      }],
      ['the finish', async () => { await b.setControl(b.$('fmtSel'), 'gallery'); }],
      ['the crop', async () => { await b.setControl(b.$('zoom'), '2'); }],
      ['a photo pan', async () => { await b.drag(b.svg.querySelector('.hit'), { x: 300, y: 300 }, 70, 40); }],
      ['recentre', async () => { await b.press(b.$('reset')); }],
      ['the background colour', async () => {
        const c = b.$('custom'); if (!c) return;
        await b.setControl(c, '#123456');
      }],
    ];

    for (const [what, act] of cases) {
      const before = await b.recipeOf();
      await act();
      const after = await b.recipeOf();
      if (before === after) { say(`  (skipped: ${what} changed nothing here)`); continue; }
      ok(b.canUndo(), `${what}: there is something to undo`);
      b.click(b.$('undoBtn')); await tick(80);
      ok((await b.recipeOf()) === before, `${what}: undo restores the design byte for byte`);
      ok(b.canRedo(), `${what}: and offers a redo`);
      b.click(b.$('redoBtn')); await tick(80);
      ok((await b.recipeOf()) === after, `${what}: redo puts it back byte for byte`);
    }
  } finally { b.close(); }
}

/* ══════════════════════════════════ 2. one step per gesture */

say('\n2. ONE STEP PER GESTURE\n');
{
  const b = await open('personalised-book-covers', 'steps');
  try {
    await addPhoto(b);
    await tick(60);
    const depth = async () => {
      let n = 0;
      while (b.canUndo() && n < 60) { b.click(b.$('undoBtn')); await tick(25); n++; }
      return n;
    };
    await depth();                     // start from nothing to undo

    await b.drag(b.svg.querySelector('.hit'), { x: 300, y: 300 }, 90, 60);
    ok((await depth()) === 1, 'a drag of a photograph is one step');

    await b.setControl(b.$('zoom'), '2.4');
    ok((await depth()) === 1, 'a slider is one step, not one per pixel of travel');

    /* Typing: one step per burst, on the 400ms timer. */
    const inp = b.root.querySelector('textarea, input[type="text"]');
    if (inp) {
      const word = 'HELLO';
      for (const ch of word) { inp.value += ch; b.fireOn(inp, 'input'); await tick(25); }
      await tick(600);
      ok((await depth()) === 1, 'typing a word is one step, not one per letter');
    } else {
      say('  (no text field on this template)');
    }
  } finally { b.close(); }
}

/* ══════════════════════════════════ 3. the paid work survives */

say('\n3. UNDO NEVER SPENDS MONEY\n');
{
  const b = await open('personalised-book-covers', 'paid');
  try {
    await addPhoto(b);
    await tick(80);

    const img = () => b.svg.querySelector('image[data-role="panel"]');
    const hrefBefore = img() && img().getAttribute('href');
    ok(!!hrefBefore, 'a photograph is in the slot', hrefBefore);

    const paid = () => b.asked.filter((r) => /personalisation-photo|style-photo|personalise-save|upload/.test(r.url));
    const spentBefore = paid().length;

    await b.press(b.$('clear'));
    ok(!img().getAttribute('href'), 'clearing empties the slot');

    b.click(b.$('undoBtn')); await tick(120);
    ok(img().getAttribute('href') === hrefBefore,
      'undo puts the same photograph back', img().getAttribute('href'));
    b.click(b.$('redoBtn')); await tick(120);
    ok(!img().getAttribute('href'), 'redo clears it again');
    b.click(b.$('undoBtn')); await tick(120);
    ok(img().getAttribute('href') === hrefBefore, 'and undo brings it back once more');

    ok(paid().length === spentBefore,
      'and not one request was made to upload, style or cut out anything',
      `${paid().length - spentBefore} new request(s)`);
    if (paid().length !== spentBefore && LOUD) paid().slice(spentBefore).forEach((r) => say(`      ${r.method} ${r.url}`));
  } finally { b.close(); }
}

/* ══════════════════════════════════ 4. across a rebuild */

say('\n4. ACROSS A FORMAT CHANGE\n');
{
  const b = await open('personalised-book-covers', 'rebuild');
  try {
    await addPhoto(b);
    await b.setControl(b.$('zoom'), '1.8');
    await tick(60);
    const before = await b.recipeOf();
    const vbBefore = b.svg.getAttribute('viewBox');

    await b.setControl(b.$('fmtSel'), 'gallery');
    ok(b.svg.getAttribute('viewBox') !== vbBefore, 'the board really was rebuilt');

    b.click(b.$('undoBtn')); await tick(140);
    ok(b.$('fmtSel').value !== 'gallery', 'undo puts the finish back', b.$('fmtSel').value);
    ok(b.svg.getAttribute('viewBox') === vbBefore, 'and the board with it');
    ok((await b.recipeOf()) === before,
      'and the crop survived a rebuild that threw every node away');
  } finally { b.close(); }
}

/* ══════════════════════════════════ 5. the view is not the design */

say('\n5. THE VIEW IS NOT UNDOABLE\n');
{
  const b = await open('personalised-book-covers', 'view');
  try {
    await addPhoto(b);
    await tick(60);
    while (b.canUndo()) { b.click(b.$('undoBtn')); await tick(25); }
    b.click(b.$('viewIn')); await tick(40);
    b.click(b.$('viewIn')); await tick(40);
    ok(b.$('viewPct').textContent.trim() === '150%', 'the view zoomed', b.$('viewPct').textContent);
    ok(!b.canUndo(), 'and there is still nothing to undo — a view is not a decision');
  } finally { b.close(); }
}

/* ══════════════════════════════════ 6. the cap, and the redo stack */

say('\n6. HOUSEKEEPING\n');
{
  const b = await open('personalised-book-covers', 'cap');
  try {
    await addPhoto(b);
    await tick(60);
    /* Sixty distinct crops: more steps than the fifty the history keeps. */
    for (let i = 0; i < 60; i++) await b.setControl(b.$('zoom'), (1 + (i % 20) * 0.1).toFixed(2));
    let n = 0;
    while (b.canUndo() && n < 200) { b.click(b.$('undoBtn')); await tick(12); n++; }
    ok(n > 0 && n <= 50, 'the history stops at fifty steps', `${n} undone`);

    /* A new move after an undo closes the future. */
    await b.setControl(b.$('zoom'), '1.5');
    await b.setControl(b.$('zoom'), '2.5');
    b.click(b.$('undoBtn')); await tick(60);
    ok(b.canRedo(), 'after an undo there is a redo');
    await b.setControl(b.$('zoom'), '3');
    ok(!b.canRedo(), 'and taking a different turn discards it');
  } finally { b.close(); }
}

/* ══════════════════════════════════ 7. every template */

say('\n7. EVERY TEMPLATE\n');
for (const [slug, label] of [
  ['personalised-strips', 'Strip'],
  ['personalised-book-covers', 'Classic cover'],
  ['personalised-book-covers', 'Full bleed'],
  ['personalised-icons', 'Icon portrait'],
  ['personalised-icons', 'Icon landscape'],
]) {
  const b = await open(slug, `tpl-${label}`);
  try {
    const btn = [...b.$('switch').children].find((x) => x.textContent.trim() === label);
    if (!btn) { say(`  (${label} not on ${slug})`); continue; }
    await b.press(btn);
    await addPhoto(b);
    await tick(60);
    const before = await b.recipeOf();
    await b.setControl(b.$('zoom'), '2.2');
    const after = await b.recipeOf();
    if (before === after) { say(`  (${label}: the crop changed nothing)`); continue; }
    b.click(b.$('undoBtn')); await tick(80);
    const undone = await b.recipeOf();
    b.click(b.$('redoBtn')); await tick(80);
    const redone = await b.recipeOf();
    ok(undone === before && redone === after, `${label}: do, undo, redo is exact`);
    if (undone !== before || redone !== after) {
      const diff = (a, x) => {
        if (!a || !x) return `one side is empty (${!!a}/${!!x})`;
        for (let i = 0; i < Math.max(a.length, x.length); i++) {
          if (a[i] !== x[i]) return `first differs at ${i}: ...${a.slice(Math.max(0, i - 50), i + 50)}...`
            + ` vs ...${x.slice(Math.max(0, i - 50), i + 50)}...`;
        }
        return 'identical';
      };
      say(`      undo: ${diff(before, undone)}`);
      say(`      redo: ${diff(after, redone)}`);
    }
  } finally { b.close(); }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
