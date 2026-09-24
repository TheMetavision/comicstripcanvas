/**
 * How a design is laid out on a face, and how to move a saved one onto another.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The builder decides where the artwork sits: how far it is scaled to meet the
 * chosen face, how much border that leaves, and how far the design has to carry
 * on past the face to wrap round a stretcher bar. That arithmetic lived inside
 * product-builder.js, which runs in a browser.
 *
 * Fulfilment needs the same arithmetic on the server, because an order is for
 * ONE size and finish and the stored print master is whatever size the design
 * was built at. tools/builder/README.md says the proof and the print are the
 * same SVG and not to recalculate layout server-side -- and that rule is the
 * reason this is a shared module rather than a second implementation. There is
 * one geom(); the builder calls it and so does the renderer.
 *
 * THE SHAPE OF IT
 *
 *   canvas          the design's own coordinate space, in pixels
 *   face            what the customer bought, in inches
 *   wrap            inches of design beyond the face, folded round the bars
 *   pad             what is left over on the axis that does not fit
 *
 * 'pad' fits the whole design inside the face and grows the border to fill the
 * rest; 'fill' scales until the design covers the face and loses a little off
 * the long axis. Which one a template uses is a property of the artwork, not of
 * the size, so FIT is per template and never per order.
 */

/** Inches of design beyond the face, per finish. Poster has no wrap. */
export const WRAP = { poster: 0, standard: 1.5, gallery: 2.5 };

/**
 * Whether a template pads or crops when the face is not its own shape.
 *
 * A strip pads: its panels are the design and losing an edge of one is losing
 * part of the picture. A cover and an icon fill: their outer edge is decorative
 * burst, and a visible border of background on a comic cover looks like a
 * mistake rather than a margin.
 */
export const FIT = {
  strip: 'pad',
  cover: 'fill',
  'cover-fullbleed': 'fill',
  'icon-portrait': 'fill',
  'icon-landscape': 'fill',
};

export const DPI = 300;

/** Inches of wrap for a finish, 0 for anything unrecognised. */
export const wrapInchesFor = (finish) => WRAP[finish] || 0;

/**
 * Where the design sits on one face.
 *
 * @param {{width:number,height:number}} canvas  the design's coordinate space
 * @param {{w:number,h:number}} face             inches
 * @param {string} fit                           'pad' | 'fill'
 * @param {number} wrapIn                        inches of wrap
 *
 * Returns pixel measurements in CANVAS units: ppi is canvas pixels per face
 * inch, so padX/ppi is the border in inches. dx/dy may be negative, which means
 * the face crops the design; ex/ey are the same clamped at zero, which is what
 * an element's box uses, because a box cannot have negative overhang.
 */
export function geom(canvas, face, fit, wrapIn = 0) {
  const cw = Number(canvas?.width), ch = Number(canvas?.height);
  const fw = Number(face?.w), fh = Number(face?.h);
  if (!(cw > 0 && ch > 0 && fw > 0 && fh > 0)) {
    throw new Error(`geom: need a canvas and a face, got ${cw}x${ch} on ${fw}x${fh}`);
  }
  const byW = cw / fw, byH = ch / fh;
  const ppi = fit === 'pad' ? Math.max(byW, byH) : Math.min(byW, byH);
  const padX = (fw * ppi - cw) / 2;
  const padY = (fh * ppi - ch) / 2;
  const wrapPx = (Number(wrapIn) || 0) * ppi;
  const dx = padX + wrapPx, dy = padY + wrapPx;
  return {
    ppi, padX, padY, wrapPx, dx, dy,
    ex: Math.max(0, dx),
    ey: Math.max(0, dy),
    /* The whole printed sheet, face plus wrap on all four sides. */
    fileInches: [fw + 2 * (Number(wrapIn) || 0), fh + 2 * (Number(wrapIn) || 0)],
  };
}

/** The viewBox the builder would emit for this geometry. */
export const viewBoxFor = (canvas, g) =>
  `${-g.dx} ${-g.dy} ${canvas.width + 2 * g.dx} ${canvas.height + 2 * g.dy}`;

/** Pixel size of the printed sheet at 300 dpi. */
export const printPixels = (g) => ({
  width: Math.round(g.fileInches[0] * DPI),
  height: Math.round(g.fileInches[1] * DPI),
});

/* ───────────────────────────── re-projection ─────────────────────────────
 *
 * A saved scene was laid out for ONE face and finish. Everything in it is in
 * canvas coordinates and does not move -- except the handful of boxes the
 * builder stretched to cover the padding and the wrap:
 *
 *   the viewBox                       always
 *   <rect data-role="bg-colour">      a colour background (a strip)
 *   <image data-role="background">    the composited burst (a cover)
 *   a panel that covers the canvas    and its clipPath rect
 *
 * build() draws each of those at (-ex, -ey) sized canvas + 2ex/2ey. So moving a
 * design to another face is: work out the old ex/ey and the new ones, and
 * rewrite every box that matches the old to the new. Nothing else is touched --
 * no text is re-measured, no panel is re-fitted, no colour is recomputed --
 * which is what keeps this a re-projection rather than a second layout engine.
 */

const near = (a, b, tol = 0.75) => Math.abs(Number(a) - Number(b)) <= tol;

/**
 * Move a saved scene onto a different face and finish.
 *
 * @param {string} svg      the tokenised scene as saved
 * @param {object} canvas   {width, height} from the recipe
 * @param {object} from     geom() for the face it was saved at
 * @param {object} to       geom() for the face being printed
 * @returns {{svg: string, changed: string[]}}
 */
export function reprojectScene(svg, canvas, from, to) {
  if (typeof svg !== 'string' || !svg) throw new Error('reprojectScene: no scene');
  const changed = [];
  let out = svg;

  /* The old and new stretched boxes, in canvas units. */
  const oldBox = {
    x: -from.ex, y: -from.ey,
    width: canvas.width + 2 * from.ex, height: canvas.height + 2 * from.ey,
  };
  const newBox = {
    x: -to.ex, y: -to.ey,
    width: canvas.width + 2 * to.ex, height: canvas.height + 2 * to.ey,
  };

  /* ---- the viewBox ---- */
  const wantVB = viewBoxFor(canvas, to);
  const vbHit = /viewBox\s*=\s*"([^"]*)"/.exec(out);
  if (!vbHit) throw new Error('reprojectScene: the scene has no viewBox');
  out = out.replace(vbHit[0], `viewBox="${wantVB}"`);
  changed.push('viewBox');

  /* The root width/height, which the builder writes as the rounded viewBox.
     resvg is told a width explicitly when it rasterises, so these do not decide
     the print -- but a document whose declared size disagrees with its viewBox
     is a trap for anything else that opens it, and leaving them behind was the
     one difference between this and the builder's own output. */
  const rootEnd = out.indexOf('>');
  if (rootEnd > 0) {
    const head = out.slice(0, rootEnd + 1);
    const body = out.slice(rootEnd + 1);
    const w = Math.round(canvas.width + 2 * to.dx);
    const h = Math.round(canvas.height + 2 * to.dy);
    const fixed = head
      .replace(/\bwidth\s*=\s*"[^"]*"/, `width="${w}"`)
      .replace(/\bheight\s*=\s*"[^"]*"/, `height="${h}"`);
    if (fixed !== head) changed.push('root size');
    out = fixed + body;
  }

  /* ---- every element whose box is the stretched one ----
     Matched on the numbers rather than on a role list, so a template that grows
     another element into the wrap is carried too. An element that merely
     happens to be canvas-sized and unstretched (from.ex and from.ey both zero,
     a poster) is rewritten to the same numbers when the target is also a poster,
     and correctly grown when it is not -- which is the intended behaviour, and
     the reason a poster-to-poster re-projection is a no-op rather than a skip. */
  const tagRe = /<(rect|image)\b[^>]*>/g;
  out = out.replace(tagRe, (tag) => {
    const get = (a) => {
      const m = new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`).exec(tag);
      return m ? m[1] : null;
    };
    /* A panel's photo is NOT one of these boxes, even when its numbers happen
       to match: it is placed to cover its clip rect at the customer's zoom and
       pan, and is re-fitted below. A square photo on a square canvas has
       exactly the stretched box, and moving it here and again down there moved
       it twice -- the picture grew by the wrap squared. */
    if (get('data-role') === 'panel') return tag;
    const x = get('x'), y = get('y'), w = get('width'), h = get('height');
    if (x === null || y === null || w === null || h === null) return tag;
    if (!(near(x, oldBox.x) && near(y, oldBox.y)
      && near(w, oldBox.width) && near(h, oldBox.height))) return tag;

    let next = tag;
    for (const [attr, val] of [['x', newBox.x], ['y', newBox.y],
      ['width', newBox.width], ['height', newBox.height]]) {
      next = next.replace(new RegExp(`\\b${attr}\\s*=\\s*"[^"]*"`), `${attr}="${val}"`);
    }
    const role = get('data-role') || (tag.startsWith('<rect') ? 'rect' : 'image');
    changed.push(role);
    return next;
  });

  /* ---- the photo inside a panel that was stretched ----
     A panel's image is placed to COVER its clip rect, centred, at whatever zoom
     and pan the customer left it at. When the clip rect grows into the wrap the
     image has to grow with it or the wrap shows empty.

     Expressed as cover size, zoom and pan rather than scaled proportionally:
     the image keeps its own aspect while the rect changes aspect, so scaling
     x and y independently would stretch the photograph. Verified against the
     builder's own output for all five templates -- see sizes-tests. */
  const stretchedPanels = [];
  const clipRe = /<clipPath\b[^>]*\bid\s*=\s*"clip-([^"]+)"[^>]*>([\s\S]*?)<\/clipPath>/g;
  for (const m of out.matchAll(clipRe)) {
    const rect = /<rect\b[^>]*>/.exec(m[2]);
    if (!rect) continue;                       // a path clip is not stretched
    const num = (a) => {
      const hit = new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`).exec(rect[0]);
      return hit ? Number(hit[1]) : NaN;
    };
    if (near(num('x'), newBox.x) && near(num('y'), newBox.y)
      && near(num('width'), newBox.width) && near(num('height'), newBox.height)) {
      stretchedPanels.push(m[1]);
    }
  }

  for (const panel of stretchedPanels) {
    const imgRe = new RegExp(`<image\\b[^>]*\\bdata-panel\\s*=\\s*"${panel}"[^>]*>`);
    const hit = imgRe.exec(out);
    if (!hit) continue;
    const tag = hit[0];
    const attr = (a) => {
      const g = new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`).exec(tag);
      return g ? Number(g[1]) : NaN;
    };
    const b0 = { x: attr('x'), y: attr('y'), w: attr('width'), h: attr('height') };
    if (![b0.x, b0.y, b0.w, b0.h].every(Number.isFinite) || b0.w <= 0 || b0.h <= 0) continue;

    const aspect = b0.w / b0.h;
    const coverW = (r) => Math.max(r.width, r.height * aspect);
    const c0w = coverW(oldBox), c0h = c0w / aspect;
    const c1w = coverW(newBox), c1h = c1w / aspect;
    const zoom = b0.w / c0w;
    const panX = ((b0.x + b0.w / 2) - (oldBox.x + oldBox.width / 2)) / c0w;
    const panY = ((b0.y + b0.h / 2) - (oldBox.y + oldBox.height / 2)) / c0h;

    const w1 = c1w * zoom, h1 = c1h * zoom;
    const cx = newBox.x + newBox.width / 2 + panX * c1w;
    const cy = newBox.y + newBox.height / 2 + panY * c1h;
    const b1 = { x: cx - w1 / 2, y: cy - h1 / 2, w: w1, h: h1 };

    let next = tag;
    for (const [a, v] of [['x', b1.x], ['y', b1.y], ['width', b1.w], ['height', b1.h]]) {
      next = next.replace(new RegExp(`\\b${a}\\s*=\\s*"[^"]*"`), `${a}="${round2(v)}"`);
    }
    out = out.replace(tag, next);
    changed.push(`panel:${panel}`);
  }

  return { svg: out, changed };
}

/* The builder writes these at two decimals; matching it keeps a re-projected
   scene byte-comparable with one the builder made itself. */
const round2 = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
