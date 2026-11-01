/**
 * Comic Strip Canvas's non-secret settings, committed instead of held as
 * Netlify environment variables.
 *
 * WHY. Every variable scoped to Functions is copied into every function, and
 * AWS Lambda refuses a function whose environment is over 4 KB. A deploy
 * failed on exactly that, and only passed once three variables were deleted.
 * A brand colour, a group id or a public URL costs the same bytes as a secret
 * but protects nothing, so they live here and only secrets stay in Netlify.
 *
 * OVERRIDES. Each key is the name of the environment variable it replaced. If
 * that variable is set (non-empty), it still wins, so a value can be changed
 * for one deploy context without a commit. Unset is the normal state.
 *
 * NOTHING SECRET GOES IN THIS FILE. It is in a public repository's history for
 * ever. Tokens, API keys and webhook secrets stay in Netlify.
 */

export const SITE_CONFIG = Object.freeze({
  SITE_URL: 'https://comicstripcanvas.co.uk',

  // Sanity: the same project and dataset src/lib/sanity.ts hardcodes.
  SANITY_PROJECT_ID: 'lwbwahym',
  SANITY_DATASET: 'production',

  // The contact form's emails (contact.mts).
  BRAND_NAME: 'Comic Strip Canvas',
  BRAND_ACCENT: '#F00060',
  EMAIL_HEADER_BG: '#000000',
  LOGO_URL: 'https://cdn.sanity.io/images/lwbwahym/production/d3b36041ed3eb60d6ef9e6a6353c30ab79363be4-440x440.png',
  NOTIFICATION_FROM: 'Comic Strip Canvas <contact@comicstripcanvas.co.uk>',
  // Contact-form messages. Deliberately NOT the same inbox as TEAM_EMAIL.
  NOTIFICATION_TO: 'contact@comicstripcanvas.co.uk',

  // Order, approval, shipping and alert emails to the team.
  TEAM_EMAIL: 'hello@comicstripcanvas.co.uk',

  // MailerLite: newsletter subscribers, and customers after dispatch.
  MAILERLITE_GROUP_ID: '185267369617131462',
  MAILERLITE_CUSTOMERS_GROUP_ID: '200032151549249509',

  // GA4 Measurement Protocol. The id is public (it is in every page's gtag);
  // GA4_API_SECRET is the secret half and stays in Netlify.
  GA4_MEASUREMENT_ID: 'G-LH10709LC0',

  // The metavision-shipping service. Every call is HMAC-signed with
  // SHIPPING_SECRET, which stays in Netlify.
  SHIPPING_API_URL: 'https://mv-shipping-svc-26.netlify.app',
  SHIPPING_BRAND: 'CSC',

  // Where each carrier's returns are collected from. For the team's "ready to
  // collect" email only; never sent to a customer.
  RETURN_POINT_INPOST: 'InPost locker, 59 West Road, Shoeburyness',
  RETURN_POINT_EVRI: 'ASDA Shoebury, North Shoebury Road',
  RETURN_POINT_UPS: 'Skanda, 93-95 West Road, Shoeburyness',
});

/**
 * A setting: the environment variable of the same name if it is set, else the
 * committed value.
 *
 * @param {keyof typeof SITE_CONFIG} name
 * @param {Record<string, string|undefined>} [env] defaults to process.env; tests pass their own
 */
export function setting(name, env = process.env) {
  if (!(name in SITE_CONFIG)) throw new Error(`site-config: unknown setting ${name}`);
  const v = env?.[name];
  return typeof v === 'string' && v.trim() ? v.trim() : SITE_CONFIG[name];
}
