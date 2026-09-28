/**
 * The admin editor, driven: does a paid build come back the way it was saved?
 *
 *   npm run build && node tools/builder/admin-edit-tests.mjs
 *
 * WHAT IS ACTUALLY AT RISK
 * ------------------------
 * Reopening a design is easy to do in a way that looks right and quietly throws
 * things away, and the two things it throws away are the two that cost money.
 *
 *   the crop    applyStyled recentres a panel on purpose -- a customer's framing
 *               was chosen against a photograph the model then reframed -- and
 *               in an admin edit that is exactly wrong: the styled image IS what
 *               they framed. A load that went through applyStyled would open
 *               every build centred and unzoomed, and the first save would make
 *               that permanent.
 *   the keys    recipe() re-emits styledKey, cutoutKey, rawKey and imageVariant
 *               from panel state. A panel filled without them saves a recipe
 *               saying this build has no styled artwork, and the renderer has
 *               nothing to print. Nothing on screen would look wrong.
 *
 * Neither shows up in a screenshot, so both are asserted on the recipe.
 *
 * The page itself is server-rendered, so there is no HTML for it in dist/. The
 * bundle is the same file either way and it reads its mode off the root element,
 * so the root is put into admin mode here and the real bundle is imported
 * against it. What is exercised is the shipped JavaScript.
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

if (!fs.existsSync(path.join(DIST, 'store/personalised-book-covers/index.html'))) {
  say('\nNo dist/ — run "npm run build" first.\n');
  process.exit(1);
}

const BUILD_ID = `pp-${'c'.repeat(32)}`;
/** The crop the customer chose. Everything here exists to protect it. */
const CROP = { zoom: 1.85, offsetX: -120, offsetY: 64 };
const KEYS = {
  rawKey: `personalisation/${BUILD_ID}/art.jpg`,
  styledKey: `personalisation/${BUILD_ID}/styled-art.jpg`,
  cutoutKey: `personalisation/${BUILD_ID}/cutout-art.png`,
};

const sceneReply = () => ({
  id: BUILD_ID,
  status: 'rendered',
  editable: true,
  orderNumber: 'CSC-1006',
  template: 'cover',
  templateId: 'cover',
  printSize: '16 × 24 in',
  outputFormat: 'standard',
  editCount: 0,
  rev: 'rev-paid-1',
  missingPanels: [],
  recipe: {
    template: 'cover',
    output: { format: 'standard', faceInches: [16, 24], sizeKey: 'large' },
    panels: [{
      id: 'art',
      image: 'holiday.jpg',
      placeholder: false,
      transform: { ...CROP },
      sourcePx: [3000, 4000], effectiveDpi: 143,
      styledPx: [3000, 4000], cutoutPx: [2900, 3900],
      imageVariant: 'cutout',
      removeBackground: { on: false, spread: 34, soften: 2 },
      ...KEYS,
    }],
    text: [{ id: 'title', value: 'CUSTOMER TITLE', pos: { x: 40, y: 60 } }],
    boxes: [],
    logo: null,
  },
  sceneSvg: '<svg viewBox="0 0 100 100"><text>CUSTOMER TITLE</text></svg>',
  panels: {
    art: {
      styled: `/api/personalisation-photo/${BUILD_ID}/art`,
      cutout: `/api/personalisation-photo/${BUILD_ID}/art?variant=cutout`,
    },
  },
});

/**
 * The endpoints that actually spend something.
 *
 * Not simply "anything with cutout in it": /api/personalisation-photo?variant=cutout
 * reads a PNG that was made and paid for weeks ago, and forbidding that would
 * forbid showing the customer their own artwork. What costs money is asking for
 * the work again --
 *
 *   personalise-save        stores a photograph, and starts a styling run
 *   personalisation-style   a retry, which is a fresh model call
 *   style-photo             the styling run itself
 *   studio-upload           the studio's own upload path
 *
 * The cut-out service is never called from a browser at all -- style-photo calls
 * it server-side -- so the way to spend on a cut-out from here is to trigger a
 * styling run, which the first three cover.
 */
const PAID = /personalise-save|personalisation-style|style-photo|studio-upload/;

async function open(tag, { sceneOverride = null, sceneStatus = 200 } = {}) {
  const html = fs.readFileSync(path.join(DIST, 'store/personalised-book-covers/index.html'), 'utf8');
  const bundle = html.match(/src="\/(_astro\/ProductBuilder\.astro[^"]+\.js)"/)[1];
  const asked = [];
  const imgSrcs = [];
  let saved = null;

  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: `https://x/admin/personalisation/${BUILD_ID}/edit`,
    beforeParse(w) {
      class Img {
        constructor() { this.complete = false; this._l = []; }
        set src(v) {
          /* Recorded here, not in the fetch stub: an <img> never goes through
             fetch(), so asserting on requests would have said the photographs
             were never loaded while they plainly were. */
          imgSrcs.push(String(v));
          this._src = v; this.complete = true;
          this.naturalWidth = 3000; this.naturalHeight = 4000;
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
      w.fetch = async (url, init = {}) => {
        const href = String(url);
        asked.push({ url: href, method: (init.method || 'GET').toUpperCase() });
        if (href.includes('/admin/api/personalisation-scene/')) {
          return {
            ok: sceneStatus === 200, status: sceneStatus,
            json: async () => (sceneOverride || sceneReply()),
          };
        }
        if (href.includes('/admin/api/personalisation-edit-save')) {
          saved = JSON.parse(init.body || '{}');
          return { ok: true, status: 200, json: async () => ({ ok: true, status: 'preparing', editCount: 1 }) };
        }
        if (href.includes('/api/personalisation-photo/')) {
          return { ok: true, status: 200, blob: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
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
  const root = doc.getElementById('csc-builder-root');

  /* Into admin mode, BEFORE the bundle runs: the script reads its mode off the
     root once, at module scope. This is the same switch the server-rendered page
     throws with mode="admin". */
  root.dataset.mode = 'admin';
  root.dataset.buildId = BUILD_ID;
  /* The one control the admin page adds and the customer page does not. */
  const btn = doc.createElement('button');
  btn.id = 'adminSave';
  root.appendChild(btn);
  const note = doc.createElement('p');
  note.id = 'adminSaveNote';
  root.appendChild(note);

  for (const k of ['window', 'document', 'Image', 'FileReader', 'XMLSerializer', 'DOMParser',
    'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage', 'getComputedStyle',
    'URLSearchParams', 'Blob', 'File', 'FormData', 'location', 'navigator', 'URL',
    'HTMLElement', 'SVGElement', 'Element', 'Node', 'fetch', 'console']) {
    if (window[k] === undefined && k !== 'console') continue;
    Object.defineProperty(globalThis, k,
      { value: k === 'console' ? HUSH : window[k], configurable: true, writable: true });
  }
  await import(pathToFileURL(path.join(DIST, bundle)).href + `?run=${encodeURIComponent(tag)}`);
  await tick(400);

  const $ = (id) => root.querySelector('#' + id);
  const svg = doc.getElementById('svg');

  /* recipe() is reached the way the other suites reach it: Copy logs it. */
  const recipeOf = async () => {
    let logged = null;
    const spy = { log: (...a) => { logged = a.join(' '); }, error() {}, warn() {}, info() {} };
    const was = Object.getOwnPropertyDescriptor(globalThis, 'console');
    Object.defineProperty(globalThis, 'console', { value: spy, configurable: true, writable: true });
    $('copy').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick(60);
    if (was) Object.defineProperty(globalThis, 'console', was);
    try { return JSON.parse(logged); } catch { return null; }
  };

  const fireOn = (el, type, extra = {}) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, extra);
    el.dispatchEvent(e);
    return e;
  };
  /* Every event on the SAME element. Sending pointermove to window instead
     looks equivalent and is not -- the handler is bound to the target that took
     the pointerdown -- and a drag that goes nowhere reads as a builder that
     ignores drags. */
  const drag = async (el, from, dx, dy) => {
    fireOn(el, 'pointerdown', { clientX: from.x, clientY: from.y, pointerId: 1, isPrimary: true, button: 0 });
    await tick(10);
    fireOn(el, 'pointermove', { clientX: from.x + dx, clientY: from.y + dy, pointerId: 1, isPrimary: true, button: 0 });
    await tick(10);
    fireOn(el, 'pointerup', { clientX: from.x + dx, clientY: from.y + dy, pointerId: 1, isPrimary: true, button: 0 });
    await tick(80);
  };

  return {
    dom, window, doc, root, $, svg, recipeOf, fireOn, drag,
    asked, imgSrcs,
    /* Requests AND image loads: a cut-out fetched as an <img> still costs
       nothing, but an upload posted as one would not show up in `asked`. */
    paidCalls: () => [...asked.map((a) => a.url), ...imgSrcs].filter((u) => PAID.test(u)),
    savedBody: () => saved,
    click: (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    close: () => dom.window.close(),
  };
}

/* ─────────────── 1. what comes back */

say('\n1. A PAID BUILD REOPENS AS IT WAS SAVED\n');
{
  const b = await open('admin-load');
  try {
    ok(b.asked.some((a) => a.url.includes('/admin/api/personalisation-scene/')),
      'the build is loaded from the admin endpoint');
    ok(b.imgSrcs.some((u) => u.includes(`/api/personalisation-photo/${BUILD_ID}/art`)),
      'and its styled photograph is loaded', b.imgSrcs.join(' '));
    ok(b.imgSrcs.some((u) => u.includes('variant=cutout')),
      'along with the cut-out it was saved with');

    const r = await b.recipeOf();
    ok(!!r, 'the builder produces a recipe');
    const panel = (r.panels || []).find((p) => p.id === 'art');
    ok(!!panel, 'with the art panel in it');

    /* The whole point. */
    ok(panel.transform.zoom === CROP.zoom,
      "the customer's ZOOM survives the round trip", `${panel.transform.zoom} (want ${CROP.zoom})`);
    ok(panel.transform.offsetX === CROP.offsetX,
      "their offsetX survives", `${panel.transform.offsetX} (want ${CROP.offsetX})`);
    ok(panel.transform.offsetY === CROP.offsetY,
      "their offsetY survives", `${panel.transform.offsetY} (want ${CROP.offsetY})`);

    ok(panel.styledKey === KEYS.styledKey, 'the styled key is re-emitted', panel.styledKey);
    ok(panel.rawKey === KEYS.rawKey, 'the raw key too', panel.rawKey);
    ok(panel.cutoutKey === KEYS.cutoutKey, 'and the cut-out key', panel.cutoutKey);
    ok(panel.imageVariant === 'cutout',
      'and the variant is the one the customer chose, not one inferred', panel.imageVariant);
    ok(panel.placeholder === false, 'the panel is not a placeholder');

    const title = (r.text || []).find((t) => t.id === 'title');
    ok(title && title.value === 'CUSTOMER TITLE', 'their wording is there', title && title.value);
    ok(r.output && r.output.format === 'standard', 'and the finish they bought', r.output && r.output.format);
    ok(Array.isArray(r.output.faceInches) && r.output.faceInches[0] === 16,
      'at the size they bought', JSON.stringify(r.output.faceInches));
  } finally { b.close(); }
}

/* ─────────────── 2. nothing that costs money */

say('\n2. NOTHING PAID FOR TWICE\n');
{
  const b = await open('admin-paid');
  try {
    ok(b.paidCalls().length === 0,
      'opening the build makes no upload, style or cut-out request',
      b.paidCalls().map((a) => a.url).join(', ') || 'none');

    /* Then edit it about as hard as the controls allow. */
    const field = b.$('tx-title');
    if (field) {
      field.value = 'TIDIED TITLE';
      b.fireOn(field, 'keydown', { key: 'X' });
      b.fireOn(field, 'input');
      await tick(120);
    }
    const hit = b.svg.querySelector('.hit');
    if (hit) await b.drag(hit, { x: 300, y: 300 }, 40, 25);
    const zoom = b.$('zoom');
    if (zoom) { zoom.value = '2.2'; b.fireOn(zoom, 'input'); b.fireOn(zoom, 'change'); await tick(80); }
    await tick(200);

    ok(b.paidCalls().length === 0,
      'and neither does editing the text, the crop or the zoom',
      b.paidCalls().map((a) => a.url).join(', ') || 'none');
    /* Said positively too, so a suite that stopped making ANY requests could not
       pass this section by accident. */
    ok(b.asked.length > 0, 'while the session did make requests', String(b.asked.length));

    const after = await b.recipeOf();
    const panel = (after.panels || []).find((p) => p.id === 'art');
    ok(panel.styledKey === KEYS.styledKey, 'the paid artwork is still referenced after editing');
  } finally { b.close(); }
}

/* ─────────────── 3. the edit itself */

say('\n3. THE EDIT CHANGES WHAT IT SHOULD\n');
{
  const b = await open('admin-edit');
  try {
    const before = await b.recipeOf();
    const beforePanel = before.panels.find((p) => p.id === 'art');

    const field = b.$('tx-title');
    ok(!!field, 'the title field is there to edit');
    field.value = 'TIDIED TITLE';
    b.fireOn(field, 'keydown', { key: 'E' });
    b.fireOn(field, 'input');
    await tick(200);

    const mid = await b.recipeOf();
    const t = (mid.text || []).find((x) => x.id === 'title');
    ok(t && t.value === 'TIDIED TITLE', 'retyping the title changes the recipe', t && t.value);

    /* And the crop is still theirs -- an edit to the WORDS must not move the
       photograph. */
    const midPanel = mid.panels.find((p) => p.id === 'art');
    ok(midPanel.transform.zoom === CROP.zoom && midPanel.transform.offsetY === CROP.offsetY,
      'and leaves the crop exactly where it was',
      `${midPanel.transform.zoom}/${midPanel.transform.offsetY}`);

    /* Now move the photograph on purpose. */
    const hit = b.svg.querySelector('.hit');
    await b.drag(hit, { x: 320, y: 320 }, 50, 0);
    const moved = await b.recipeOf();
    const movedPanel = moved.panels.find((p) => p.id === 'art');
    ok(movedPanel.transform.offsetX !== beforePanel.transform.offsetX,
      'dragging the photograph moves it',
      `${beforePanel.transform.offsetX} -> ${movedPanel.transform.offsetX}`);
    ok(movedPanel.transform.zoom === CROP.zoom,
      'without changing the zoom', String(movedPanel.transform.zoom));
    ok(movedPanel.styledKey === KEYS.styledKey, 'and without losing the styled key');
  } finally { b.close(); }
}

/* ─────────────── 4. undo and zoom, as in customer mode */

say('\n4. UNDO AND VIEW ZOOM STILL WORK\n');
{
  const b = await open('admin-undo');
  try {
    ok(!!b.$('undoBtn') && !!b.$('redoBtn'), 'the undo controls are present');
    ok(!!b.$('viewIn') && !!b.$('viewOut') && !!b.$('viewFit'), 'and the zoom controls');

    const start = await b.recipeOf();
    const field = b.$('tx-title');
    field.value = 'SOMETHING ELSE';
    b.fireOn(field, 'keydown', { key: 'S' });
    b.fireOn(field, 'input');
    await tick(600);
    const changed = await b.recipeOf();
    ok(JSON.stringify(changed.text) !== JSON.stringify(start.text), 'an edit registers');

    b.click(b.$('undoBtn'));
    await tick(200);
    const undone = await b.recipeOf();
    ok(JSON.stringify(undone.text) === JSON.stringify(start.text),
      'undo puts the wording back');
    const undonePanel = undone.panels.find((p) => p.id === 'art');
    ok(undonePanel.styledKey === KEYS.styledKey,
      'and undo does not drop the paid artwork — it never writes those fields');

    b.click(b.$('redoBtn'));
    await tick(200);
    const redone = await b.recipeOf();
    ok(JSON.stringify(redone.text) === JSON.stringify(changed.text), 'redo walks forward again');

    /* Zoom is a magnifying glass: it must not reach the design. */
    const beforeZoom = await b.recipeOf();
    b.click(b.$('viewIn'));
    await tick(120);
    const afterZoom = await b.recipeOf();
    ok(JSON.stringify(afterZoom) === JSON.stringify(beforeZoom),
      'zooming the VIEW changes nothing in the design');
  } finally { b.close(); }
}

/* ─────────────── 5. the save */

say('\n5. SAVING SENDS THE RIGHT THING\n');
{
  const b = await open('admin-save');
  try {
    const field = b.$('tx-title');
    field.value = 'READY TO SEND';
    b.fireOn(field, 'keydown', { key: 'R' });
    b.fireOn(field, 'input');
    await tick(200);

    b.click(b.$('adminSave'));
    await tick(300);

    const sent = b.savedBody();
    ok(!!sent, 'pressing Save posts to the admin save endpoint');
    ok(sent.id === BUILD_ID, '  with the build id', sent && sent.id);
    ok(sent.rev === 'rev-paid-1',
      '  and the revision it was loaded at, so a concurrent render is refused', sent && sent.rev);
    ok(!!sent.recipe && typeof sent.recipe === 'object', '  carrying the recipe');
    ok(typeof sent.recipe.svg === 'string' && sent.recipe.svg.includes('<svg'),
      '  with the scene inside it');
    const panel = (sent.recipe.panels || []).find((p) => p.id === 'art');
    ok(panel && panel.styledKey === KEYS.styledKey, '  and the paid keys intact');
    ok(panel && panel.transform.zoom === CROP.zoom, '  and the crop intact');
    const t = (sent.recipe.text || []).find((x) => x.id === 'title');
    ok(t && t.value === 'READY TO SEND', '  and the edit that was made', t && t.value);
    ok(b.paidCalls().length === 0, '  and still nothing paid for twice');
    /* The scene must be tokenised: the save endpoint refuses data: URIs, and
       here is where that would first be visible. */
    ok(!/href\s*=\s*["']?data:/i.test(sent.recipe.svg),
      '  the scene references its panels by token, not by bytes');
    ok(/\{\{IMAGE:|\{\{BACKGROUND\}\}/.test(sent.recipe.svg),
      '  as tokens', 'tokenised');
  } finally { b.close(); }
}

/* ─────────────── 6. a build that may not be edited */

say('\n6. A BUILD THAT MAY NOT BE EDITED STAYS SHUT\n');
{
  const b = await open('admin-refused', {
    sceneOverride: {
      ...sceneReply(),
      status: 'in_production',
      editable: false,
      whyNotEditable: 'The customer has already approved this artwork.',
    },
  });
  try {
    ok(b.paidCalls().length === 0, 'nothing paid for is requested');
    ok(!b.imgSrcs.some((u) => u.includes('/api/personalisation-photo/')),
      'and the photographs are not even loaded');
    /* Nothing is BUILT, which is the real guarantee: load() is never reached, so
       there is no template, no panels, and nothing a save could be made from.
       Asserted on the DOM rather than by asking for a recipe -- recipe() reads
       the template and would throw, and a throw inside an event listener is
       reported by jsdom as an uncaught error that no try/catch here can see. */
    ok(b.svg.querySelectorAll('.hit.filled').length === 0,
      'no panel on the board is filled');
    ok(b.svg.querySelectorAll('image[href]').length === 0,
      'and no artwork was placed at all',
      String(b.svg.querySelectorAll('image[href]').length));
    /* The veil is what a person would see. It cannot be asserted here: the
       element is rendered by the server-side page for admin and customise
       modes, and this harness borrows a customer page, which has none. Its copy
       is covered by the endpoint test that returns whyNotEditable. */
  } finally { b.close(); }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
