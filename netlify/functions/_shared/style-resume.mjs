import {
  guardStore, readGlobal, visitorHasStyleBudget, BUSY_MESSAGE,
} from './spend-guard.mjs';

/**
 * Restarting photos the circuit breaker paused.
 *
 * A paused photo is stored, priced and waiting: the customer has done
 * everything asked of them and the shop simply is not spending right now. So
 * pausing is only half a feature -- something has to pick them up again, and it
 * has to happen without the customer doing anything.
 *
 * Two callers, deliberately:
 *
 *   the status poll   picks up a document the customer still has open, within
 *                     one poll of the counter resetting -- see
 *                     personalisation-status.mjs
 *   style-resume      the hourly sweep, for everyone who closed the tab
 *
 * Both come through here so there is one set of rules about when it is safe to
 * spend again, and both re-check every guard: the site-wide budget and the
 * visitor's own 24-hour budget. A resume is a new style call and is billed like
 * any other, so it cannot be allowed to walk past the limits that paused it.
 *
 * The paused -> pending patch carries ifRevisionId, so two resumes racing on
 * the same panel cannot both fire: the loser's patch is rejected and it leaves
 * the panel alone rather than buying a second generation.
 */

export const PAUSED = 'paused';

/** Rows this document has waiting on the breaker. */
export const pausedRows = (doc) =>
  (doc?.photos || []).filter((p) => p && p.styleStatus === PAUSED && p.rawKey);

/**
 * Mark one panel as waiting on the breaker.
 *
 * BUSY_MESSAGE goes into styleError rather than being invented by the builder,
 * so the Studio's per-panel row says the same thing the customer is reading.
 */
export async function pausePanel(sanity, id, panel) {
  await sanity
    .patch(id)
    .set({
      [`photos[panel == "${panel}"].styleStatus`]: PAUSED,
      [`photos[panel == "${panel}"].styleError`]: BUSY_MESSAGE,
      [`photos[panel == "${panel}"].pausedAt`]: new Date().toISOString(),
    })
    .commit();
}

/**
 * Restart one paused panel, if every guard still allows it.
 *
 * @returns {'resumed'|'no-budget'|'visitor-limited'|'raced'|'failed'}
 */
async function resumePanel({ sanity, store, doc, panel, origin, now }) {
  if (doc.guardKey && !(await visitorHasStyleBudget(store, doc.guardKey, now))) {
    console.warn(
      `style-resume: ${doc._id} ${panel} left paused — visitor ${doc.guardKey} has no 24h budget left`
    );
    return 'visitor-limited';
  }

  try {
    await sanity
      .patch(doc._id)
      .ifRevisionId(doc._rev)
      .set({ [`photos[panel == "${panel}"].styleStatus`]: 'pending' })
      .unset([`photos[panel == "${panel}"].styleError`, `photos[panel == "${panel}"].pausedAt`])
      .commit();
  } catch (err) {
    // A revision clash means somebody else got there first, which is the
    // outcome this guard exists to produce. Anything else is a real failure.
    console.warn(`style-resume: ${doc._id} ${panel} not claimed (${err.message})`);
    return 'raced';
  }

  try {
    const res = await fetch(`${origin}/api/style-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: doc._id, panel }),
    });
    if (!res.ok) {
      console.error(`style-resume: ${doc._id} ${panel} trigger returned ${res.status}`);
      return 'failed';
    }
  } catch (err) {
    console.error(`style-resume: ${doc._id} ${panel} trigger failed: ${err.message}`);
    return 'failed';
  }
  console.log(`style-resume: ${doc._id} ${panel} resumed after the breaker reset`);
  return 'resumed';
}

/**
 * Restart whatever this one document has paused.
 *
 * Called from the status poll, so it must be cheap when there is nothing to do:
 * a document with no paused rows reads no blobs at all.
 *
 * @returns {{ resumed: number, remaining: number }} — `remaining` is how many
 *          of this document's panels are still paused afterwards.
 */
export async function resumeDocument({ sanity, doc, origin, now = new Date(), store }) {
  const rows = pausedRows(doc);
  if (!rows.length) return { resumed: 0, remaining: 0 };

  const s = store || guardStore();
  const global = await readGlobal(s, now);
  if (global.tripped) return { resumed: 0, remaining: rows.length };

  let budget = global.remaining;
  let resumed = 0;
  // Re-read: the caller's copy may predate another resume, and _rev is what the
  // claim below is made against.
  let fresh = await sanity.fetch('*[_id == $id][0]{ _id, _rev, guardKey, photos }', { id: doc._id });
  for (const row of pausedRows(fresh)) {
    if (budget <= 0) break;
    const outcome = await resumePanel({ sanity, store: s, doc: fresh, panel: row.panel, origin, now });
    if (outcome === 'resumed') { resumed++; budget--; }
    if (outcome === 'visitor-limited') break;   // the whole document shares one visitor
    fresh = await sanity.fetch('*[_id == $id][0]{ _id, _rev, guardKey, photos }', { id: doc._id });
  }
  return { resumed, remaining: pausedRows(fresh).length };
}

/**
 * The sweep: everything paused anywhere, oldest first.
 *
 * Oldest first on purpose -- the customer who has been waiting longest is
 * served first, and a single large strip cannot starve everyone behind it
 * because the budget is spent panel by panel rather than document by document.
 *
 * @returns {{ documents, resumed, stillPaused, budget, tripped }}
 */
export async function resumeAllPaused({ sanity, origin, now = new Date(), store, max = 200 }) {
  const s = store || guardStore();
  const global = await readGlobal(s, now);
  const report = {
    documents: 0, resumed: 0, stillPaused: 0,
    budget: global.remaining, tripped: global.tripped, day: global.day,
  };
  if (global.tripped) {
    console.log(
      `style-resume: still over the daily limit (${global.calls}/${global.max}) — nothing resumed`
    );
    return report;
  }

  const docs = await sanity.fetch(
    `*[_type == "pendingPersonalisation" && count(photos[styleStatus == "paused"]) > 0]
       | order(createdAt asc) [0...$max]{ _id, _rev, guardKey, photos, createdAt }`,
    { max }
  );
  report.documents = docs.length;
  if (!docs.length) {
    console.log('style-resume: nothing is paused.');
    return report;
  }

  let budget = global.remaining;
  for (const doc of docs) {
    if (budget <= 0) {
      report.stillPaused += pausedRows(doc).length;
      continue;
    }
    const { resumed, remaining } = await resumeDocument({ sanity, doc, origin, now, store: s });
    report.resumed += resumed;
    report.stillPaused += remaining;
    budget -= resumed;
  }
  console.log(
    `style-resume: ${report.resumed} panel(s) resumed across ${report.documents} document(s), ` +
    `${report.stillPaused} still paused, ${Math.max(0, budget)} of today's budget left.`
  );
  return report;
}
