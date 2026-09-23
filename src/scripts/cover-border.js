/**
 * The cover border, composited from masks instead of recoloured pixel by pixel.
 *
 * ── What was wrong with the old way ────────────────────────────────────────
 *
 * The border shipped as one flattened three-colour PNG, and recolouring it
 * meant replacing pixels. A pixel on an antialiased edge is a BLEND of the
 * stroke and the fill, so replacing it needs to know what it is a blend of --
 * and the moment the fill changes, every one of those blends is wrong. The
 * asset in the repo still carries the evidence of an earlier pass: 99,021 of
 * its 24.4M pixels cannot be explained by any mixture of its own three
 * colours, and at 400% they read as a salmon rim around every black stroke.
 *
 * Worse, the recolour only ever ran in the browser. exportSVG() rewrites the
 * background to {{BACKGROUND}} and the renderer resolved that to the original
 * file, so a customer's chosen border colours never reached the print at all.
 *
 * ── How it works now ───────────────────────────────────────────────────────
 *
 * Three greyscale masks -- line work, and one per flat region -- with the
 * colours applied at render time:
 *
 *     <rect fill=A/>                     the base region
 *     <rect fill=B mask=region-b/>       the other region over it
 *     <rect fill=line mask=line/>        the black line work over both
 *
 * Antialiasing then comes from the mask's own alpha, so it is correct for any
 * colour, for ever, and there is nothing to contaminate. It is also the SAME
 * markup in the browser and in the print renderer: SVG masks are native in the
 * DOM and resvg honours image masks exactly, so preview and print composite by
 * one method rather than two that are supposed to agree.
 *
 * This module builds markup and nothing else -- no DOM, no fs, no network --
 * so both sides can use it and the rules can be tested without either.
 */

/**
 * The artwork's own colours, and the single source for them.
 *
 * Measured from background-print.png by tools/builder/extract-border-layers.mjs,
 * which re-checks them every time it runs and complains if they have drifted.
 * The vector defaults elsewhere on the cover -- the title colour, the caption
 * box fills -- are the same three values and now read them from here rather
 * than repeating them, because three copies of a colour is three chances for
 * two of them to be right.
 */
export const COVER_PALETTE = {
  line: '#040707',
  regionA: '#368975',
  regionB: '#fce534',
};

/** In the order the pickers show them, darkest first, as the builder always had. */
export const coverPaletteList = () => [COVER_PALETTE.line, COVER_PALETTE.regionA, COVER_PALETTE.regionB];

/** Labels for the three pickers. */
export const COVER_PALETTE_LABELS = ['Line work', 'Left', 'Right'];

const isHex = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

/**
 * Fill in anything the caller did not choose.
 *
 * A recipe records whatever the customer picked; a design that never touched
 * the pickers records the defaults, and an older one may record nothing. All
 * three have to come out as three usable colours, because the alternative is a
 * border rendered in `undefined`.
 */
export function resolvePalette(chosen) {
  const d = coverPaletteList();
  const out = Array.isArray(chosen) ? d.map((fallback, i) => (isHex(chosen[i]) ? chosen[i] : fallback)) : d.slice();
  return { line: out[0], regionA: out[1], regionB: out[2] };
}

/** Is this palette the one the artwork was drawn in? */
export function isDefaultPalette(chosen) {
  const p = resolvePalette(chosen);
  return p.line.toLowerCase() === COVER_PALETTE.line
    && p.regionA.toLowerCase() === COVER_PALETTE.regionA
    && p.regionB.toLowerCase() === COVER_PALETTE.regionB;
}

/**
 * The masks, in two sizes, exactly as the flattened artwork always had.
 *
 * The browser previews at canvas size and must not pull 24 megapixels of mask
 * per layer to do it; the print renderer wants every one of them. Same pairing
 * as background.png beside background-print.png, and generated together so the
 * two cannot fall out of step.
 */
const BORDER_DIR = '/builder/templates/cover-border';
export const BORDER_MASKS = {
  line: `${BORDER_DIR}/line-print.png`,
  regionB: `${BORDER_DIR}/region-b-print.png`,
  regionA: `${BORDER_DIR}/region-a-print.png`,
};
export const BORDER_MASKS_SCREEN = {
  line: `${BORDER_DIR}/line.png`,
  regionB: `${BORDER_DIR}/region-b.png`,
  regionA: `${BORDER_DIR}/region-a.png`,
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * The border as SVG markup.
 *
 * `ids` are suffixed so two borders on one document cannot collide -- which
 * they would, silently and invisibly, by both defining a mask called "line".
 *
 * @param {object} o
 * @param {number} o.x @param {number} o.y @param {number} o.width @param {number} o.height
 * @param {string[]} o.colours      artColours as recorded in the recipe
 * @param {{line: string, regionB: string}} o.masks  hrefs or data URIs
 * @param {string} [o.idSuffix]
 * @returns {string}
 */
export function borderMarkup({ x, y, width, height, colours, masks, idSuffix = '' }) {
  const p = resolvePalette(colours);
  const box = `x="${x}" y="${y}" width="${width}" height="${height}"`;
  const mk = (id, href) =>
    `<mask id="${id}" maskUnits="userSpaceOnUse" ${box}>`
    + `<image href="${esc(href)}" ${box} preserveAspectRatio="none"/>`
    + `</mask>`;
  const idB = `cscBorderB${idSuffix}`;
  const idL = `cscBorderL${idSuffix}`;

  return `<g data-role="border">`
    + `<defs>${mk(idB, masks.regionB)}${mk(idL, masks.line)}</defs>`
    + `<rect ${box} fill="${esc(p.regionA)}"/>`
    + `<rect ${box} fill="${esc(p.regionB)}" mask="url(#${idB})"/>`
    + `<rect ${box} fill="${esc(p.line)}" mask="url(#${idL})"/>`
    + `</g>`;
}

/**
 * Find the background <image> in an exported scene and read its geometry.
 *
 * Attribute order is whatever the serialiser felt like, so each one is matched
 * on its own rather than by assuming a shape.
 *
 * @returns {{ element: string, x: number, y: number, width: number, height: number } | null}
 */
export function findBackgroundImage(svg, token = '{{BACKGROUND}}') {
  const re = /<image\b[^>]*\/>|<image\b[^>]*>[\s\S]*?<\/image>/g;
  for (const m of svg.match(re) || []) {
    if (!m.includes(token)) continue;
    const num = (name) => {
      const hit = new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(m);
      return hit ? Number(hit[1]) : null;
    };
    const x = num('x'), y = num('y'), width = num('width'), height = num('height');
    if ([x, y, width, height].some((v) => v === null)) return null;
    return { element: m, x, y, width, height };
  }
  return null;
}

/**
 * Swap the flattened background for the composited one.
 *
 * Returns the scene unchanged when there is no background to swap, so a
 * full-bleed cover -- which has none -- costs nothing and needs no special
 * case at the call site.
 */
export function replaceBackgroundWithBorder(svg, { colours, masks, idSuffix = '' } = {}) {
  const found = findBackgroundImage(svg);
  if (!found) return { svg, replaced: false };
  const markup = borderMarkup({
    x: found.x, y: found.y, width: found.width, height: found.height,
    colours, masks, idSuffix,
  });
  return { svg: svg.replace(found.element, markup), replaced: true };
}
