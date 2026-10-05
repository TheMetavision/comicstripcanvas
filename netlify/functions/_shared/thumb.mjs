/**
 * The basket thumbnail, and what happens to it when we edit a build.
 *
 * The builder snapshots its live preview on Add to basket and stores it at
 * personalisation/<id>/thumb.jpg (personalise-save.mjs). Everything that shows
 * "this build" outside the proof reads that one key through
 * /api/personalisation-thumb/<id> -- so after an admin edit it has to be
 * replaced, or the basket and the order line keep picturing a design that no
 * longer exists.
 *
 * Replaced, but never lost: the customer's own snapshot is copied to
 * thumb-original.jpg first, for the same two reasons customerOriginal and
 * proof-customer.png are kept. Both keys sit under personalisation/<id>/, so the
 * retention sweep, which lists that prefix, collects them with the photos.
 */

export const PHOTO_STORE = 'personalisation';
export const thumbKey = (id) => `personalisation/${id}/thumb.jpg`;
export const originalThumbKey = (id) => `personalisation/${id}/thumb-original.jpg`;

/* The builder's own numbers (product-builder.js, THUMB_MAX_SIDE and
   THUMB_QUALITY), so an edited build's thumbnail is the same size and weight as
   one the customer made. */
export const THUMB_MAX_SIDE = 600;
export const THUMB_QUALITY = 80;

/**
 * Copy the customer's thumbnail aside, unless a copy is already there.
 *
 * "Unless already there" rather than "on the first edit": a build first edited
 * before thumbnails were regenerated still has the customer's own picture at
 * thumb.jpg, and this is what keeps it. It cannot copy one of ours by mistake,
 * because the renderer only ever replaces thumb.jpg once this copy exists.
 *
 * @returns {Promise<'kept'|'already'|'none'>}
 */
export async function keepOriginalThumb(store, id, keptAt) {
  if (await store.getMetadata(originalThumbKey(id))) return 'already';
  const was = await store.get(thumbKey(id), { type: 'arrayBuffer' });
  if (!was) return 'none';
  await store.set(originalThumbKey(id), was, {
    metadata: {
      contentType: 'image/jpeg',
      role: 'basket-thumb-original',
      // uploadedAt, as on every blob here: the orphan sweep ages blobs by it.
      uploadedAt: keptAt,
    },
  });
  return 'kept';
}

/**
 * Replace thumb.jpg with one made from the new proof, for a build we edited.
 * `jpeg` is already encoded: sharp is the renderer's to import, because this
 * module is also loaded by edit-save, which has no native modules.
 *
 * Never overwrites the customer's snapshot unless a copy of it is safe at
 * thumb-original.jpg: it makes that copy itself if edit-save could not, and if
 * the copy fails it throws before thumb.jpg is touched. A build with no
 * snapshot at all (the builder's is best-effort) simply gets one.
 *
 * @returns {Promise<'replaced'|'created'>}
 */
export async function replaceThumb(store, id, jpeg, at) {
  const kept = await keepOriginalThumb(store, id, at);
  await store.set(thumbKey(id), jpeg, {
    metadata: {
      contentType: 'image/jpeg',
      role: 'basket-thumb',
      source: 'admin-edit',
      uploadedAt: at,
    },
  });
  return kept === 'none' ? 'created' : 'replaced';
}
