import { createClient } from '@sanity/client';
import { MAX_STYLE_CALLS } from './_shared/style.mjs';
import { findStyledTwin, adoptStyledTwin } from './_shared/style-dedupe.mjs';
import {
  guardStore, visitorKey, readVisitor, readGlobal, originOr, busyMessageFor,
  familyForTemplate,
} from './_shared/spend-guard.mjs';
import { pausePanel, limitPanel } from './_shared/style-resume.mjs';
import { notifyStyleLimit } from './_shared/limit-email.mjs';
import { internalOrigin } from './_shared/origin.mjs';

/**
 * Re-style one panel:
 *   POST /api/personalisation-style/<id>/<panel>?retry=1
 *
 * Used by the builder's per-panel retry, and later by a Studio action. It only
 * re-triggers the background function; the work, the cap accounting and the
 * status writes all stay in one place there.
 *
 * Same guards as personalisation-proof: the unguessable id is the access
 * control, and anything not shaped like a pp- id is refused before Sanity is
 * touched. Note this endpoint SPENDS MONEY, so it refuses a panel that is
 * already styling (a double tap must not buy two generations), refuses one
 * that is already done unless retry=1 is explicit, and takes the sha256
 * dedupe first -- a retry of a photograph already styled elsewhere in the
 * document costs nothing at all.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);
const isPanel = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s);

const PRIVATE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex',
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: PRIVATE });
const notFound = () => reply({ error: 'Not found' }, 404);

export default async (req, context) => {
  if (req.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);

  const { pathname, searchParams } = new URL(req.url);
  const segs = pathname.split('/').filter(Boolean);
  let id = null, panel = null;
  if (segs.length >= 2 && isId(segs[segs.length - 2]) && isPanel(segs[segs.length - 1])) {
    id = segs[segs.length - 2];
    panel = segs[segs.length - 1];
  } else if (isId(searchParams.get('id')) && isPanel(searchParams.get('panel'))) {
    id = searchParams.get('id');
    panel = searchParams.get('panel');
  }
  if (!id || !panel) {
    console.log(`personalisation-style: refusing "${pathname}" — not a well-formed id/panel pair`);
    return notFound();
  }
  const retry = searchParams.get('retry') === '1';

  try {
    const doc = await sanity.fetch(
      '*[_id == $id][0]{ photos, styleCalls, guardKey, origin, templateId }', { id });
    if (!doc) return notFound();
    const row = (doc.photos || []).find((p) => p.panel === panel);
    if (!row || !row.rawKey) return notFound();

    if (row.styleStatus === 'styling') {
      return reply({ id, panel, triggered: false, reason: 'already styling' }, 409);
    }
    if (row.styleStatus === 'done' && !retry) {
      return reply({ id, panel, triggered: false, reason: 'already styled; pass retry=1 to redo' }, 409);
    }

    /* Dedupe, exactly as the upload path does it -- retrying a panel whose
       photograph is already styled on another panel should cost nothing.
       Checked BEFORE the cap so a personalisation that has spent its budget can
       still finish any panel sharing a photo with one that succeeded.

       Skipped when this panel is already done, which can only be reached with
       retry=1: that is someone deliberately asking for a fresh generation
       because they did not like this one, and handing back the twin's copy --
       almost certainly the very image they are rejecting, since a shared
       photograph already shares one styledKey -- would silently refuse them. */
    if (row.styleStatus !== 'done') {
      const twin = findStyledTwin(doc.photos, { panel, sha256: row.sha256 });
      if (twin) {
        await adoptStyledTwin(sanity, id, panel, twin);
        console.log(`personalisation-style: dedupe hit — ${id} ${panel} reused the styled photo from ${twin.panel} (same sha256), no model call`);
        return reply({ id, panel, triggered: false, deduped: true, from: twin.panel });
      }
    }

    /* The same counters the upload path checks, because this is the same
       money. Checked AFTER the dedupe above -- a retry that costs nothing
       should not be refused for budget -- and before the per-design cap, which
       has its own answer to give.

       The DOCUMENT's key is preferred over this request's, so the counter that
       is checked is the counter style-photo-background will bill: a retry from
       a different address must not spend against a budget nobody is watching. */
    const store = guardStore();
    const gkey = doc.guardKey || visitorKey(req, context);
    const family = familyForTemplate(doc.templateId);
    const spent = await readVisitor(store, gkey, { templateId: doc.templateId });
    if (spent.styleCalls24h >= spent.limit) {
      /* 200 and a notice, not a 429 and an error. The request was understood
         and acted on: the panel now records that this customer is out of
         attempts for today, and the answer says what they can do about it.
         Their photograph and their build are untouched. */
      const notice = await limitPanel(sanity, id, panel, doc.templateId);
      /* One claim per visitor per day covers all three of the places that can
         notice this, so tapping Replace repeatedly is quiet after the first. */
      await notifyStyleLimit({
        store, key: gkey, buildId: id, templateId: doc.templateId, calls: spent.styleCalls24h,
      });
      console.warn(
        `spend-guard: ${id} ${panel} from ${gkey} is out of ${family} attempts ` +
        `(${spent.styleCalls24h}/${spent.limit} in 24h)`
      );
      return reply({
        id, panel, triggered: false, reason: `visitor-style-limit-${family}`,
        limited: true, notice, error: notice.text,
      });
    }

    /* The document's budget, for the same reason its guardKey is preferred
       over this request's: a retry spends what the build spends. */
    const spendOrigin = originOr(doc.origin);
    const breaker = await readGlobal(store, new Date(), spendOrigin);
    if (breaker.tripped) {
      await pausePanel(sanity, id, panel, spendOrigin);
      console.warn(
        `spend-guard: paused a retry of ${id} ${panel} — the ${spendOrigin} daily limit ` +
        `is reached (${breaker.calls}/${breaker.max} today)`
      );
      /* 200, not an error: the request was understood and acted on. The panel
         is now waiting on the breaker, the poll will report it as paused, and
         style-resume will finish the job without anyone asking again. */
      return reply({ id, panel, triggered: false, paused: true, message: busyMessageFor(spendOrigin) });
    }

    if ((doc.styleCalls || 0) >= MAX_STYLE_CALLS) {
      /* Refusing must not destroy a good result. This used to mark the panel
         failed unconditionally, so asking to redo an ALREADY-DONE panel once
         the budget was spent downgraded it to failed while its styledKey sat
         there intact -- and the render job then refused the whole build for a
         panel whose styled photograph existed all along. Only a panel that had
         nothing to lose is marked. */
      if (row.styleStatus !== 'done') {
        await sanity
          .patch(id)
          .set({
            [`photos[panel == "${panel}"].styleStatus`]: 'failed',
            [`photos[panel == "${panel}"].styleError`]: 'cap',
          })
          .commit();
      }
      console.warn(
        `personalisation-style: ${id} ${panel} refused — ${MAX_STYLE_CALLS} calls already used` +
        (row.styleStatus === 'done' ? ' (left as done; the existing result stands)' : '')
      );
      return reply({
        id, panel, triggered: false, reason: 'cap',
        styleCalls: doc.styleCalls, keptExisting: row.styleStatus === 'done',
      }, 429);
    }

    // Put it back to pending before firing, so a poll between the two sees an
    // honest state rather than the previous 'failed'.
    await sanity
      .patch(id)
      .set({ [`photos[panel == "${panel}"].styleStatus`]: 'pending' })
      .unset([`photos[panel == "${panel}"].styleError`])
      .commit();

    const origin = internalOrigin(req);
    const res = await fetch(`${origin}/api/style-photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, panel }),
    });
    if (!res.ok) {
      console.error(`personalisation-style: trigger for ${id} ${panel} returned ${res.status}`);
      return reply({ id, panel, triggered: false, reason: `trigger returned ${res.status}` }, 502);
    }
    console.log(`personalisation-style: re-styling ${id} ${panel}${retry ? ' (retry)' : ''}`);
    return reply({ id, panel, triggered: true });
  } catch (err) {
    console.error(`personalisation-style: ${id} ${panel} failed:`, err.message);
    return reply({ error: 'Could not trigger styling' }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }` here — routed by the
// forced /api/* rewrite in netlify.toml. An inline config.path collides with it.
