#!/usr/bin/env node
/**
 * tools/migrate-private-ids.mjs
 *
 * Moves customer documents to dotted _ids so anonymous API reads can't see
 * them. On the Free plan the dataset can't be made private, but any document
 * whose _id contains a "." is only readable with a token. Same approach as
 * pixel8's tools/migrate-private-ids.mjs.
 *
 * For each document, in ONE transaction:
 *   1. create the new doc: every field copied, plus legacyId: <old _id>
 *      (and drafts.<new> if a drafts.<old> exists)
 *   2. re-point every reference to the old _id at the new one
 *   3. rewrite string fields that hold the old _id (e.g. an order id kept as
 *      a plain string on another document)
 *   4. delete the old doc (and its draft)
 * Stops at the first error. A transaction is all-or-nothing, so a failure
 * leaves that document untouched.
 *
 * Counters: if the dotted counter already exists (the new code ran first), it
 * keeps the higher of the two values and the old one is deleted, so the
 * sequence never goes backwards.
 *
 * Usage (needs the write token in .env):
 *   node tools/migrate-private-ids.mjs [--dry-run]  # dry run: print the plan
 *   node tools/migrate-private-ids.mjs --validate   # send each transaction with
 *                                                   # Sanity's dryRun flag
 *   node tools/migrate-private-ids.mjs --apply      # do it
 *
 * Writes the old → new mapping (ids only) to %TEMP%\<site>-migrate-ids.json.
 * Prints ids only — never names, emails, addresses or messages.
 */
import 'dotenv/config';
import { createClient } from '@sanity/client';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Site config ───────────────────────────────────────────────────────────────
const SITE = 'comicstripcanvas';
const PROJECT_ID = 'lwbwahym';
const TOKEN = process.env.SANITY_WRITE_TOKEN;
/** Types to move (anything not already dotted). */
const TYPES = ['order', 'contactSubmission', 'orderCounter'];
/** Types scanned for the old id held as a plain string. */
const MENTION_TYPES = ['order', 'contactSubmission', 'orderCounter', 'pendingPersonalisation'];
/** Counter types → the numeric field that must never go backwards. */
const COUNTERS = { orderCounter: 'lastOrderNumber' };

function newIdFor(doc) {
  // Must match netlify/functions/webhook.mjs.
  if (doc._type === 'order' && doc._id.startsWith('order-')) return `order.${doc._id.slice('order-'.length)}`;
  if (doc._type === 'orderCounter' && doc._id === 'orderCounter') return 'orderCounter.csc';
  return `${doc._type}.${doc._id}`;
}

/** Links and ids outside Sanity that carry the old _id. */
function derivedLinks(doc) {
  if (doc._type === 'order') {
    return [
      'Stripe finds it by stripeSessionId (unchanged); the webhook also matches legacyId',
      'print files already made are stored under the old id — re-make from the admin print-file page if needed',
    ];
  }
  return [];
}
// ──────────────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply');
const VALIDATE = process.argv.includes('--validate');
const MODE = APPLY ? 'APPLY' : VALIDATE ? 'VALIDATE (server dryRun, nothing written)' : 'DRY RUN (nothing sent)';
const MAP_FILE = join(tmpdir(), `${SITE}-migrate-ids.json`);

if (APPLY && VALIDATE) {
  console.error('Use either --apply or --validate, not both.');
  process.exit(1);
}
if (!TOKEN) {
  console.error('Sanity write token is not set in .env.');
  process.exit(1);
}

const sanity = createClient({
  projectId: process.env.SANITY_PROJECT_ID || PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  apiVersion: '2024-12-01',
  token: TOKEN,
  useCdn: false,
  perspective: 'raw', // see drafts too, so they move with their document
});

/** Every JSONMatch path inside `value` whose _ref equals `id`. */
function refPaths(value, id, path = '') {
  const out = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const seg = item && typeof item === 'object' && item._key ? `[_key=="${item._key}"]` : `[${i}]`;
      out.push(...refPaths(item, id, `${path}${seg}`));
    });
  } else if (value && typeof value === 'object') {
    if (value._ref === id) out.push(`${path}._ref`.replace(/^\./, ''));
    for (const [k, v] of Object.entries(value)) {
      if (k === '_ref') continue;
      out.push(...refPaths(v, id, path ? `${path}.${k}` : k));
    }
  }
  return out;
}

// System and identity keys are never rewritten: _system is managed by Sanity,
// and a short id (e.g. "orderCounter") can equal a _type.
const SKIP_KEYS = ['_id', '_ref', '_rev', '_type', '_key', '_system', 'legacyId'];
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches `id` only as a whole id, not inside a longer one. */
const idRe = (id) => new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(id)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'g');
const replaceId = (str, oldId, newId) => str.replace(idRe(oldId), newId);

/** Every string field (outside SKIP_KEYS) containing `id` as a whole id: { path: current value }. */
function stringMentions(value, id, path = '') {
  const out = {};
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const seg = item && typeof item === 'object' && item._key ? `[_key=="${item._key}"]` : `[${i}]`;
      Object.assign(out, stringMentions(item, id, `${path}${seg}`));
    });
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SKIP_KEYS.includes(k)) continue;
      const p = path ? `${path}.${k}` : k;
      if (typeof v === 'string') { if (idRe(id).test(v)) out[p] = v; }
      else Object.assign(out, stringMentions(v, id, p));
    }
  }
  return out;
}

// _system (Sanity's own bookkeeping, e.g. a draft's base revision) is not copied.
const strip = ({ _rev, _updatedAt, _system, ...rest }) => rest;
/** Copy of `value` with whole-id occurrences of oldId replaced in string fields (SKIP_KEYS untouched). */
function rewrite(value, oldId, newId) {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, oldId, newId));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      SKIP_KEYS.includes(k) ? v : typeof v === 'string' ? replaceId(v, oldId, newId) : rewrite(v, oldId, newId)]));
  }
  return value;
}

// process.exitCode rather than process.exit() once requests have been made:
// exiting while fetch sockets close trips a libuv assertion on Windows (Node 24).
async function main() {
  // ── Plan ────────────────────────────────────────────────────────────────────
  const docs = await sanity.fetch(
    `*[_type in $types && !(_id in path("drafts.**"))]{ _id, _type }`,
    { types: TYPES }
  );
  const toMove = docs
    .filter((d) => !d._id.includes('.'))
    .sort((a, b) => TYPES.indexOf(a._type) - TYPES.indexOf(b._type) || a._id.localeCompare(b._id));
  const orphanDrafts = await sanity.fetch(
    `*[_type in $types && _id in path("drafts.**") && !(_id in path("drafts.*.**"))]._id`,
    { types: TYPES }
  );
  const draftOnly = orphanDrafts.filter((d) => !toMove.some((m) => `drafts.${m._id}` === d));

  // Every mention candidate, fetched once; re-read per document on --apply.
  const mentionIds = await sanity.fetch(`*[_type in $types]._id`, { types: MENTION_TYPES });
  let mentionCache = null;
  async function mentionDocs(fresh) {
    if (!mentionCache || fresh) {
      mentionCache = [];
      for (let i = 0; i < mentionIds.length; i += 100) {
        const ids = mentionIds.slice(i, i + 100);
        mentionCache.push(...(await sanity.fetch(`*[_id in $ids]`, { ids })));
      }
    }
    return mentionCache;
  }

  console.log(`\n  Private-id migration (${SITE}) — ${MODE}\n`);
  const byType = {};
  for (const d of toMove) byType[d._type] = (byType[d._type] || 0) + 1;
  console.log(`  ${toMove.length} document(s) to move: ${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`);
  if (draftOnly.length) {
    console.log(`  ${draftOnly.length} draft-only document(s) with no published version — not handled, publish or delete them first:`);
    for (const d of draftOnly) console.log(`    ${d}`);
  }

  // Built from fresh reads. Execution calls it again per document, because an
  // earlier transaction can change this one's references.
  async function planFor(oldId, fresh) {
    const doc = await sanity.getDocument(oldId);
    if (!doc) throw new Error(`${oldId} no longer exists`);
    const newId = newIdFor(doc);
    const draft = await sanity.getDocument(`drafts.${doc._id}`);
    const referrers = await sanity.fetch(`*[references($id)]{ _id, _type }`, { id: doc._id });
    const referrerPatches = [];
    for (const r of referrers) {
      const full = await sanity.getDocument(r._id);
      referrerPatches.push({ _id: r._id, _type: r._type, paths: refPaths(full, doc._id) });
    }
    const mentionPatches = [];
    for (const m of await mentionDocs(fresh)) {
      if (m._id === doc._id || m._id === `drafts.${doc._id}`) continue;
      const found = stringMentions(m, doc._id);
      if (Object.keys(found).length) {
        mentionPatches.push({ _id: m._id, set: Object.fromEntries(Object.entries(found).map(([p, v]) => [p, replaceId(v, doc._id, newId)])) });
      }
    }
    const selfMentions = Object.keys(stringMentions(doc, doc._id));
    const target = await sanity.getDocument(newId);
    const counterField = COUNTERS[doc._type];
    const counterMerge = !!target && !!counterField;
    return {
      doc, newId, draft, referrerPatches, mentionPatches, selfMentions, counterField,
      clash: !!target && !counterMerge, counterMerge, target, links: derivedLinks(doc),
    };
  }

  const plan = [];
  for (const d of toMove) plan.push(await planFor(d._id, false));

  for (const p of plan) {
    console.log(`\n  ${p.doc._type}  ${p.doc._id}  →  ${p.newId}${p.clash ? '   !! TARGET ID ALREADY EXISTS' : ''}`);
    if (p.counterMerge) {
      console.log(`    counter:    target exists — will keep the higher ${p.counterField} (old ${p.doc[p.counterField]}, new ${p.target[p.counterField]}) and delete the old`);
    }
    if (p.draft) console.log(`    draft:      drafts.${p.doc._id}  →  drafts.${p.newId}`);
    if (!p.referrerPatches.length) console.log('    references: none');
    for (const r of p.referrerPatches) {
      console.log(`    reference:  ${r._type} ${r._id}  (${r.paths.join(', ') || 'path not found'})`);
    }
    for (const m of p.mentionPatches) console.log(`    string id:  ${m._id}  (${Object.keys(m.set).join(', ')})`);
    if (p.selfMentions.length) console.log(`    own fields: ${p.selfMentions.join(', ')} (rewritten in the copy)`);
    for (const n of p.links) console.log(`    link:       ${n}`);
  }

  const mapping = plan.map((p) => ({
    type: p.doc._type, oldId: p.doc._id, newId: p.newId, draft: !!p.draft,
    referrers: p.referrerPatches.map((r) => r._id), mentions: p.mentionPatches.map((m) => m._id), applied: false,
  }));
  const saveMap = () => writeFileSync(MAP_FILE, JSON.stringify({ mode: MODE, at: new Date().toISOString(), mapping }, null, 2));
  saveMap();
  console.log(`\n  Mapping written to ${MAP_FILE}`);

  if (plan.some((p) => p.clash)) {
    console.error('\n  Stopping: at least one target id already exists. Nothing was sent.\n');
    return 1;
  }
  if (plan.some((p) => p.referrerPatches.some((r) => !r.paths.length))) {
    console.error('\n  Stopping: a reference path could not be located. Nothing was sent.\n');
    return 1;
  }
  if (!APPLY && !VALIDATE) {
    console.log('\n  Nothing sent. Re-run with --validate to have Sanity check each transaction, or --apply to migrate.\n');
    return 0;
  }

  // ── Execute ─────────────────────────────────────────────────────────────────
  for (const [i, planned] of plan.entries()) {
    // --validate writes nothing, so the up-front plan is still exact. --apply re-reads.
    const p = APPLY ? await planFor(planned.doc._id, true) : planned;
    if (p.clash || p.referrerPatches.some((r) => !r.paths.length)) {
      console.error(`\n  Stopping at ${p.doc._id}: target exists or a reference path is missing. ${i} done before this.\n`);
      return 1;
    }
    const tx = sanity.transaction();
    if (p.counterMerge) {
      const f = p.counterField;
      tx.patch(p.newId, (patch) => patch.set({ [f]: Math.max(p.doc[f] ?? 0, p.target[f] ?? 0), legacyId: p.doc._id }));
    } else {
      // The copy keeps every field; ids held as strings in its own fields move too.
      const { _id, ...fields } = strip(p.doc);
      tx.create({ ...rewrite(fields, p.doc._id, p.newId), _id: p.newId, legacyId: p.doc._id });
      if (p.draft) {
        const { _id: _d, ...draftFields } = strip(p.draft);
        tx.create({ ...rewrite(draftFields, p.doc._id, p.newId), _id: `drafts.${p.newId}`, legacyId: p.doc._id });
      }
    }
    for (const r of p.referrerPatches) {
      tx.patch(r._id, (patch) => patch.set(Object.fromEntries(r.paths.map((path) => [path, p.newId]))));
    }
    for (const m of p.mentionPatches) tx.patch(m._id, (patch) => patch.set(m.set));
    // Sanity's dryRun checks the delete against the references as they were
    // BEFORE this transaction's patches, so it rejects a delete whose
    // referrers this same transaction re-points (a real commit accepts it —
    // tested 2026-10-02). --validate leaves that delete out.
    const skipDelete = VALIDATE && p.referrerPatches.length > 0;
    if (!skipDelete) {
      if (p.draft) tx.delete(`drafts.${p.doc._id}`);
      tx.delete(p.doc._id);
    }
    try {
      await tx.commit({ visibility: 'sync', dryRun: VALIDATE });
    } catch (err) {
      console.error(`\n  FAILED on ${p.doc._id} → ${p.newId}: ${err?.message || err}`);
      console.error(`  ${i} of ${plan.length} document(s) ${VALIDATE ? 'validated' : 'migrated'} before this; this one is unchanged. Stopping.\n`);
      return 1;
    }
    if (APPLY) { mapping[i].applied = true; saveMap(); }
    console.log(`  ${VALIDATE ? 'ok (not written)' : 'moved'}  ${p.doc._id} → ${p.newId}`);
  }
  console.log(`\n  Done: ${plan.length} document(s) ${VALIDATE ? 'validated — nothing written' : 'migrated'}.\n`);
  return 0;
}

process.exitCode = await main();
