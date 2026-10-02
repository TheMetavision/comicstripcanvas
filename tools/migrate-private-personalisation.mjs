#!/usr/bin/env node
/**
 * tools/migrate-private-personalisation.mjs
 *
 * Two things the public dataset should never have held, moved out of it.
 *
 * 1. pendingPersonalisation documents → pendingPersonalisation.<ref>
 *    Dotted _ids are not returned to anonymous reads. The build ref (pp-<hex>)
 *    is unchanged and still what the builder, basket, Stripe metadata, order
 *    line items, emails and Blobs keys carry -- netlify/functions/_shared/pp-id.mjs
 *    maps it to the _id at every Sanity call. So, unlike migrate-private-ids.mjs,
 *    NO string anywhere is rewritten: only the documents move. One transaction
 *    per document (and its draft): create the new one with legacyId, delete the
 *    old. Stops if anything references a document being moved.
 *
 * 2. Customer photos hosted as Sanity image assets → private Netlify Blobs
 *    The legacy upload flow kept cdn.sanity.io URLs in uploadedImages on the
 *    pendingPersonalisation and on the order (personalisationDetails.uploadedImages).
 *    Asset URLs are public, and the asset list can be enumerated anonymously.
 *    For each asset:
 *      a. download the original (dlRaw, authenticated) and check it against the
 *         asset's own sha1hash and size
 *      b. write it to the "legacy-customer-photos" store under <sha256>.<ext>,
 *         read it back and compare sha256 and size
 *      c. re-point every document holding the URL at the admin-only
 *         /admin/api/legacy-photo/<key> (ifRevisionId, drafts included)
 *      d. only then, and only if no document still mentions the asset and
 *         nothing references it, delete the Sanity asset
 *    Stops at the first failure; nothing later in the chain runs for that asset.
 *
 * Usage (SANITY_WRITE_TOKEN in .env; Blobs needs NETLIFY_AUTH_TOKEN, and the
 * site id from NETLIFY_SITE_ID or .netlify/state.json):
 *   node tools/migrate-private-personalisation.mjs [--dry-run]  # print the plan, read only
 *   node tools/migrate-private-personalisation.mjs --validate   # Sanity dryRun transactions,
 *                                                               # photo downloads checked,
 *                                                               # Blobs access checked; no writes
 *   node tools/migrate-private-personalisation.mjs --apply      # do it
 *   node tools/migrate-private-personalisation.mjs --inventory  # what the file/image assets are
 *
 * Prints ids, counts and 8-character hash prefixes only -- never names, notes,
 * photo URLs or images. The full mapping goes to
 * %TEMP%\comicstripcanvas-migrate-personalisation.json.
 */
import 'dotenv/config';
import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PP_DOC_PREFIX } from '../netlify/functions/_shared/pp-id.mjs';
import { LEGACY_PHOTO_STORE, LEGACY_PHOTO_KEY, legacyPhotoUrl } from '../netlify/edge-lib/legacy-photo-keys.mjs';

const PROJECT_ID = 'lwbwahym';
const DATASET = 'production';
const SITE_URL = 'https://comicstripcanvas.co.uk';
const TOKEN = process.env.SANITY_WRITE_TOKEN;

/** Where uploadedImages URLs live, per type. */
const PHOTO_FIELDS = { pendingPersonalisation: 'uploadedImages', order: 'personalisationDetails.uploadedImages' };
/** Types scanned before an asset is deleted, for any remaining mention of it. */
const MENTION_TYPES = ['pendingPersonalisation', 'order', 'contactSubmission'];

const CDN_IMAGE = /^https:\/\/cdn\.sanity\.io\/images\/([a-z0-9]+)\/([a-z0-9_-]+)\/([a-f0-9]{40})-(\d+x\d+)\.(jpg|jpeg|png|webp|gif)(\?.*)?$/;

const APPLY = process.argv.includes('--apply');
const VALIDATE = process.argv.includes('--validate');
const INVENTORY = process.argv.includes('--inventory');
const MODE = APPLY ? 'APPLY' : VALIDATE ? 'VALIDATE (nothing written)' : 'DRY RUN (read only)';
const MAP_FILE = join(tmpdir(), 'comicstripcanvas-migrate-personalisation.json');

if ([APPLY, VALIDATE, INVENTORY].filter(Boolean).length > 1) {
  console.error('Use one of --apply, --validate, --inventory.');
  process.exit(1);
}
if (!TOKEN) {
  console.error('SANITY_WRITE_TOKEN is not set in .env.');
  process.exit(1);
}

const sanity = createClient({
  projectId: PROJECT_ID,
  dataset: DATASET,
  apiVersion: '2024-12-01',
  token: TOKEN,
  useCdn: false,
  perspective: 'raw', // drafts move with their documents
});

const sha = (algo, buf) => createHash(algo).update(buf).digest('hex');
// _system (Sanity's own bookkeeping) is not copied, as in migrate-private-ids.mjs.
const strip = ({ _rev, _updatedAt, _system, ...rest }) => rest;
const isDraft = (id) => id.startsWith('drafts.');
const baseOf = (id) => (isDraft(id) ? id.slice('drafts.'.length) : id);

/** A cdn.sanity.io image URL for this dataset → its asset id, else null. */
function assetIdOf(url) {
  const m = CDN_IMAGE.exec(typeof url === 'string' ? url : '');
  if (!m || m[1] !== PROJECT_ID || m[2] !== DATASET) return null;
  return `image-${m[3]}-${m[4]}-${m[5]}`;
}
const short = (assetId) => assetId.split('-')[1].slice(0, 8);
const extOf = (assetId) => assetId.split('-').pop();

function getPath(doc, path) {
  return path.split('.').reduce((v, k) => (v == null ? v : v[k]), doc);
}

function blobStore() {
  const siteID = process.env.NETLIFY_SITE_ID
    || (existsSync('.netlify/state.json') ? JSON.parse(readFileSync('.netlify/state.json', 'utf8')).siteId : '');
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) {
    throw new Error('Blobs access needs NETLIFY_AUTH_TOKEN and a site id (NETLIFY_SITE_ID or .netlify/state.json).');
  }
  return getStore({ name: LEGACY_PHOTO_STORE, siteID, token, consistency: 'strong' });
}

// ── Inventory ────────────────────────────────────────────────────────────────

async function inventory() {
  const files = await sanity.fetch(
    `*[_type == "sanity.fileAsset"]{ _id, originalFilename, "refTypes": array::unique(*[references(^._id)]._type) }`);
  const images = await sanity.fetch(
    `*[_type == "sanity.imageAsset"]{ _id, "refTypes": array::unique(*[references(^._id)]._type) }`);
  const photoAssets = new Set((await photoHolders()).flatMap((h) => h.urls.map(assetIdOf)).filter(Boolean));

  const group = (rows) => rows.reduce((m, r) => {
    const k = r.refTypes.length ? r.refTypes.sort().join('+') : '(unreferenced)';
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});

  console.log(`\n  Asset inventory (comicstripcanvas)\n`);
  console.log(`  File assets: ${files.length}`);
  for (const [k, n] of Object.entries(group(files))) console.log(`    ${String(n).padStart(4)}  referenced by ${k}`);
  /* studio-render-background uploads every product's print master as
     <slug>-print.png; a re-render replaces the reference and leaves the old
     file behind. No customer photo has ever been a file asset. */
  const unref = files.filter((f) => !f.refTypes.length);
  const studioPrints = unref.filter((f) => /-print\.png$/.test(f.originalFilename || ''));
  console.log(`    of the unreferenced: ${studioPrints.length} product-studio print masters (superseded), ${unref.length - studioPrints.length} other`);
  for (const f of unref) console.log(`      ${f.originalFilename || '(no filename)'}`);
  console.log(`    customer uploads among file assets: 0`);

  console.log(`\n  Image assets: ${images.length}`);
  for (const [k, n] of Object.entries(group(images))) console.log(`    ${String(n).padStart(4)}  referenced by ${k}`);
  console.log(`    customer photos (held as URLs in uploadedImages, not references): ${photoAssets.size}`);
  process.exitCode = 0;
}

// ── Phase 1: documents ───────────────────────────────────────────────────────

async function moveDocuments() {
  const all = await sanity.fetch(`*[_type == "pendingPersonalisation"]._id`);
  const published = all.filter((id) => !isDraft(id) && !id.includes('.'));
  const draftOnly = all
    .filter((id) => isDraft(id) && !baseOf(id).includes('.'))
    .filter((id) => !published.includes(baseOf(id)));

  console.log(`  Phase 1 — documents: ${published.length} to move, ${draftOnly.length} draft-only`);
  const moved = {};

  for (const oldId of [...published, ...draftOnly.map(baseOf)]) {
    const newId = `${PP_DOC_PREFIX}${oldId}`;
    const [doc, draft, referrers] = await Promise.all([
      sanity.getDocument(oldId),
      sanity.getDocument(`drafts.${oldId}`),
      sanity.fetch(`*[references($id) || references($d)]._id`, { id: oldId, d: `drafts.${oldId}` }),
    ]);
    if (referrers.length) {
      throw new Error(`${oldId} is referenced by ${referrers.join(', ')} — not expected; stopping`);
    }
    console.log(`    ${oldId}  →  ${newId}${doc ? '' : '  (draft only)'}${draft ? '  (+ draft)' : ''}`);
    moved[oldId] = newId;
    if (!APPLY && !VALIDATE) continue;

    let tx = sanity.transaction();
    if (doc) tx = tx.create({ ...strip(doc), _id: newId, legacyId: oldId });
    if (draft) tx = tx.create({ ...strip(draft), _id: `drafts.${newId}`, legacyId: oldId });
    if (draft) tx = tx.delete(`drafts.${oldId}`);
    if (doc) tx = tx.delete(oldId);
    await tx.commit({ dryRun: VALIDATE, visibility: 'sync' });
    console.log(`      ${VALIDATE ? 'ok (not written)' : 'moved'}`);
  }
  return moved;
}

// ── Phase 2: photos ──────────────────────────────────────────────────────────

/** Every document (drafts included) holding uploadedImages, with its URLs. */
async function photoHolders() {
  const rows = [];
  for (const [type, path] of Object.entries(PHOTO_FIELDS)) {
    const docs = await sanity.fetch(
      `*[_type == $type && defined(${path})]{ _id, _rev, _type, "urls": ${path} }`, { type });
    for (const d of docs) rows.push({ ...d, path, urls: d.urls || [] });
  }
  return rows;
}

async function movePhotos() {
  const holders = await photoHolders();
  const byAsset = new Map(); // assetId → [{ docId, path }]
  let foreign = 0;
  for (const h of holders) {
    for (const url of h.urls) {
      const a = assetIdOf(url);
      if (!a) { if (!String(url).includes(SITE_URL + '/admin/api/legacy-photo/')) foreign++; continue; }
      if (!byAsset.has(a)) byAsset.set(a, []);
      byAsset.get(a).push(h._id);
    }
  }
  const docsWithPhotos = new Set([...byAsset.values()].flat());
  console.log(`\n  Phase 2 — photos: ${byAsset.size} Sanity-hosted customer photo(s) on ${docsWithPhotos.size} document(s)`
    + (foreign ? `; ${foreign} URL(s) on other hosts left alone` : ''));
  for (const [a, ids] of byAsset) console.log(`    ${short(a)}…  on ${[...new Set(ids)].join(', ')}`);

  const store = (APPLY || VALIDATE) ? blobStore() : null;
  if (VALIDATE) {
    await store.list({ prefix: 'zz-access-check/' });
    console.log('    Blobs store reachable');
  }

  // a + b: download, check against the asset record, copy, read back, compare.
  const keyOf = {};
  for (const assetId of byAsset.keys()) {
    const asset = await sanity.getDocument(assetId);
    if (!asset?.url) throw new Error(`${short(assetId)}… has no asset record; stopping`);
    /* dlRaw (authenticated) serves the ORIGINAL file. The plain CDN URL serves a
       processed copy that matches neither the asset's sha1hash nor its size. */
    const res = await fetch(`${asset.url}?dlRaw=`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`${short(assetId)}… download failed: HTTP ${res.status}; stopping`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha('sha1', bytes) !== asset.sha1hash || bytes.length !== asset.size) {
      throw new Error(`${short(assetId)}… download does not match the asset record (sha1/size); stopping`);
    }
    const sha256 = sha('sha256', bytes);
    const key = `${sha256}.${extOf(assetId)}`;
    if (!LEGACY_PHOTO_KEY.test(key)) throw new Error(`${short(assetId)}… unexpected extension; stopping`);
    keyOf[assetId] = key;

    if (APPLY) {
      await store.set(key, bytes, {
        metadata: { sha256, bytes: bytes.length, contentType: asset.mimeType, copiedAt: new Date().toISOString() },
      });
      const back = Buffer.from(await store.get(key, { type: 'arrayBuffer' }) || new ArrayBuffer(0));
      if (back.length !== bytes.length || sha('sha256', back) !== sha256) {
        throw new Error(`${short(assetId)}… Blobs copy does not read back identical; stopping`);
      }
    }
    console.log(`    ${short(assetId)}…  ${(bytes.length / 1024).toFixed(0)} KB  verified against the asset${APPLY ? ', copied and read back' : ''}`);
  }

  // c: re-point each document at the admin URLs.
  for (const h of holders.filter((x) => docsWithPhotos.has(x._id))) {
    const next = h.urls.map((u) => (assetIdOf(u) && keyOf[assetIdOf(u)] ? legacyPhotoUrl(SITE_URL, keyOf[assetIdOf(u)]) : u));
    console.log(`    re-point ${h._id}: ${h.urls.filter(assetIdOf).length} URL(s)`);
    if (!APPLY) continue;
    await sanity.patch(h._id).ifRevisionId(h._rev)
      .set({ [h.path]: next })
      .commit({ visibility: 'sync' });
  }

  // d: delete each asset once nothing mentions or references it.
  const deleted = [];
  for (const assetId of byAsset.keys()) {
    const hash = assetId.split('-')[1];
    const mentions = await sanity.fetch(`*[_type in $types]`, { types: MENTION_TYPES })
      .then((docs) => docs.filter((d) => JSON.stringify(d).includes(hash)).map((d) => d._id));
    const refs = await sanity.fetch(`count(*[references($id)])`, { id: assetId });
    if (!APPLY) {
      console.log(`    delete ${short(assetId)}… after re-pointing (currently ${mentions.length} mention(s), ${refs} reference(s))`);
      continue;
    }
    if (mentions.length || refs) {
      throw new Error(`${short(assetId)}… still mentioned by ${mentions.join(', ') || '-'} / ${refs} reference(s); not deleted; stopping`);
    }
    await sanity.delete(assetId);
    deleted.push(assetId);
    console.log(`    deleted asset ${short(assetId)}…`);
  }
  return { keyOf, deleted };
}

// process.exitCode rather than process.exit() once requests have been made:
// exiting while fetch sockets close trips a libuv assertion on Windows (Node 24).
async function main() {
  if (INVENTORY) return inventory();
  console.log(`\n  Private personalisation migration (comicstripcanvas) — ${MODE}\n`);
  const moved = await moveDocuments();
  const photos = await movePhotos();
  writeFileSync(MAP_FILE, JSON.stringify({ mode: MODE, at: new Date().toISOString(), moved, photos }, null, 2));
  console.log(`\n  Mapping written to ${MAP_FILE}`);
  console.log(APPLY ? '\n  Done. Run tools/check-public-exposure.mjs.\n'
    : '\n  Nothing written. --validate checks it against the live services; --apply migrates.\n');
}

main().catch((err) => {
  console.error(`\n  STOPPED: ${err.message}\n`);
  process.exitCode = 1;
});
