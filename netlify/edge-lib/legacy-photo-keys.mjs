/**
 * Customer photos from the old upload flow, moved out of Sanity.
 *
 * Before the builder stored photos in Blobs, the legacy flow uploaded them as
 * Sanity image assets and kept their cdn.sanity.io URLs on the
 * pendingPersonalisation and on the order (personalisationDetails.uploadedImages).
 * Those URLs were public, and so is the asset list itself: anyone could
 * enumerate every image in the dataset. tools/migrate-private-personalisation.mjs
 * copied each one here, verified the copy, re-pointed the documents at
 * legacyPhotoUrl() and deleted the Sanity asset.
 *
 * Keys are content-addressed (sha256 of the bytes), so a key never names a
 * customer and a copy can be checked against its own name.
 */

/** Its own store: nothing else lists, sweeps or overwrites it. */
export const LEGACY_PHOTO_STORE = 'legacy-customer-photos';

export const LEGACY_PHOTO_KEY = /^[a-f0-9]{64}\.(jpg|jpeg|png|webp|gif)$/;

export const CONTENT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};

export const LEGACY_PHOTO_PATH = '/admin/api/legacy-photo/';

/** The admin-only URL the documents hold instead of the old public one. */
export const legacyPhotoUrl = (site, key) => `${String(site).replace(/\/+$/, '')}${LEGACY_PHOTO_PATH}${key}`;
