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

/**
 * Open the print store, reading STRONGLY.
 *
 * Netlify Blobs reads are eventually consistent unless you ask otherwise, and
 * this store is written by one function and read immediately by another. That
 * is exactly the case eventual consistency breaks, and it broke it: on
 * production, the status route said "ready" and the download route, a moment
 * later, said "not made yet" -- two reads of the same key, one fresh and one
 * stale. The file was there the whole time; the store listing shows it written
 * at 15:04 with the status note pointing straight at it.
 *
 * It never showed up under netlify dev because the local blob server answers
 * from one copy, so every read is strong by accident.
 *
 * Opened through one helper so a future caller cannot quietly get the default
 * again -- which is what the original three getStore(PRINT_STORE) calls did.
 */
export const openPrintStore = (getStore) => getStore({
  name: PRINT_STORE,
  consistency: 'strong',
});

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

/**
 * Was this line written by the webhook that stamps its own keys?
 *
 * Everything before September 2026 recorded only what a human reads -- a title,
 * a format label, a size label -- and nothing a machine can act on. Those lines
 * are not missing a print file; they predate the idea of one being attached.
 * Treating them as faults lit up all fourteen orders in the dataset at once,
 * which is the fastest way to teach somebody to ignore a warning.
 *
 * sizeKey rather than productSlug: the webhook sets sizeKey unconditionally on
 * a stock line, and productSlug only when the cart carried a slug.
 */
export const isStamped = (line) => Boolean(line && line.sizeKey);

/**
 * A line that was never going to be printed: the artwork fee, and anything else
 * carrying an em dash for its format and size. Not a fault and not a product.
 */
export const isFeeLine = (line) => {
  /* An absent format or size counts as blank, not just an em dash. A stock
     line always carries both -- the webhook has set them on every branch it
     has ever had -- so a line with neither is a fee line or something
     malformed, and both are better left alone than looked up. The cost of
     being wrong here is a missing button on one line; the cost the other way
     is a product offered against a line that was never for one. */
  const blank = (v) => v === '—' || v === '-' || v === '' || v == null;
  return Boolean(line) && blank(line.format) && blank(line.size);
};

/**
 * A personalised line from the old flow, which recorded no buildKind.
 *
 * webhook.mjs's legacy branch keys these `pers-<timestamp>` (and once
 * `pers-icon-<timestamp>`), alongside the `artfee-` line above. They are
 * printed from the customer's own brief on the Personalisations entry, exactly
 * like a modern built line -- so they have no stock product, and hunting for
 * one produces "no product for Personalised Comic Book Icon" against ten of the
 * fourteen orders in the dataset. That is the same false alarm this change
 * exists to remove, one flow older.
 */
export const isLegacyBuildLine = (line, lineKey = '') =>
  Boolean(line) && !line.buildKind && /^pers(-|$)/.test(String(lineKey || line._key || ''));

/** Is this line printed from a stock product at all? */
export const isStockLine = (line, lineKey = '') =>
  Boolean(line) && !line.buildKind && !isFeeLine(line) && !isLegacyBuildLine(line, lineKey);

/**
 * Where to look for the product a line was for, most reliable first.
 *
 * `named` means the line said so outright and there is nothing to fall back to:
 * a wrong slug must fail rather than quietly resolve to something else.
 * Otherwise the line's own _key is the best evidence -- the webhook built it as
 * <slug>-<style>-<format>-<size>-<index>, and before styles existed without the
 * style -- so each suffix is stripped in turn.
 */
export function slugCandidates(line = {}, lineKey = '') {
  const named = line.productSlug || line.slug || null;
  if (named) return { candidates: [named], named: true };

  const parts = String(lineKey || '').split('-').filter(Boolean);
  const candidates = [];
  for (let take = parts.length - 1; take >= 1; take--) {
    const c = parts.slice(0, take).join('-');
    if (c && !candidates.includes(c)) candidates.push(c);
  }
  return { candidates, named: false };
}

/**
 * Which product this line was for.
 *
 * The lookups are injected so the same rules serve the renderer, which has a
 * server client and a write token, and the Studio panel, which has neither.
 *
 * An ambiguous title REFUSES. Three published products are called "Bob Marley"
 * -- bob-marley-cover, bob-marley-icon and bob-marley -- so picking the first
 * would offer somebody a different picture from the one that was bought, and
 * look entirely reasonable doing it.
 *
 * @param bySlug  async (slug) => product | null
 * @param byTitle async (title) => [{ slug }]
 */
export async function resolveLineProduct({ line = {}, lineKey = '', bySlug, byTitle }) {
  const { candidates, named } = slugCandidates(line, lineKey);
  for (const slug of candidates) {
    const found = await bySlug(slug);
    if (found) return { product: found, by: named ? 'slug' : 'key' };
  }
  if (named) {
    return { error: `no product with slug "${candidates[0]}"`, reason: 'missing' };
  }

  const title = line.productTitle;
  if (!title) return { error: 'this line does not name a product', reason: 'missing' };

  const matches = (await byTitle(title)) || [];
  if (matches.length === 1) {
    const slug = matches[0]?.slug || matches[0];
    const found = await bySlug(slug);
    if (found) return { product: found, by: 'title' };
  }
  if (matches.length > 1) {
    const slugs = matches.map((m) => m?.slug || m);
    return {
      error: `"${title}" matches ${matches.length} products (${slugs.join(', ')}) `
        + 'and this line does not say which',
      reason: 'ambiguous',
      candidates: slugs,
    };
  }
  return { error: `no product for "${title}"`, reason: 'missing' };
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
