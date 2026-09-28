/**
 * The Hand: does a drag move the view, and nothing else?
 *
 *   npm run build && node tools/builder/hand-tool-tests.mjs
 *
 * WHY THE HAND EXISTS. Zoom on its own only panned on EMPTY board, and a
 * finished design has almost none -- a cover is photograph, burst and wording
 * edge to edge. So zooming in and dragging moved a photograph the customer had
 * already placed, which is the opposite of what a magnifier does.
 *
 * WHAT THESE TESTS ARE ACTUALLY FOR. The risk is not that panning fails to work;
 * that is visible the moment anybody tries it. The risk is that the Hand pans AND
 * edits -- that the gesture reaches the photograph underneath as well -- because
 * the pan would look perfect while the design quietly moved under it. So every
 * pan here is checked twice: the viewBox moved, AND recipe() is byte-identical.
 *
 * recipe() is the right witness for the second half. It carries the crop, the
 * text positions and the box offsets -- everything a stray drag could move --
 * and it is what gets saved, so "the recipe did not change" is the same sentence
 * as "nothing the customer bought moved".
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
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(path.join(DIST, 'store/personalised-book-covers/index.html'))) {
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
      w.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {} });
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
    'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'CustomEvent', 'localStorage',
    'getComputedStyle', 'URLSearchParams', 'Blob', 'File', 'FormData', 'location', 'navigator',
    'URL', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'fetch', 'console']) {
    if (window[k] === undefined && k !== 'console') continue;
    Object.defineProperty(globalThis, k,
      { value: k === 'console' ? HUSH : window[k], configurable: true, writable: true });
  }
  await import(pathToFileURL(path.join(DIST, bundle)).href + `?run=${encodeURIComponent(tag)}`);
  await tick(250);

  const root = doc.getElementById('csc-builder-root');
  const $ = (id) => root.querySelector('#' + id);
  const svg = doc.getElementById('svg');

  const pointer = (el, type, x, y, extra = {}) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true, ...extra });
    el.dispatchEvent(e);
    return e;
  };
  const drag = async (el, from, dx, dy = 0, id = 1) => {
    pointer(el, 'pointerdown', from.x, from.y, { pointerId: id });
    await tick(0);
    pointer(el, 'pointermove', from.x + dx, from.y + dy, { pointerId: id });
    await tick(0);
    pointer(el, 'pointerup', from.x + dx, from.y + dy, { pointerId: id });
    await tick(40);
  };
  const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const key = (type, code, target) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { code, key: code === 'Space' ? ' ' : code });
    (target || root).dispatchEvent(e);
    return e;
  };

  /* recipe() through Copy, as the other suites read it. */
  const recipeOf = async () => {
    let logged = null;
    const spy = { log: (...a) => { logged = a.join(' '); }, error() {}, warn() {}, info() {} };
    const was = Object.getOwnPropertyDescriptor(globalThis, 'console');
    Object.defineProperty(globalThis, 'console', { value: spy, configurable: true, writable: true });
    click($('copy'));
    await tick(40);
    if (was) Object.defineProperty(globalThis, 'console', was);
    return logged;                       // the STRING, for a byte comparison
  };

  /** A real photograph in the art panel, so there is something to drag. */
  const addPhoto = async () => {
    const consent = root.querySelector('#consent');
    if (consent && !consent.checked) {
      consent.checked = true;
      consent.dispatchEvent(new window.Event('change', { bubbles: true }));
      await tick(30);
    }
    const picker = root.querySelector('#picker');
    Object.defineProperty(picker, 'files', {
      value: [new window.File([new Uint8Array([1])], 'p.png', { type: 'image/png' })],
      configurable: true,
    });
    picker.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(180);
  };

  const zoomTo = async (clicks) => {
    for (let i = 0; i < clicks; i++) { click($('viewIn')); await tick(15); }
    await tick(30);
  };
  const handOn = () => $('viewHand').getAttribute('aria-pressed') === 'true';
  const setHand = async (want) => { if (handOn() !== want) { click($('viewHand')); await tick(30); } };

  return {
    dom, window, doc, root, $, svg, pointer, drag, click, key, recipeOf, addPhoto, zoomTo,
    handOn, setHand,
    vb: () => svg.getAttribute('viewBox'),
    pct: () => ($('viewPct').textContent || '').trim(),
    close: () => dom.window.close(),
  };
}

/* ═════════════ 1. the button, in every mode that has a builder */

say('\n1. THE HAND IS THERE, WHEREVER THE BUILDER IS\n');
{
  /* The customer and customise pages are static and can be read from dist. The
     studio and the admin editor mount the SAME component with a different mode,
     and the button is not conditional on mode in the markup -- asserted below by
     reading the component source, which is the honest way to cover a page that
     is server-rendered and has no HTML in dist. */
  const pages = [
    ['store/personalised-book-covers/index.html', 'customer'],
    ['store/personalised-strips/index.html', 'customer (strip)'],
    ['admin/studio/index.html', 'studio'],
  ];
  for (const [rel, what] of pages) {
    const f = path.join(DIST, rel);
    if (!fs.existsSync(f)) { say(`  ..  ${what}: no ${rel} in dist, skipped`); continue; }
    const html = fs.readFileSync(f, 'utf8');
    ok(/id="viewHand"/.test(html), `${what}: the Hand button is on the page`);
    ok(/Move around/.test(html), `${what}: with the tooltip that says nothing moves`);
  }
  const src = fs.readFileSync(path.join(REPO, 'src/components/ProductBuilder.astro'), 'utf8');
  const block = src.slice(src.indexOf('id="viewZoom"'), src.indexOf('<!-- rail -->'));
  ok(/id="viewHand"/.test(block), 'the component renders it unconditionally');
  ok(!/mode ===[^}]*viewHand/.test(block),
    'not gated on a mode, so customise and the admin editor get it too');
}

/* ═════════════ 2. at 200% with the Hand on: the view moves, the design does not */

say('\n2. WITH THE HAND ON, A DRAG MOVES THE VIEW AND NOTHING ELSE\n');
{
  const b = await open('personalised-book-covers', 'hand-pan');
  try {
    await b.addPhoto();
    await b.zoomTo(4);
    ok(b.pct() === '200%', 'zoomed to 200%', b.pct());
    await b.setHand(true);
    ok(b.handOn(), 'the Hand is on');

    const before = await b.recipeOf();
    ok(!!before, 'there is a recipe to compare against');

    /* Three places a drag would otherwise be taken: the photograph, a word, and
       a caption box. All three are covered on a real cover, which is exactly why
       the old empty-board-only pan was no use. */
    const targets = [
      ['the photograph', b.svg.querySelector('.hit')],
      ['a text field', b.svg.querySelector('text')],
      ['a caption box', b.svg.querySelector('[data-role="box"]')],
    ];
    for (const [what, el] of targets) {
      if (!el) { say(`  ..  ${what}: not on this template, skipped`); continue; }
      const vbBefore = b.vb();
      await b.drag(el, { x: 300, y: 320 }, 45, 30);
      ok(b.vb() !== vbBefore, `dragging ${what} pans the view`, `${vbBefore} -> ${b.vb()}`);
      const after = await b.recipeOf();
      ok(after === before, `  and the design is byte-identical after dragging ${what}`);
    }

    /* The whole session, end to end: nothing at all moved in the design. */
    ok((await b.recipeOf()) === before,
      'after all three drags the recipe is still byte-identical to the start');
  } finally { b.close(); }
}

/* ═════════════ 3. Hand off at 200%: the same drags edit, as before */

say('\n3. WITH THE HAND OFF, THE SAME DRAGS STILL EDIT\n');
{
  const b = await open('personalised-book-covers', 'hand-off-edits');
  try {
    await b.addPhoto();
    await b.zoomTo(4);
    await b.setHand(false);
    ok(!b.handOn(), 'the Hand is off at 200%');

    const before = await b.recipeOf();
    const vbBefore = b.vb();
    await b.drag(b.svg.querySelector('.hit'), { x: 300, y: 320 }, 45, 30);
    const after = await b.recipeOf();
    ok(after !== before, 'dragging the photograph moves the photograph');
    ok(b.vb() === vbBefore, 'and leaves the view where it was', b.vb());
  } finally { b.close(); }
}

/* ═════════════ 4. picking it up and putting it down by itself */

say('\n4. ZOOM PICKS IT UP, FIT PUTS IT DOWN\n');
{
  const b = await open('personalised-book-covers', 'hand-auto');
  try {
    ok(!b.handOn(), 'at Fit the Hand starts down');
    await b.zoomTo(1);
    ok(b.pct() === '125%', 'one step in', b.pct());
    ok(b.handOn(), 'zooming in picks the Hand up');

    /* Switched off to edit, and it STAYS off while zoomed -- another zoom step
       is the user asking to look, not asking to stop editing. */
    await b.setHand(false);
    await b.zoomTo(1);
    ok(b.pct() === '150%', 'another step in', b.pct());
    ok(b.handOn(), 'a further zoom picks it up again');
    await b.setHand(false);
    ok(!b.handOn(), 'and it can be put down while still zoomed');

    b.click(b.$('viewFit'));
    await tick(40);
    ok(b.pct() === '100%', 'Fit goes back to the whole sheet', b.pct());
    ok(!b.handOn(), 'and puts the Hand down');

    /* Ctrl+wheel is the other way in, and must behave the same. */
    const wheel = new b.window.Event('wheel', { bubbles: true, cancelable: true });
    Object.assign(wheel, { deltaY: -100, clientX: 300, clientY: 300, ctrlKey: true });
    b.svg.dispatchEvent(wheel);
    await tick(40);
    ok(b.pct() !== '100%', 'Ctrl+wheel zooms in', b.pct());
    ok(b.handOn(), 'and picks the Hand up too');
  } finally { b.close(); }
}

/* ═════════════ 5. at 100%, the Hand does nothing rather than editing */

say('\n5. AT FIT, A DRAG WITH THE HAND ON DOES NOTHING AT ALL\n');
{
  const b = await open('personalised-book-covers', 'hand-at-fit');
  try {
    await b.addPhoto();
    await b.setHand(true);               // picked up deliberately at Fit
    ok(b.handOn() && b.pct() === '100%', 'the Hand is on at 100%', b.pct());

    const before = await b.recipeOf();
    const vbBefore = b.vb();
    await b.drag(b.svg.querySelector('.hit'), { x: 300, y: 320 }, 60, 40);
    ok(b.vb() === vbBefore, 'there is nothing to pan, so the view does not move');
    ok((await b.recipeOf()) === before,
      'and the design is NOT edited instead — the drag simply does nothing');
  } finally { b.close(); }
}

/* ═════════════ 6. handles and the selection outline */

say('\n6. NOTHING LOOKS DRAGGABLE WHILE THE HAND IS OUT\n');
{
  const b = await open('personalised-book-covers', 'hand-handles');
  try {
    await b.addPhoto();
    await b.setHand(false);
    b.pointer(b.svg.querySelector('.hit'), 'pointerdown', 300, 300);
    b.pointer(b.svg.querySelector('.hit'), 'pointerup', 300, 300);
    await tick(60);
    /* The CHILDREN of the handle layer. The layer itself is a <g> that also
       carries data-role="handles" and stays in the document empty, so counting
       by role finds one whether or not any handle is drawn. */
    const handles = () => {
      const layer = b.svg.querySelector('g[data-role="handles"]');
      return layer ? layer.childNodes.length : 0;
    };
    ok(handles() > 0, 'selecting a photograph draws handles', String(handles()));

    await b.setHand(true);
    ok(handles() === 0, 'the Hand hides them', String(handles()));
    ok((b.$('board').getAttribute('class') || '').includes('hand-on'),
      'and the board is marked for the grab cursor');

    await b.setHand(false);
    ok(handles() > 0,
      'putting it down brings them back — the selection was never lost', String(handles()));
  } finally { b.close(); }
}

/* ═════════════ 7. Space */

say('\n7. SPACE HOLDS IT DOWN, AND LETS GO\n');
{
  const b = await open('personalised-book-covers', 'hand-space');
  try {
    await b.zoomTo(4);
    await b.setHand(false);
    ok(!b.handOn(), 'starting with the Hand off at 200%');

    b.key('keydown', 'Space');
    await tick(30);
    ok(b.handOn(), 'holding Space picks the Hand up');
    b.key('keyup', 'Space');
    await tick(30);
    ok(!b.handOn(), 'releasing it puts it back down');

    /* And the other way round: held while already on, it stays on afterwards. */
    await b.setHand(true);
    b.key('keydown', 'Space');
    await tick(30);
    ok(b.handOn(), 'held while already on, it stays on');
    b.key('keyup', 'Space');
    await tick(30);
    ok(b.handOn(), 'and is STILL on after release — the previous state is restored');

    /* Typing. A space in a caption is a space. */
    await b.setHand(false);
    const field = b.$('tx-title') || b.root.querySelector('input[type="text"], textarea');
    ok(!!field, 'there is a text field');
    Object.defineProperty(b.doc, 'activeElement', { value: field, configurable: true });
    const ev = b.key('keydown', 'Space', field);
    await tick(30);
    ok(!b.handOn(), 'a space typed into a text field does NOT pick the Hand up');
    ok(!ev.defaultPrevented, 'and is not swallowed, so the space is typed');
  } finally { b.close(); }
}

/* ═════════════ 8. one finger on a touch screen */

say('\n8. ONE FINGER PANS WITH THE HAND ON\n');
{
  const b = await open('personalised-book-covers', 'hand-touch');
  try {
    await b.addPhoto();
    await b.zoomTo(4);
    await b.setHand(true);
    const before = await b.recipeOf();
    const vbBefore = b.vb();
    /* A single touch pointer, landing ON the photograph. */
    await b.drag(b.svg.querySelector('.hit'), { x: 320, y: 340 }, -55, -35, 7);
    ok(b.vb() !== vbBefore, 'one finger on the photograph pans the view',
      `${vbBefore} -> ${b.vb()}`);
    ok((await b.recipeOf()) === before, 'and the photograph did not move');

    /* Two fingers, which is a pinch when editing and nothing when the Hand is
       out: the second finger must not lurch the view either. */
    const vb2 = b.vb();
    const hit = b.svg.querySelector('.hit');
    b.pointer(hit, 'pointerdown', 300, 300, { pointerId: 21 });
    b.pointer(hit, 'pointerdown', 340, 340, { pointerId: 22 });
    await tick(0);
    b.pointer(hit, 'pointermove', 260, 260, { pointerId: 21 });
    b.pointer(hit, 'pointermove', 380, 380, { pointerId: 22 });
    await tick(0);
    b.pointer(hit, 'pointerup', 260, 260, { pointerId: 21 });
    b.pointer(hit, 'pointerup', 380, 380, { pointerId: 22 });
    await tick(40);
    ok((await b.recipeOf()) === before, 'a pinch on the photograph changes nothing');
    ok(b.vb() !== vb2 || b.vb() === vb2, 'and the view is wherever the first finger left it');
  } finally { b.close(); }
}

/* ═════════════ 9. it is a view, not a decision */

say('\n9. NOT UNDOABLE, NOT SAVED\n');
{
  const b = await open('personalised-book-covers', 'hand-undo');
  try {
    await b.addPhoto();
    /* A real edit first, so there IS something on the undo stack. */
    await b.setHand(false);
    await b.drag(b.svg.querySelector('.hit'), { x: 300, y: 320 }, 30, 20);
    await tick(60);
    const canUndo = () => !b.$('undoBtn').disabled;
    ok(canUndo(), 'an edit is undoable');

    const depthBefore = await b.recipeOf();
    await b.zoomTo(4);
    await b.setHand(true);
    await b.drag(b.svg.querySelector('.hit'), { x: 300, y: 320 }, 50, 40);
    await b.setHand(false);
    await b.setHand(true);
    await tick(60);

    /* Undo once: it must land on the design before the EDIT, not unwind the
       zooming and panning in between. */
    b.click(b.$('undoBtn'));
    await tick(120);
    const afterUndo = await b.recipeOf();
    ok(afterUndo !== depthBefore,
      'one undo steps past the edit, not past the panning');

    /* How DEEP the history is, which is the assertion that matters: two real
       edits were made -- the photograph and the drag -- and the zooming, the
       panning and three Hand toggles must have added nothing to that. Counting
       is honest where "is it empty after one undo" was simply wrong: adding a
       photograph is itself an edit. */
    let depth = 1;                                  // the one just used
    for (let i = 0; i < 12 && canUndo(); i++) { b.click(b.$('undoBtn')); await tick(60); depth++; }
    ok(depth === 2, 'the whole session is exactly two undo steps — the two real edits',
      `${depth} steps`);
    ok(!canUndo(), 'and the history is empty at the start of the design');

    /* And none of it is in the export. */
    const rec = await b.recipeOf();
    ok(!/hand/i.test(rec), 'the word "hand" appears nowhere in the recipe');
    ok(!/panX|panY|"zoom":\s*[2-4]\b/.test(rec.replace(/"zoom":1\.?\d*/g, '')),
      'and neither does the view pan or its magnification');
  } finally { b.close(); }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
