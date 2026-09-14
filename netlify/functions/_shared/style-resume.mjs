import {
  guardStore, readGlobal, visitorHasStyleBudget, busyMessageFor, originOr, ORIGINS,
  styleLimitNotice, familyForTemplate,
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

/**
 * Out of style attempts for today.
 *
 * A SEPARATE state from PAUSED, and the difference is the whole reason it
 * exists: a paused panel is waiting on the shop and comes back by itself the
 * moment the site-wide breaker clears, so the sweep below picks it up and the
 * customer need do nothing. A limited panel is waiting on the CUSTOMER's own
 * daily allowance, and nothing here restarts it -- their allowance refills
 * gradually over the next twenty-four hours and they choose whether to come
 * back or to send the photograph to the artwork team instead.
 *
 * Resuming one automatically would spend an allowance they have not been given
 * back yet and would do it without asking, so pausedRows deliberately does not
 * match these and the sweep never sees them.
 */
export const LIMITED = 'limited';

/** Rows this document has waiting on the breaker. */
export const pausedRows = (doc) =>
  (doc?.photos || []).filter((p) => p && p.styleStatus === PAUSED && p.rawKey);

/**
 * Mark one panel as waiting on its budget.
 *
 * The message goes into styleError rather than being invented by the builder,
 * so the Studio's per-panel row says the same thing the customer is reading --
 * and which message it is depends on which budget ran out, because "we're
 * unusually busy" is true for a customer and useless to whoever has to decide
 * whether to raise the ceiling.
 */
export async function pausePanel(sanity, id, panel, spendOrigin) {
  await sanity
    .patch(id)
    .set({
      [`photos[panel == "${panel}"].styleStatus`]: PAUSED,
      [`photos[panel == "${panel}"].styleError`]: busyMessageFor(spendOrigin),
      [`photos[panel == "${panel}"].pausedAt`]: new Date().toISOString(),
    })
    .commit();
}

/**
 * Mark one panel as out of attempts for today.
 *
 * Everything the customer has done survives: the photograph is already stored,
 * the document is already written, and this only records that the last step did
 * not happen. Coming back tomorrow and asking again is all that is needed.
 *
 * The wording and the link come from the server, exactly as the paused message
 * does, so the panel, the Studio row and the status poll cannot drift apart.
 */
export async function limitPanel(sanity, id, panel, templateId) {
  const notice = styleLimitNotice(id, familyForTemplate(templateId));
  await sanity
    .patch(id)
    .set({
      [`photos[panel == "${panel}"].styleStatus`]: LIMITED,
      [`photos[panel == "${panel}"].styleError`]: notice.text,
      [`photos[panel == "${panel}"].limitedAt`]: new Date().toISOString(),
    })
    .commit();
  return notice;
}

/**
 * Restart one paused panel, if every guard still allows it.
 *
 * @returns {'resumed'|'no-budget'|'visitor-limited'|'raced'|'failed'}
 */
async function resumePanel({ sanity, store, doc, panel, origin, now }) {
  /* The visitor's allowance for THIS document's family. Asking the wrong one
     would either stall a strip because its owner is out of cover attempts, or
     spend a cover allowance that is already gone. */
  if (doc.guardKey && !(await visitorHasStyleBudget(store, doc.guardKey, now, doc.templateId))) {
    console.warn(
      `style-resume: ${doc._id} ${panel} left paused — visitor ${doc.guardKey} has no `
      + `${familyForTemplate(doc.templateId)} attempts left`
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

  /* `origin` is the site URL -- it is what the trigger is POSTed to. The budget
     this document spends from is `spendOrigin`, off the document itself. Two
     unrelated meanings of the same word, and only one of them can keep it. */
  const spendOrigin = originOr(doc.origin);
  const s = store || guardStore();
  const global = await readGlobal(s, now, spendOrigin);
  if (global.tripped) return { resumed: 0, remaining: rows.length };

  let budget = global.remaining;
  let resumed = 0;
  // Re-read: the caller's copy may predate another resume, and _rev is what the
  // claim below is made against.
  let fresh = await sanity.fetch(
    '*[_id == $id][0]{ _id, _rev, guardKey, origin, templateId, photos }', { id: doc._id });
  for (const row of pausedRows(fresh)) {
    if (budget <= 0) break;
    const outcome = await resumePanel({ sanity, store: s, doc: fresh, panel: row.panel, origin, now });
    if (outcome === 'resumed') { resumed++; budget--; }
    if (outcome === 'visitor-limited') break;   // the whole document shares one visitor
    fresh = await sanity.fetch(
      '*[_id == $id][0]{ _id, _rev, guardKey, origin, templateId, photos }', { id: doc._id });
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
  /* A budget per origin, read once and spent down independently. Sharing one
     number here would undo the whole point of separating the counters: a studio
     batch still waiting would eat the allowance customers are queued against. */
  const globals = {};
  for (const o of ORIGINS) globals[o] = await readGlobal(s, now, o);
  const report = {
    documents: 0, resumed: 0, stillPaused: 0,
    budgets: Object.fromEntries(ORIGINS.map((o) => [o, globals[o].remaining])),
    tripped: Object.fromEntries(ORIGINS.map((o) => [o, globals[o].tripped])),
    day: globals.customer.day,
  };
  if (ORIGINS.every((o) => globals[o].tripped)) {
    console.log(
      'style-resume: every budget is spent — nothing resumed ('
      + ORIGINS.map((o) => `${o} ${globals[o].calls}/${globals[o].max}`).join(', ') + ')'
    );
    return report;
  }

  const docs = await sanity.fetch(
    `*[_type == "pendingPersonalisation" && count(photos[styleStatus == "paused"]) > 0]
       | order(createdAt asc) [0...$max]{ _id, _rev, guardKey, origin, templateId, photos, createdAt }`,
    { max }
  );
  report.documents = docs.length;
  if (!docs.length) {
    console.log('style-resume: nothing is paused.');
    return report;
  }

  const budget = { ...report.budgets };
  for (const doc of docs) {
    const spendOrigin = originOr(doc.origin);
    if (budget[spendOrigin] <= 0) {
      report.stillPaused += pausedRows(doc).length;
      continue;
    }
    const { resumed, remaining } = await resumeDocument({ sanity, doc, origin, now, store: s });
    report.resumed += resumed;
    report.stillPaused += remaining;
    budget[spendOrigin] -= resumed;
  }
  console.log(
    `style-resume: ${report.resumed} panel(s) resumed across ${report.documents} document(s), `
    + `${report.stillPaused} still paused, `
    + ORIGINS.map((o) => `${Math.max(0, budget[o])} ${o}`).join(' and ')
    + " of today's budget left."
  );
  return report;
}
