/**
 * Capture the 20 proof cases from what actually ships.
 *
 * Drives the built Astro pages in dist/ (run `npm run build` at the repo root
 * first) and the real ProductBuilder bundle they load, rather than the
 * tools/builder/product-builder.html prototype. Same 20 cases, same tags, same
 * output files -- prove.mjs is unchanged.
 *
 * Each personalised product only offers its own variants in the switch, so the
 * five templates come from three pages:
 *   personalised-strips       Strip
 *   personalised-book-covers  Cover, Cover (full bleed)
 *   personalised-icons        Icon portrait, Icon landscape
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const DIST = path.resolve('../../../dist');
const PAGES = ['personalised-strips', 'personalised-book-covers', 'personalised-icons'];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

if (!fs.existsSync(path.join(DIST, 'store', PAGES[0], 'index.html')))
  throw new Error(`no build at ${DIST} — run "npm run build" at the repo root first`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The island loads its assets over HTTP, so the serialised scene graph carries
   /builder/... URLs. resvg cannot fetch those, and the prototype embedded the
   same bytes as data: URIs, so resolve them off disk the way a browser would.
   This is the transport differing, not the artwork. */
function inlineAssets(svgEl) {
  for (const im of svgEl.querySelectorAll('image')) {
    const href = im.getAttribute('href') || '';
    if (!href.startsWith('/builder/')) continue;
    const file = path.join(DIST, href);
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    im.setAttribute('href', `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`);
  }
}

const cases = [];

for (const slug of PAGES) {
  const pageFile = path.join(DIST, 'store', slug, 'index.html');
  const html = fs.readFileSync(pageFile, 'utf8');

  // the bundle name carries a content hash, so read it off the page
  const m = html.match(/src="\/(_astro\/ProductBuilder\.astro[^"]+\.js)"/);
  if (!m) throw new Error(`no ProductBuilder bundle referenced by ${slug}`);
  const bundle = fs.readFileSync(path.join(DIST, m[1]), 'utf8');

  let logged = null;
  const dom = new JSDOM(html, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: `https://x/store/${slug}?dev`,          // ?dev unhides Copy recipe
    beforeParse(w) {
      class F {
        constructor() { this.complete = false; this._l = []; }
        set src(v) {
          this._src = v; this.complete = true; this.naturalWidth = 1600; this.naturalHeight = 1600;
          queueMicrotask(() => this._l.forEach(f => f()));
        }
        get src() { return this._src; }
        addEventListener(t, f) { if (t === 'load') this._l.push(f); }
      }
      w.Image = F; w.SVGElement.prototype.getComputedTextLength = () => 1;
      w.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 9, height: 9 });
      w.Element.prototype.setPointerCapture = () => {}; w.HTMLCanvasElement.prototype.getContext = () => null;
      Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 1200; } });
      Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 800; } });
      w.document.fonts = { ready: Promise.resolve(), load: () => Promise.resolve() };
      // jsdom has no navigator.clipboard, so the Copy handler falls into its own
      // catch and logs the recipe -- that is how we read it out of the closure.
      w.console = { log: (...a) => { logged = a.join(' '); }, error() {}, warn() {}, info() {} };
    },
  });

  const { window } = dom, doc = window.document;
  window.eval(bundle);                            // the shipped island, verbatim
  await sleep(140);

  const root = doc.getElementById('csc-builder-root');
  const $ = id => root.querySelector('#' + id);
  const click = el => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  for (const btn of [...$('switch').children]) {
    const name = btn.textContent;
    click(btn);
    await sleep(60);
    for (const fmt of ['poster', 'gallery']) {
      $('fmtSel').value = fmt; $('fmtSel').dispatchEvent(new window.Event('change', { bubbles: true }));
      await sleep(40);
      for (const si of [0, 2]) {
        const s = $('sizeSel'); if (si >= s.options.length) continue;
        s.value = si; s.dispatchEvent(new window.Event('change', { bubbles: true }));
        await sleep(50);
        const tag = `${name.replace(/[^a-z]/gi, '')}-${fmt}-${si}`;

        logged = null;
        click($('copy'));
        await sleep(60);
        if (!logged) throw new Error(`${tag}: no recipe captured from the Copy handler`);
        fs.writeFileSync(`run/${tag}.recipe.json`, logged);

        const live = doc.getElementById('svg').cloneNode(true);
        live.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        live.querySelectorAll('.hit,[data-role="guide"]').forEach(e => e.remove());
        inlineAssets(live);
        const v = live.getAttribute('viewBox').split(' ').map(Number);
        live.setAttribute('width', Math.round(v[2])); live.setAttribute('height', Math.round(v[3]));
        fs.writeFileSync(`run/${tag}.builder.svg`, new window.XMLSerializer().serializeToString(live));
        cases.push(tag);
      }
    }
  }
  dom.window.close();
}

fs.writeFileSync('run/cases.json', JSON.stringify(cases, null, 1));
console.log('captured', cases.length, 'cases from dist/ (' + PAGES.join(', ') + ')');
