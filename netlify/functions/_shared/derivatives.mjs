/**
 * How a print master becomes a web image.
 *
 * One definition, used by both things that make these: the batch tool
 * (tools/builder/web-versions.mjs) and the studio renderer. They existed
 * separately first, which is exactly how two sets of listing images end up
 * looking subtly different from each other -- and setListingImage is here for
 * the same reason, so both attach the result the same way.
 *
 * sharp is imported by the caller and passed in. studio-save keeps it out of
 * its bundle (external_node_modules in netlify.toml), and the tool loads it
 * from the repo root -- neither can import it the same way, but both can hand
 * it over.
 */

/** Longest side, format and quality for each derivative. */
export const DERIVATIVES = [
  { name: '2000.jpg', side: 2000, format: 'jpeg', quality: 85 },
  { name: '1200.webp', side: 1200, format: 'webp', quality: 80 },
  { name: '400.webp', side: 400, format: 'webp', quality: 80 },
];

/** The one Sanity gets, and the only one: a 2000px sRGB JPEG. */
export const WEB_MASTER = DERIVATIVES[0];

/**
 * The single images[] key a rendered product image lives under.
 *
 * There used to be two. The renderer wrote a 1600px PNG under "listing" and a
 * 2000px JPEG under "web-master", which put two near-identical pictures of the
 * same artwork side by side in the product gallery. The 2000px JPEG is the
 * better of the two on every count -- larger, sRGB-converted, a twentieth of
 * the bytes -- so it is now the one, and it keeps the "listing" key so that
 * nothing reading images[0] or querying by key has to change.
 */
export const LISTING_KEY = 'listing';

/**
 * What the second entry used to be called. Kept ONLY so it can be removed:
 * every product rendered before this change still carries one, and the render
 * that replaces its artwork is the moment to drop it. Nothing writes it.
 */
export const LEGACY_WEB_MASTER_KEY = 'web-master';

/** How many artwork changes a product remembers. */
export const HISTORY_LIMIT = 5;

/**
 * images[] with the product image set under LISTING_KEY, and any stale
 * web-master entry taken out.
 *
 * Both things that attach product images go through here -- the renderer and
 * the batch tool -- because this is exactly the kind of small array surgery
 * that drifts into two versions.
 *
 * THE PRODUCT IMAGE IS images[0]. Not "the entry keyed listing" -- that is only
 * how the studio's own products happen to be arranged. Every consumer on the
 * site reads position zero: ProductCard, the product page's main image, the
 * category carousels on the home and services pages, related products. So that
 * is the slot this writes to, and there are three ways in:
 *
 *   listing    an entry keyed "listing" already exists -> replace it in place
 *   displaced  no such entry, but images[0] exists -> REPLACE images[0], taking
 *              over its slot and its role, and keep its asset ref so the
 *              caller can record what was pushed out
 *   first      images[] is empty -> it becomes the only entry
 *
 * "displaced" is the one to be careful with, and it is what happens to all 292
 * hand-curated catalogue products: their images[0] is a picture somebody chose,
 * and appending would have left it on the site while the render it was supposed
 * to produce sat invisibly at the end of the array. Replacing is right, but it
 * does mean a curated image stops being displayed -- hence `displaced`, which
 * both callers write into artworkHistory so there is a way back.
 *
 * images[1..] are never touched in any of the three cases. That is the curated
 * gallery, and later the lifestyle mockups.
 */
export function setListingImage(images, assetId, alt) {
  const original = Array.isArray(images) ? images : [];
  const list = original.filter((i) => i && i._key !== LEGACY_WEB_MASTER_KEY);
  const removedLegacy = list.length !== original.length;

  const entry = { _type: 'image', _key: LISTING_KEY, asset: { _type: 'reference', _ref: assetId }, alt };
  const at = list.findIndex((i) => i && i._key === LISTING_KEY);
  const slot = at >= 0 ? at : 0;
  const mode = at >= 0 ? 'listing' : (list.length ? 'displaced' : 'first');

  /* What was in the slot before. Null when there was nothing there, which is
     the only case where nothing is being taken away from anybody. */
  const displaced = (list[slot] && list[slot].asset && list[slot].asset._ref) || null;

  if (mode === 'first') list.push(entry); else list[slot] = entry;

  return { images: list, mode, displaced, removedLegacy, replaced: mode !== 'first' };
}

/**
 * artworkHistory with the displaced product image recorded on the change that
 * displaced it.
 *
 * The renderer already writes an entry per redraw (studio-save creates it, with
 * the printFile reference it is about to overwrite); this fills in the other
 * half, which is only knowable at attach time because it is whatever the
 * document's images[0] happened to be a moment before. The batch tool has no
 * entry of its own, so it gets one.
 *
 * @param {Array}  history   the document's artworkHistory, or undefined
 * @param {string} displaced asset ref that is no longer the product image
 * @param {object} opts      { by, ownEntry } -- ownEntry true when the caller
 *                           already wrote the entry this belongs on
 */
export function recordDisplacedListing(history, displaced, { by = 'studio', ownEntry = false } = {}) {
  if (!displaced) return { history: Array.isArray(history) ? history : [], recorded: false };
  const list = (Array.isArray(history) ? history : []).slice();

  /* Fill in the entry this change already has rather than adding a second one
     describing the same event. */
  if (ownEntry && list[0]) {
    list[0] = { ...list[0], prevListingAssetId: displaced };
    return { history: list, recorded: true };
  }

  list.unshift({
    _type: 'artworkChange',
    _key: `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    by,
    prevListingAssetId: displaced,
  });
  return { history: list.slice(0, HISTORY_LIMIT), recorded: true };
}

/**
 * Build one derivative from a PNG buffer or path.
 *
 * Never upscales, converts to sRGB, and keeps no metadata -- a print master
 * carries a print profile, and a browser handed one without conversion renders
 * it wrong. Returns { data, info } from sharp.
 */
export function renderDerivative(sharp, source, spec = WEB_MASTER) {
  let pipe = sharp(source)
    .resize(spec.side, spec.side, { fit: 'inside', withoutEnlargement: true })
    .toColorspace('srgb');
  pipe = spec.format === 'jpeg'
    ? pipe.jpeg({ quality: spec.quality, chromaSubsampling: '4:4:4' })
    : pipe.webp({ quality: spec.quality });
  return pipe.toBuffer({ resolveWithObject: true });
}
