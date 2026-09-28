/**
 * Type like a person, then press Undo.
 *
 *   npm run build && node tools/builder/undo-typing-repro.mjs
 *
 * Alan's report: type or delete a few characters in a caption, press Undo, and
 * it steps back ONE character and then greys out. Everything before that burst
 * is gone.
 *
 * The undo suite missed it because it typed by assigning .value and firing one
 * input event per character with no keydown and no realistic gap. This types
 * the way a keyboard does -- keydown, the value change, input, keyup -- at
 * 80-150ms, and deletes with Backspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { JSDOM } = createRequire(path.join(REPO, 'tools/builder/renderer/package.json'))('jsdom');
const DIST = path.join(REPO, 'dist');
const REAL = console;
const say = REAL.log.bind(REAL);
const HUSH = { log() {}, error() {}, warn() {}, info() {} };
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const html = fs.readFileSync(path.join(DIST, 'store/personalised-book-covers/index.html'), 'utf8');
const bundle = html.match(/src="\/(_astro\/ProductBuilder\.astro[^"]+\.js)"/)[1];

const dom = new JSDOM(html, {
  runScripts: 'outside-only', pretendToBeVisual: true,
  url: 'https://x/store/personalised-book-covers?dev',
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
  'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage', 'getComputedStyle',
  'URLSearchParams', 'Blob', 'File', 'FormData', 'location', 'navigator', 'URL',
  'HTMLElement', 'SVGElement', 'Element', 'Node', 'fetch', 'console']) {
  if (window[k] === undefined && k !== 'console') continue;
  Object.defineProperty(globalThis, k,
    { value: k === 'console' ? HUSH : window[k], configurable: true, writable: true });
}
await import(pathToFileURL(path.join(DIST, bundle)).href + '?repro=1');
await tick(200);

const root = doc.getElementById('csc-builder-root');
const $ = (id) => root.querySelector('#' + id);
const fire = (el, type, extra = {}) => {
  const e = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, extra);
  el.dispatchEvent(e);
  return e;
};

/** A keystroke as a keyboard sends one. */
async function typeChar(el, ch, ms) {
  fire(el, 'keydown', { key: ch });
  el.value += ch;
  fire(el, 'input');
  fire(el, 'keyup', { key: ch });
  await tick(ms);
}
async function backspace(el, ms) {
  fire(el, 'keydown', { key: 'Backspace' });
  el.value = el.value.slice(0, -1);
  fire(el, 'input');
  fire(el, 'keyup', { key: 'Backspace' });
  await tick(ms);
}

/* Re-queried every time: the rail is rebuilt on a restore, so a reference
   held across an undo points at a detached element. */
const fieldNow = () => root.querySelector('textarea, input[type="text"]');
const svgText = () => {
  const t = doc.getElementById('svg').querySelector('text');
  return t ? t.textContent : '(none)';
};
const field = fieldNow();
const label = field ? (field.id || field.name || '(text)') : null;
if (!field) { say('no text field found'); process.exit(1); }

/* Focus it, the way a click does. */
fire(field, 'pointerdown', { clientX: 5, clientY: 5, pointerId: 1 });
fire(field, 'pointerup', { clientX: 5, clientY: 5, pointerId: 1 });
field.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
Object.defineProperty(doc, 'activeElement', { value: field, configurable: true });
await tick(60);

const start = field.value;
say(`\nfield: ${label}`);
say(`start: ${JSON.stringify(start)}`);

/* One burst: five characters at human speed. */
for (const ch of 'ABCDE') await typeChar(field, ch, 110);
await tick(600);                       // let the burst settle
const afterTyping = field.value;
say(`typed: ${JSON.stringify(afterTyping)}`);

/* A second burst after a clear pause, then two deletions. */
for (const ch of 'XY') await typeChar(field, ch, 130);
await tick(600);
await backspace(field, 120);
await backspace(field, 120);
await tick(600);
const afterAll = field.value;
say(`then : ${JSON.stringify(afterAll)}   (expect three separate steps behind this)`);
say(`svg  : ${JSON.stringify(svgText())}`);

say('\npressing Undo repeatedly:');
const seen = [];
for (let i = 0; i < 8; i++) {
  const disabled = $('undoBtn').disabled;
  if (disabled) { say(`  ${i + 1}. Undo is DISABLED — history empty`); break; }
  $('undoBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick(120);
  const live = fieldNow();
  seen.push(live.value);
  say(`  ${i + 1}. undo -> field ${JSON.stringify(live.value)}`);
  say(`             svg   ${JSON.stringify(svgText())}`);
  say(`             same element as before? ${live === field}`);
}

say('');
if (seen.length === 0) say('RESULT: Undo was disabled immediately.');
else if (seen.length === 1) say(`RESULT: only ONE step. Undo went to ${JSON.stringify(seen[0])} and stopped.`);
else say(`RESULT: ${seen.length} steps: ${seen.map((v) => JSON.stringify(v)).join(' -> ')}`);
say(`back to the start? ${seen[seen.length - 1] === start ? 'yes' : 'NO — expected ' + JSON.stringify(start)}`);
dom.window.close();
process.exit(0);
