/**
 * Whether the Studio shows the Sendcloud dispatch and returns UI.
 *
 * The Netlify functions read SHIPPING_ENABLED, which the Studio cannot see:
 * it is a separate bundle, built by `npx sanity deploy`. Vite inlines any
 * SANITY_STUDIO_* variable at build time, so this one is set in studio/.env
 * (SANITY_STUDIO_SHIPPING_ENABLED=true) before deploying. It is a switch, not
 * a secret -- the Studio bundle is public.
 *
 * Off (unset), the order form, desk and actions are exactly as before: the
 * shipment fields are hidden and the Shipping / Returns lists and the Create
 * return button are not there.
 */
export const SHIPPING_UI = (typeof process !== 'undefined' && process.env
  && process.env.SANITY_STUDIO_SHIPPING_ENABLED === 'true') || false;
