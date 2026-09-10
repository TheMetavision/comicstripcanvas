/**
 * Where studio artwork lives between the browser and the renderer, and what a
 * key for it is allowed to look like.
 *
 * Three functions need to agree about this and none of them should import
 * another: studio-upload writes the parts and assembles them, studio-save is
 * handed the assembled key and must be able to tell a real one from a string
 * somebody typed, and retention sweeps whatever is left behind. So the shapes
 * live here.
 *
 * Layout inside the "studio" store:
 *
 *   studio/up-<32 hex>/parts/000   a chunk, in flight
 *   studio/up-<32 hex>/art.png     the assembled upload
 *   studio/<designId>/scene.json   a save waiting to be rendered
 *   studio/<designId>/print.png    the print master, and what everything else
 *                                  is derived from
 *
 * Uploads carry the up- prefix precisely so they cannot be confused with a
 * design id, which is either a fresh studio-<hex> or, when a product is being
 * redrawn, the product's own id from Sanity.
 */

export const STUDIO_STORE = 'studio';

/** The id shape studio-upload issues, and the only one anything here acts on. */
export const isUploadId = (s) => typeof s === 'string' && /^up-[0-9a-f]{32}$/.test(s);

/* Parts are fetched by name rather than by listing the prefix, so the index has
   to sort as a name too -- and an eventually-consistent list() that has not
   caught up cannot make a complete upload look incomplete. */
export const partKey = (id, i) => `studio/${id}/parts/${String(i).padStart(3, '0')}`;

/** The assembled upload. The extension is kept: dataUri reads the mime off it. */
export const artKey = (id, ext) => `studio/${id}/art${ext}`;

/**
 * The upload id inside a key, or null if that is not what this string is.
 *
 * A key arrives from the browser and names a blob the renderer will read and
 * print, so it is parsed rather than trusted -- a "key" of ../../something is
 * the whole reason this returns null instead of a boolean.
 */
export function uploadIdFromKey(key) {
  const m = /^studio\/(up-[0-9a-f]{32})\/art\.[A-Za-z0-9]{1,5}$/.exec(String(key || ''));
  return m ? m[1] : null;
}
