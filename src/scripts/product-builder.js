/**
 * product-builder.js
 * ---------------------------------------------------------------------------
 * Behaviour for src/components/ProductBuilder.astro, ported from
 * tools/builder/product-builder.html. The prototype is the source of truth:
 * every control, every geometry rule, the recipe export and exportSVG() behave
 * identically. The layout maths is copied verbatim and must not be "improved".
 *
 * Deliberate differences, all forced by moving out of a single self-contained
 * file -- nothing else changed:
 *
 *   1. Assets load from /builder/ instead of inline base64 data: URIs.
 *   2. PATHS / COVER / CAPBOX / BOXES / METRICS are read from a
 *      <script type="application/json"> block the component renders at build
 *      time, instead of being inlined as literals.
 *   3. $() resolves inside the component root rather than the whole document,
 *      so the builder's generic ids cannot collide with the host page.
 *   4. --accent is set on the component root rather than <html>, so the
 *      per-product accent cannot leak into the surrounding page.
 *   5. The template switch offers only the current product's variants
 *      (orientation / full bleed) rather than all five templates.
 *   6. draftSVG() is async and inlines asset URLs. An SVG loaded as an <img>
 *      is sandboxed and cannot fetch external files, so with (1) in place the
 *      background, overlay, logo and placeholders would have dropped out of the
 *      downloaded draft. Inlining restores the prototype's draft exactly.
 */

import { PRICES } from '../data/products';

const SVGNS = 'http://www.w3.org/2000/svg', SR = 0.065;

/* What counts as soft depends on what it is printed on. Canvas has texture and
   is viewed from further away, so it carries a lower resolution than a poster
   held at arm's length. This only changes the threshold we warn at -- the dpi
   figure itself is calculated exactly as before. */
const MIN_DPI_BY_FORMAT = { poster: 150, standard: 100, gallery: 100 };
const DPI_SURFACE = { poster: 'as a poster', standard: 'on canvas', gallery: 'on canvas' };

/** Builder format/size vocabulary -> the basket's. */
const CART_FORMAT = { poster: 'poster', standard: 'canvas-standard', gallery: 'canvas-gallery' };
const CART_SIZE = ['small', 'medium', 'large'];
const FORMAT_WORD = { poster: 'poster print', standard: 'standard wrap', gallery: 'gallery wrap' };
const TEMPLATE_WORD = {
  strip: 'Comic strip', cover: 'Comic cover', 'cover-fullbleed': 'Comic cover (full bleed)',
  'icon-portrait': 'Comic icon', 'icon-landscape': 'Comic icon',
};

/** Assets, previously base64 blobs in the prototype's `A` object. */
const ASSET = {
  cover_bg: '/builder/templates/comic-cover/background.png',
  cover_ov: '/builder/templates/comic-cover/overlay.png',
  logo: '/builder/csc-logo.png',
  placeholder: '/builder/placeholder.png',
  placeholder_cover: '/builder/placeholder-cover.png',
  placeholder_coverfb: '/builder/placeholder-coverfb.png',
};

/** Which templates each mounted product may switch between. */
const VARIANTS = {
  strip: ['strip'],
  cover: ['cover', 'cover-fullbleed'],
  'icon-portrait': ['icon-portrait', 'icon-landscape'],
};

export function initProductBuilder() {
  const root = document.getElementById('csc-builder-root');
  const dataEl = document.getElementById('csc-builder-data');
  if (!root || !dataEl) return;

  const { PATHS, COVER, CAPBOX, BOXES, METRICS, PERSONALISATION_FEE } = JSON.parse(dataEl.textContent);

  /** "customer" | "studio" -- plumbed through; both behave identically today. */
  const MODE = root.dataset.mode === 'studio' ? 'studio' : 'customer';
  const INITIAL = VARIANTS[root.dataset.template] ? root.dataset.template : 'cover';

  const $ = (id) => root.querySelector('#' + id);
  const svg = $('svg'), board = $('board'), picker = $('picker');
  const mk = (t, a) => { const e = document.createElementNS(SVGNS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };

  /* Measure from the font's own advance widths rather than asking the browser.
     getComputedTextLength answers with whatever face is currently rendering, so
     before the webfont arrives it reports fallback metrics and the fit concludes
     text fits when it doesn't. This is deterministic and race-free. */
  function textWidth(str, size, family) {
    const m = METRICS[family] || METRICS.Chewy;
    let w = 0;
    for (const ch of String(str)) w += (m.adv[ch.codePointAt(0)] !== undefined ? m.adv[ch.codePointAt(0)] : m.default);
    return w * size;
  }
  const STROKE = {
    masthead: '#FFFFFF', title: '#000000', quote: '#000000', attribution: '#000000',
    'caption-1': '#000000', 'caption-2': '#000000',
  };
  // The family name must match the one inside the font file. Asking for
  // "LuckiestGuy" works in a browser via @font-face but silently falls back
  // in any renderer that matches on the font's own name.
  const FONTOF = (id) => (id === 'title' ? 'Luckiest Guy' : 'Chewy');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // the cover caption has two colour tiers, each its own editable line
  const capSlot = (f) => (f.id === 'caption-1' || f.id === 'caption-2'
    ? { ...f, boxRef: 'caption', slot: f.id } : f);
  const DEFAULT_LOGO = ASSET.logo;
  const PLACEHOLDER = ASSET.placeholder;
  const PLACEHOLDER_COVER = ASSET.placeholder_cover;
  const demoImg = new Image(); demoImg.src = PLACEHOLDER;
  const demoCover = new Image(); demoCover.src = PLACEHOLDER_COVER;
  // the standard cover already has its own colour burst, so the example there is
  // just the bubble on transparency and lets the artwork show through
  const PLACEHOLDER_COVERFB = ASSET.placeholder_coverfb;
  const demoCoverFB = new Image(); demoCoverFB.src = PLACEHOLDER_COVERFB;
  const demoFor = () => {
    if (TK === 'cover') return { img: demoCover, href: PLACEHOLDER_COVER };
    if (TK === 'cover-fullbleed') return { img: demoCoverFB, href: PLACEHOLDER_COVERFB };
    return { img: demoImg, href: PLACEHOLDER };
  };
  // The cover PSD positions its furniture right up to the artwork edge, which is
  // 2.5" outside the trim. Scaling it toward the centre restores a margin.
  /* The cover furniture occupies only the middle of its artwork, so at print size
     it reads small. Scale it about its own centre until it reaches the face. */
  // cx/cy is where the furniture currently centres; to is where it should end up
  const FURNITURE_FIT = {
    cover: { cx: 2118, cy: 2714, tx: 2100, ty: 2900, scale: 1.20 },
    'cover-fullbleed': { cx: 2118, cy: 2714, tx: 2100, ty: 2900, scale: 1.20 },
  };
  function applyFurnitureInset(t, key) {
    const F = FURNITURE_FIT[key]; if (!F || t._inset) return;
    const k = F.scale, cx = F.cx, cy = F.cy, tx = F.tx, ty = F.ty;
    const map = (x, y) => [tx + (x - cx) * k, ty + (y - cy) * k];
    t.furniture = { cx, cy, tx, ty, scale: k };
    t.text.forEach((f) => {
      f.fontSize *= k; f.pos = null;
      if (f.boxRef) return;               // its position comes from the box
      const [x, y] = map(f.cx, f.cy); f.cx = x; f.cy = y;
      f.boxW *= k; f.boxH *= k;
    });
    if (t.logo) {
      const [x, y] = map(t.logo.x, t.logo.y);
      t.logo.x = x; t.logo.y = y; t.logo.width *= k; t.logo.height *= k;
    }
    (t.boxes || []).forEach((b) => {
      const [x, y] = map(b.x, b.y);
      b.x = x; b.y = y - (b.lift || 0) * k;      // nudge the caption up off the page edge
      b.scale = (b.scale || 1) * k;
      b.width *= k; b.height *= k;
      b.inner = { x: b.inner.x * k, y: b.inner.y * k, w: b.inner.w * k, h: b.inner.h * k };
      (b.slots || []).forEach((s) => { s.x *= k; s.y *= k; s.w *= k; s.h *= k; });
    });
    t._inset = true;
  }
  const ACCENT = {
    strip: '#00AEEF', cover: '#EC008C', 'cover-fullbleed': '#EC008C',
    'icon-portrait': '#FFF200', 'icon-landscape': '#FFF200',
  };
  const onDark = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#000' : '#fff';
  };

  /* Icon geometry is vector, so it is stored as fractions of a reference canvas
     and rebuilt at whatever print size the customer picks. */
  const ICON_REF = { portrait: [3600, 5400], landscape: [5400, 3600] };
  const ICON_POS = {
    portrait: [[1408 / 3600, 294 / 5400], [1727 / 3600, 612 / 5400]],
    landscape: [[300 / 5400, 250 / 3600], [620 / 5400, 612 / 3600]],
  };
  function iconTemplate(name, orient, sizes) {
    const [rw, rh] = ICON_REF[orient], size = sizes[sizes.length - 1];
    const t = {
      name, orient, sizes, size, bg: null, boxes: [],
      text: [{
        id: 'quote', label: 'quote', value: 'Dummy wording — please replace', boxRef: 'quote',
        baseSize: 156.2, rot: 0, colours: ['#FFFFFF'], wrap: true,
      }, {
        id: 'attribution', label: 'attribution', value: '— your name here —', boxRef: 'attribution',
        baseSize: 104.2, rot: 0, colours: ['#FFFFFF'], wrap: true,
      }],
    };
    t.resize = (sz) => {
      const W = Math.round(sz.w * 300), H = Math.round(sz.h * 300), k = W / rw;
      t.canvas = { width: W, height: H, dpi: 300 };
      t.art = { id: 'art', x: 0, y: 0, width: W, height: H };
      t.panels = [t.art];
      t.boxes = clone(BOXES).map((b, i) => ({
        ...b,
        x: Math.round(ICON_POS[orient][i][0] * W), y: Math.round(ICON_POS[orient][i][1] * H),
        width: Math.round(b.width * k), height: Math.round(b.height * k),
        inner: { x: b.inner.x * k, y: b.inner.y * k, w: b.inner.w * k, h: b.inner.h * k },
        scale: k, dx: 0, dy: 0, lineColour: '#000000',
      }));
      t.text.forEach((f) => {
        f.fontSize = f.baseSize * k; f.dx = 0; f.dy = 0;
        const b = t.boxes.find((x) => x.id === f.boxRef);
        if (b) {
          const s = f.slot && (b.slots || []).find((o) => o.id === f.slot);
          f.pos = s ? { x: b.x + b.dx + s.x + s.w / 2, y: b.y + b.dy + s.y + s.h / 2 }
            : ((a) => ({ x: a.cx, y: a.cy }))(boxArea(b, t.boxes));
        }
      });
    };
    t.resize(size); return t;
  }
  const WRAP = { poster: 0, standard: 1.5, gallery: 2.5 };
  /* There was an ART_WRAP table here, recording "wrap already drawn into each
     template's artwork", and a banner that fired whenever the chosen finish
     asked for more wrap than the table declared. Every entry was 0, so it fired
     on every canvas order, and its premise was wrong: build() already extends
     the scene into the wrap region -- the background rect/image is drawn at
     -ex,-ey at canvas + 2*ex/ey, and a panel covering the whole canvas is
     expanded to match -- so the exported SVG does cover the wrap on all five
     templates. The table described the source artwork and took no account of
     that, which made the banner a false alarm rather than a misplaced one.
     Removed outright rather than hidden; the geometry it warned about is
     handled in geom() and build(). */
  const FORMAT_LABEL = {
    poster: 'Poster print', standard: 'Canvas — standard wrap',
    gallery: 'Canvas — gallery wrap',
  };
  const SIZES = {
    strip: [{ label: '12 × 8 in', w: 12, h: 8 }, { label: '16 × 12 in', w: 16, h: 12 },
      { label: '24 × 16 in', w: 24, h: 16 }],
    cover: [{ label: '8 × 12 in', w: 8, h: 12 }, { label: '12 × 16 in', w: 12, h: 16 },
      { label: '16 × 24 in', w: 16, h: 24 }],
    portrait: [{ label: '8 × 12 in', w: 8, h: 12 }, { label: '12 × 16 in', w: 12, h: 16 }, { label: '16 × 24 in', w: 16, h: 24 }],
    landscape: [{ label: '12 × 8 in', w: 12, h: 8 }, { label: '16 × 12 in', w: 16, h: 12 }, { label: '24 × 16 in', w: 24, h: 16 }],
  };
  const TEMPLATES = {
    strip: {
      name: 'Strip', canvas: { width: 7350, height: 4950, dpi: 300 },
      bg: { type: 'colour', value: '#EC008C' }, page: { x: 156, y: 176, w: 7014, h: 4586 },
      panels: PATHS.panels.map((p) => ({ id: p.id, x: p.x, y: p.y, width: p.width, height: p.height, d: p.d })),
      vectorOutlines: true, overlay: null, boxes: [], text: [],
    },
    cover: {
      name: 'Cover', logo: { x: 3354, y: 640, width: 237, height: 183, fillPlate: true },
      canvas: { width: 4200, height: 5800, dpi: 200 },
      bg: { type: 'image', href: ASSET.cover_bg, tintable: true },
      art: { id: 'art', x: 397, y: 378, width: 3411, height: 5000 },
      overlay: ASSET.cover_ov,
      boxes: clone(CAPBOX), text: clone(COVER).map(capSlot),
    },
    'cover-fullbleed': {
      name: 'Cover (full bleed)', logo: { x: 3354, y: 640, width: 237, height: 183, fillPlate: true },
      canvas: { width: 4200, height: 5800, dpi: 200 },
      bg: null,
      art: { id: 'art', x: 0, y: 0, width: 4200, height: 5800 },
      overlay: ASSET.cover_ov,
      boxes: clone(CAPBOX), text: clone(COVER).map(capSlot),
    },
    'icon-portrait': iconTemplate('Icon portrait', 'portrait', SIZES.portrait),
    'icon-landscape': iconTemplate('Icon landscape', 'landscape', SIZES.landscape),
  };
  TEMPLATES.strip.sizes = SIZES.strip; TEMPLATES.strip.size = SIZES.strip[2];
  TEMPLATES.cover.sizes = SIZES.cover; TEMPLATES.cover.size = SIZES.cover[2];
  TEMPLATES['cover-fullbleed'].sizes = SIZES.cover;
  TEMPLATES['cover-fullbleed'].size = SIZES.cover[2];
  for (const k of ['cover', 'cover-fullbleed']) TEMPLATES[k].panels = [TEMPLATES[k].art];

  let T, TK, state, selected, pickTarget = null, bg, tint = { h: 0, s: 100 }, nodes = {}, moveMode = false;
  let fmt = 'poster';

  const sw = $('switch');
  VARIANTS[INITIAL].forEach((k) => {
    const b = document.createElement('button');
    b.textContent = TEMPLATES[k].name; b.dataset.k = k; b.className = 'b-btn';
    b.addEventListener('click', () => load(k)); sw.appendChild(b);
  });

  function load(key) {
    TK = key; T = TEMPLATES[key]; state = new Map(); selected = null; tint = { h: 0, s: 100 };
    applyFurnitureInset(T, key);
    T.boxes.forEach((b) => { b.dx = b.dx || 0; b.dy = b.dy || 0; });
    T.text.forEach((f) => {
      if (f.stroke === undefined) f.stroke = STROKE[f.id] || null;
      f.strokeScale = f.strokeScale || 1; f.sizeScale = f.sizeScale || 1;
      if (f.linked === undefined) f.linked = true;
      if (!f.pos) {
        if (f.boxRef) {
          const b = T.boxes.find((x) => x.id === f.boxRef);
          const s = f.slot && (b.slots || []).find((o) => o.id === f.slot);
          f.pos = s ? { x: b.x + b.dx + s.x + s.w / 2, y: b.y + b.dy + s.y + s.h / 2 }
            : ((a) => ({ x: a.cx, y: a.cy }))(boxArea(b));
        } else f.pos = { x: f.cx, y: f.cy };
      }
    });
    bg = T.bg && T.bg.type === 'colour' ? T.bg.value : null;
    [...sw.children].forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === key));
    const ac = ACCENT[key] || '#EC008C';
    root.style.setProperty('--b-accent', ac);
    root.style.setProperty('--b-on-accent', onDark(ac));
    sizeBoard();                    // one place decides the board's shape
    svg.setAttribute('viewBox', viewBoxNow());
    buildSizes(); build(); rail(); seedDemo(); refresh();
    if (T.panels.length === 1) select(T.panels[0].id);
  }

  function wrapIn() { return WRAP[fmt] || 0; }
  /* The artwork has one fixed shape; the chosen face may not share it. Scale so
     the whole design fits the face, pad the short axis with border, then add the
     wrap outside that. Each axis is worked out separately. */
  // 'fill' crops a little of a decorative edge so the design fills the face;
  // 'pad' keeps the whole layout visible and grows the border instead.
  const FIT = {
    strip: 'pad', 'icon-portrait': 'fill', 'icon-landscape': 'fill',
    cover: 'fill', 'cover-fullbleed': 'fill',
  };
  function geom() {
    const c = T.canvas, sz = T.size || { w: 1, h: 1 }, w = wrapIn();
    const ppi = (FIT[TK] === 'pad') ? Math.max(c.width / sz.w, c.height / sz.h)
      : Math.min(c.width / sz.w, c.height / sz.h);
    const padX = (sz.w * ppi - c.width) / 2, padY = (sz.h * ppi - c.height) / 2;
    const wrapPx = w * ppi;
    return { c, sz, w, ppi, padX, padY, dx: padX + wrapPx, dy: padY + wrapPx };
  }
  function viewBoxNow() {
    const { c, dx, dy } = geom();
    return `${-dx} ${-dy} ${c.width + 2 * dx} ${c.height + 2 * dy}`;
  }
  function drawGuides() {
    ['trimGuide', 'trimUnder'].forEach((k) => { if (nodes[k]) { nodes[k].remove(); nodes[k] = null; } });
    if (!T.size || !wrapIn()) return;
    // the face is the artwork plus its padding; everything beyond that wraps
    const { c, padX, padY } = geom();
    const wdt = Math.max(6, c.width / 230);
    const box = { x: -padX, y: -padY, width: c.width + 2 * padX, height: c.height + 2 * padY };
    // a dark under-stroke so the white line reads on pale artwork too
    const under = mk('rect', {
      ...box, 'data-role': 'guide', fill: 'none', stroke: 'rgba(0,0,0,.55)',
      'stroke-width': wdt * 1.8, 'pointer-events': 'none',
    });
    const r = mk('rect', {
      ...box, 'data-role': 'guide', fill: 'none', stroke: '#FFFFFF', 'stroke-width': wdt,
      'stroke-dasharray': `${c.width / 34} ${c.width / 48}`, 'stroke-linecap': 'butt',
      'pointer-events': 'none',
    });
    svg.append(under, r); nodes.trimGuide = r; nodes.trimUnder = under;
  }
  function showGuide() { $('guide').hidden = false; }
  $('help').addEventListener('click', showGuide);
  $('guideClose').addEventListener('click', () => {
    $('guide').hidden = true;
    try { localStorage.setItem('csc-guide-seen', '1'); } catch (e) { /* private mode */ }
  });
  /* Every template opens with an example so customers see a finished layout
     rather than empty frames. Anything they drop replaces it. */
  function seedDemo() {
    const put = () => {
      if (!T) return;
      const { img: dImg, href: dHref } = demoFor();
      T.panels.forEach((p) => {
        if (state.get(p.id) || !nodes[p.id]) return;
        state.set(p.id, {
          url: dHref, el: dImg, name: null, demo: true,
          natW: dImg.naturalWidth || 1600, natH: dImg.naturalHeight || 1600,
          zoom: 1, ox: 0, oy: 0, cut: false, tol: 34, feather: 2,
        });
        const n = nodes[p.id];
        n.img.setAttribute('href', dHref); n.img.setAttribute('opacity', 1);
        if (n.num) n.num.setAttribute('opacity', 0);
        if (n.plate) n.plate.setAttribute('opacity', 0);
        layout(p.id);
      });
      refresh();
    };
    const d = demoFor().img;
    if (d.complete && d.naturalWidth) put();
    else { d.addEventListener('load', put, { once: true }); setTimeout(put, 600); }
  }
  function sizeBoard() {
    const c = T.canvas;
    // scale the preview against the largest size on offer, so choosing a smaller
    // print actually looks smaller instead of always filling the stage
    let rel = 1;
    if (T.sizes && T.size) {
      const big = T.sizes.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a), T.sizes[0]);
      rel = Math.sqrt((T.size.w * T.size.h) / (big.w * big.h));
    }
    const { dx, dy } = geom();
    const extW = c.width + 2 * dx, extH = c.height + 2 * dy;
    // Size the board explicitly. Setting a width and a max-height together let the
    // browser clamp one without the other, which left the svg letterboxed inside.
    const stage = board.parentNode;
    const sw2 = (stage.clientWidth || 1000) - 52, sh = (stage.clientHeight || 700) - 52;
    const k = Math.min(sw2 / extW, sh / extH) * rel;
    board.style.aspectRatio = 'auto';
    board.style.maxWidth = 'none'; board.style.maxHeight = 'none';
    board.style.width = Math.max(40, Math.round(extW * k)) + 'px';
    board.style.height = Math.max(40, Math.round(extH * k)) + 'px';
  }
  window.addEventListener('resize', () => { if (T) sizeBoard(); });
  function buildSizes() {
    const sel = $('sizeSel'); sel.innerHTML = '';
    (T.sizes || []).forEach((s, i) => {
      const o = document.createElement('option'); o.value = i; o.textContent = s.label;
      if (s === T.size) o.selected = true; sel.appendChild(o);
    });
    sel.disabled = !T.sizes;
  }
  $('fmtSel').addEventListener('change', (e) => {
    fmt = e.target.value; rebuildKeepingImages();
    // multi-panel templates keep their selection through a rebuild but are not
    // re-synced by it, so the panel readout would otherwise show the old output
    if (selected && nodes[selected]) syncPanel();
  });
  $('sizeSel').addEventListener('change', (e) => {
    const s = T.sizes[+e.target.value]; T.size = s;
    if (T.resize) T.resize(s);              // icons rebuild their vector geometry
    rebuildKeepingImages();                 // every template re-fits to the new face
  });
  /* Rebuild the scene at the current size/format, putting the customer's images
     back where they were. */
  function rebuildKeepingImages() {
    sizeBoard();
    svg.setAttribute('viewBox', viewBoxNow());
    const keep = new Map(state); state = new Map();
    build(); rail();
    keep.forEach((v, k) => {
      if (nodes[k]) {
        state.set(k, v);
        const n = nodes[k];
        n.img.setAttribute('href', v.url); n.img.setAttribute('opacity', 1);
        if (n.num) n.num.setAttribute('opacity', 0);
        if (n.plate) n.plate.setAttribute('opacity', 0);
        n.hit.classList.add('filled'); layout(k);
        // build() threw the old nodes away, so a failed slot needs its flag
        // (and its dimmed artwork) put back on the new ones.
        if (v.uploadState && v.uploadState !== UPLOADED) n.img.setAttribute('opacity', 0.45);
        drawSlotFlag(k);
      }
    });
    seedDemo(); refresh();
    if (T.panels.length === 1) select(T.panels[0].id);
  }
  function build() {
    svg.textContent = ''; nodes = {};
    const c = T.canvas, defs = document.createElementNS(SVGNS, 'defs'); svg.appendChild(defs);
    const G = geom(), ex = Math.max(0, G.dx), ey = Math.max(0, G.dy);
    if (T.bg && T.bg.type === 'colour') {
      nodes.bgRect = mk('rect', { x: -ex, y: -ey, width: c.width + 2 * ex, height: c.height + 2 * ey, fill: bg, 'data-role': 'bg-colour' });
      svg.appendChild(nodes.bgRect);
    } else if (T.bg && T.bg.type === 'image') {
      // stretch the burst over whatever padding and wrap the chosen face needs
      nodes.bgImg = mk('image', {
        href: T.bg.href, x: -ex, y: -ey,
        width: c.width + 2 * ex, height: c.height + 2 * ey, 'data-role': 'background',
      });
      nodes.bgImg.setAttribute('preserveAspectRatio', 'none');
      svg.appendChild(nodes.bgImg);
    }
    if (T.page) svg.appendChild(mk('rect', { x: T.page.x, y: T.page.y, width: T.page.w, height: T.page.h, fill: '#fff', stroke: '#000', 'stroke-width': 13 }));

    const EP = T.panels.map((p) => {
      const covers = p.x <= 0 && p.y <= 0 && p.width >= c.width && p.height >= c.height;
      return (covers && (ex > 0 || ey > 0))
        ? { ...p, x: -ex, y: -ey, width: c.width + 2 * ex, height: c.height + 2 * ey } : p;
    });
    EP.forEach((p, i) => {
      const cl = document.createElementNS(SVGNS, 'clipPath'); cl.id = 'clip-' + p.id;
      cl.appendChild(p.d ? mk('path', { d: p.d }) : mk('rect', { x: p.x, y: p.y, width: p.width, height: p.height }));
      defs.appendChild(cl);
      const g = mk('g', { 'clip-path': `url(#clip-${p.id})` });
      const plate = p.d ? mk('path', { d: p.d, fill: '#fff' }) : mk('rect', { x: p.x, y: p.y, width: p.width, height: p.height, fill: T.bg ? 'none' : '#1A1A1A' });
      g.appendChild(plate);
      const img = mk('image', { opacity: 0, 'data-role': 'panel', 'data-panel': p.id });
      img.setAttribute('preserveAspectRatio', 'none');
      g.appendChild(img); svg.appendChild(g);
      let num = null;
      if (T.panels.length > 1) {
        num = mk('text', { x: p.x + p.width / 2, y: p.y + p.height / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 190, 'font-weight': 800, fill: '#B9BCC2' });
        num.textContent = String(i + 1).padStart(2, '0'); svg.appendChild(num);
      }
      nodes[p.id] = { panel: p, img, num, index: i, plate };
    });
    if (T.vectorOutlines) EP.forEach((p) => {
      nodes[p.id].outline = mk('path', { d: p.d, fill: 'none', stroke: '#000', 'stroke-width': 9, 'stroke-linejoin': 'round' });
      svg.appendChild(nodes[p.id].outline);
    });
    if (T.overlay) {
      const F = T.furniture, k = F ? F.scale : 1;
      const fx = F ? F.cx : c.width / 2, fy = F ? F.cy : c.height / 2;
      const tx = F ? F.tx : c.width / 2, ty = F ? F.ty : c.height / 2;
      nodes.overlay = mk('image', {
        href: T.overlay, 'data-role': 'overlay',
        x: tx + (0 - fx) * k, y: ty + (0 - fy) * k, width: c.width * k, height: c.height * k,
      });
      svg.appendChild(nodes.overlay);
    }
    if (T.logo) {
      const L = T.logo;
      if (!L.href) L.href = DEFAULT_LOGO;
      nodes.logoPlate = mk('rect', { x: L.x, y: L.y, width: L.width, height: L.height, rx: 14, ry: 14, fill: 'none' });
      nodes.logo = mk('image', { href: L.href, x: L.x, y: L.y, width: L.width, height: L.height, 'data-role': 'logo' });
      nodes.logo.setAttribute('preserveAspectRatio', 'none');
      const lc = document.createElementNS(SVGNS, 'clipPath'); lc.id = 'logoClip';
      lc.appendChild(mk('rect', { x: L.x, y: L.y, width: L.width, height: L.height, rx: 14, ry: 14 }));
      defs.appendChild(lc);
      svg.append(nodes.logoPlate, nodes.logo);
      placeLogo();
    }

    T.boxes.forEach((b) => {
      // the path data is in reference units, so it must be scaled as well as placed
      const g = mk('g', { transform: `translate(${b.x + b.dx},${b.y + b.dy}) scale(${b.scale || 1})` });
      const sh = mk('path', { d: b.shadow, fill: b.shadowColour });
      g.appendChild(sh);
      const fills = (b.fills || [{ d: b.fill, colour: b.fillColour }]).map((f) => {
        const el = mk('path', { d: f.d, fill: f.colour }); g.appendChild(el); return el;
      });
      svg.appendChild(g);
      nodes['b-' + b.id] = { g, sh, fl: fills[0], fills, box: b };
      let bd = null;
      g.addEventListener('pointerdown', (e) => {
        if (!moveMode) return; e.stopPropagation();
        g.setPointerCapture(e.pointerId);
        bd = {
          px: e.clientX, py: e.clientY, dx: b.dx, dy: b.dy,
          k: T.canvas.width / (svg.getBoundingClientRect().width || T.canvas.width),
        };
      });
      g.addEventListener('pointermove', (e) => {
        if (!bd) return;
        const nx = bd.dx + (e.clientX - bd.px) * bd.k, ny = bd.dy + (e.clientY - bd.py) * bd.k;
        const sx = nx - b.dx, sy = ny - b.dy;
        b.dx = nx; b.dy = ny;
        g.setAttribute('transform', `translate(${b.x + b.dx},${b.y + b.dy}) scale(${b.scale || 1})`);
        T.text.forEach((f) => { if (f.boxRef === b.id && f.linked) { f.pos.x += sx; f.pos.y += sy; } });
        layoutAllText();
      });
      const bend = () => { bd = null; };
      g.addEventListener('pointerup', bend); g.addEventListener('pointercancel', bend);
    });

    T.text.forEach((f) => {
      const t = mk('text', {
        'text-anchor': 'middle', 'font-family': FONTOF(f.id),
        fill: f.colours[0], 'paint-order': 'stroke', 'stroke-linejoin': 'round', 'font-size': f.fontSize,
      });
      if (f.stroke) t.setAttribute('stroke', f.stroke);
      svg.appendChild(t); nodes['t-' + f.id] = t;
      wireMove(f);
    });

    EP.forEach((p) => {
      const hit = p.d ? mk('path', { d: p.d, fill: 'transparent' }) : mk('rect', { x: p.x, y: p.y, width: p.width, height: p.height, fill: 'transparent' });
      hit.classList.add('hit'); hit.tabIndex = 0; hit.setAttribute('role', 'button');
      const firstAbove = T.boxes.length ? nodes['b-' + T.boxes[0].id].g
        : (T.text.length ? nodes['t-' + T.text[0].id] : null);
      svg.insertBefore(hit, firstAbove);
      nodes[p.id].hit = hit; wire(p.id);
    });
    applyTint(); layoutAllText(); drawGuides();
  }
  /* The burst is flat colour + black line work, so each region can be remapped
     exactly rather than hue-shifted. Classify once, then repaint cheaply. */
  let artMap = null;   // {w,h,idx:Uint8Array,base:[[r,g,b],...],src}
  function classifyArt(img) {
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return;                       // no canvas: leave the artwork as drawn
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data, n = c.width * c.height;
    const bins = {};
    for (let i = 0; i < n; i += 7) {
      const j = i * 4, k = ((px[j] >> 5) << 10) | ((px[j + 1] >> 5) << 5) | (px[j + 2] >> 5);
      bins[k] = (bins[k] || 0) + 1;
    }
    const base = Object.entries(bins).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => {
      k = +k; return [((k >> 10) & 7) * 32 + 16, ((k >> 5) & 7) * 32 + 16, (k & 7) * 32 + 16];
    });
    base.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));   // darkest first = line work
    const idx = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4; let best = 0, bd = 1e9;
      for (let b = 0; b < base.length; b++) {
        const dr = px[j] - base[b][0], dg = px[j + 1] - base[b][1], db = px[j + 2] - base[b][2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bd) { bd = dist; best = b; }
      }
      idx[i] = best;
    }
    // mean x of each region, so the pickers can be labelled by position
    const sx = new Float64Array(base.length), sn = new Float64Array(base.length);
    for (let i = 0; i < n; i++) { sx[idx[i]] += i % c.width; sn[idx[i]]++; }
    const meanX = base.map((_, b) => (sn[b] ? sx[b] / sn[b] / c.width : 0.5));
    const order = base.map((_, b) => b).filter((b) => sn[b] / n > 0.15).sort((a, b) => meanX[a] - meanX[b]);
    const labels = base.map(() => 'Line work');
    if (order.length === 2) { labels[order[0]] = 'Left'; labels[order[1]] = 'Right'; }
    else order.forEach((b, i) => { labels[b] = 'Area ' + (i + 1); });
    artMap = { w: c.width, h: c.height, idx, base, data: d, labels };
    artColours = base.map((cc) => '#' + cc.map((v) => v.toString(16).padStart(2, '0')).join(''));
  }
  let artColours = [];
  function repaintArt() {
    if (!artMap || !nodes.bgImg) return;
    const { w, h, idx, data } = artMap, px = data.data;
    const rgb = artColours.map((hx) => [parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)]);
    for (let i = 0; i < w * h; i++) {
      const c = rgb[idx[i]], j = i * 4;
      px[j] = c[0]; px[j + 1] = c[1]; px[j + 2] = c[2];
    }
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').putImageData(data, 0, 0);
    nodes.bgImg.setAttribute('href', cv.toDataURL('image/png'));
  }
  function applyTint() {
    if (!(T.bg && T.bg.type === 'image')) return;
    if (artMap) { repaintArt(); buildArtPickers(); return; }
    const img = new Image();
    img.onload = () => { classifyArt(img); buildArtPickers(); };
    img.src = T.bg.href;
  }
  function buildArtPickers() {
    const box = $('artColours'); if (!box) return;
    box.innerHTML = '';
    artColours.forEach((c, i) => {
      const ci = document.createElement('input'); ci.type = 'color'; ci.value = c;
      ci.className = 'b-colour';
      ci.title = (artMap && artMap.labels ? artMap.labels[i] : 'Area ' + i);
      const cap = document.createElement('span');
      cap.className = 'b-cap';
      cap.textContent = ci.title; box.appendChild(cap);
      const apply = () => { artColours[i] = ci.value; repaintArt(); };
      ci.addEventListener('input', apply); ci.addEventListener('change', apply);
      box.appendChild(ci);
    });
  }

  /* ---------- text: anchor, wrap, shrink ---------- */
  /* The two speech boxes overlap by design, so a box's usable area stops where
     the next one begins -- otherwise a wrapped second line lands underneath it. */
  function boxArea(b, boxes) {
    boxes = boxes || T.boxes;      // resize runs before T exists, so pass them in
    const n = b.inner, top = b.y + (b.dy || 0) + n.y, left = b.x + (b.dx || 0) + n.x;
    const below = boxes.filter((o) => o !== b && (o.y + (o.dy || 0)) > (b.y + (b.dy || 0))).map((o) => o.y + (o.dy || 0));
    const limit = below.length ? Math.min(...below) - b.height * 0.06 : Infinity;
    const h = Math.max(n.h * 0.35, Math.min(n.h, limit - top));
    return { cx: left + n.w / 2, cy: top + h / 2, w: n.w, h };
  }
  function anchorOf(f) {
    if (f.boxRef) {
      const b = T.boxes.find((x) => x.id === f.boxRef);
      // a slot is an independent area inside a box; otherwise use the whole box
      const s = f.slot && (b.slots || []).find((o) => o.id === f.slot);
      if (s) return { cx: f.pos.x, cy: f.pos.y, w: s.w * 0.94, h: s.h * 0.94 };
      const a = boxArea(b);
      return { cx: f.pos.x, cy: f.pos.y, w: a.w * 0.82, h: a.h * 0.86 };
    }
    return { cx: f.pos.x, cy: f.pos.y, w: f.boxW, h: f.boxH };
  }
  function layoutText(f) {
    const el = nodes['t-' + f.id], a = anchorOf(f);
    // Asking for bigger text means asking for a bigger element, so the allowance
    // scales too -- otherwise auto-fit immediately claws back whatever you added.
    const grow = f.sizeScale || 1;
    a.w *= grow; a.h *= grow;
    let size = f.fontSize * grow, lines = [f.value];
    const fam = FONTOF(f.id);
    const measure = (txt, s) => textWidth(txt, s, fam);
    for (let pass = 0; pass < 40; pass++) {
      lines = f.wrap ? wrap(f.value, size, a.w * 0.90, measure) : [f.value];
      const tall = lines.length * size * 1.16 > a.h;
      const wide = lines.some((l) => measure(l, size) > a.w * 0.92);
      if (!tall && !wide) break;
      size *= 0.94;
    }
    el.textContent = ''; el.setAttribute('font-size', size);
    el.style.fill = f.colours[0];
    el.style.stroke = f.stroke || 'none';
    el.style.strokeWidth = (f.stroke ? size * SR * 2 * (f.strokeScale || 1) : 0) + 'px';
    const lh = size * 1.16, top = a.cy - (lines.length - 1) * lh / 2;
    lines.forEach((ln, i) => {
      const ts = mk('tspan', { x: a.cx, y: top + i * lh, 'dominant-baseline': 'central' });
      if (f.twoTone && lines.length === 1 && f.colours[1]) {
        const sp = ln.indexOf(' ');
        const a1 = mk('tspan', {}); a1.style.fill = f.colours[0]; a1.textContent = ln.slice(0, sp + 1);
        const a2 = mk('tspan', {}); a2.style.fill = f.colours[1]; a2.textContent = ln.slice(sp + 1);
        ts.append(a1, a2);
      } else { ts.style.fill = f.colours[0]; ts.textContent = ln; }
      el.appendChild(ts);
    });
    el.setAttribute('transform', `rotate(${-(f.rot || 0)} ${a.cx} ${a.cy})`);
    f.resolved = Math.round(size * 10) / 10; f.lines = lines.length;
  }
  function wrap(text, size, maxw, measure) {
    const words = text.split(/\s+/), lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (cur && measure(t, size) > maxw) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function layoutAllText() { T.text.forEach(layoutText); }
  function remeasure() { if (T) layoutAllText(); }
  try {
    if (document.fonts && typeof document.fonts.load === 'function') {
      Promise.all([document.fonts.load('160px Chewy'),
        document.fonts.load("160px 'Luckiest Guy'")])
        .then(remeasure).catch(remeasure);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
  } catch (e) { /* no font loading API */ }
  setTimeout(remeasure, 1200);            // last resort if the font events misfire

  /* ---------- moving text and boxes ---------- */
  function wireMove(f) {
    const el = nodes['t-' + f.id]; let d = null;
    el.addEventListener('pointerdown', (e) => {
      if (!moveMode) return; e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      d = {
        px: e.clientX, py: e.clientY, ox: f.pos.x, oy: f.pos.y,
        k: T.canvas.width / (svg.getBoundingClientRect().width || T.canvas.width),
      };
    });
    el.addEventListener('pointermove', (e) => {
      if (!d) return;
      f.pos.x = d.ox + (e.clientX - d.px) * d.k; f.pos.y = d.oy + (e.clientY - d.py) * d.k;
      layoutText(f);
    });
    const end = () => { d = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  $('reposition').addEventListener('click', (e) => {
    moveMode = !moveMode; e.target.setAttribute('aria-pressed', moveMode);
    T.text.forEach((f) => nodes['t-' + f.id].classList.toggle('movable', moveMode));
    T.boxes.forEach((b) => nodes['b-' + b.id].g.classList.toggle('movable', moveMode));
    T.panels.forEach((p) => { if (nodes[p.id].hit) nodes[p.id].hit.style.pointerEvents = moveMode ? 'none' : ''; });
  });

  /* ---------- logo: exact fit, no letterboxing ---------- */
  function placeLogo() {
    const L = T.logo; if (!L || !nodes.logo) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (!g) { sizeLogo(img.naturalWidth, img.naturalHeight, L.href, null); return; }
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
      let transparent = false;
      for (let i = 3; i < px.length; i += 4) { if (px[i] < 250) { transparent = true; break; } }
      const j0 = 0, corner = [px[j0], px[j0 + 1], px[j0 + 2]];

      // A transparent logo is trimmed to its ink. An opaque one keeps its own
      // background -- cropping that away would strand light artwork on white.
      let x0 = 0, y0 = 0, x1 = c.width - 1, y1 = c.height - 1;
      if (transparent) {
        x0 = c.width; y0 = c.height; x1 = 0; y1 = 0;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
          if (px[(y * c.width + x) * 4 + 3] > 12) {
            if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
          }
        }
        if (x1 < x0 || y1 < y0) { x0 = 0; y0 = 0; x1 = c.width - 1; y1 = c.height - 1; }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      let href = L.href;
      if (transparent && (w !== c.width || h !== c.height)) {
        const t = document.createElement('canvas'); t.width = w; t.height = h;
        t.getContext('2d').drawImage(c, x0, y0, w, h, 0, 0, w, h);
        href = t.toDataURL('image/png');
      }
      L.bgColour = transparent ? null
        : '#' + corner.map((v) => v.toString(16).padStart(2, '0')).join('');
      sizeLogo(w, h, href, L.bgColour);
    };
    img.onerror = () => {};
    img.src = L.href;
  }
  function sizeLogo(w, h, href, bgColour) {
    const L = T.logo;
    const k = (L.fillPlate && L.bgColour) ? Math.max(L.width / w, L.height / h)
      : Math.min(L.width / w, L.height / h);
    const w2 = Math.round(w * k), h2 = Math.round(h * k);
    const x = Math.round(L.x + (L.width - w2) / 2), y = Math.round(L.y + (L.height - h2) / 2);
    nodes.logo.setAttribute('href', href);
    nodes.logo.setAttribute('clip-path', L.fillPlate && L.bgColour ? 'url(#logoClip)' : 'none');
    nodes.logo.setAttribute('x', x); nodes.logo.setAttribute('y', y);
    nodes.logo.setAttribute('width', w2); nodes.logo.setAttribute('height', h2);
    nodes.logoPlate.setAttribute('fill', L.fillPlate && bgColour ? bgColour : 'none');
    L.fitted = [x, y, w2, h2];
  }

  /* ---------- background removal ---------- */
  function cutout(el, tol, feather) {
    if (!document.createElement('canvas').getContext('2d')) return el.src;
    const long = Math.max(el.naturalWidth, el.naturalHeight), k = Math.min(1, 1400 / long);
    const w = Math.round(el.naturalWidth * k), h = Math.round(el.naturalHeight * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(el, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h), px = d.data;
    let r = 0, gr = 0, b = 0, n = 0;
    const edge = [];
    for (let x = 0; x < w; x++) { edge.push([x, 0], [x, h - 1]); }
    for (let y = 0; y < h; y++) { edge.push([0, y], [w - 1, y]); }
    edge.forEach(([x, y]) => { const i = (y * w + x) * 4; r += px[i]; gr += px[i + 1]; b += px[i + 2]; n++; });
    r /= n; gr /= n; b /= n;
    const lim = tol * tol * 3, seen = new Uint8Array(w * h), q = [];
    edge.forEach(([x, y]) => { const p = y * w + x; if (!seen[p]) { seen[p] = 1; q.push(p); } });
    const near = (p) => {
      const i = p * 4, dr = px[i] - r, dg = px[i + 1] - gr, db = px[i + 2] - b;
      return dr * dr + dg * dg + db * db <= lim;
    };
    const out = new Uint8Array(w * h);
    while (q.length) {
      const p = q.pop(); if (!near(p)) continue;
      out[p] = 1;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !seen[p - 1]) { seen[p - 1] = 1; q.push(p - 1); }
      if (x < w - 1 && !seen[p + 1]) { seen[p + 1] = 1; q.push(p + 1); }
      if (y > 0 && !seen[p - w]) { seen[p - w] = 1; q.push(p - w); }
      if (y < h - 1 && !seen[p + w]) { seen[p + w] = 1; q.push(p + w); }
    }
    const alpha = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) alpha[i] = out[i] ? 0 : 255;
    for (let pass = 0; pass < feather; pass++) {
      const cp = Float32Array.from(alpha);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        alpha[i] = (cp[i] + cp[i - 1] + cp[i + 1] + cp[i - w] + cp[i + w]) / 5;
      }
    }
    for (let i = 0; i < w * h; i++) px[i * 4 + 3] = alpha[i];
    g.putImageData(d, 0, 0);
    return cv.toDataURL('image/png');
  }
  /* One place decides which bitmap a panel shows, because three did and they
     disagreed. The server cutout outranks the manual chroma cut -- they are two
     answers to the same question, and the manual sliders are hidden wherever
     the server cutout is on offer, so in practice only one is ever set. */
  const srcFor = (s) =>
    (s.variant === 'cutout' && s.cutoutUrl) ? s.cutoutUrl
      : (s.cut && s.cutUrl) ? s.cutUrl
        : s.url;

  function applyCut(id) {
    const s = state.get(id); if (!s) return;
    const n = nodes[id];
    if (!s.cut) { n.img.setAttribute('href', srcFor(s)); return; }
    const key = s.tol + '/' + s.feather;
    if (s.cutKey !== key) { s.cutUrl = cutout(s.el, s.tol, s.feather); s.cutKey = key; }
    n.img.setAttribute('href', srcFor(s));
  }

  /* ---------- images ---------- */
  function layout(id) {
    const { panel: p, img } = nodes[id], s = state.get(id); if (!s) return;
    // Everything fills its panel, examples included. The example graphic keeps its
    // message small and central so even the widest panel cannot clip it.
    const base = Math.max(p.width / s.natW, p.height / s.natH);
    const dw = s.natW * base * s.zoom, dh = s.natH * base * s.zoom;
    const mx = Math.max(0, (dw - p.width) / 2), my = Math.max(0, (dh - p.height) / 2);
    if (s.demo) { s.ox = 0; s.oy = 0; }   // examples always sit centred
    else { s.ox = Math.max(-mx, Math.min(mx, s.ox)); s.oy = Math.max(-my, Math.min(my, s.oy)); }
    img.setAttribute('x', p.x + (p.width - dw) / 2 + s.ox); img.setAttribute('y', p.y + (p.height - dh) / 2 + s.oy);
    img.setAttribute('width', dw); img.setAttribute('height', dh);
    /* Effective print resolution of this photo, as placed.

       geom().ppi is canvas pixels per printed inch AT THE CHOSEN FACE, which is
       what this has to be measured against. It used to use T.canvas.dpi, a
       fixed per-template constant (strip 300, cover 200), but the canvas is one
       fixed raster mapped onto whichever face the customer picks -- so that
       constant is only right where it happens to coincide with ppi. The strip
       canvas is authored at 24.5 x 16.5 in; at a 12 x 8 in face every canvas
       pixel covers half the distance, so the true resolution is roughly double
       what the old figure claimed. Customers choosing the smaller prints were
       being warned their photo would print soft when it would not.

       dw already carries the zoom, so this stays a reading of the crop as
       placed, not of the file in the abstract. recipe() reports it as
       effectiveDpi, so the brief now carries the corrected figure too. */
    s.dpi = Math.round(geom().ppi * s.natW / dw);
  }
  /* ---------- upload ---------- */
  /* Functions run on Lambda with a ~6 MB request cap, so each photo goes up on
     its own and is re-encoded first. This is a transport re-encode, not a
     downscale of the artwork: 4000px on the longest side still carries a
     16 x 24 in print at well over 150dpi, and comfortably more than the
     largest face any template offers.

     It used to start at 5000px, which is where iPhone uploads were dying. A
     5000 x 3750 canvas is a 75 MB backing store, and the old code allocated a
     fresh one per rung on top of the decoded source. iOS Safari caps canvas
     area and, past the cap, drawImage does not throw -- it silently yields a
     blank canvas, which then encodes to a small, plausible-looking, entirely
     white JPEG. So: start lower, keep ONE canvas for every rung, and check
     that the draw actually produced something. */
  /* Pixels are cheaper to lose than quality: below about 0.75 JPEG artefacts
     start to show, and the comic styling applied later amplifies them. So give
     up resolution first and only trade quality once the pixel steps run out. */
  const ENCODE_LADDER = [[4000, 0.9], [4000, 0.82], [3000, 0.82]];
  // Aim under 4 MiB. The function hard-rejects above 5.5 MiB, and anything that
  // still misses that after the ladder surfaces as a per-panel upload error.
  const UPLOAD_TARGET_BYTES = 4 * 1024 * 1024;
  const QUALITY_FLOOR = 0.6;                      // last resort, visibly soft
  const QUALITY_STEP = 0.06;
  // Rungs to fall back to when a draw comes back blank, longest side in px.
  const BLANK_FALLBACK_SIDES = [2400, 1600, 1000];
  let saveId = null;                 // pendingPersonalisation._id, set by the first upload

  /* Per-slot upload lifecycle. Previously two loose flags (s.uploading and
     s.uploadError) that could disagree; one field cannot. A slot showing the
     seeded example has no state at all -- nothing of the customer's to send. */
  const PENDING = 'pending';         // queued behind another upload
  const UPLOADING = 'uploading';     // in flight
  const UPLOADED = 'uploaded';       // stored, key held in s.key
  const FAILED = 'failed';           // s.uploadError says why; tap to retry

  /* The styling lifecycle is a SECOND axis, not more values on the first: a
     photo is uploaded and then styled, and both halves can be in flight or
     have failed independently. Mirrors the server's photos[].styleStatus so a
     poll response maps straight across with no translation. */
  const STYLE_PENDING = 'pending';
  const STYLE_STYLING = 'styling';
  const STYLE_DONE = 'done';
  const STYLE_FAILED = 'failed';

  /* Polling. 3s is brisk enough that a 36s generation feels watched; after two
     minutes something is wrong and there is no point asking twelve times a
     minute about it. */
  const STYLE_POLL_MS = 3000;
  const STYLE_POLL_SLOW_MS = 10000;
  const STYLE_POLL_SLOW_AFTER_MS = 120000;

  /* Judged on the SHORTEST side, because that is what a face is measured
     across. These replace the dpi warning at the raw stage: before styling
     there is no styled image to measure, and the model's output size is fixed
     by styleSize rather than by what went in -- so the only useful question
     about the raw photo is whether there is enough of it to work from. */
  const SOFT_MIN_SOURCE_PX = 800;    // warn, still allowed
  const HARD_MIN_SOURCE_PX = 400;    // refuse the file outright

  const mine = () => [...state.values()].filter((s) => !s.demo);
  const inState = (st) => mine().filter((s) => s.uploadState === st).length;
  const inFlight = () => inState(PENDING) + inState(UPLOADING);
  /** 0-based index of the first slot whose upload failed, or -1. */
  const firstFailed = () => T.panels.findIndex((p) => {
    const s = state.get(p.id);
    return !!s && !s.demo && s.uploadState === FAILED;
  });

  /* Styling counts only slots that reached the server: an upload still in
     flight is not "waiting for style", it is waiting for itself. */
  const styleable = () => mine().filter((s) => s.uploadState === UPLOADED);
  const styleReady = () => styleable().filter((s) => s.styleState === STYLE_DONE).length;
  const styleWaiting = () => styleable().filter(
    (s) => s.styleState === STYLE_PENDING || s.styleState === STYLE_STYLING
  ).length;
  /* And the cutout, which is a SECOND wait after styling finishes -- the server
     writes it once the panel is already 'done'. Counting it separately is the
     whole point: styling being over does not mean there is nothing left to
     wait for, and the poller used to think it did. */
  const cutoutWaiting = () => styleable().filter((s) => !cutoutSettled(s)).length;
  /** 0-based index of the first slot whose STYLING failed, or -1. */
  const firstStyleFailed = () => T.panels.findIndex((p) => {
    const s = state.get(p.id);
    return !!s && !s.demo && s.styleState === STYLE_FAILED;
  });

  /* The server writes a short reason: "safety: ...", "timeout", "http 404",
     "other: ...", "cap". Two of those cannot be fixed by asking again -- a
     photograph the model refuses will be refused identically, and the cap is
     spent for the whole build -- so those get Replace instead of a retry that
     would only fail the same way. */
  const isSafetyReason = (r) => /^safety/i.test(r || '');
  const isCapReason = (r) => /^cap$/i.test((r || '').trim());
  const styleRetryable = (r) => !isSafetyReason(r) && !isCapReason(r);

  const loadImage = (file) => new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => res({ im, url });
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("That file is not an image we can read")); };
    im.src = url;
  });
  const toBlob = (cv, q) => new Promise((res) => cv.toBlob(res, "image/jpeg", q));

  /* Did the draw actually put anything on the canvas? Past iOS Safari's canvas
     area cap drawImage is a silent no-op, leaving transparent black. Sampling a
     grid is enough to tell that apart from a real photograph: a genuine image
     that is uniformly one colour at every one of these points, alpha included,
     is not something a customer photograph does.

     getImageData can itself throw (a tainted canvas, or the context being lost
     under memory pressure). Treating a throw as "not blank" is the safe way
     round: the worst case is that we send a photo we could not inspect, rather
     than discarding a good one. */
  function canvasDrewSomething(g, w, h) {
    try {
      const xs = [0.02, 0.25, 0.5, 0.75, 0.98], ys = xs;
      let first = null;
      for (const fx of xs) {
        for (const fy of ys) {
          const x = Math.min(w - 1, Math.max(0, Math.round(fx * w)));
          const y = Math.min(h - 1, Math.max(0, Math.round(fy * h)));
          const d = g.getImageData(x, y, 1, 1).data;
          const key = `${d[0]},${d[1]},${d[2]},${d[3]}`;
          if (first === null) first = key;
          else if (key !== first) return true;
        }
      }
      // Every sample identical. Fully transparent is the iOS no-op signature.
      return !/,0$/.test(first || '');
    } catch (e) {
      return true;
    }
  }

  async function encodeForUpload(file) {
    // ONE canvas for the whole ladder. Resizing it reuses the same element and
    // lets the previous backing store go, instead of holding four at once.
    const cv = document.createElement("canvas");
    const g = cv.getContext ? cv.getContext("2d") : null;
    if (!g) return file;                        // no canvas: send the original
    const { im, url } = await loadImage(file);
    try {
      const w0 = im.naturalWidth || im.width, h0 = im.naturalHeight || im.height;
      /** Draw at this longest side; false if the canvas came back blank. */
      const drawAt = (maxSide) => {
        const k = Math.min(1, maxSide / Math.max(w0, h0));   // never upscale
        cv.width = Math.max(1, Math.round(w0 * k));
        cv.height = Math.max(1, Math.round(h0 * k));
        g.clearRect(0, 0, cv.width, cv.height);
        g.drawImage(im, 0, 0, cv.width, cv.height);
        return canvasDrewSomething(g, cv.width, cv.height);
      };

      let blob = null, q = 0, drew = false, blankAt = null;
      for (const [side, quality] of ENCODE_LADDER) {
        q = quality;
        // Two rungs share 4000px (same pixels, lower quality). If that size has
        // already come back blank, re-allocating it only to fail again costs
        // another large backing store on the very device that could not afford
        // the first one.
        if (blankAt === side) continue;
        if (!drawAt(side)) { blankAt = side; continue; }   // past the cap
        drew = true;
        blob = await toBlob(cv, q);
        if (!blob) return file;
        if (blob.size <= UPLOAD_TARGET_BYTES) break;
      }

      /* Every rung came back blank, so the cap is below even the smallest of
         them. Keep halving until the device will actually draw. Resolution lost
         here is resolution the device was never going to give us, and a soft
         photo is a far better outcome than a white rectangle the customer does
         not discover until the proof. */
      if (!drew) {
        for (const side of BLANK_FALLBACK_SIDES) {
          if (!drawAt(side)) continue;
          drew = true;
          q = 0.82;
          blob = await toBlob(cv, q);
          break;
        }
      }
      // Nothing would draw at any size: send the original and let the function
      // judge it, rather than uploading a blank.
      if (!drew || !blob) return file;

      /* Pixel steps exhausted; the canvas is at the last rung it managed, so
         only quality is left to give. Stop at the floor rather than send mush.

         The step is clamped to the floor instead of just being compared with
         it. From 0.82 a plain 0.06 step goes 0.76, 0.70, 0.64, 0.58 -- it never
         lands on 0.60, so the old loop ran one step BELOW the floor it names.
         Clamping makes 0.60 the last quality actually used. */
      while (blob.size > UPLOAD_TARGET_BYTES && q > QUALITY_FLOOR) {
        q = Math.max(QUALITY_FLOOR, Math.round((q - QUALITY_STEP) * 100) / 100);
        const encoded = await toBlob(cv, q);
        if (!encoded) break;
        blob = encoded;
      }
      const base = (file.name || "photo").replace(/\.[^.]+$/, "");
      return new File([blob], base + ".jpg", { type: "image/jpeg" });
    } finally {
      // Release the decoded source and the canvas backing store before the next
      // photo in the queue starts: on a phone these are the whole budget.
      URL.revokeObjectURL(url);
      try { im.src = ""; } catch (e) { /* nothing to release */ }
      cv.width = 0; cv.height = 0;
    }
  }

  function setUploadState(id, st, reason) {
    const s = state.get(id), n = nodes[id];
    if (!s) return;
    s.uploadState = st;
    s.uploadError = st === FAILED ? (reason || "Upload failed") : null;
    // Dim while it is not yet safely stored, so "still working" is visible on
    // the artwork itself rather than only in the side panel.
    if (n && n.img) n.img.setAttribute("opacity", st === UPLOADED ? 1 : 0.45);
    drawSlotFlag(id);
    if (selected === id) syncPanel();
    refresh();
  }

  /* A failed slot has to be findable without reading the side panel: on a phone
     the panel is far below the board, which is exactly how this shipped looking
     fine. The flag is drawn last so it sits above the artwork, and carries no
     pointer events of its own so a tap still reaches the slot underneath.

     data-role marks it as screen furniture: both exporters strip it, so it can
     never reach a print file, a draft download or the basket snapshot. */
  function drawSlotFlag(id) {
    const n = nodes[id];
    if (!n) return;
    if (n.flag) { n.flag.remove(); n.flag = null; }
    // the reason lives on the hit area, which is what a pointer actually meets
    if (n.hit) {
      const old = n.hit.querySelector("title");
      if (old) old.remove();
    }
    const s = state.get(id);
    if (!s || s.demo) return;            // the seeded example is exempt from all of this

    /* Three things can be worth saying over a slot, and only one at a time.
       Upload first: until the photo is stored there is nothing to style, so a
       styling message would be describing work that has not been queued. */
    let kind = null, lines = null, tip = null;
    if (s.uploadState === FAILED) {
      kind = 'bad';
      lines = ['Upload failed', 'Tap to retry'];
      tip = `Upload failed — tap to retry. ${s.uploadError || ''}`.trim();
    } else if (s.uploadState === UPLOADED && s.styleState === STYLE_FAILED) {
      kind = 'bad';
      lines = isSafetyReason(s.styleError) ? ['Style not applied', 'Use a different photo']
        : isCapReason(s.styleError) ? ['Style not applied', 'No attempts left']
          : ['Style not applied', 'Tap to try again'];
      tip = `${styleFailureText(s)} (${s.styleError || 'unknown'})`;
    } else if (s.uploadState === UPLOADED && !s.styled
      && (s.styleState === STYLE_PENDING || s.styleState === STYLE_STYLING)) {
      kind = 'busy';
      lines = ['Applying', 'comic style…'];
      tip = 'Applying the comic style to this photo…';
    }
    if (!kind) return;

    const bad = kind === 'bad';
    const p = n.panel;
    const g = mk("g", { "data-role": "slot-flag", "pointer-events": "none" });
    g.appendChild(mk("rect", {
      x: p.x, y: p.y, width: p.width, height: p.height,
      fill: bad ? "rgba(214,0,28,0.34)" : "rgba(10,10,16,0.55)",
    }));
    const inset = Math.max(2, Math.min(p.width, p.height) * 0.02);
    g.appendChild(mk("rect", {
      x: p.x + inset, y: p.y + inset,
      width: Math.max(1, p.width - 2 * inset), height: Math.max(1, p.height - 2 * inset),
      fill: "none", stroke: bad ? "#D6001C" : "#FFF200", "stroke-width": inset,
      "stroke-dasharray": `${inset * 3} ${inset * 2}`,
    }));

    // Two lines: a strip panel is far narrower than it is tall, and one line of
    // this at a readable size runs straight out of it.
    const size = Math.max(12, Math.min(p.height * 0.11, p.width * 0.085));

    /* A spinner rather than a percentage. The model reports no progress, so any
       bar would be a guess dressed as information -- and a stalled fake bar
       reads as a broken page. SMIL because it animates without a paint loop,
       which matters on the phone this runs on. */
    if (!bad) {
      const r = size * 0.9;
      const cx = p.x + p.width / 2, cy = p.y + p.height / 2 - size * 1.5;
      g.appendChild(mk('circle', {
        cx, cy, r, fill: 'none', stroke: 'rgba(255,255,255,0.25)', 'stroke-width': size * 0.22,
      }));
      const arc = mk('circle', {
        cx, cy, r, fill: 'none', stroke: '#FFF200', 'stroke-width': size * 0.22,
        'stroke-linecap': 'round',
        'stroke-dasharray': `${2 * Math.PI * r * 0.28} ${2 * Math.PI * r}`,
      });
      const spin = document.createElementNS(SVGNS, 'animateTransform');
      spin.setAttribute('attributeName', 'transform');
      spin.setAttribute('type', 'rotate');
      spin.setAttribute('from', `0 ${cx} ${cy}`);
      spin.setAttribute('to', `360 ${cx} ${cy}`);
      spin.setAttribute('dur', '1.1s');
      spin.setAttribute('repeatCount', 'indefinite');
      arc.appendChild(spin);
      g.appendChild(arc);
    }

    const t = mk("text", {
      "text-anchor": "middle", "font-family": "ui-sans-serif,system-ui,sans-serif",
      "font-size": size, "font-weight": 800, fill: "#FFFFFF",
      stroke: "#000000", "stroke-width": size * 0.16, "paint-order": "stroke",
    });
    lines.forEach((line, i) => {
      const ts = mk("tspan", { x: p.x + p.width / 2, y: p.y + p.height / 2 });
      ts.setAttribute("dy", (bad ? -size * 0.15 : size * 0.9) + (i === 0 ? 0 : size * 1.3));
      ts.textContent = line;
      t.appendChild(ts);
    });
    g.appendChild(t);
    svg.appendChild(g);
    n.flag = g;

    if (n.hit && tip) {
      const title = document.createElementNS(SVGNS, "title");
      title.textContent = tip;
      n.hit.appendChild(title);
    }
  }

  /** The sentence a customer reads when styling did not work. */
  function styleFailureText(s) {
    if (isSafetyReason(s.styleError)) {
      return "We couldn't apply the comic style to this photo — please try a different one";
    }
    if (isCapReason(s.styleError)) {
      return 'This build has used all its style attempts — please start a new one';
    }
    return "The comic style didn't apply — tap to try again";
  }

  /* ---------- styling ---------- */
  /* ONE poller for the whole personalisation, not one per slot. The status
     endpoint answers for every panel at once, so a poller per slot would ask
     the same question twelve times and still learn nothing extra. */
  let pollTimer = null;
  let pollStartedAt = 0;
  let pollPausedHidden = false;

  const pollDelay = () =>
    (Date.now() - pollStartedAt > STYLE_POLL_SLOW_AFTER_MS ? STYLE_POLL_SLOW_MS : STYLE_POLL_MS);

  function ensureStylePoll() {
    if (MODE !== 'customer' || !saveId) return;
    if (pollTimer !== null || pollPausedHidden) return;   // already running, or waiting on the tab
    if (!pollStartedAt) pollStartedAt = Date.now();
    pollTimer = setTimeout(runStylePoll, 0);
  }

  function stopStylePoll() {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    pollStartedAt = 0;
  }

  async function runStylePoll() {
    pollTimer = null;
    /* A hidden tab is throttled to roughly one timer a minute anyway, and
       polling it burns the customer's data for answers nobody is looking at.
       Genuinely paused rather than slowed: the visibilitychange listener below
       is what starts it again. */
    if (document.hidden) { pollPausedHidden = true; return; }

    let payload = null;
    try {
      const res = await fetch(`/api/personalisation-status/${saveId}`, { cache: 'no-store' });
      if (res.ok) payload = await res.json();
      else console.warn(`[builder] style status returned ${res.status}`);
    } catch (e) {
      // A dropped poll is not a failure -- the next one asks again.
      console.warn(`[builder] style status poll failed: ${e.message}`);
    }

    if (payload) await applyStyleStatus(payload);

    /* Keep going while ANYTHING is outstanding. This asked only about styling,
       and the cutout is written after the panel is committed 'done' -- so the
       poll stopped at the exact moment the cutout became the thing worth
       waiting for. The customer sat on "Cutting out the background…" for ever
       with the full picture in the panel, because nobody was listening when
       the cutout landed twenty seconds later. */
    if (styleWaiting() > 0 || cutoutWaiting() > 0) pollTimer = setTimeout(runStylePoll, pollDelay());
    else stopStylePoll();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !pollPausedHidden) return;
    pollPausedHidden = false;
    if (styleWaiting() > 0 || cutoutWaiting() > 0) ensureStylePoll();
  });

  /* ---------- swapping panels ---------- */
  /** Which slot currently holds the photograph the server calls `sp`. */
  function slotForServerPanel(sp) {
    for (const p of T.panels) {
      const s = state.get(p.id);
      if (s && !s.demo && (s.serverPanel || p.id) === sp) return p.id;
    }
    return null;
  }

  let swapFrom = null;   // slot id awaiting a partner, or null

  /* Point a slot's nodes at whatever it now holds. Used by the swap, which
     moves state between slots without touching the photographs themselves --
     no upload, no style call, nothing the cap could count. */
  function rebindSlot(id) {
    const n = nodes[id], s = state.get(id);
    if (!n) return;
    if (!s) {
      n.img.setAttribute('opacity', 0); n.img.removeAttribute('href');
      if (n.num) n.num.setAttribute('opacity', 1);
      if (n.plate) n.plate.setAttribute('opacity', 1);
      n.hit.classList.remove('filled');
      drawSlotFlag(id);
      return;
    }
    /* Panels are different shapes, so a crop chosen in one is meaningless in
       another -- a face centred in a tall panel can end up out of frame in a
       wide one. Both sides start fit-centred and the customer re-crops if they
       want to, which is the same reasoning as the styled swap. */
    s.zoom = 1; s.ox = 0; s.oy = 0;
    n.img.setAttribute('href', srcFor(s));
    n.img.setAttribute('opacity', s.demo ? 1 : (s.uploadState && s.uploadState !== UPLOADED ? 0.45 : 1));
    if (n.num) n.num.setAttribute('opacity', s.demo ? 1 : 0);
    if (n.plate) n.plate.setAttribute('opacity', s.demo ? 1 : 0);
    n.hit.classList.toggle('filled', !s.demo);
    if (s.cut) { s.cutKey = null; applyCut(id); }
    layout(id);
    drawSlotFlag(id);
  }

  /* Exchange two panels' contents.

     The whole state object moves, which carries the photograph, its blob keys,
     the styled image and its dimensions, and the sha256 the server dedupes on.
     serverPanel travels with it, so the poll and the retry endpoint keep
     addressing the photograph rather than the hole it used to sit in. Nothing
     is uploaded and nothing is styled: this is a rearrangement of things the
     server already has. */
  function swapPanels(a, b) {
    if (!a || !b || a === b) return false;
    const sa = state.get(a), sb = state.get(b);
    if (!sa && !sb) return false;
    if (sb) state.set(a, sb); else state.delete(a);
    if (sa) state.set(b, sa); else state.delete(b);
    rebindSlot(a); rebindSlot(b);
    select(b);
    refresh();
    console.log(`[builder] swapped ${a} <-> ${b}`);
    return true;
  }

  function beginSwap(id) {
    const s = state.get(id);
    if (!s || s.demo) return;            // nothing to move
    swapFrom = id;
    if (nodes[id] && nodes[id].hit) nodes[id].hit.classList.add('swap-source');
    syncPanel(); refresh();
  }

  function cancelSwap() {
    if (!swapFrom) return;
    const n = nodes[swapFrom];
    if (n && n.hit) n.hit.classList.remove('swap-source');
    swapFrom = null;
    syncPanel(); refresh();
  }

  /** A tap while a swap is armed. Returns true if it consumed the tap. */
  function handleSwapTap(id) {
    if (!swapFrom) return false;
    const from = swapFrom;
    cancelSwap();
    if (id !== from) swapPanels(from, id);   // same panel = cancel, as promised
    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && swapFrom) { e.preventDefault(); cancelSwap(); }
  });

  /** Fold one status response into the slots. */
  async function applyStyleStatus(payload) {
    /* A deployment with no cutout service configured never sends one, so the
       gate must not wait for one. Only an explicit false counts -- an older
       function that does not send the field at all leaves this alone. */
    if (payload.cutoutEnabled === false) cutoutEnabled = false;
    const rows = Array.isArray(payload.photos) ? payload.photos : [];
    let touched = false;
    for (const row of rows) {
      // Matched on serverPanel, not on the slot id: after a swap the photo the
      // server calls panel-01 may be sitting in panel-05.
      const slot = slotForServerPanel(row.panel);
      if (!slot) continue;
      const s = state.get(slot);
      if (!s || s.demo) continue;              // the seeded example is not ours to style
      const was = s.styleState;
      s.styleState = row.styleStatus || STYLE_PENDING;
      /* When the cutout's clock starts. The server writes the cutout after the
         panel is already done, so this is the moment from which waiting for it
         is reasonable -- and, past CUTOUT_GIVE_UP_MS, no longer is. */
      if (s.styleState === STYLE_DONE && !s.styleDoneAt) s.styleDoneAt = Date.now();
      s.styleError = row.styleError || null;
      if (row.styledWidth) s.styledW = row.styledWidth;
      if (row.styledHeight) s.styledH = row.styledHeight;
      if (row.styledKey) s.styledKey = row.styledKey;
      /* Cover only, and arriving a little after the styled image because the
         cutout runs once the panel is already done. cutoutError with no key is
         a settled answer, not a wait: the cover prints from the styled image. */
      if (row.cutoutKey) s.cutoutKey = row.cutoutKey;
      if (row.cutoutWidth) s.cutoutW = row.cutoutWidth;
      if (row.cutoutHeight) s.cutoutH = row.cutoutHeight;
      s.cutoutError = row.cutoutError || null;

      if (s.styleState === STYLE_DONE) {
        // A dedupe hit lands here on the very first poll, already done, with no
        // 'styling' in between. Nothing special to do -- the swap is the same.
        await applyStyled(slot);
        if (s.cutoutKey && !s.cutoutUrl) { await applyCutout(slot); touched = true; }
      } else if (was !== s.styleState) {
        drawSlotFlag(slot);
        touched = true;
      }
    }
    if (touched) { if (selected) syncPanel(); refresh(); }
  }

  /* Swap the styled photograph into the slot.
     The model reframes slightly, so any crop the customer set was chosen
     against a picture that no longer exists -- start centred and unzoomed and
     invite them to re-crop, rather than keeping a framing that now cuts
     somewhere they did not choose. */
  async function applyStyled(id) {
    const s = state.get(id);
    if (!s || s.demo || s.styled || s.styledLoading) return;
    s.styledLoading = true;
    try {
      const res = await fetch(`/api/personalisation-photo/${saveId}/${s.serverPanel || id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const probe = new Image();
      await new Promise((ok, fail) => {
        probe.onload = ok;
        probe.onerror = () => fail(new Error('the styled image would not decode'));
        probe.src = url;
      });

      const old = s.url;
      s.rawUrl = s.rawUrl || old;      // kept: the raw is what a re-style works from
      s.url = url; s.el = probe;
      s.natW = probe.naturalWidth || s.natW;
      s.natH = probe.naturalHeight || s.natH;
      s.styled = true;
      s.zoom = 1; s.ox = 0; s.oy = 0;  // fit to panel, centred

      const n = nodes[id];
      if (n && n.img) { n.img.setAttribute('href', url); n.img.setAttribute('opacity', 1); }
      if (s.cut) { s.cutKey = null; applyCut(id); }
      if (old && old !== url && old !== s.rawUrl) {
        try { URL.revokeObjectURL(old); } catch (e) { /* already gone */ }
      }
      layout(id);                      // recomputes s.dpi from the styled pixels
      drawSlotFlag(id);
      if (selected === id) syncPanel();
      refresh();
      console.log(`[builder] ${id} styled ${s.natW}x${s.natH}`);
    } catch (e) {
      // Leave it as done-but-unswapped and let the next poll try again; the
      // gate keeps the basket shut either way.
      s.styledLoading = false;
      console.warn(`[builder] could not load the styled photo for ${id}: ${e.message}`);
      return;
    }
    s.styledLoading = false;
  }

  /* ---------- cutout (standard cover only) ---------- */
  /** Is the cutout question settled for this slot -- arrived, refused, or N/A? */
  const CUTOUT_TEMPLATE = 'cover';
  /* Assume the service is on until the server says otherwise, and let the first
     status poll correct it. The other way round -- assume off, switch on when
     told -- opens Add to basket for the moment before the first poll lands,
     which is exactly long enough for someone to click it. */
  let cutoutEnabled = true;
  const wantsCutout = () => MODE === 'customer' && TK === CUTOUT_TEMPLATE && cutoutEnabled;
  /* How long to keep asking after the styled image lands. The service gets 90s
     server-side, so three minutes covers it with room for a retry. Past that,
     stop waiting: a background function that died without writing either a key
     or an error would otherwise hold the customer on "Cutting out the
     background…" for ever, with a disabled Add to basket and no way forward.
     Giving up costs them the toggle; not giving up costs them the order. */
  const CUTOUT_GIVE_UP_MS = 180000;

  const cutoutSettled = (s) =>
    !wantsCutout() || !!s.cutoutKey || !!s.cutoutError || s.styleState !== STYLE_DONE
    || (!!s.styleDoneAt && Date.now() - s.styleDoneAt > CUTOUT_GIVE_UP_MS);

  /** Which image a slot is currently showing. */
  const variantOf = (s) => (s.cutoutUrl && s.variant !== 'styled' ? 'cutout' : 'styled');

  /* Fetch the background-removed PNG and hold it alongside the styled JPEG.
     Both are kept: the toggle switches between them without another request,
     and the recipe records which one the customer settled on. */
  async function applyCutout(id) {
    const s = state.get(id);
    if (!s || s.demo || !s.cutoutKey || s.cutoutUrl || s.cutoutLoading) return;
    s.cutoutLoading = true;
    try {
      const res = await fetch(
        `/api/personalisation-photo/${saveId}/${s.serverPanel || id}?variant=cutout`,
        { cache: 'no-store' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const probe = new Image();
      await new Promise((ok, fail) => {
        probe.onload = ok;
        probe.onerror = () => fail(new Error('the cutout would not decode'));
        probe.src = url;
      });
      s.cutoutUrl = url; s.cutoutEl = probe;
      if (s.variant !== 'styled') showVariant(id, 'cutout');   // default to the cutout
      console.log(`[builder] ${id} cutout ${probe.naturalWidth}x${probe.naturalHeight}`);
    } catch (e) {
      // Not fatal, and not recorded as a cutoutError -- the server's verdict is
      // the one that matters; this is just a fetch that can be retried by the
      // next poll.
      console.warn(`[builder] could not load the cutout for ${id}: ${e.message}`);
    }
    s.cutoutLoading = false;
  }

  /* Swap the panel between the cut-out subject and the whole styled picture.
     The cutout sits over the template's burst, which is the entire point of it
     on a cover; the full picture covers the burst completely. */
  function showVariant(id, variant) {
    const s = state.get(id), n = nodes[id];
    if (!s || !n) return;
    const useCutout = variant === 'cutout' && s.cutoutUrl;
    s.variant = useCutout ? 'cutout' : 'styled';
    const el = useCutout ? s.cutoutEl : s.el;
    const url = srcFor(s);
    if (!el || !url) return;
    // layout() measures from natW/natH, so they have to describe what is shown
    s.natW = el.naturalWidth || s.natW;
    s.natH = el.naturalHeight || s.natH;
    s.zoom = 1; s.ox = 0; s.oy = 0;
    n.img.setAttribute('href', url);
    n.img.setAttribute('opacity', 1);
    layout(id);
    if (selected === id) syncPanel();
    refresh();
  }

  /* Ask for one panel to be styled again. Only reached for reasons that could
     plausibly come out differently -- see styleRetryable. */
  async function retryStyle(id) {
    const s = state.get(id);
    if (!s || s.demo || !saveId) return false;
    if (s.styleState === STYLE_PENDING || s.styleState === STYLE_STYLING) return false;
    s.styleState = STYLE_PENDING; s.styleError = null;
    drawSlotFlag(id);
    if (selected === id) syncPanel();
    refresh();
    try {
      const res = await fetch(`/api/personalisation-style/${saveId}/${s.serverPanel || id}?retry=1`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      // A dedupe hit answers 200 with deduped:true and the panel already done;
      // the poll picks that up on its next pass like any other 'done'.
      if (!res.ok && !data.deduped) throw new Error(data.reason || `HTTP ${res.status}`);
      ensureStylePoll();
      return true;
    } catch (e) {
      s.styleState = STYLE_FAILED;
      s.styleError = e.message || 'retry failed';
      console.warn(`[builder] re-style of ${id} failed: ${s.styleError}`);
      drawSlotFlag(id);
      if (selected === id) syncPanel();
      refresh();
      return false;
    }
  }

  /* Re-send one photo, leaving every other slot alone. The original file is
     still in s.file: adoptEncoded only swaps it in once a send has succeeded,
     so a failed slot still holds what the customer chose. */
  function retryUpload(id) {
    const s = state.get(id);
    if (!s || s.demo || !s.file) return false;
    if (s.uploadState === PENDING || s.uploadState === UPLOADING) return false;
    upload(id, s.file);
    return true;
  }

  /* Put a slot in front of the customer -- used when Add to basket names one.

     Deliberately not just scrollIntoView. That call is animated (this site sets
     scroll-behavior: smooth), and an animated scroll is silently dropped in
     more places than is comfortable: iOS Safari before 15.4 ignores the options
     object outright, a background tab never runs the animation, and
     prefers-reduced-motion can cancel it. Being shown the panel matters more
     than the glide, so try the nice version, then check it actually happened
     and place the page directly if it did not. */
  function focusSlot(id) {
    select(id);
    const n = nodes[id];
    if (!n || !n.hit || !n.hit.getBoundingClientRect) return;
    const vh = () => window.innerHeight || document.documentElement.clientHeight || 0;
    const inView = () => {
      const r = n.hit.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= vh();
    };
    if (inView()) return;

    try { n.hit.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    catch (e) { try { n.hit.scrollIntoView(); } catch (e2) { /* nothing more to try */ } }

    setTimeout(() => {
      if (inView()) return;
      const r = n.hit.getBoundingClientRect();
      const page = window.pageYOffset || document.documentElement.scrollTop || 0;
      const top = Math.max(0, r.top + page - Math.max(0, (vh() - r.height) / 2));
      // 'instant' is the only way past the page's own scroll-behavior: smooth
      try { window.scrollTo({ top, behavior: 'instant' }); }
      catch (e) { window.scrollTo(0, top); }
    }, 700);
  }

  /* The panel must show, and be measured from, the file that was actually
     stored -- not the original the customer dropped. Otherwise they position
     one image while another is kept, and the dpi reading (and the recipe's
     sourcePx / effectiveDpi) describe a file nobody has. Zoom and offset are
     in canvas units and the aspect ratio is unchanged, so the framing the
     customer set is preserved across the swap. */
  function adoptEncoded(id, encoded) {
    return new Promise((resolve) => {
      const s = state.get(id);
      if (!s || s.demo) return resolve();
      const url = URL.createObjectURL(encoded), probe = new Image();
      probe.onload = () => {
        const old = s.url;
        s.url = url; s.el = probe; s.file = encoded;
        s.natW = probe.naturalWidth || s.natW;
        s.natH = probe.naturalHeight || s.natH;
        const n = nodes[id];
        if (n && n.img) n.img.setAttribute("href", url);
        if (s.cut) { s.cutKey = null; applyCut(id); }   // recut from the stored file
        if (old && old !== url) { try { URL.revokeObjectURL(old); } catch (e) { /* already gone */ } }
        layout(id);                                     // recomputes s.dpi from natW
        if (selected === id) syncPanel();
        refresh();
        resolve();
      };
      probe.onerror = () => resolve();                  // keep the original rather than blank the panel
      probe.src = url;
    });
  }

  /* One photo, one request -- and one at a time. The first upload creates the
     document and hands back the id every later one has to carry, so they must
     not be in flight together: a board drop of twelve would otherwise race and
     create twelve documents. Queueing also keeps the "N to go" count honest. */
  /* A phone on a weak uplink can sit on an open socket indefinitely -- fetch
     has no timeout of its own, so a stalled upload used to hang the whole
     serial queue behind it with nothing but "Uploading…" to show for it.
     45s is comfortably longer than a 4 MiB post on a poor connection and short
     enough that a customer has not given up. */
  const UPLOAD_TIMEOUT_MS = 45000;
  // Doubles as the retry sentinel and as the words the customer reads.
  const TIMED_OUT = 'The upload timed out — the connection may be slow.';

  /** POST once, aborting at the timeout. Throws Error(TIMED_OUT) on abort. */
  async function postPhoto(fd) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), UPLOAD_TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch('/api/personalise-save',
        { method: 'POST', body: fd, ...(ac ? { signal: ac.signal } : {}) });
    } catch (e) {
      // An abort and a dropped connection both land here; only the first is
      // ours, and it is the one worth naming to the customer.
      if (ac && ac.signal.aborted) throw new Error(TIMED_OUT);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  /* Worth one silent retry: a timeout, and the gateway codes that mean the
     platform gave up rather than the function refusing us. A 4xx is a decision
     -- wrong file type, too large, bad id -- and repeating it would only waste
     the customer's data allowance to arrive at the same answer. */
  const worthRetrying = (status, message) =>
    message === TIMED_OUT || status === 502 || status === 503 || status === 504;

  let uploadChain = Promise.resolve();
  function upload(id, file) {
    setUploadState(id, PENDING);   // counted as soon as it is queued
    const run = async () => {
      // The slot may have been cleared or replaced while this waited its turn.
      const before = state.get(id);
      if (!before || before.demo || before.uploadState !== PENDING) return;
      setUploadState(id, UPLOADING);
      try {
        const sending = await encodeForUpload(file);
        const buildBody = () => {
          // A FormData that has been handed to a consumed/aborted request is
          // not safe to send again, so each attempt gets its own.
          const fd = new FormData();
          fd.append("panelId", id);
          fd.append("photo", sending, sending.name || (id + ".jpg"));
          if (saveId) fd.append("id", saveId);
          if (consentAt) fd.append("consentAt", consentAt);
          /* The template decides styleSize, and the server cannot know it from
             the first photo alone -- the recipe does not arrive until Add to
             basket. Sent on every upload, not just the first: it costs nothing,
             and the first upload is the one that creates the document, so a
             cover has to be marked 4K before any styling starts. finalise()
             sets the field authoritatively later either way. */
          fd.append("templateId", TK);
          return fd;
        };

        let res, data;
        for (let attempt = 1; ; attempt++) {
          let status = 0, message = null;
          try {
            ({ res, data } = await postPhoto(buildBody()));
            if (res.ok && data.id) break;
            status = res.status;
            // The function answers with a reason on every refusal. Carry it
            // through verbatim rather than flattening everything to "Upload
            // failed": "too large once encoded" and "unsupported file type"
            // need different fixes from the customer, and only the reason
            // tells them apart.
            message = data.error || `Upload failed (HTTP ${res.status})`;
          } catch (e) {
            message = e.message || 'Upload failed';
          }
          if (attempt === 1 && worthRetrying(status, message)) {
            console.warn(`[builder] upload attempt 1 for ${id} failed (${message}) — retrying once`);
            continue;
          }
          throw new Error(message);
        }

        saveId = data.id;
        const s = state.get(id);
        if (s) {
          s.key = data.key;
          /* The server starts styling the moment it has the photo, so the slot
             is already waiting by the time this returns. A dedupe hit is
             reported as done on the very first poll. */
          s.styleState = STYLE_PENDING;
          s.styleError = null;
        }
        // the stored file is the one the customer should be working with
        if (sending !== file) await adoptEncoded(id, sending);
        setUploadState(id, UPLOADED);
        ensureStylePoll();
      } catch (e) {
        const reason = e.message || "Upload failed";
        // The slot's tooltip carries the reason too, but a tooltip is no use on
        // a phone -- which is where these failures actually happen.
        console.warn(`[builder] upload failed for ${id}: ${reason}`);
        setUploadState(id, FAILED, reason);
      }
    };
    uploadChain = uploadChain.then(run);   // run never rejects
    return uploadChain;
  }

  /* A photo the styling stage cannot work from, refused before it is placed.

     Judged here rather than at Add to basket on purpose: uploading it, styling
     it and only then saying no would spend a model call and a minute of the
     customer's time to reach the same answer. Customer mode only -- studio
     work is prepared artwork, not a phone snap, and is never styled. */
  let rejected = null;   // { id, text } -- surfaced by syncPanel for that slot

  function tooSmall(w, h) {
    return Math.min(w || 0, h || 0) < HARD_MIN_SOURCE_PX;
  }

  function place(id, file) {
    if (!hasConsent()) return;          // belt and braces: picker, panel drop, board drop
    const url = URL.createObjectURL(file), probe = new Image();
    probe.onload = () => {
      if (MODE === 'customer' && tooSmall(probe.naturalWidth, probe.naturalHeight)) {
        rejected = {
          id,
          text: `This photo is too small to use — it is ${probe.naturalWidth} × ${probe.naturalHeight} `
            + `and we need at least ${HARD_MIN_SOURCE_PX} pixels on the shortest side.`,
        };
        try { URL.revokeObjectURL(url); } catch (e) { /* already gone */ }
        select(id); syncPanel(); refresh();
        return;
      }
      if (rejected && rejected.id === id) rejected = null;
      state.set(id, {
        url, el: probe, name: file.name, file, natW: probe.naturalWidth, natH: probe.naturalHeight,
        zoom: 1, ox: 0, oy: 0, cut: false, tol: 34, feather: 2,
        // Studio mode never uploads, so its slots stay stateless. A customer
        // slot is uploaded the moment it is filled, so it starts queued.
        uploadState: MODE === 'customer' ? PENDING : null, uploadError: null,
        styleState: null, styleError: null, styled: false,
        /* The panel this photograph was UPLOADED under, which stops being the
           panel it sits in the moment anything is swapped. Every conversation
           with the server -- the status poll, fetching the styled image, asking
           for a re-style -- is about this id, because it is the one the server
           knows. The slot id is only where it currently appears on screen. */
        serverPanel: id,
      });
      drawSlotFlag(id);            // a replaced photo clears the old failure
      const n = nodes[id]; n.img.setAttribute('href', url); n.img.setAttribute('opacity', 1);
      if (n.num) n.num.setAttribute('opacity', 0); n.hit.classList.add('filled');
      if (n.plate) n.plate.setAttribute('opacity', 0);
      layout(id); select(id); refresh(); palette(probe);
      // Customer mode uploads as photos are dropped. Studio mode keeps the
      // file in state and never sends it anywhere until Save as product.
      if (MODE === 'customer') upload(id, file);
    };
    probe.src = url;
  }
  /* A panel does two things with the pointer: a press-and-move repositions the
     photo; a press-and-release without moving opens the file chooser. The same
     gesture split as a photo app -- tap to change, drag to move. */
  const CLICK_SLOP = 6;   // px of movement before a press counts as a drag
  function wire(id) {
    const hit = nodes[id].hit; let drag = null, moved = false;
    hit.addEventListener('pointerdown', (e) => {
      if (moveMode) return;
      select(id); moved = false;
      const s = state.get(id); if (!s) return;
      hit.setPointerCapture(e.pointerId); hit.classList.add('dragging');
      drag = {
        px: e.clientX, py: e.clientY, ox: s.ox, oy: s.oy,
        k: T.canvas.width / (svg.getBoundingClientRect().width || T.canvas.width),
      };
    });
    hit.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!moved && Math.hypot(e.clientX - drag.px, e.clientY - drag.py) < CLICK_SLOP) return;
      moved = true;
      const s = state.get(id);
      s.ox = drag.ox + (e.clientX - drag.px) * drag.k; s.oy = drag.oy + (e.clientY - drag.py) * drag.k; layout(id);
    });
    const end = () => { drag = null; hit.classList.remove('dragging'); };
    hit.addEventListener('pointerup', end); hit.addEventListener('pointercancel', end);
    // click fires after pointerup; only treat it as "choose a photo" if the
    // pointer didn't travel -- otherwise it was a reposition
    /* Enter and Space on a focused panel do what a tap does. The panels have
       carried tabIndex 0 and role="button" since they were built, which
       promised keyboard operation that was never actually wired -- an SVG
       element does not synthesise a click from Enter the way a <button> does. */
    hit.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    hit.addEventListener('click', () => {
      // A swap in progress claims the next tap, whatever it lands on.
      if (handleSwapTap(id)) { moved = false; return; }
      if (!moveMode && !moved) {
        /* A failed slot promises "tap to retry" on its face, so a tap has to
           mean that and not the file chooser -- re-picking the same photo
           would be a puzzling thing to have to do, and would lose the framing.

           Which retry depends on which half failed: the upload, or the styling
           of a photo that uploaded fine. A refusal the model will repeat -- a
           safety block, or a spent cap -- promises no such thing on its face,
           so a tap there opens the chooser, which is the only thing that can
           actually help. */
        const s = state.get(id);
        if (s && !s.demo && s.uploadState === FAILED) retryUpload(id);
        else if (s && !s.demo && s.styleState === STYLE_FAILED && styleRetryable(s.styleError)) {
          retryStyle(id);
        } else ask(id);
      }
      moved = false;
    });
    hit.addEventListener('wheel', (e) => {
      const s = state.get(id); if (!s) return; e.preventDefault();
      s.zoom = Math.min(3, Math.max(1, s.zoom * (e.deltaY < 0 ? 1.08 : 0.93)));
      layout(id); if (selected === id) syncPanel();
    }, { passive: false });
    hit.addEventListener('dragover', (e) => e.preventDefault());
    hit.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      const f = [...e.dataTransfer.files].find((ff) => ff.type.startsWith('image/')); if (f) place(id, f);
    });
  }
  /* ---------- consent ---------- */
  /* Must be given before the first photo goes in. The timestamp is what ends up
     on the pendingPersonalisation document as consentAt. */
  let consentAt = null;
  const consentBox = $('consent');            // customer mode only
  /* Studio mode has nothing to consent to: the photos are never uploaded, so
     they stay in the browser for the length of the session and go no further. */
  const consented = () => MODE === 'studio' || !!(consentBox && consentBox.checked);
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  if (consentBox) consentBox.addEventListener('change', () => {
    if (consentBox.checked) consentAt = consentAt || new Date().toISOString();
    else consentAt = null;
    $('consentHint').textContent = consentBox.checked
      ? 'Thanks — you can add your photos now.'
      : 'Tick this before adding your first photo.';
    refresh();
  });
  function hasConsent() {
    if (consented()) return true;
    $('consentHint').textContent = 'Please tick this before adding photos.';
    try { consentBox.focus(); } catch (e) { /* not focusable yet */ }
    return false;
  }

  function ask(id) { if (!hasConsent()) return; pickTarget = id; picker.click(); }
  picker.addEventListener('change', () => {
    const files = [...picker.files].filter((f) => f.type.startsWith('image/'));
    if (pickTarget === '__logo__') {
      if (files[0] && T.logo) {
        T.logo.href = URL.createObjectURL(files[0]);
        T.logo.custom = files[0].name;
        placeLogo();
      }
    } else fill(files, pickTarget);
    picker.value = ''; pickTarget = null;
  });
  function fill(files, startId) {
    if (!files.length) return;
    const order = T.panels.map((p) => p.id);
    // A panel showing the seeded example is still empty as far as the customer
    // is concerned, so dropping several photos onto the board fills those in
    // order rather than finding nothing to do.
    const free = (i) => { const s = state.get(i); return !s || s.demo; };
    const q = startId ? [startId, ...order.filter((i) => i !== startId && free(i))] : order.filter(free);
    files.forEach((f, i) => { if (q[i]) place(q[i], f); });
  }
  board.addEventListener('dragover', (e) => { e.preventDefault(); board.classList.add('dragover'); });
  board.addEventListener('dragleave', () => board.classList.remove('dragover'));
  board.addEventListener('drop', (e) => {
    e.preventDefault(); board.classList.remove('dragover');
    fill([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')), null);
  });

  /* ---------- rail ---------- */
  function select(id) {
    if (selected && nodes[selected] && nodes[selected].outline) nodes[selected].outline.setAttribute('stroke', '#000');
    selected = id;
    if (nodes[id].outline) nodes[id].outline.setAttribute('stroke',
      getComputedStyle(root).getPropertyValue('--b-accent').trim() || '#EC008C');
    syncPanel();
  }
  function syncPanel() {
    const n = nodes[selected], s = state.get(selected), flag = $('dpiFlag');
    const up = $('uploadHint');
    $('panelTitle').textContent = T.panels.length > 1 ? `Panel ${String(n.index + 1).padStart(2, '0')}` : 'Image';
    $('panelEmpty').hidden = !!s; $('panelControls').hidden = !s;

    /* A file refused for being too small leaves no state behind, so its reason
       has to survive here or it vanishes the moment anything re-renders.

       Checked against "no photo of theirs in this slot" rather than "no state":
       an empty slot is not empty, it holds the seeded example, so testing for
       absent state missed every slot the customer could actually drop onto. */
    const note = rejected && rejected.id === selected && (!s || s.demo) ? rejected.text : '';
    if (note) {
      flag.hidden = true;
      $('panelEmpty').hidden = false;
      $('panelControls').hidden = true;
      up.classList.add('b-hint-bad');
      up.hidden = false;
      up.textContent = note;
      return;
    }
    if (!s) {
      flag.hidden = true;
      up.classList.remove('b-hint-bad');
      up.hidden = true;
      up.textContent = '';
      return;
    }

    $('pSize').textContent = `${n.panel.width} × ${n.panel.height}`;
    $('pImg').textContent = s.demo ? 'example artwork'
      : `${s.natW} × ${s.natH}${s.styled ? ' (styled)' : ''}`;
    $('zoom').value = s.zoom;
    /* Swap is only meaningful from a panel holding one of the customer's
       photographs -- the seeded example is not theirs to move. While a swap is
       armed the button is the way out of it, from any panel. */
    /* The toggle only exists once there is something to toggle between. A
       cover whose cutout was refused shows nothing rather than a dead control
       offering a choice of one. */
    const vRow = $('variantRow');
    if (vRow) {
      const have = !!s.cutoutUrl;
      vRow.hidden = !(wantsCutout() && have && !s.demo);
      if (have) {
        const v = variantOf(s);
        $('variantCutout').setAttribute('aria-pressed', String(v === 'cutout'));
        $('variantStyled').setAttribute('aria-pressed', String(v === 'styled'));
        $('variantCutout').disabled = v === 'cutout';
        $('variantStyled').disabled = v === 'styled';
      }
    }

    const swapBtn = $('swap');
    if (swapBtn) {
      swapBtn.textContent = swapFrom ? 'Cancel swap' : 'Swap';
      swapBtn.disabled = !swapFrom && (s.demo || T.panels.length < 2);
      swapBtn.setAttribute('aria-pressed', String(!!swapFrom));
    }
    /* Not on a customer's cover: the server does this properly there, and two
       controls that both claim to cut out the background is one too many. */
    $('cutBox').hidden = !(T.bg && T.bg.type === 'image') || wantsCutout();
    $('cutOn').checked = s.cut; $('tol').value = s.tol; $('feather').value = s.feather;

    /* Two different questions before and after styling.

       Once styled, s.natW/natH ARE the styled pixels -- applyStyled swapped
       them in -- so s.dpi is already the resolution of the thing that will
       actually be printed, measured against the size-dependent ppi. That is
       the only reading worth showing a customer.

       Before that, the dpi of the raw photo answers a question nobody asked:
       the model outputs a fixed size set by styleSize, so a bigger upload does
       not print bigger. What matters is whether there is enough detail to work
       FROM, which is a question about the shortest side. */
    if (s.demo) {
      $('pDpi').textContent = '—';
      flag.hidden = true;
    } else if (MODE !== 'customer') {
      /* Studio mode is unchanged. Nothing here is ever styled -- these are
         prepared files being turned into products -- so the dpi of the file in
         hand is exactly the right question, and the styling vocabulary would
         be describing a stage that does not exist. */
      const minDpi = MIN_DPI_BY_FORMAT[fmt] || 150;
      const surface = DPI_SURFACE[fmt] || 'as a poster';
      $('pDpi').textContent = `${s.dpi} dpi`;
      flag.hidden = s.dpi >= minDpi;
      flag.textContent = `This photo prints at ${s.dpi} dpi here. Below ${minDpi} it will look soft `
        + `${surface} — try a larger file or zoom out.`;
    } else if (s.styled) {
      const minDpi = MIN_DPI_BY_FORMAT[fmt] || 150;
      const surface = DPI_SURFACE[fmt] || 'as a poster';
      $('pDpi').textContent = `${s.dpi} dpi`;
      flag.hidden = s.dpi >= minDpi;
      flag.textContent = `This prints at ${s.dpi} dpi here. Below ${minDpi} it will look soft `
        + `${surface} — try zooming out.`;
    } else {
      const shortest = Math.min(s.natW || 0, s.natH || 0);
      $('pDpi').textContent = 'after styling';
      flag.hidden = shortest >= SOFT_MIN_SOURCE_PX;
      flag.textContent = `This photo is small — faces may come out soft. `
        + `It is ${s.natW} × ${s.natH}; ${SOFT_MIN_SOURCE_PX} pixels or more on the shortest side works best.`;
    }

    /* One line, and only one. Upload first for the same reason the slot overlay
       does it: until the photo is stored, styling has not been asked for. */
    /* An armed swap owns the hint: it is a mode, and the one thing worth saying
       is how to finish or leave it. */
    if (swapFrom) {
      flag.hidden = true;
      up.classList.remove('b-hint-bad');
      up.hidden = false;
      up.textContent = swapFrom === selected
        ? 'Now choose the panel to swap with — tap this one again, or press Escape, to cancel.'
        : 'Tap to swap with the highlighted panel, or press Escape to cancel.';
      return;
    }

    const st = s.uploadState;
    const styleFailed = st === UPLOADED && s.styleState === STYLE_FAILED;
    const styling = st === UPLOADED && !s.styled
      && (s.styleState === STYLE_PENDING || s.styleState === STYLE_STYLING);
    up.classList.toggle('b-hint-bad', st === FAILED || styleFailed);
    up.hidden = !(st === PENDING || st === UPLOADING || st === FAILED || styling || styleFailed || s.styled);
    up.textContent = st === PENDING ? 'Waiting to upload…'
      : st === UPLOADING ? 'Uploading this photo…'
        : st === FAILED ? `Upload failed — tap the panel to retry. ${s.uploadError || ''}`.trim()
          : styleFailed ? styleFailureText(s)
            : styling ? 'Applying comic style…'
              : s.styled ? 'Style applied — adjust the crop if you like'
                : '';
  }
  function rail() {
    const tb = $('textFields'); tb.innerHTML = '';
    $('textBox').hidden = !T.text.length;
    T.text.forEach((f) => {
      const w = document.createElement('div'); w.className = 'b-fld';
      const top = document.createElement('div'); top.className = 'b-fld-top';
      const lab = document.createElement('span'); lab.className = 'b-fld-lab'; lab.textContent = f.label || f.id;
      top.appendChild(lab);
      f.colours.forEach((c, i) => {
        const ci = document.createElement('input'); ci.type = 'color'; ci.value = c;
        ci.className = 'b-colour';
        ci.title = i ? 'Second colour' : 'Text colour';
        const apply = () => { f.colours[i] = ci.value; layoutText(f); };
        ci.addEventListener('input', apply); ci.addEventListener('change', apply);
        top.appendChild(ci);
      });
      if (f.stroke !== null && f.stroke !== undefined) {
        const ks = document.createElement('input'); ks.type = 'color'; ks.value = f.stroke;
        ks.className = 'b-colour';
        ks.title = 'Key line colour';
        const kapply = () => { f.stroke = ks.value; layoutText(f); };
        ks.addEventListener('input', kapply); ks.addEventListener('change', kapply);
        top.appendChild(ks);
      }
      const row = document.createElement('div'); row.className = 'b-row';
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = f.value;
      inp.className = 'b-text';
      inp.addEventListener('input', () => { f.value = inp.value; layoutText(f); });
      row.appendChild(inp);
      if (f.boxRef) {
        const lk = document.createElement('div'); lk.className = 'b-row';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = f.linked;
        cb.id = 'lk-' + f.id; cb.className = 'h-[18px] w-[18px] flex-none accent-comic-red';
        const ll = document.createElement('label'); ll.htmlFor = cb.id; ll.textContent = 'Move with box';
        ll.className = 'b-lab';
        cb.addEventListener('change', () => { f.linked = cb.checked; });
        lk.append(cb, ll); w.appendChild(lk);
      }
      const an = document.createElement('div'); an.className = 'b-row';
      const al = document.createElement('label'); al.textContent = 'Angle'; al.className = 'b-lab';
      const ar = document.createElement('input'); ar.type = 'range'; ar.min = -30; ar.max = 30; ar.step = 0.5;
      ar.className = 'b-range';
      ar.value = f.rot || 0;
      const av = document.createElement('span');
      av.className = 'min-w-[34px] text-right font-source text-xs';
      av.textContent = (f.rot || 0).toFixed(1) + '°';
      const arApply = () => { f.rot = +ar.value; av.textContent = f.rot.toFixed(1) + '°'; layoutText(f); };
      ar.addEventListener('input', arApply); ar.addEventListener('change', arApply);
      an.append(al, ar, av); w.appendChild(an);
      const sz = document.createElement('div'); sz.className = 'b-row';
      const sl = document.createElement('label'); sl.textContent = 'Size'; sl.htmlFor = 'sz-' + f.id;
      sl.className = 'b-lab';
      const sr = document.createElement('input'); sr.type = 'range'; sr.id = 'sz-' + f.id;
      sr.className = 'b-range';
      sr.min = 0.4; sr.max = 2.5; sr.step = 0.01; sr.value = f.sizeScale;
      const sv = document.createElement('span'); sv.className = 'min-w-[34px] text-right font-source text-xs';
      sv.textContent = Math.round(f.sizeScale * 100) + '%';
      sr.addEventListener('input', () => { f.sizeScale = +sr.value; sv.textContent = Math.round(f.sizeScale * 100) + '%'; layoutText(f); });
      sz.append(sl, sr, sv);
      w.append(top, row, sz);
      if (f.stroke) {
        const kw = document.createElement('div'); kw.className = 'b-row';
        const kl = document.createElement('label'); kl.textContent = 'Key line'; kl.className = 'b-lab';
        const kr = document.createElement('input'); kr.type = 'range'; kr.min = 0; kr.max = 2.5; kr.step = 0.05;
        kr.className = 'b-range';
        kr.value = f.strokeScale;
        kr.addEventListener('input', () => { f.strokeScale = +kr.value; layoutText(f); });
        kw.append(kl, kr); w.appendChild(kw);
      }
      tb.appendChild(w);
    });
    const bb = $('boxFields'); bb.innerHTML = '';
    $('boxBox').hidden = !T.boxes.length;
    T.boxes.forEach((b) => {
      const w = document.createElement('div'); w.className = 'b-fld';
      const top = document.createElement('div'); top.className = 'b-fld-top';
      const lab = document.createElement('span'); lab.className = 'b-fld-lab'; lab.textContent = b.id + ' box';
      top.appendChild(lab);
      const regions = b.fills || [{ colour: b.fillColour }];
      regions.forEach((r, i) => {
        const ci = document.createElement('input'); ci.type = 'color'; ci.value = r.colour;
        ci.className = 'b-colour';
        ci.title = regions.length > 1 ? `Region ${i + 1}` : 'Box colour';
        const go = () => {
          r.colour = ci.value; if (!b.fills) b.fillColour = ci.value;
          nodes['b-' + b.id].fills[i].setAttribute('fill', ci.value);
        };
        ci.addEventListener('input', go); ci.addEventListener('change', go);
        top.appendChild(ci);
      });
      const f2 = document.createElement('input'); f2.type = 'color'; f2.value = b.shadowColour; f2.title = 'Box key line colour';
      f2.className = 'b-colour';
      const kgo = () => { b.shadowColour = f2.value; nodes['b-' + b.id].sh.setAttribute('fill', f2.value); };
      f2.addEventListener('input', kgo); f2.addEventListener('change', kgo);
      top.appendChild(f2); w.appendChild(top); bb.appendChild(w);
    });
    $('logoBox').hidden = !T.logo;
    if (T.logo) $('logoFill').checked = !!T.logo.fillPlate;
    const solid = T.bg && T.bg.type === 'colour', tintable = T.bg && T.bg.tintable;
    $('colourBox').hidden = !(solid || tintable);
    $('colourSolid').hidden = !solid; $('colourTint').hidden = !tintable;
    $('colourTitle').textContent = solid ? 'Border colour' : 'Border artwork';
    if (solid) drawSwatches();
    if (!solid && tintable) applyTint();
  }
  $('zoom').addEventListener('input', (e) => { const s = state.get(selected); if (!s) return; s.zoom = +e.target.value; layout(selected); syncPanel(); });
  $('reset').addEventListener('click', () => { const s = state.get(selected); s.ox = s.oy = 0; s.zoom = 1; layout(selected); syncPanel(); });
  $('replace').addEventListener('click', () => ask(selected));
  on('variantCutout', 'click', () => showVariant(selected, 'cutout'));
  on('variantStyled', 'click', () => showVariant(selected, 'styled'));
  $('swap').addEventListener('click', () => {
    if (swapFrom) cancelSwap();          // the button doubles as Cancel
    else beginSwap(selected);
  });
  $('logoPick').addEventListener('click', () => { pickTarget = '__logo__'; picker.click(); });
  $('logoReset').addEventListener('click', () => {
    if (!T.logo) return; T.logo.href = DEFAULT_LOGO; T.logo.custom = null; placeLogo();
  });
  $('logoFill').addEventListener('change', (e) => {
    if (!T.logo) return; T.logo.fillPlate = e.target.checked; placeLogo();
  });
  $('cutOn').addEventListener('change', (e) => {
    const s = state.get(selected); if (!s) return;
    s.cut = e.target.checked; applyCut(selected);
  });
  ['tol', 'feather'].forEach((id) => $(id).addEventListener('change', () => {
    const s = state.get(selected); if (!s) return;
    s.tol = +$('tol').value; s.feather = +$('feather').value; if (s.cut) applyCut(selected);
  }));
  $('clear').addEventListener('click', () => {
    state.delete(selected); const n = nodes[selected];
    n.img.setAttribute('opacity', 0); n.img.removeAttribute('href');
    if (n.num) n.num.setAttribute('opacity', 1);
    if (n.plate) n.plate.setAttribute('opacity', 1);
    drawSlotFlag(selected);      // the slot is empty; any failure flag goes with it
    n.hit.classList.remove('filled'); syncPanel(); refresh();
  });
  $('resetTint').addEventListener('click', () => {
    if (artMap) {
      artColours = artMap.base.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''));
      repaintArt(); buildArtPickers();
    }
  });
  $('sampleArt').addEventListener('click', () => {
    const s = state.get(T.panels[0].id); if (!s || !artMap) return;
    const c = document.createElement('canvas'); c.width = 32; c.height = 22;
    const g = c.getContext('2d'); g.drawImage(s.el, 0, 0, 32, 22);
    const px = g.getImageData(0, 0, 32, 22).data, bins = {};
    for (let i = 0; i < px.length; i += 4) {
      const k = [px[i], px[i + 1], px[i + 2]].map((v) => Math.round(v / 32) * 32).join(','); bins[k] = (bins[k] || 0) + 1;
    }
    const top = Object.entries(bins).sort((a, b) => b[1] - a[1]).slice(0, artColours.length - 1)
      .map(([k]) => '#' + k.split(',').map((v) => (+v).toString(16).padStart(2, '0')).join(''));
    top.forEach((hx, i) => { if (artColours[i + 1]) artColours[i + 1] = hx; });
    repaintArt(); buildArtPickers();
  });

  const swatchBox = $('swatches');
  let swatchList = ['#EC008C', '#FFF200', '#00AEEF', '#000000', '#E2A7D6', '#FFFFFF'];
  function drawSwatches() {
    swatchBox.innerHTML = '';
    swatchList.slice(0, 12).forEach((hex) => {
      const b = document.createElement('button'); b.className = 'b-sw'; b.style.background = hex; b.title = hex;
      b.setAttribute('aria-pressed', hex.toLowerCase() === (bg || '').toLowerCase());
      b.addEventListener('click', () => setBg(hex)); swatchBox.appendChild(b);
    });
  }
  function setBg(hex) { bg = hex; if (nodes.bgRect) nodes.bgRect.setAttribute('fill', hex); $('custom').value = hex; drawSwatches(); }
  $('custom').addEventListener('input', (e) => setBg(e.target.value));
  function palette(imgEl) {
    if (!(T.bg && T.bg.type === 'colour')) return;
    const c = document.createElement('canvas'); c.width = 32; c.height = 22;
    const g = c.getContext('2d'); if (!g) return;
    g.drawImage(imgEl, 0, 0, 32, 22);
    const px = g.getImageData(0, 0, 32, 22).data, bins = {};
    for (let i = 0; i < px.length; i += 4) { const k = [px[i], px[i + 1], px[i + 2]].map((v) => Math.round(v / 32) * 32).join(','); bins[k] = (bins[k] || 0) + 1; }
    const top = Object.entries(bins).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k]) => '#' + k.split(',').map((v) => (+v).toString(16).padStart(2, '0')).join(''));
    swatchList = [...new Set([...top, ...swatchList])];
    $('paletteHint').textContent = 'The first colours are pulled from your photo.';
    drawSwatches();
  }
  function refresh() {
    const w = wrapIn(), sz = T.size;
    if (sz) {
      const outW = (sz.w + 2 * w), outH = (sz.h + 2 * w);
      $('outSpec').textContent = w
        ? `${sz.label} face · file ${outW} × ${outH} in incl. ${w}" wrap`
        : `${sz.label} · file ${sz.w} × ${sz.h} in`;
    }
    const real = mine().length;
    $('filled').textContent = `${real} of ${T.panels.length}`;
    $('download').disabled = real === 0;

    // Sits beside "Images placed": placing a photo and getting it safely stored
    // are two different things, and only the second one lets you check out.
    const uploadedEl = $('uploaded');
    if (uploadedEl) uploadedEl.textContent = `${inState(UPLOADED)} of ${T.panels.length}`;

    // Every panel must hold a photo the customer actually chose. The example
    // graphic is seeded into empty panels and does not count.
    const total = T.panels.length;
    const btn = $('addBasket');
    if (btn) {
      const busy = inFlight();
      const failedIdx = firstFailed();
      const styleFailedIdx = firstStyleFailed();
      const waiting = styleWaiting();
      const ready = styleReady();
      /* Deliberately still enabled with a failed slot. The button is how the
         customer asks to check out, and its answer has to be the one thing they
         can act on -- which photo, and what to do about it. Disabling it left
         them with a dead button and a sentence they had to go looking for.

         Styling is different: while it is running there is nothing to act on
         and nothing to say beyond "not yet", so the button stays shut until
         every photo is through. That is also what makes the basket thumbnail
         correct without any special handling -- the snapshot is taken from the
         live scene at Add to basket, and by then every slot holds its styled
         image, so it captures the styled artwork by construction. */
      /* On a cover the cutout is part of "ready": the customer is choosing
         between two images, and offering checkout before the second one exists
         would settle that choice for them. Settled means arrived OR refused. */
      const cutWaiting = cutoutWaiting();
      btn.disabled = basketBusy || busy > 0 || waiting > 0 || cutWaiting > 0
        || !consented() || real !== total;
      $('basketHint').textContent = basketBusy ? ''
        : !consented() ? 'Tick the consent box to get started.'
          : busy > 0 ? `Uploading — ${busy} photo${busy === 1 ? '' : 's'} to go…`
            : failedIdx >= 0 ? `Photo ${failedIdx + 1} didn't upload — tap it to retry`
              : styleFailedIdx >= 0 ? styleFailureText(state.get(T.panels[styleFailedIdx].id))
                : waiting > 0 ? `Applying your comic style — ${ready} of ${ready + waiting} ready`
                  : cutWaiting > 0 ? 'Cutting out the background…'
                  : real === total ? ''
                    : `Add your own photo to every panel — ${total - real} to go.`;
    }

    const save = $('saveProduct');
    if (save) {
      const titled = ($('studioTitle').value || '').trim().length > 0;
      save.disabled = studioBusy || real !== total || !titled;
      if (studioMsg) { showStudioMsg(); return; }
      $('studioHint').textContent = studioBusy ? ''
        : real !== total ? `Fill every panel — ${total - real} to go.`
          : !titled ? 'Give the product a title before saving.'
            : 'Renders the print master and creates a draft product in the Studio.';
    }
  }
  /* Both exporters work on a copy of the live scene, and that copy is built in
     an inert document rather than with svg.cloneNode().

     A detached clone still belongs to the page's document, so its <image>
     elements keep loading: cloneNode re-requested every asset, and the moment
     exportSVG() swapped them for {{TOKEN}}s the browser went and fetched those
     too -- /admin/{{LOGO}} and friends, resolved relative to the page, 404 every
     time. A document from DOMImplementation has no browsing context, so nothing
     inside it fetches anything. */
  const inertDoc = document.implementation.createHTMLDocument('scene-export');
  const sceneCopy = () => inertDoc.importNode(svg, true);
  /* The preview and the print file are the same document. Rather than rebuilding
     the scene server-side from numbers -- where any drift means the customer gets
     something they didn't approve -- the builder exports its own SVG with every
     asset replaced by a token. The renderer swaps the tokens for full-resolution
     files and rasterises the identical document. */
  function exportSVG() {
    const c = sceneCopy();
    c.setAttribute('xmlns', SVGNS);
    c.removeAttribute('style');
    // Astro stamps a scoped-style id on the component's own <svg>. It is a screen
    // artifact, so it must not travel into the exported print document.
    [...c.attributes].forEach((a) => { if (a.name.startsWith('data-astro-cid-')) c.removeAttribute(a.name); });
    c.querySelectorAll('.hit,[data-role="guide"],[data-role="slot-flag"]').forEach((el) => el.remove());
    c.querySelectorAll('image').forEach((im) => {
      const role = im.getAttribute('data-role');
      const token = role === 'panel' ? `{{IMAGE:${im.getAttribute('data-panel')}}}`
        : role === 'overlay' ? '{{OVERLAY}}'
          : role === 'background' ? '{{BACKGROUND}}'
            : role === 'logo' ? '{{LOGO}}' : null;
      if (token) im.setAttribute('href', token);
    });
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    c.setAttribute('width', Math.round(vb[2]));
    c.setAttribute('height', Math.round(vb[3]));
    return new XMLSerializer().serializeToString(c);
  }
  function recipe() {
    return {
      template: TK,
      canvas: T.canvas,
      svg: exportSVG(),
      output: T.size ? {
        format: fmt, formatLabel: FORMAT_LABEL[fmt],
        faceInches: [T.size.w, T.size.h], wrapInches: wrapIn(),
        fileInches: [T.size.w + 2 * wrapIn(), T.size.h + 2 * wrapIn()],
      } : null,
      background: T.bg && T.bg.type === 'colour' ? { colour: bg } : T.bg ? { artColours } : null,
      panels: T.panels.map((p) => {
        const s = state.get(p.id);
        return {
          id: p.id,
          image: s ? s.name : null,
          placeholder: !!(s && s.demo),
          placeholder: !!(s && s.demo),
          transform: s ? { zoom: +s.zoom.toFixed(4), offsetX: Math.round(s.ox), offsetY: Math.round(s.oy) } : null,
          /* sourcePx and effectiveDpi describe the STYLED image, because that
             is what gets printed -- once applyStyled has run, s.natW/natH and
             s.dpi are all measurements of it. The raw key is kept beside them
             so a panel can be re-styled from the original without hunting for
             it, and the styled key so this record says exactly which blob the
             numbers came from. */
          sourcePx: s && !s.demo ? [s.natW, s.natH] : null,
          effectiveDpi: s && !s.demo ? s.dpi : null,
          rawKey: s && !s.demo ? (s.key || null) : null,
          styledKey: s && !s.demo ? (s.styledKey || null) : null,
          styledPx: s && !s.demo && s.styledW ? [s.styledW, s.styledH] : null,
          /* Which image the customer settled on, and the key it came from.
             The render job reads imageVariant -- it is the record of a choice
             they made and approved, so it decides, not the presence of a key. */
          imageVariant: s && !s.demo ? variantOf(s) : null,
          cutoutKey: s && !s.demo ? (s.cutoutKey || null) : null,
          cutoutPx: s && !s.demo && s.cutoutW ? [s.cutoutW, s.cutoutH] : null,
          removeBackground: s ? { on: s.cut, spread: s.tol, soften: s.feather } : null,
        };
      }),
      boxes: T.boxes.map((b) => ({
        id: b.id, offset: { x: Math.round(b.dx), y: Math.round(b.dy) },
        fillColour: b.fillColour, keyLineColour: b.shadowColour,
      })),
      logo: T.logo ? {
        custom: T.logo.custom || null, slot: [T.logo.x, T.logo.y, T.logo.width, T.logo.height],
        fitted: T.logo.fitted || null, fillPlate: !!T.logo.fillPlate, plateColour: T.logo.bgColour || null,
      } : null,
      text: T.text.map((f) => ({
        id: f.id, value: f.value, colours: f.colours,
        keyLine: f.stroke || null, keyLineScale: f.strokeScale, sizeScale: f.sizeScale,
        offset: { x: Math.round(f.dx), y: Math.round(f.dy) },
        resolvedFontSize: f.resolved, lines: f.lines, font: FONTOF(f.id), rotationDeg: f.rot || 0,
      })),
    };
  }
  $('copy').addEventListener('click', async (e) => {
    const t = JSON.stringify(recipe(), null, 2);
    try { await navigator.clipboard.writeText(t); e.target.textContent = 'Recipe copied'; }
    catch { e.target.textContent = 'Copy blocked — see console'; console.log(t); }
    setTimeout(() => { e.target.textContent = 'Copy recipe'; }, 1600);
  });
  /* An SVG loaded as an image is sandboxed: it can carry data: URIs but cannot
     reach the page's blob: URLs. Dropped photos live as blobs, so they came out
     blank in the draft while the embedded placeholders survived. Convert each one
     to embedded data (downscaled -- this is a draft) before serialising.
     Since the template assets moved out to /builder/ they are ordinary URLs and
     are sandboxed out too, so those are inlined byte-for-byte as well. */
  const assetDataCache = new Map();
  async function assetAsDataURI(url) {
    if (assetDataCache.has(url)) return assetDataCache.get(url);
    const p = fetch(url)
      .then((r) => r.blob())
      .then((b) => new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(b);
      }))
      .catch(() => null);
    assetDataCache.set(url, p);
    return p;
  }
  async function draftSVG() {
    const c = sceneCopy();
    c.setAttribute('xmlns', SVGNS);
    // Astro stamps a scoped-style id on the component's own <svg>. It is a screen
    // artifact, so it must not travel into the exported print document.
    [...c.attributes].forEach((a) => { if (a.name.startsWith('data-astro-cid-')) c.removeAttribute(a.name); });
    c.querySelectorAll('.hit,[data-role="guide"],[data-role="slot-flag"]').forEach((el) => el.remove());
    // the selection highlight is a screen affordance, not part of the artwork
    c.querySelectorAll('path[stroke]').forEach((p) => {
      if (p.getAttribute('stroke') !== '#000' && p.getAttribute('fill') === 'none'
        && p.getAttribute('stroke-width') === '9') p.setAttribute('stroke', '#000');
    });
    const toData = (el, maxSide = 1600) => {
      const k = Math.min(1, maxSide / Math.max(el.naturalWidth || 1, el.naturalHeight || 1));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round((el.naturalWidth || 1) * k));
      cv.height = Math.max(1, Math.round((el.naturalHeight || 1) * k));
      const g = cv.getContext('2d'); if (!g) return null;
      g.drawImage(el, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/jpeg', 0.9);
    };
    const pending = [];
    c.querySelectorAll('image').forEach((im) => {
      const href = im.getAttribute('href') || '';
      if (href.startsWith('data:')) return;
      const role = im.getAttribute('data-role');
      if (href.startsWith('blob:')) {
        let src = null;
        if (role === 'panel') {
          const s = state.get(im.getAttribute('data-panel'));
          if (s) { if (s.cut && s.cutUrl) src = s.cutUrl; else if (s.el) src = toData(s.el); }
        } else if (role === 'logo' && nodes.logo) {
          const probe = new Image(); probe.src = href;
          if (probe.complete && probe.naturalWidth) src = toData(probe, 800);
        }
        if (src) im.setAttribute('href', src);
        return;
      }
      // an ordinary URL (/builder/...): inline it losslessly or it drops out
      pending.push(assetAsDataURI(href).then((d) => { if (d) im.setAttribute('href', d); }));
    });
    await Promise.all(pending);
    return new XMLSerializer().serializeToString(c);
  }

  /* ---------- basket thumbnail ---------- */
  /* The basket used to show the generic product shot for every personalised
     line, so two builds of the same product were indistinguishable in the
     drawer and again on the Stripe page. This snapshots what the customer is
     actually looking at.

     draftSVG() is what makes it possible: an SVG rasterised through an <img>
     taints the canvas if it references anything cross-origin, and toBlob() on a
     tainted canvas throws SecurityError. draftSVG() has already rewritten every
     href -- the customer's blob: photos and the /builder/ assets alike -- to a
     data: URI, so there is nothing left for the canvas to be tainted by. */
  const THUMB_MAX_SIDE = 600;
  const THUMB_QUALITY = 0.8;

  async function snapshotThumb() {
    const { c, dx, dy } = geom();
    // the whole board, wrap included -- the thumbnail should be the thing they
    // approved, not a crop of it
    const extW = c.width + 2 * Math.max(0, dx), extH = c.height + 2 * Math.max(0, dy);
    const k = THUMB_MAX_SIDE / Math.max(extW, extH);
    const w = Math.max(1, Math.round(extW * k)), h = Math.max(1, Math.round(extH * k));

    const text = await draftSVG();
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('the preview would not rasterise'));
        im.src = url;
      });
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const g = cv.getContext('2d');
      if (!g) throw new Error('no 2D canvas context');
      // JPEG carries no alpha, so anything transparent would come out black.
      g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', THUMB_QUALITY));
      if (!blob) throw new Error('the canvas would not encode');
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* Best-effort, and called only after the brief has been saved: the basket line
     is going in either way, so a snapshot that fails costs it its picture and
     nothing else. Returns the URL to show, or null to fall back. */
  async function saveThumb(id) {
    try {
      const blob = await snapshotThumb();
      const fd = new FormData();
      fd.append('id', id);
      fd.append('thumb', blob, 'thumb.jpg');
      const res = await fetch('/api/personalise-save', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // An absolute URL: the basket drawer renders it on any page, and checkout
      // rebuilds the same one server-side to hand to Stripe.
      return `${window.location.origin}/api/personalisation-thumb/${id}`;
    } catch (e) {
      console.warn(`[builder] basket thumbnail failed for ${id}: ${e.message || e}`);
      return null;
    }
  }

  /* ---------- draft watermark ---------- */
  /* Drawn onto the exported bitmap and nowhere else.

     This is the ONLY place it exists. It is not in the live SVG, so it cannot
     reach the recipe, the basket thumbnail, the proof or the print file --
     those all derive from the scene, and the scene never carries it. Anything
     that wants a watermark has to ask for it here, at export, on a copy.

     The old one was a single line at low opacity across the middle: on a strip
     it covered two panels out of twelve and a screenshot of any other panel was
     clean. Tiled at 45 degrees, every panel carries some of it.

     White with a dark outline rather than one flat colour, because the artwork
     underneath is both: flat black text vanishes on a dark panel and flat white
     vanishes on a pale sky. An outlined glyph has an edge against either. */
  const WATERMARK_TEXT = 'DRAFT · comicstripcanvas.co.uk';
  const WATERMARK_ALPHA = 0.22;
  const WATERMARK_ANGLE = -Math.PI / 4;      // 45 degrees, rising left to right

  function stampWatermark(g, w, h) {
    const size = Math.max(14, Math.round(Math.min(w, h) / 26));
    g.save();
    g.globalAlpha = WATERMARK_ALPHA;
    g.font = `700 ${size}px ui-sans-serif,system-ui,sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.miterLimit = 2;

    const runWidth = g.measureText(WATERMARK_TEXT).width;
    /* Gaps set from the text itself, not from the canvas: the tile has to stay
       legible at any output size, and a spacing that scales with the image
       would space a strip and a cover completely differently. Row spacing is
       tighter than column spacing so a narrow panel still catches a line. */
    const stepX = runWidth + size * 3;
    const stepY = size * 4.5;

    // Rotating about the centre leaves the corners uncovered, so lay the grid
    // over a square big enough to cover the canvas whatever the angle.
    const reach = Math.ceil(Math.hypot(w, h) / 2) + Math.max(stepX, stepY);
    g.translate(w / 2, h / 2);
    g.rotate(WATERMARK_ANGLE);

    let row = 0;
    for (let y = -reach; y <= reach; y += stepY, row++) {
      // Offset alternate rows so the tiling does not read as tram lines.
      const offset = (row % 2) * (stepX / 2);
      for (let x = -reach + offset; x <= reach; x += stepX) {
        g.strokeStyle = 'rgba(0,0,0,0.85)';
        g.lineWidth = Math.max(2, size * 0.22);
        g.strokeText(WATERMARK_TEXT, x, y);
        g.fillStyle = '#FFFFFF';
        g.fillText(WATERMARK_TEXT, x, y);
      }
    }
    g.restore();
  }

  $('download').addEventListener('click', async () => {
    const s = await draftSVG();
    const blob = new Blob([s], { type: 'image/svg+xml' });
    const img = new Image(); const url = URL.createObjectURL(blob);
    img.onload = () => {
      /* Studio mode still gets the canvas at full size -- it is producing
         artwork, not previewing it -- but the watermark now applies to both.
         A studio draft is still a draft, and one that leaves the building
         unmarked is one that can come back as somebody's product photo. */
      const full = MODE === 'studio';
      const c = T.canvas, k = full ? 1 : 1400 / Math.max(c.width, c.height);
      const cv = document.createElement('canvas'); cv.width = Math.round(c.width * k); cv.height = Math.round(c.height * k);
      const g = cv.getContext('2d'); g.drawImage(img, 0, 0, cv.width, cv.height);
      stampWatermark(g, cv.width, cv.height);
      cv.toBlob((b) => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(b);
        a.download = `${TK}-${full ? 'studio' : 'draft'}.png`; a.click();
      });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
  /* ---------- add to basket ---------- */
  /* Saves the build first -- recipe, scene and the photos themselves -- then puts a
     line in the basket carrying the returned pendingPersonalisation id. The photos
     go to Netlify Blobs via the function; they never touch Sanity. */
  let basketBusy = false;
  let studioBusy = false;
  /* Sticky result of the last save. refresh() runs right after a save finishes
     and would otherwise overwrite the outcome with the idle hint. */
  let studioMsg = null;
  on('addBasket', 'click', async () => {
    if (basketBusy) return;
    const filled = T.panels
      .map((p) => [p.id, state.get(p.id)])
      .filter(([, s]) => s && !s.demo && s.file);
    if (filled.length !== T.panels.length || !consented()) return;

    const btn = $('addBasket'), hint = $('basketHint');

    /* Name the photo and put it back in front of them. On a phone the board has
       usually scrolled away by the time they reach this button, so a message on
       its own leaves them hunting for which of twelve panels went wrong. */
    const failedIdx = firstFailed();
    if (failedIdx >= 0) {
      hint.textContent = `Photo ${failedIdx + 1} didn't upload — tap it to retry`;
      focusSlot(T.panels[failedIdx].id);
      return;
    }
    // Same treatment for a photo the styling stage could not finish: name it
    // and put it back on screen rather than leaving a dead button.
    const styleFailedIdx = firstStyleFailed();
    if (styleFailedIdx >= 0) {
      const id = T.panels[styleFailedIdx].id;
      hint.textContent = `Photo ${styleFailedIdx + 1}: ${styleFailureText(state.get(id))}`;
      focusSlot(id);
      return;
    }
    if (inFlight() > 0 || styleWaiting() > 0 || !saveId) return;   // not ready to brief yet
    if (cutoutWaiting() > 0) return;

    basketBusy = true; btn.disabled = true;
    const label = btn.textContent; btn.textContent = 'Saving…';
    hint.textContent = 'Saving your artwork…';
    try {
      // the photos went up as they were dropped; this posts only the brief
      const fd = new FormData();
      fd.append('id', saveId);
      fd.append('recipe', JSON.stringify(recipe()));
      fd.append('notes', $('notes').value || '');

      const res = await fetch('/api/personalise-save', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) throw new Error(data.error || 'Could not save your artwork');

      // After the brief is safely saved, so a snapshot failure can never cost
      // the customer the build itself.
      hint.textContent = 'Saving your preview…';
      const thumbUrl = await saveThumb(data.id);

      const sizeIdx = Math.max(0, (T.sizes || []).indexOf(T.size));
      const cartFormat = CART_FORMAT[fmt] || 'poster';
      const cartSize = CART_SIZE[sizeIdx] || 'large';
      // the same photo may fill several panels, so count the distinct files
      const photos = new Set(filled.map(([, s]) =>
        `${s.file.name}|${s.file.size}|${s.file.lastModified}`)).size;
      const description = [TEMPLATE_WORD[TK] || T.name, T.size ? T.size.label : '',
        FORMAT_WORD[fmt] || fmt, `${photos} photo${photos === 1 ? '' : 's'}`]
        .filter(Boolean).join(' · ');

      // the host page already publishes the product identity for its own cart button
      const pd = document.getElementById('product-data');
      const ds = (pd && pd.dataset) || {};
      const { addToCart } = await import('../stores/cart');
      addToCart({
        productId: ds.productId || TK,
        slug: ds.productSlug || TK,
        title: ds.productTitle || TEMPLATE_WORD[TK] || T.name,
        format: cartFormat,
        size: cartSize,
        quantity: 1,
        unitPrice: (PRICES[cartFormat] || {})[cartSize] + PERSONALISATION_FEE,
        accentColor: ds.productAccent || ACCENT[TK] || '#EC008C',
        imageUrl: ds.productImage || '',
        // The customer's own build. Omitted when the snapshot failed, and the
        // basket falls back to imageUrl. Never a data: URI -- the basket is
        // persisted to localStorage.
        ...(thumbUrl ? { thumbUrl } : {}),
        personalisationId: saveId,
        description,
      });
      btn.textContent = 'Added to basket';
      hint.textContent = 'Saved. You can keep building and add another.';
      setTimeout(() => { btn.textContent = label; }, 2000);
    } catch (e) {
      btn.textContent = label;
      hint.textContent = e.message || 'Something went wrong saving your artwork.';
    } finally {
      basketBusy = false;
      refresh();
    }
  });

  /* ---------- studio: save as product ---------- */
  /* The photos have stayed in the browser up to this point. They are sent once,
     with the recipe and the scene, and the function renders the print master and
     creates a draft product; it never stores the photos. */
  function studioSecret(reset) {
    let v = '';
    try { v = reset ? '' : (sessionStorage.getItem('csc-studio-secret') || ''); } catch (e) { /* private mode */ }
    if (!v) {
      v = window.prompt('Studio secret (PERSONALISATION_ACTION_SECRET)') || '';
      try { sessionStorage.setItem('csc-studio-secret', v); } catch (e) { /* private mode */ }
    }
    return v;
  }

  on('saveProduct', 'click', async () => {
    if (studioBusy) return;
    const title = ($('studioTitle').value || '').trim();
    const filled = T.panels
      .map((p) => [p.id, state.get(p.id)])
      .filter(([, s]) => s && !s.demo && s.file);
    if (!title || filled.length !== T.panels.length) return;

    const btn = $('saveProduct'), hint = $('studioHint');
    studioBusy = true; btn.disabled = true;
    const label = btn.textContent; btn.textContent = 'Saving…';
    hint.textContent = 'Rendering the print master…';
    try {
      const r = recipe();
      const fd = new FormData();
      fd.append('title', title);
      fd.append('sceneSvg', r.svg || '');
      const rest = Object.assign({}, r); delete rest.svg;
      fd.append('recipe', JSON.stringify(rest));
      for (const [id, st] of filled) {
        const sending = await encodeForUpload(st.file);
        fd.append('image:' + id, sending, sending.name || (id + '.jpg'));
      }
      const res = await fetch('/api/studio-save', {
        method: 'POST',
        headers: { 'X-CSC-Action-Secret': studioSecret(false) },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        try { sessionStorage.removeItem('csc-studio-secret'); } catch (e) { /* private mode */ }
        throw new Error('That secret was not accepted — click Save again to re-enter it.');
      }
      if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save the product');

      studioMsg = {
        text: `Saved as a draft — listing ${data.listing.width} x ${data.listing.height}, ` +
              `print master (${data.print.width}px wide) rendering in the background. `,
        href: data.studioUrl,
        label: 'Open "' + data.title + '" in the Studio',
      };
      btn.textContent = 'Saved';
      setTimeout(() => { btn.textContent = label; }, 2500);
    } catch (e) {
      btn.textContent = label;
      studioMsg = { text: e.message || 'Something went wrong saving the product.' };
    } finally {
      studioBusy = false;
      refresh();
    }
  });

  function showStudioMsg() {
    const hint = $('studioHint');
    if (!hint || !studioMsg) return;
    hint.textContent = studioMsg.text;
    if (!studioMsg.href) return;
    const a = document.createElement('a');
    a.href = studioMsg.href; a.target = '_blank'; a.rel = 'noopener';
    a.style.color = '#FFF200'; a.style.textDecoration = 'underline';
    a.textContent = studioMsg.label;
    hint.appendChild(a);
  }

  // Editing the title starts a new save, so the last result stops applying.
  on('studioTitle', 'input', () => { studioMsg = null; refresh(); });

  if (new URLSearchParams(location.search).has('dev')) $('copy').hidden = false;
  load(INITIAL);
  try { if (!localStorage.getItem('csc-guide-seen')) showGuide(); } catch (e) { showGuide(); }

  return { MODE };
}
