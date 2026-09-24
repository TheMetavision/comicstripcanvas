/**
 * The three sizes the shop sells, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Medium moved from 16x12 to 18x12 so that all three sizes share the artwork's
 * 3:2 / 2:3 shape. Doing that meant changing the same pair of numbers in nine
 * places -- two Netlify functions, four front-end label tables, the Google
 * Shopping feed, the size guide and the JSON-LD FAQ -- each with its own
 * spelling of the same fact, and no way to tell from any one of them whether
 * the others had been done. They are all derived from SIZE_INCHES now.
 *
 * The size KEY (small|medium|large) is what travels through the cart, Stripe
 * metadata and an order line, and it is deliberately not a dimension: changing
 * what "medium" measures must never change what a basket or a paid order means.
 * An order line stores the rendered LABEL, so orders placed before this change
 * keep saying 16x12 for ever, which is what they were sold as.
 *
 * Imported by netlify/functions/*.mjs, by src/ (Vite resolves this path -- see
 * product-builder.js importing _shared/photo-input.mjs) and by the tests.
 */

/** In the order they are offered. The index is the cart's size index. */
export const SIZE_KEYS = ['small', 'medium', 'large'];

/**
 * [long edge, short edge] in inches. Orientation belongs to the artwork rather
 * than to this table: a strip is 18x12 and a cover is 12x18 from one entry.
 */
export const SIZE_INCHES = {
  small: [12, 8],
  medium: [18, 12],
  large: [24, 16],
};

export const SIZE_NAME = { small: 'Small', medium: 'Medium', large: 'Large' };

/** `18×12"`. Pass 'x' for the front end's spelling of the same thing. */
export function sizeDim(key, times = '×') {
  const pair = SIZE_INCHES[key];
  return pair ? `${pair[0]}${times}${pair[1]}"` : '';
}

/** `Medium (18×12")` */
export function sizeLabel(key, times = '×') {
  return SIZE_NAME[key] ? `${SIZE_NAME[key]} (${sizeDim(key, times)})` : String(key);
}

/** The whole table, replacing the SIZE_LABELS objects that used to be copied about. */
export function sizeLabels(times = '×') {
  const out = {};
  for (const key of SIZE_KEYS) out[key] = sizeLabel(key, times);
  return out;
}

/**
 * The builder's size list for one orientation: actual w x h, its own label, and
 * the key -- so a saved recipe can name its size instead of being matched on
 * two numbers that are free to change.
 *
 * Call this ONCE per orientation and share the result. The builder compares a
 * chosen size to the list by object identity (`s === T.size`, and
 * `T.sizes.indexOf(T.size)` for the cart's size index), so a second array with
 * equal contents is not interchangeable with the first.
 */
export function builderSizes(orient) {
  return SIZE_KEYS.map((key) => {
    const [long, short] = SIZE_INCHES[key];
    const [w, h] = orient === 'portrait' ? [short, long] : [long, short];
    return { key, label: `${w} × ${h} in`, w, h };
  });
}

/* ─────────────────────────── orientation ─────────────────────────────────
 *
 * SIZE_INCHES is [long, short] because a size is one thing whichever way up it
 * is printed. What a CUSTOMER should read is the way their picture is shaped:
 * a cover is 12x18, a strip is 18x12, and telling a cover buyer "18x12" is
 * telling them the wrong number about the thing they are buying.
 *
 * So anywhere a label belongs to a particular product -- the cart, the Stripe
 * line, the order line, the emails -- it is built with the product's own
 * orientation. Anywhere it does not -- the pricing grid, the size guide, the
 * FAQ -- the orientation-free form above stays, because there is no single
 * product to take an orientation from.
 */

export const ORIENTATIONS = ['portrait', 'landscape'];

/** Actual [w, h] in inches for a size printed this way up. */
export function sizeWH(key, orient) {
  const pair = SIZE_INCHES[key];
  if (!pair) return null;
  const [long, short] = pair;
  return orient === 'portrait' ? [short, long] : [long, short];
}

/** `12×18"` portrait, `18×12"` landscape. */
export function sizeDimFor(key, orient, times = '×') {
  const wh = sizeWH(key, orient);
  return wh ? `${wh[0]}${times}${wh[1]}"` : '';
}

/** `Medium (12×18")` for a cover, `Medium (18×12")` for a strip. */
export function sizeLabelFor(key, orient, times = '×') {
  return SIZE_NAME[key] ? `${SIZE_NAME[key]} (${sizeDimFor(key, orient, times)})` : String(key);
}

/**
 * Which way up a product's artwork is.
 *
 * Taken from the aspect ratio of what the customer is looking at rather than a
 * field somebody has to remember to set: there is no orientation field on a
 * product, and 117 of 311 products are landscape, so defaulting either way
 * would mislabel a third of the shop. Square and unknown both fall to portrait,
 * which is the majority and the shape of every cover.
 */
export function orientationFromAspect(aspect) {
  const a = Number(aspect);
  return Number.isFinite(a) && a > 1 ? 'landscape' : 'portrait';
}

/** Orientation from explicit dimensions, for callers holding pixels. */
export const orientationFromSize = (w, h) =>
  orientationFromAspect(Number(h) ? Number(w) / Number(h) : NaN);

/**
 * Faces that were sold once and are not offered now, mapped to what they became.
 * Medium was 16x12 (12x16 portrait) until September 2026.
 */
export const LEGACY_FACES = {
  '16x12': 'medium',
  '12x16': 'medium',
};

/**
 * Which size a saved build reopens at.
 *
 * In order: the key the recipe recorded; an exact match on the face; a face we
 * used to sell; then the NEAREST size by area.
 *
 * That last step is the point of this function. The old code matched on exact
 * inches and, finding nothing, left the template default in place -- which is
 * the LARGEST size. So after this change a customer resuming a half-finished
 * Medium build would have silently reopened on Large, at Large's price, with no
 * indication anything had moved. Nearest-by-area is not a guess about intent;
 * it is a guarantee that the failure is small and local instead of maximal.
 *
 * Returns null only when the recipe says nothing about its size at all, which
 * is the one case where there is genuinely nothing to go on.
 */
export function resumeSize(output, sizes) {
  if (!Array.isArray(sizes) || !sizes.length) return null;
  const byKey = (key) =>
    sizes.find((z) => z && z.key === key) || sizes[SIZE_KEYS.indexOf(key)] || null;

  if (output && SIZE_KEYS.includes(output.sizeKey)) {
    const named = byKey(output.sizeKey);
    if (named) return named;
  }

  const face = output && output.faceInches;
  if (!Array.isArray(face) || face.length !== 2) return null;
  const fw = Number(face[0]), fh = Number(face[1]);
  if (!Number.isFinite(fw) || !Number.isFinite(fh) || fw <= 0 || fh <= 0) return null;

  const exact = sizes.find((z) => z.w === fw && z.h === fh);
  if (exact) return exact;

  /* Either orientation of a retired face: a cover recipe records [12, 16] and a
     strip records [16, 12], and both were Medium. */
  const legacy = LEGACY_FACES[`${fw}x${fh}`] || LEGACY_FACES[`${fh}x${fw}`];
  if (legacy) {
    const mapped = byKey(legacy);
    if (mapped) return mapped;
  }

  const want = fw * fh;
  let best = null, bestGap = Infinity;
  for (const z of sizes) {
    const gap = Math.abs(z.w * z.h - want);
    if (gap < bestGap) { bestGap = gap; best = z; }
  }
  return best;
}
