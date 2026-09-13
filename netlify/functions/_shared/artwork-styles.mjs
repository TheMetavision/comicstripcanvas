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

/* ------------------------------------------------------------------ the fee */

/**
 * What "Customise this design" costs, in PENCE, when the product does not say.
 *
 * Every product predates the customiseFee field, so almost none of them carry
 * one and a page that waited for the field would offer the button and then
 * refuse the payment. The default is the answer to "what does it cost" for a
 * product nobody has priced individually; a number ON the product overrides it
 * and is how one ever gets priced differently.
 *
 * ONE source, used by the product page's label, by the endpoint that hands the
 * builder its price, and by checkout -- so what a customer is shown and what
 * they are charged come from the same line of code.
 */
export const CUSTOMISE_FEE_DEFAULT = 500;

/**
 * The fee to charge for a build, in pence.
 *
 * A product's own value wins when it is a whole number of pence above zero.
 * Anything else -- absent, null, a string, a fraction, zero, negative -- is not
 * a price, and the honest reading of "not a price" for a field nobody has
 * filled in is the default rather than a refusal. A value that is PRESENT and
 * nonsense is a different matter: that is somebody having typed something, and
 * the caller is told so it can refuse rather than guess.
 *
 * @returns {{ pence: number, source: 'product'|'default', bad: boolean }}
 */
export function resolveCustomiseFee(value) {
  if (value === undefined || value === null || value === '') {
    return { pence: CUSTOMISE_FEE_DEFAULT, source: 'default', bad: false };
  }
  const ok = typeof value === 'number' && Number.isInteger(value) && value > 0;
  return ok
    ? { pence: value, source: 'product', bad: false }
    : { pence: CUSTOMISE_FEE_DEFAULT, source: 'default', bad: true };
}

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

/*
 * The artwork itself, kept.
 *
 * The uploads a save arrives with are a transport buffer: retention sweeps them
 * a day later, and the renderer deletes them as soon as the print exists. That
 * was fine while the print master was the only thing anybody needed afterwards.
 * "Customise this design" needs the SOURCE artwork again, months later, to put
 * it back on a customer's screen with their own wording over it -- so the
 * renderer now keeps a copy of its own under the product's prefix, where
 * nothing sweeps it.
 *
 *   art/<panel>.<ext>      full resolution, what the print is composed from
 *   art-web/<panel>.png    <= ART_WEB_SIDE, what the builder and the draft use
 *
 * Two sizes because they are read by different things for different reasons: a
 * 20 MB transparent PNG is the right thing to print from and an absurd thing to
 * send to a phone, and the endpoint that serves the browser copy should not
 * have to resize anything at request time.
 */
export const ART_WEB_SIDE = 1600;
export const artKey = (id, style, panel, ext = 'png') =>
  `studio/${id}/${styleOr(style)}/art/${panel}.${ext}`;
export const artWebKey = (id, style, panel) =>
  `studio/${id}/${styleOr(style)}/art-web/${panel}.png`;
/** Is this key one of ours, rather than something a caller made up? */
export const isArtKey = (key) =>
  typeof key === 'string' && /^studio\/[A-Za-z0-9._-]{1,120}\/(classic|fullBleed)\/art\/[A-Za-z0-9_-]{1,40}\.[a-z0-9]{1,5}$/.test(key);

/** The Sanity paths each style writes to, for the renderer and for a reader. */
export const IMAGE_FIELD = { [CLASSIC]: 'images', [FULL_BLEED]: 'fullBleed.listingImage' };
export const PRINT_FIELD = { [CLASSIC]: 'printFile', [FULL_BLEED]: 'fullBleed.printFile' };
