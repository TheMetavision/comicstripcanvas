/**
 * Which document actions each type gets. Plain JavaScript, with the action
 * components passed in, so tools/builder/guarded-publish-tests.mjs can check
 * the exact list the Studio will show.
 *
 *   order                   Publish is replaced by the guarded one
 *                           (../lib/guarded-publish.mjs). Everything else stays.
 *   pendingPersonalisation  Every field is read-only, so no draft of a build can
 *                           be made by editing. Publish, Duplicate and Restore
 *                           are removed as well, because each of them could
 *                           still create or publish a draft: Restore writes an
 *                           old revision into one, Duplicate makes a whole new
 *                           build, and Publish would put a stray draft over
 *                           what the server wrote. Discard stays, so a draft
 *                           that exists anyway can only be thrown away.
 *                           Approve / Hold / Re-render are added as before.
 */

export const BUILD_REMOVED = ['publish', 'duplicate', 'restore'];

export function resolveDocumentActions(prev, context, { OrderPublishAction, buildExtras = [] }) {
  if (context.schemaType === 'order') {
    return prev.map((a) => (a.action === 'publish' ? OrderPublishAction : a));
  }
  if (context.schemaType === 'pendingPersonalisation') {
    return [...prev.filter((a) => !BUILD_REMOVED.includes(a.action)), ...buildExtras];
  }
  return prev;
}
