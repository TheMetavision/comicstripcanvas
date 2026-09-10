/**
 * How a print master becomes a web image.
 *
 * One definition, used by both things that make these: the batch tool
 * (tools/builder/web-versions.mjs) and the studio's Replace artwork path in
 * studio-save.mjs. They existed separately first, which is exactly how two
 * sets of listing images end up looking subtly different from each other.
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

/** The one Sanity gets: the web master. */
export const WEB_MASTER = DERIVATIVES[0];

/** The images[] key it is stored under, and what makes replacing it idempotent. */
export const WEB_MASTER_KEY = 'web-master';
/** The key studio-save gives the listing image it renders itself. */
export const LISTING_KEY = 'listing';

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
