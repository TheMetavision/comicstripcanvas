import { createHash } from 'node:crypto';

/**
 * A scene's revision: a hash of its own bytes.
 *
 * One definition, because three things now compare it and they have to mean
 * the same number. The print cache names a finished file after it, the renderer
 * stamps it on the scene it has just written, and the sweep asks whether the
 * scene it is looking at is still that one. A blob etag would do for any single
 * pair of those, but a hash of the bytes cannot disagree with the bytes, and it
 * survives a copy between stores.
 *
 * Its own module, and server-only, because of node:crypto. It used to live in
 * order-print.mjs, which the Studio's Print Files panel also imports -- and a
 * browser bundle cannot contain node:crypto, so from 24 September 2026 every
 * `sanity build` failed and the deployed Studio silently stayed where it was.
 */
export const sceneRevOf = (raw) =>
  createHash('sha256').update(typeof raw === 'string' ? raw : String(raw)).digest('hex').slice(0, 16);
