/**
 * Whether the Studio shows the Sendcloud dispatch and returns UI.
 *
 * The Netlify functions read SHIPPING_ENABLED, which the Studio cannot see: it
 * is a separate bundle, built by `npx sanity deploy`. Sanity inlines any
 * SANITY_STUDIO_* variable at build time -- the exact expressions
 * `import.meta.env.SANITY_STUDIO_SHIPPING_ENABLED` and
 * `process.env.SANITY_STUDIO_SHIPPING_ENABLED` are replaced by its value --
 * so this one is set in studio/.env (SANITY_STUDIO_SHIPPING_ENABLED=true)
 * before deploying. It is a switch, not a secret -- the Studio bundle is public.
 *
 * Both expressions are written out in full so the build can replace them. Do
 * not guard them with `typeof process` or `process.env &&`: those parts are
 * not replaced, `process` does not exist in the browser, and the flag would
 * always read off (the bug this replaces). The try blocks cover the cases
 * where an expression was not replaced (Node tests have no import.meta.env;
 * the browser has no `process`).
 *
 * Off (unset), the order form, desk and actions are exactly as before: the
 * shipment fields are hidden and the Shipping / Returns lists and the Create
 * return button are not there.
 */
function read() {
  try {
    if (import.meta.env.SANITY_STUDIO_SHIPPING_ENABLED === 'true') return true;
  } catch { /* not replaced, and no import.meta.env outside Vite */ }
  try {
    if (process.env.SANITY_STUDIO_SHIPPING_ENABLED === 'true') return true;
  } catch { /* not replaced, and no `process` in the browser */ }
  return false;
}
export const SHIPPING_UI = read();
