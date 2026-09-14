import { getStore } from '@netlify/blobs';

/**
 * Deleting a build, in the one order that does not leave litter.
 *
 * BLOBS FIRST, THEN THE DOCUMENT. That order is the whole reason this exists.
 * A blob is only reachable through the document that names it -- nothing else
 * points at it -- so deleting the document first and then failing on the blobs
 * leaves customer photographs in the store with nothing to find them by. Doing
 * it the other way round fails safe: the document survives, still names its
 * blobs, and the next run tries again.
 *
 * Three callers used to each remember that for themselves, and two of them had
 * forgotten -- the webhook's two delete paths took the document and left the
 * photographs. They were dead code, so nothing leaked from them in practice,
 * but "it was never called" is not a thing to rely on twice.
 *
 * TWO PREFIXES, and only these two: the customer's own photographs and the
 * renders made for them. Listing by prefix rather than reading keys off the
 * document is deliberate and load-bearing. A key written but never recorded
 * would otherwise be orphaned by the deletion -- and, more seriously, a
 * customised stock design carries artworkKeys pointing into the STUDIO store,
 * which is the shop's own artwork, shared by every customer who orders that
 * design and by the product page itself. Following those would delete a
 * product's artwork because one customer's build aged out. Nothing here looks
 * at them, and the prefix guard means nothing here can start to by accident.
 */

export const PHOTO_STORE = 'personalisation';
export const RENDER_STORE = 'renders';

/** The only id shape that ever had blobs under these prefixes. */
export const isBuildId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

/** Where a build's own bytes live, and nowhere else. */
export const buildPrefixes = (id) => [
  [PHOTO_STORE, `personalisation/${id}/`],
  [RENDER_STORE, `renders/${id}/`],
];

/** The two stores, built once, unless the caller has its own. */
export const defaultStores = () => ({
  [PHOTO_STORE]: getStore(PHOTO_STORE),
  [RENDER_STORE]: getStore(RENDER_STORE),
});

/**
 * Every blob belonging to this build.
 *
 * A legacy id never had blobs under these prefixes, so it is answered without
 * asking the store anything.
 */
export async function listBuildBlobs(id, stores) {
  const keys = [];
  if (!isBuildId(id)) return keys;
  for (const [store, prefix] of buildPrefixes(id)) {
    const { blobs } = await stores[store].list({ prefix });
    for (const b of blobs) {
      // Belt and braces; list() already scopes to the prefix.
      if (!b.key.startsWith(prefix)) continue;
      keys.push({ store, key: b.key });
    }
  }
  return keys;
}

/**
 * Delete a build and everything that belongs to it.
 *
 * Safe to run against a build whose blobs are already gone -- the listing comes
 * back empty and the document is still removed -- and safe to run twice, since
 * deleting an absent blob or document is not an error in either store.
 *
 * Throws if the blob listing or a blob delete fails, DELIBERATELY and before
 * the document is touched, so the caller can leave the record in place and try
 * again. Every caller treats a throw as "leave it for the next run".
 *
 * @param {string} id
 * @param {object} opts
 * @param {object} opts.sanity          a client with .delete()
 * @param {object} [opts.stores]        { personalisation, renders }
 * @param {boolean} [opts.dryRun]       list what would go, delete nothing
 * @returns {Promise<{ id, blobs: string[], deleted: boolean }>}
 */
export async function deleteBuild(id, { sanity, stores, dryRun = false } = {}) {
  if (!sanity) throw new Error('deleteBuild needs a sanity client');
  const s = stores || defaultStores();

  const keys = await listBuildBlobs(id, s);
  const blobs = keys.map((k) => k.key);
  if (dryRun) return { id, blobs, deleted: false };

  for (const { store, key } of keys) await s[store].delete(key);
  await sanity.delete(id);
  return { id, blobs, deleted: true };
}
