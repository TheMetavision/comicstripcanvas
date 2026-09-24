/**
 * Turning an order line into "which file, made how" -- and where it is kept.
 *
 * Shared by the background renderer, the status/download route and the admin
 * page, so all three agree on the cache key. A cache whose key is computed in
 * three places is a cache that serves one job's file for another job.
 */
import { SIZE_KEYS, SIZE_NAME, orientationFromAspect } from './sizes.mjs';
import { CLASSIC, FULL_BLEED, styleOr } from './artwork-styles.mjs';

/** Where finished print files live. Separate from the studio store: different
 *  lifetime, different owner, and mixing them makes the retention sweep guess. */
export const PRINT_STORE = 'order-prints';

/** Cart format -> the finish print-geometry knows about. */
export const FINISH_OF_FORMAT = {
  poster: 'poster',
  'canvas-standard': 'standard',
  'canvas-gallery': 'gallery',
};

/* The labels an order line actually stores, so a line written before the keys
   were stored can still be read. Matched on the NAME rather than the
   dimensions: "Medium (16x12")" is what orders placed before September 2026
   say, and those numbers are deliberately never coming back. */
const FORMAT_KEY_OF_LABEL = {
  'poster print': 'poster',
  'canvas (standard frame)': 'canvas-standard',
  'canvas (gallery frame)': 'canvas-gallery',
  'canvas (standard)': 'canvas-standard',
  'canvas (gallery)': 'canvas-gallery',
};

/**
 * The size and finish a line was bought at.
 *
 * Lines written from now on carry sizeKey and formatKey outright. Older ones
 * carry only the labels a human reads, so those are parsed -- on the size NAME,
 * never on the dimensions, because the dimensions have changed once already.
 * Returns nulls rather than guessing: a print file made at the wrong size is
 * worse than one that was not made.
 */
export function keysFromLine(line = {}) {
  let sizeKey = SIZE_KEYS.includes(line.sizeKey) ? line.sizeKey : null;
  if (!sizeKey && typeof line.size === 'string') {
    const name = line.size.trim().split(/[\s(]/)[0].toLowerCase();
    if (SIZE_KEYS.includes(name)) sizeKey = name;
  }

  let formatKey = FINISH_OF_FORMAT[line.formatKey] ? line.formatKey : null;
  if (!formatKey && typeof line.format === 'string') {
    formatKey = FORMAT_KEY_OF_LABEL[line.format.trim().toLowerCase()] || null;
  }

  return {
    sizeKey,
    formatKey,
    finish: formatKey ? FINISH_OF_FORMAT[formatKey] : null,
    style: styleOr(line.artworkStyle),
  };
}

/**
 * What the file is made FROM, as an id that changes when the artwork does.
 *
 * This is the half of the cache key that makes a refreshed master invalidate
 * the cached print rather than serving last week's picture for ever. A scene
 * product uses the scene's own revision; a flat one uses the Sanity asset id,
 * which is new on every upload.
 */
export function sourceId({ sceneRev, masterAssetId }) {
  const raw = sceneRev || masterAssetId || 'none';
  return String(raw).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'none';
}

/**
 * The blob key for one line's finished file.
 *
 * Everything that changes the bytes is in the key: the size, the finish, the
 * style, and what it was made from. Nothing that does not is -- the order id
 * and line key are in the path so a file can be found again and swept, not
 * because they change the picture.
 */
export function printKeyFor({ orderId, lineKey, sizeKey, finish, style, source }) {
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '-');
  return `print/${safe(orderId)}/${safe(lineKey)}/`
    + `${safe(sizeKey)}-${safe(finish)}-${safe(style)}-${safe(source)}.png`;
}

/** Everything under one order, for the retention sweep and for re-renders. */
export const orderPrefix = (orderId) =>
  `print/${String(orderId || '').replace(/[^A-Za-z0-9._-]/g, '-')}/`;

/**
 * A filename a human can file. Whoever opens it is standing at a printer with
 * several of these on screen, so it says what it is rather than being a hash.
 */
export function downloadName({ orderNumber, productTitle, sizeKey, finish, style, orientation }) {
  const slug = (s) => String(s || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const parts = [
    slug(orderNumber || 'order'),
    slug(productTitle),
    (SIZE_NAME[sizeKey] || sizeKey || '').toLowerCase(),
    orientation === 'landscape' ? 'landscape' : 'portrait',
    finish,
  ];
  if (style === FULL_BLEED) parts.push('fullbleed');
  return `${parts.filter(Boolean).join('-')}.png`;
}

/** Which scene id a line's style is printed from, if the product has one. */
export const sceneIdFor = (product, style) =>
  (styleOr(style) === FULL_BLEED ? product?.fullBleed?.sceneId : product?.classicSceneId) || null;

/** Which stored master a line's style would fall back to. */
export const masterFor = (product, style) =>
  (styleOr(style) === FULL_BLEED ? product?.fullBleedPrintUrl : product?.printUrl) || null;

/** Which way up this product's artwork is, for the face and the filename. */
export const orientationFor = (product, style) =>
  orientationFromAspect(
    styleOr(style) === FULL_BLEED
      ? (product?.fbAspect ?? product?.aspect)
      : product?.aspect
  );

export { CLASSIC, FULL_BLEED };
