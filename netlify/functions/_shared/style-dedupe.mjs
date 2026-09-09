/**
 * Reusing a styled photograph across panels.
 *
 * The same picture dropped into several panels is one generation, not several.
 * On a twelve-panel strip that is the difference between 36 seconds and seven
 * minutes, and between one model call and twelve against a cap of sixteen.
 *
 * Both routes into styling need this: the upload path in personalise-save, and
 * the retry path in personalisation-style. It lives here rather than in either
 * of them because two copies of a rule about when NOT to spend money is two
 * chances for them to disagree.
 *
 * Deliberately not in style.mjs: that module talks to Gemini and knows nothing
 * about Sanity, and this is the opposite. The client is passed in so this file
 * stays free of connection config too.
 */

/**
 * Another panel holding the identical photograph, already styled.
 *
 * Only a row that is actually 'done' with a styledKey counts. Copying from a
 * row still in flight would point this panel at a blob that does not exist
 * yet, and copying from a failed one would spread the failure.
 *
 * @param {Array}  photos   the document's photos[]
 * @param {object} opts     { panel, sha256 } — the panel being filled
 * @returns {object|null}   the twin row, or null
 */
export function findStyledTwin(photos, { panel, sha256 }) {
  if (!sha256) return null;   // nothing to match on; never dedupe on undefined
  return (photos || []).find(
    (p) => p.sha256 === sha256 && p.panel !== panel && p.styleStatus === 'done' && p.styledKey
  ) || null;
}

/**
 * Point a panel at a twin's styled photograph and mark it done.
 *
 * No Gemini call and no cap increment: nothing was generated, so nothing is
 * charged. styledKeys is kept in step for the code still reading the flat
 * arrays, unset-then-append so a repeat cannot double-enter the same key.
 *
 * @param {object} sanity  a configured @sanity/client
 */
export async function adoptStyledTwin(sanity, id, panel, twin) {
  await sanity
    .patch(id)
    .set({
      [`photos[panel == "${panel}"].styledKey`]: twin.styledKey,
      [`photos[panel == "${panel}"].styleStatus`]: 'done',
      [`photos[panel == "${panel}"].styledWidth`]: twin.styledWidth ?? null,
      [`photos[panel == "${panel}"].styledHeight`]: twin.styledHeight ?? null,
      [`photos[panel == "${panel}"].styledAt`]: new Date().toISOString(),
    })
    .setIfMissing({ styledKeys: [] })
    .unset([`photos[panel == "${panel}"].styleError`, `styledKeys[@ == "${twin.styledKey}"]`])
    .append('styledKeys', [twin.styledKey])
    .commit();
}
