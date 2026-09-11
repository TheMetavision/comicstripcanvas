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

/**
 * images[] with the product image set under LISTING_KEY, and any stale
 * web-master entry taken out.
 *
 * Both things that attach product images go through here -- the renderer and
 * the batch tool -- because "replace one entry by key and drop another" is
 * exactly the kind of small array surgery that drifts into two versions.
 *
 * Order matters and is preserved: the whole frontend reads images[0] as the
 * product image (ProductCard, the product page's main image, the category
 * carousels, related products), so an existing listing entry is replaced where
 * it already sits rather than moved to the end. Lifestyle mockups added later
 * sit at images[1..] and show as the gallery's thumbnail strip.
 */
export function setListingImage(images, assetId, alt) {
  const list = (Array.isArray(images) ? images : [])
    .filter((i) => i && i._key !== LEGACY_WEB_MASTER_KEY);
  const removedLegacy = (Array.isArray(images) ? images : []).length !== list.length;

  const entry = { _type: 'image', _key: LISTING_KEY, asset: { _type: 'reference', _ref: assetId }, alt };
  const at = list.findIndex((i) => i && i._key === LISTING_KEY);
  if (at >= 0) list[at] = entry; else list.push(entry);

  return { images: list, replaced: at >= 0, removedLegacy };
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
