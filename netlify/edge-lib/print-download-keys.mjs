/**
 * The handful of names the download edge function needs from the print store.
 *
 * Why not import netlify/functions/_shared/order-print.mjs, which already has
 * them: that module reaches for node:crypto (the scene rev) and pulls in the
 * size and style tables behind it. An edge function runs on Deno, and a
 * download that 500s because a transitive import did not resolve is a worse
 * failure than the one this whole change is fixing. So the four things the
 * edge needs are stated here, dependency-free, and a test asserts they still
 * match the function side rather than trusting them to.
 */

/** Finished print files. Separate store from the studio's working blobs. */
export const PRINT_STORE = 'order-prints';

/** The note order-print-file writes when a job is started, polled or finished. */
export const stateKey = (orderId, lineKey) => `pending/${orderId}/${lineKey}.state`;

/** Order numbers and line keys, as the function validates them. */
export const isSafeId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(s) && !s.includes('..');

/**
 * What this route will serve, whatever a state note claims.
 *
 * The key comes out of a stored note rather than from the URL, so it is not
 * attacker-controlled today -- but it is the only value here that names a blob,
 * and a route that will hand over any key in the store is one bug away from
 * handing over the wrong one.
 */
export const SERVABLE = /^print\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.png$/;
