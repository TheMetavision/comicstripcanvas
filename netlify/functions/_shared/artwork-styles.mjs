/**
 * The two artwork styles a stock product can be sold in.
 *
 * A product's images[] and printFile ARE the Classic style -- there is no
 * classic object, because every product that existed before this feature is
 * already one and rewriting 292 documents to say so would be a migration with
 * nothing to gain. The second style lives in an optional `fullBleed` object
 * beside them, and a product without one simply has one style.
 *
 * Written down here rather than spelled out at each call site because six
 * things now agree on these two strings: the studio save, the renderer, the
 * re-render route, checkout, the webhook and the product page. Two of those
 * decide what gets printed.
 *
 * KEEP THE LABELS IN SYNC with ARTWORK_STYLES in src/data/products.ts -- the
 * front-end copy, bundled by a different toolchain, exactly as PRICES is
 * duplicated between catalog.mjs and products.ts for the same reason.
 */

export const CLASSIC = 'classic';
export const FULL_BLEED = 'fullBleed';

/** Every style, in the order they are offered. Classic is always first. */
export const STYLES = [CLASSIC, FULL_BLEED];

export const STYLE_LABEL = {
  [CLASSIC]: 'Classic cover',
  [FULL_BLEED]: 'Full bleed',
};

/** Anything off the wire has to be one of exactly these two. */
export const isStyle = (s) => STYLES.includes(s);

/**
 * A style off the wire, or Classic.
 *
 * Classic is the default everywhere and deliberately so: it is what every
 * existing cart line, Stripe session and order document means when it says
 * nothing at all, and it is the only style guaranteed to exist on a product.
 */
export const styleOr = (s, fallback = CLASSIC) => (isStyle(s) ? s : fallback);

/** The label a human reads, on an order line or in an email. */
export const styleLabel = (s) => STYLE_LABEL[styleOr(s)] || STYLE_LABEL[CLASSIC];

/**
 * Which style a template produces by default.
 *
 * A default, not a rule: the studio operator can override it, because the two
 * cover templates are how the two styles are DRAWN and the slot is where the
 * result is FILED, and those are not quite the same question -- a full-bleed
 * design can legitimately be the product's main image.
 */
export const styleForTemplate = (template) => (template === 'cover-fullbleed' ? FULL_BLEED : CLASSIC);

/* ------------------------------------------------------------ blob layout */
/*
 * studio/<id>/<style>/scene.json   the handoff studio-save writes
 * studio/<id>/<style>/print.png    the print master fulfilment works from
 * studio/<id>/<style>/print-prev.png   one rollback
 * studio/<id>/<style>/listing.jpg  the web image that went to Sanity
 *
 * The style segment is what lets one product hold two print masters. Before it
 * there was one path per product, so redrawing the second style would have
 * overwritten the first one's print file -- and a scene written while the other
 * style was still rendering would have been rendered twice, into the wrong slot.
 */
export const sceneKey = (id, style) => `studio/${id}/${styleOr(style)}/scene.json`;
export const printKey = (id, style) => `studio/${id}/${styleOr(style)}/print.png`;
export const prevPrintKey = (id, style) => `studio/${id}/${styleOr(style)}/print-prev.png`;
export const listingKey = (id, style) => `studio/${id}/${styleOr(style)}/listing.jpg`;

/*
 * Where these lived before the style segment existed. Read-only fallbacks:
 * nothing writes them any more, but every product rendered before this change
 * has its print master at the old path, and a save that was in flight when the
 * deploy landed has its scene there. A read that misses the new path and finds
 * the old one is a product from before, not a bug.
 */
export const legacySceneKey = (id) => `studio/${id}/scene.json`;
export const legacyPrintKey = (id) => `studio/${id}/print.png`;

/** The Sanity paths each style writes to, for the renderer and for a reader. */
export const IMAGE_FIELD = { [CLASSIC]: 'images', [FULL_BLEED]: 'fullBleed.listingImage' };
export const PRINT_FIELD = { [CLASSIC]: 'printFile', [FULL_BLEED]: 'fullBleed.printFile' };
