/**
 * Build refs vs. pendingPersonalisation document ids.
 *
 * A build is known everywhere outside Sanity by its ref, pp-<32 hex>: the
 * builder, the basket, Stripe metadata, order line items, emails, admin URLs
 * and every Netlify Blobs key (personalisation/<ref>/..., renders/<ref>/...).
 *
 * Its Sanity document lives at pendingPersonalisation.<ref>. Documents whose
 * _id contains a "." are not returned to anonymous API reads, and these hold
 * customer photos' keys, notes and the approve token. So every Sanity call
 * goes through docIdFor(), and any _id read back is turned into a ref with
 * refOf() before it is used as one. Same approach as the order and
 * contactSubmission ids (tools/migrate-private-ids.mjs).
 */

export const PP_DOC_PREFIX = 'pendingPersonalisation.';

/** A build ref as the builder, basket and URLs carry it. */
export const isBuildRef = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

/** The Sanity _id for a build ref. */
export const docIdFor = (ref) => `${PP_DOC_PREFIX}${ref}`;

/** The build ref for a pendingPersonalisation _id (a bare ref passes through). */
export const refOf = (id) =>
  typeof id === 'string' && id.startsWith(PP_DOC_PREFIX) ? id.slice(PP_DOC_PREFIX.length) : id;

/** The Sanity _id for either form -- for shared helpers called with both. */
export const asDocId = (refOrId) => docIdFor(refOf(refOrId));
