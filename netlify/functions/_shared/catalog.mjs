// Shared catalogue constants for the Netlify Functions.
// Single source of truth for PRICES so checkout.mjs and personalise.mjs can
// never drift on what to charge. This is a helper module, not a function
// (it lives under _shared/ and the filename doesn't match the dir), so Netlify
// won't expose it as an endpoint — it's bundled into whichever function imports it.
//
// KEEP IN SYNC with PRICES in src/data/products.ts (the front-end copy, which
// is bundled by a different toolchain and so can't share this file directly).

// Price table (pounds), keyed by format → size.
export const PRICES = {
  poster: { small: 9.99, medium: 12.99, large: 16.99 },
  'canvas-standard': { small: 26.99, medium: 31.99, large: 44.99 },
  'canvas-gallery': { small: 28.99, medium: 33.99, large: 46.99 },
};
