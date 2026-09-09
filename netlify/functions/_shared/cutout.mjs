/**
 * Whether the cutout service is switched on for this deployment.
 *
 * Its own module, and deliberately a leaf one: personalisation-status needs
 * this answer, and importing it from style-photo-background would drag
 * @google/genai, sharp and 1.2 MB of style reference images into the status
 * function's bundle -- along with the included_files rules they need in
 * netlify.toml. A two-line predicate is not worth a bundle.
 *
 * Read at call time rather than at import: netlify dev and the Netlify UI can
 * both change the environment under a warm function.
 */
export const cutoutConfigured = () =>
  !!(process.env.CUTOUT_SERVICE_URL || '').trim() && !!(process.env.CUTOUT_TOKEN || '').trim();
