/**
 * The names and validators the two image edge functions need.
 *
 * Restated here rather than imported from netlify/functions/_shared/, for the
 * same reason print-download-keys.mjs is: those modules reach for node built-ins
 * and pull tables behind them, and an image route that 500s on a transitive
 * import in Deno is a worse failure than the headroom problem being fixed.
 *
 * Every one of these is asserted against its function-side original in
 * tools/builder/near-cap-tests.mjs, so they cannot drift quietly.
 */

/** Studio working blobs: scenes, artwork, print masters. */
export const STUDIO_STORE = 'studio';
/** A customer's photographs and the styled copies made from them. */
export const PHOTO_STORE = 'personalisation';

export const CLASSIC = 'classic';
export const FULL_BLEED = 'fullBleed';

export const isProductId = (s) =>
  typeof s === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(s) && !s.includes('..');
export const isPanelId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
export const isPersonalisationId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

/* The URL says "fullbleed"; the document field is "fullBleed". Accept either
   and anything a person might type, because this one is in a query string a
   human can see and will eventually edit by hand. Returns null for anything
   else, so an unknown style is a 404 rather than a silent Classic. */
export function readStyle(raw) {
  const v = String(raw || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (v === 'fullbleed') return FULL_BLEED;
  if (v === 'classic' || v === '') return CLASSIC;
  return null;
}

/** studio/<id>/<style>/art-web/<panel>.png — built, never taken from a caller. */
export const artWebPath = (id, style, panel) =>
  `studio/${id}/${style === FULL_BLEED ? FULL_BLEED : CLASSIC}/art-web/${panel}.png`;

/**
 * What the photo route will serve, whatever a document says.
 *
 * The key comes out of the personalisation document rather than the URL, so it
 * is not caller-controlled — but it is the only value there that names a blob,
 * and a route that will hand over any key in the store is one bad write away
 * from handing over the wrong customer's photograph.
 */
export const SERVABLE_PHOTO = /^personalisation\/pp-[0-9a-f]{32}\/[A-Za-z0-9._-]{1,60}\.(png|jpg|jpeg)$/;
