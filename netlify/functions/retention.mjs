import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';

/**
 * Photo retention. Runs daily (schedule lives in netlify.toml).
 *
 * Customer photographs should not sit in the blob store forever. Two rules:
 *
 *   dispatched  90 days after the linked order was dispatched
 *   abandoned   30 days after creation, if still draft or awaiting_payment
 *
 * Everything mid-flight is untouchable regardless of age -- see PROTECTED. A
 * job someone is still working on must never be collected out from under them,
 * so age alone is never sufficient.
 *
 * NOTE ON "dispatchedAt": there is no such field. The order schema has no
 * dispatch timestamp at all; the closest thing is shippingEmailSentAt, set by
 * order-shipped.mjs when the dispatch email goes out, and it is populated on
 * every dispatched order in the dataset. So that is what the 90 days run from.
 * The failure mode is safe: an order dispatched but whose email never sent has
 * no timestamp, so it is kept rather than deleted early.
 *
 * Deleting is irreversible, so the default posture throughout is to keep. An
 * unrecognised status is kept. A missing timestamp is kept. A blob listing that
 * errors aborts that document and leaves its Sanity record alone, so the next
 * run retries rather than orphaning blobs behind a deleted document.
 */

const PHOTO_STORE = 'personalisation';
const RENDER_STORE = 'renders';

const DISPATCHED_RETENTION_DAYS = 90;
const ABANDONED_RETENTION_DAYS = 30;

/** Live work, or work a human is holding. Never collected, at any age. */
const PROTECTED = new Set([
  'paid', 'preparing', 'rendered', 'approved', 'in_production', 'on_hold',
]);

/** Never paid for. Collected once cold. */
const ABANDONED = new Set(['draft', 'awaiting_payment']);

const DAY = 24 * 60 * 60 * 1000;
const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

const QUERY = `*[_type == "pendingPersonalisation"]{
  _id,
  _createdAt,
  status,
  orderId,
  "orderStatus": *[_type == "order" && _id == ^.orderId][0].status,
  "orderDispatchedAt": *[_type == "order" && _id == ^.orderId][0].shippingEmailSentAt
}`;

function defaultSanity() {
  return createClient({
    projectId: 'lwbwahym',
    dataset: 'production',
    apiVersion: '2026-04-11',
    token: process.env.SANITY_WRITE_TOKEN,
    useCdn: false,
  });
}

/**
 * Decide one document's fate. Pure, so the rules can be reasoned about and
 * tested without a dataset behind them.
 */
export function classify(doc, now) {
  const status = doc.status ?? null;

  if (PROTECTED.has(status)) {
    return { verdict: 'keep', reason: `protected status "${status}"` };
  }

  const dispatchedAt = doc.orderDispatchedAt ? Date.parse(doc.orderDispatchedAt) : NaN;
  if (doc.orderId && Number.isFinite(dispatchedAt)) {
    const age = Math.floor((now - dispatchedAt) / DAY);
    if (age >= DISPATCHED_RETENTION_DAYS) {
      return { verdict: 'delete', reason: `dispatched ${age} days ago`, rule: 'dispatched-90d', age };
    }
    return { verdict: 'keep', reason: `dispatched ${age} days ago, under ${DISPATCHED_RETENTION_DAYS}` };
  }

  if (ABANDONED.has(status)) {
    const age = Math.floor((now - Date.parse(doc._createdAt)) / DAY);
    if (age >= ABANDONED_RETENTION_DAYS) {
      return { verdict: 'delete', reason: `"${status}" for ${age} days`, rule: 'abandoned-30d', age };
    }
    return { verdict: 'keep', reason: `"${status}" for ${age} days, under ${ABANDONED_RETENTION_DAYS}` };
  }

  // Anything else -- an unrecognised or absent status, or a dispatched order
  // with no timestamp -- is kept. Keeping costs storage; deleting costs a
  // customer's photographs.
  return { verdict: 'keep', reason: `no rule matches (status ${JSON.stringify(status)})` };
}

/**
 * @param {object}  opts
 * @param {boolean} opts.dryRun  report what would go, delete nothing
 * @param {Date}    opts.now     injectable for testing
 * @param {object}  opts.deps    { sanity, stores } -- injectable so a dry run
 *                               can be driven from outside a Netlify context
 */
export async function runRetention({ dryRun = false, now = new Date(), deps = {} } = {}) {
  const sanity = deps.sanity || defaultSanity();
  const nowMs = now.getTime();

  const docs = await sanity.fetch(QUERY);
  const decisions = docs.map((doc) => ({ doc, ...classify(doc, nowMs) }));
  const doomed = decisions.filter((d) => d.verdict === 'delete');

  const label = dryRun ? 'retention (DRY RUN)' : 'retention';
  console.log(
    `${label}: ${docs.length} personalisation document(s) examined, ` +
    `${doomed.length} past retention, ${docs.length - doomed.length} kept.`
  );

  const report = { dryRun, examined: docs.length, deleted: [], blobsDeleted: 0, errors: [] };
  if (!doomed.length) {
    console.log(`${label}: nothing to delete.`);
    return report;
  }

  // Only reached when there is work, so a run with nothing to do never needs a
  // blob context at all -- which is what lets the dry run be driven locally.
  const stores = deps.stores || {
    [PHOTO_STORE]: getStore(PHOTO_STORE),
    [RENDER_STORE]: getStore(RENDER_STORE),
  };

  for (const { doc, reason, rule } of doomed) {
    const id = doc._id;
    try {
      // List rather than trusting photoKeys: a key that was written but never
      // recorded would otherwise be orphaned by the document's deletion.
      const keys = [];
      for (const [store, prefix] of [
        [PHOTO_STORE, `personalisation/${id}/`],
        [RENDER_STORE, `renders/${id}/`],
      ]) {
        if (!isId(id)) continue;   // legacy ids never had blobs under these prefixes
        const { blobs } = await stores[store].list({ prefix });
        for (const b of blobs) keys.push({ store, key: b.key });
      }

      if (dryRun) {
        console.log(`${label}: would delete ${id} (${rule}: ${reason}) and ${keys.length} blob(s)` +
          (keys.length ? ` -- ${keys.map((k) => k.key).join(', ')}` : ''));
      } else {
        for (const { store, key } of keys) await stores[store].delete(key);
        await sanity.delete(id);
        console.log(`retention: deleted ${id} (${rule}: ${reason}) and ${keys.length} blob(s)` +
          (keys.length ? ` -- ${keys.map((k) => k.key).join(', ')}` : ''));
      }

      report.deleted.push({ id, rule, reason, blobs: keys.map((k) => k.key) });
      report.blobsDeleted += keys.length;
    } catch (err) {
      // Leave the document in place: a failed blob delete followed by a
      // successful document delete would orphan the photos permanently, with
      // nothing left pointing at them. Next run picks it up again.
      console.error(`retention: ${id} failed, left intact for the next run:`, err.message);
      report.errors.push({ id, error: err.message });
    }
  }

  return report;
}

/** A Netlify scheduled invocation posts a body carrying next_run. */
const looksScheduled = (body) => !!body && typeof body === 'object' && 'next_run' in body;

export default async (req) => {
  if (!process.env.SANITY_WRITE_TOKEN) {
    console.error('retention: SANITY_WRITE_TOKEN is not set — refusing to run.');
    return new Response(JSON.stringify({ error: 'SANITY_WRITE_TOKEN is not set on this deploy' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

  const body = await req.json().catch(() => null);
  const scheduled = looksScheduled(body);

  // Netlify does not route scheduled functions publicly, but netlify.toml
  // force-rewrites /api/* to /.netlify/functions/, so assume this is reachable
  // and require the shared secret for anything that is not the scheduler.
  // Nobody should be able to trigger a deletion sweep with a bare GET.
  const secret = process.env.PERSONALISATION_ACTION_SECRET;
  const authorised = !!secret && req.headers.get('x-csc-action-secret') === secret;
  if (!scheduled && !authorised) {
    console.warn('retention: refused an unauthorised manual invocation');
    return new Response(JSON.stringify({ error: 'Not authorised' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }

  // The scheduler always runs for real. A manual call is a dry run unless it
  // says otherwise, so the destructive path is never the one you get by
  // accident.
  const url = new URL(req.url);
  const dryRun = scheduled
    ? false
    : !(url.searchParams.get('dry-run') === 'false' || body?.dryRun === false);

  try {
    const report = await runRetention({ dryRun });
    return new Response(JSON.stringify(report, null, 1), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('retention: run failed:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

// NOTE: deliberately NO `export const config = { ... }` here. The daily
// schedule is declared in netlify.toml, like the render function's memory, and
// an inline config.path collides with the forced /api/* rewrite.
