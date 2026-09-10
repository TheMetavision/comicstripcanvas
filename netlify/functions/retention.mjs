import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { STUDIO_STORE, isUploadId } from './_shared/studio-uploads.mjs';

/**
 * Photo retention. Runs daily (schedule lives in netlify.toml).
 *
 * Customer photographs should not sit in the blob store forever. Three rules:
 *
 *   dispatched  90 days after the linked order was dispatched
 *   abandoned   30 days after creation, if still draft or awaiting_payment
 *   orphaned     7 days after upload, if no document references the blob
 *
 * And one rule that is not about customers at all: a studio upload is swept
 * 24 hours after it was made unless a save is still waiting to render it. See
 * sweepStudioUploads.
 *
 * The first two walk documents and delete the blobs underneath them. The third
 * walks the blob store instead, because a blob whose document was never
 * written cannot be reached from any document -- see sweepOrphanBlobs.
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
/* A blob under personalisation/<id>/ that no document references is garbage:
   either a create that failed after the blob went up, or a document deletion
   whose blob delete did not complete. The age guard is only there to avoid
   racing an upload whose document has not been written yet -- a window of
   milliseconds, so seven days is generous by any measure. */
const ORPHAN_RETENTION_DAYS = 7;
/* Studio uploads are a transport buffer, not a record. Once studio-render has
   made the print master the upload is a duplicate of artwork already stored at
   full resolution, and the renderer deletes it itself -- so anything still
   sitting under an upload prefix is a save that never happened, or a delete
   that did not complete. A day is long enough to retry a failed save and short
   enough that a 20 MB PNG nobody wants is not kept for a week. */
const STUDIO_UPLOAD_RETENTION_HOURS = 24;

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
 * Blobs that belong to no document at all.
 *
 * The document sweep above walks documents, so a blob whose document was never
 * created is invisible to it -- nothing points at the blob, and nothing ever
 * will. personalise-save now takes its own blob back down when the document
 * write fails, so this is the second line: it catches the cases where that
 * compensating delete could not run either, plus everything leaked before that
 * fix shipped.
 *
 * Order matters. Blobs are listed FIRST and the document ids fetched second, so
 * a document created while the listing is in flight is still in the id set. The
 * reverse order could see a blob as unreferenced because its document was
 * written a moment after the ids were read.
 *
 * On dating: Netlify Blobs exposes no server-side timestamp -- list() returns
 * keys and etags, getMetadata() returns only the metadata we wrote -- so age
 * comes from the uploadedAt that personalise-save now stamps on every blob. A
 * blob with no uploadedAt therefore predates that change, which makes it older
 * than any threshold this function could set, and it is treated as such. That
 * is the one place here that leans towards deleting rather than keeping, and it
 * is what lets the sweep clear the backlog the old code left behind; the
 * "referenced by no document" test is what actually makes it safe.
 *
 * @param {object}  opts
 * @param {boolean} opts.dryRun  report what would go, delete nothing
 * @param {Date}    opts.now     injectable for testing
 * @param {object}  opts.deps    { sanity, stores }
 */
export async function sweepOrphanBlobs({ dryRun = false, now = new Date(), deps = {} } = {}) {
  const sanity = deps.sanity || defaultSanity();
  const store = (deps.stores || {})[PHOTO_STORE] || getStore(PHOTO_STORE);
  const label = dryRun ? 'orphan sweep (DRY RUN)' : 'orphan sweep';
  const nowMs = now.getTime();
  const report = { examined: 0, orphaned: [], blobsDeleted: 0, errors: [] };

  let blobs;
  try {
    ({ blobs } = await store.list({ prefix: 'personalisation/' }));
  } catch (err) {
    console.error(`${label}: could not list the photo store, skipping:`, err.message);
    report.errors.push({ stage: 'list', error: err.message });
    return report;
  }

  // Group by the id segment. Anything not shaped like our keys is left alone --
  // this function deletes things, so it only ever acts on what it recognises.
  const byId = new Map();
  for (const b of blobs) {
    const m = /^personalisation\/(pp-[0-9a-f]{32})\/[^/]+$/.exec(b.key);
    if (!m) continue;
    if (!byId.has(m[1])) byId.set(m[1], []);
    byId.get(m[1]).push(b.key);
  }
  report.examined = byId.size;
  if (!byId.size) {
    console.log(`${label}: no personalisation blobs to examine.`);
    return report;
  }

  const ids = await sanity.fetch('*[_type == "pendingPersonalisation"]._id');
  const referenced = new Set(ids || []);

  for (const [id, keys] of byId) {
    if (referenced.has(id)) continue;
    try {
      // Newest blob in the prefix decides the age of the whole prefix.
      let newest = 0, undated = 0;
      for (const key of keys) {
        const meta = await store.getMetadata(key);
        const stamp = meta && meta.metadata ? Date.parse(meta.metadata.uploadedAt) : NaN;
        if (Number.isFinite(stamp)) newest = Math.max(newest, stamp);
        else undated++;
      }
      // Every blob undated: written before uploadedAt existed, so older than
      // any threshold. A mix means the dated ones give the real age.
      const ageDays = newest ? Math.floor((nowMs - newest) / DAY) : Infinity;
      if (ageDays < ORPHAN_RETENTION_DAYS) continue;

      const age = newest ? `${ageDays} days old` : 'undated (predates uploadedAt)';
      const entry = { id, blobs: keys, age, undated };
      if (dryRun) {
        console.log(`${label}: would delete ${keys.length} orphaned blob(s) for ${id} ` +
          `(${age}, referenced by no document) -- ${keys.join(', ')}`);
      } else {
        for (const key of keys) await store.delete(key);
        console.log(`orphan sweep: deleted ${keys.length} orphaned blob(s) for ${id} ` +
          `(${age}, referenced by no document) -- ${keys.join(', ')}`);
      }
      report.orphaned.push(entry);
      report.blobsDeleted += keys.length;
    } catch (err) {
      // Same posture as the document sweep: leave it for the next run.
      console.error(`${label}: ${id} failed, left intact for the next run:`, err.message);
      report.errors.push({ id, error: err.message });
    }
  }

  console.log(`${label}: ${byId.size} prefix(es) examined, ${report.orphaned.length} orphaned, ` +
    `${report.blobsDeleted} blob(s) ${dryRun ? 'would be ' : ''}deleted.`);
  return report;
}

/**
 * Studio uploads left behind.
 *
 * studio-upload writes artwork to studio/<uploadId>/art.<ext> in <= 4 MB
 * chunks, and studio-render deletes it once the print master exists. So an
 * upload still in the store is one of three things: a save in flight, a save
 * that was never made -- the shop dropped a photo and closed the tab -- or a
 * delete that failed after a successful render. Only the first is worth
 * keeping, and only until it is rendered.
 *
 * "Referenced" therefore means: some studio/<id>/scene.json still names this
 * key, i.e. a save is queued or rendering. That is the same posture as the
 * photo sweep -- live work is never collected at any age -- and it is the only
 * reference whose loss would break anything, because once the render has run
 * the print master IS the artwork and the upload is a duplicate of it.
 *
 * Parts are swept with the rest of the prefix. A half-finished upload has parts
 * and no art blob, which is precisely the case nothing will ever come back for.
 */
export async function sweepStudioUploads({ dryRun = false, now = new Date(), deps = {} } = {}) {
  const store = (deps.stores || {})[STUDIO_STORE] || getStore(STUDIO_STORE);
  const label = dryRun ? 'studio sweep (DRY RUN)' : 'studio sweep';
  const nowMs = now.getTime();
  const report = { examined: 0, swept: [], blobsDeleted: 0, errors: [] };

  let blobs;
  try {
    ({ blobs } = await store.list({ prefix: 'studio/' }));
  } catch (err) {
    console.error(`${label}: could not list the studio store, skipping:`, err.message);
    report.errors.push({ stage: 'list', error: err.message });
    return report;
  }

  /* Group the upload prefixes, and collect the scenes separately. Anything else
     under studio/ -- print.png, print-prev.png, listing.png -- is a design's
     own artwork and is never touched here. */
  const byId = new Map();
  const scenes = [];
  for (const b of blobs) {
    const m = /^studio\/(up-[0-9a-f]{32})\//.exec(b.key);
    if (m && isUploadId(m[1])) {
      if (!byId.has(m[1])) byId.set(m[1], []);
      byId.get(m[1]).push(b.key);
    } else if (/^studio\/[^/]+\/scene\.json$/.test(b.key)) {
      scenes.push(b.key);
    }
  }
  report.examined = byId.size;
  if (!byId.size) {
    console.log(`${label}: no studio uploads to examine.`);
    return report;
  }

  /* Read the pending saves FIRST, so a save written while this was listing is
     still seen. The reverse order could sweep an upload out from under a scene
     that arrived a moment later. */
  const referenced = new Set();
  for (const key of scenes) {
    try {
      const job = JSON.parse(await store.get(key, { type: 'text' }) || '{}');
      for (const k of Object.values(job.images || {})) {
        const m = /^studio\/(up-[0-9a-f]{32})\//.exec(String(k));
        if (m) referenced.add(m[1]);
      }
    } catch (err) {
      /* A scene we cannot read might reference anything, so the safe reading is
         that it references everything: skip the whole sweep rather than delete
         an upload something may still be waiting for. */
      console.error(`${label}: could not read ${key}, skipping the sweep entirely:`, err.message);
      report.errors.push({ stage: 'scenes', key, error: err.message });
      return report;
    }
  }

  const maxAgeMs = STUDIO_UPLOAD_RETENTION_HOURS * 60 * 60 * 1000;
  for (const [id, keys] of byId) {
    if (referenced.has(id)) continue;      // a save is waiting on it
    try {
      // Newest blob in the prefix decides the age of the whole prefix.
      let newest = 0, undated = 0;
      for (const key of keys) {
        const meta = await store.getMetadata(key);
        const stamp = meta && meta.metadata ? Date.parse(meta.metadata.uploadedAt) : NaN;
        if (Number.isFinite(stamp)) newest = Math.max(newest, stamp);
        else undated++;
      }
      /* Undated means it predates uploadedAt, so older than any threshold --
         the same reading the photo sweep takes, and safe for the same reason:
         nothing is waiting on it. */
      const ageMs = newest ? nowMs - newest : Infinity;
      if (ageMs < maxAgeMs) continue;

      const age = newest ? `${Math.floor(ageMs / (60 * 60 * 1000))}h old` : 'undated';
      const entry = { id, blobs: keys, age, undated };
      if (dryRun) {
        console.log(`${label}: would delete ${keys.length} blob(s) for ${id} ` +
          `(${age}, no save waiting on it) -- ${keys.join(', ')}`);
      } else {
        for (const key of keys) await store.delete(key);
        console.log(`studio sweep: deleted ${keys.length} blob(s) for ${id} ` +
          `(${age}, no save waiting on it) -- ${keys.join(', ')}`);
      }
      report.swept.push(entry);
      report.blobsDeleted += keys.length;
    } catch (err) {
      console.error(`${label}: ${id} failed, left intact for the next run:`, err.message);
      report.errors.push({ id, error: err.message });
    }
  }

  console.log(`${label}: ${byId.size} upload(s) examined, ${report.swept.length} swept, ` +
    `${report.blobsDeleted} blob(s) ${dryRun ? 'would be ' : ''}deleted.`);
  return report;
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
  if (!doomed.length) console.log(`${label}: no documents to delete.`);

  // The orphan sweep walks the blob store directly, so unlike the document
  // sweep it has work to do even when no document is past retention. That is
  // the point of it: an orphaned blob has no document to be found through.
  const stores = deps.stores || {
    [PHOTO_STORE]: getStore(PHOTO_STORE),
    [RENDER_STORE]: getStore(RENDER_STORE),
    [STUDIO_STORE]: getStore(STUDIO_STORE),
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

  /* Runs after the document sweep, deliberately: the documents deleted above
     have just had their blobs removed, so anything the sweep now finds
     unreferenced is either a genuine orphan or a blob whose delete failed a
     moment ago -- and the age guard keeps the second case for the next run. */
  report.orphans = await sweepOrphanBlobs({ dryRun, now, deps: { sanity, stores } });

  /* And the studio's own leavings. Nothing to do with customer photographs --
     these are the shop's prepared artwork, uploaded in chunks and consumed by
     the renderer -- but the same job is the right place for it. */
  report.studioUploads = await sweepStudioUploads({ dryRun, now, deps: { stores } });

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

  // A manual call is a dry run unless it explicitly asks not to be, so the
  // destructive path is never what you get by accident.
  //
  // An explicit dryRun:true is honoured even on a scheduled-shaped invocation.
  // That matters because `netlify functions:invoke` sends the scheduler's own
  // payload, so without this a developer asking for a dry run gets a real
  // deletion -- which is exactly what happened the first time this was tested.
  // The real scheduler never sends dryRun, so production behaviour is unchanged.
  const url = new URL(req.url);
  const askedForDryRun = url.searchParams.get('dry-run') !== 'false' && body?.dryRun !== false;
  const explicitDryRun = body?.dryRun === true || url.searchParams.get('dry-run') === 'true';
  const dryRun = explicitDryRun || (scheduled ? false : askedForDryRun);

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
