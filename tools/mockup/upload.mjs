#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Put the rendered mockups onto products, reversibly and repeatably.
 *
 *   node tools/mockup/upload.mjs --category comic-book-icons --scenes poster --dry-run
 *   node tools/mockup/upload.mjs --category comic-book-icons --scenes poster
 *   node tools/mockup/upload.mjs --category comic-book-icons --scenes poster --limit 5
 *   node tools/mockup/upload.mjs --slug walter-white-icon --slug zz-top
 *
 * --limit takes the first n by slug, so a real upload can be staged a few
 * products at a time and the same few come back on a repeat. --slug is
 * repeatable and takes precedence over --category.
 *
 * Reads tools/mockup/out/<slug>/<scene>.jpg and writes each into a FIXED SLOT
 * on the product's images[]:
 *
 *     mockup-poster     mockup-room     mockup-studio
 *
 * ── Why the keys are fixed ─────────────────────────────────────────────────
 *
 * They used to be random hex, which made every run additive: re-uploading a
 * corrected mockup appended a second copy rather than replacing the first, so
 * the script had to refuse to run at all on any product that already carried
 * one ("already carries 3 mockup(s) — skipped, strip them first"). Re-rendering
 * 244 products therefore meant a strip, then an upload, with the product pages
 * showing no mockup in between and nothing to roll back to if the second half
 * failed.
 *
 * With a fixed key per scene the write is an upsert: present, and it is
 * replaced in place; absent, and it is inserted. Running twice does the same
 * thing as running once, which means a re-render can be pushed straight over
 * the top and a half-finished run can simply be run again.
 *
 * ── Order ──────────────────────────────────────────────────────────────────
 *
 * listing first, then poster, room, studio, whichever exist. New entries are
 * inserted after the last slot that precedes them, so the order holds however
 * many of them are being written and in whatever order they arrive.
 *
 * Anchored by KEY -- images[_key=="listing"] -- never by index. A product with
 * no listing key is skipped and named, because "after images[0]" means "after
 * whatever happens to be first", and one Studio reorder later that is the
 * wrong place.
 *
 * ── Drafts are created and patched together ────────────────────────────────
 *
 * createIfNotExists carrying the published content goes in the SAME
 * transaction as the patches, so a patch can never arrive against a document
 * that was not created. Where a draft already exists the create is a no-op and
 * whatever is already in that draft survives: nothing here addresses anything
 * but mockup keys.
 *
 * ── The alt is a contract ──────────────────────────────────────────────────
 *
 *     "<title> lifestyle mockup — Comic Strip Canvas"
 *
 * strip-mockups.mjs finds these entries by matching /lifestyle mockup/i and
 * nothing else, so the wording is not decoration: get it wrong and the mockups
 * become unremovable by the tool built to remove them.
 *
 * ── What it will not touch ─────────────────────────────────────────────────
 *
 * images[0], and any entry keyed "listing". images[0] is the product image the
 * whole site reads -- the store grid, the feed, the cards -- and the listing
 * entry is the rendered artwork itself. Nothing here ever rewrites the images
 * array wholesale; every mutation names a mockup key or inserts after one, so
 * the listing entry is not merely preserved, it is never addressed. A product
 * whose slot 0 is missing, or is itself a mockup, is skipped rather than fixed.
 *
 * ── Drafts only ────────────────────────────────────────────────────────────
 *
 * Every patch goes to drafts.<id>, created from the published document if there
 * is not one already. Nothing this writes is visible to a customer until
 * somebody opens the Studio and presses Publish.
 *
 * ── The backup ─────────────────────────────────────────────────────────────
 *
 * Every run writes tools/mockup/upload-backup-<timestamp>.json holding each
 * touched document's images[] exactly as it was, BEFORE anything is sent --
 * including on a dry run, so the way back exists before anyone needs it.
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const many = (n) => args.reduce((a, v, i) => (v === `--${n}` && args[i + 1] ? [...a, args[i + 1]] : a), []);

const DRY = flag('dry-run');
const SLUGS = many('slug');
const CATEGORY = opt('category');
const OUT_DIR = opt('out', path.join('tools', 'mockup', 'out'));
const LIMIT = opt('limit') === null ? null : Number(opt('limit'));

const PROJECT = 'lwbwahym';
const DATASET = 'production';
// Canonical slot order. Also the order new entries are inserted in.
const NAMES = ['poster', 'room', 'studio'];
const LISTING_KEY = 'listing';
const keyFor = (name) => `mockup-${name}`;
const altFor = (title) => `${title} lifestyle mockup — Comic Strip Canvas`;

const SCENES = (opt('scenes', 'poster') || '').split(',').map((s) => s.trim()).filter(Boolean);

// Read lazily, so this file can be imported by its test without a token or a
// .env. Nothing above this line touches the network or the filesystem.
let _token = null;
const token = () => {
  if (_token) return _token;
  const env = fs.readFileSync('.env', 'utf8');
  _token = (/^SANITY_WRITE_TOKEN\s*=\s*(.+)$/m.exec(env) || [])[1]?.trim().replace(/^["']|["']$/g, '');
  if (!_token) { console.error('  no SANITY_WRITE_TOKEN in .env'); process.exit(1); }
  return _token;
};

const api = (p) => `https://${PROJECT}.api.sanity.io/v2021-10-21/${p}`;
const groq = async (query, params = {}) => {
  let url = api(`data/query/${DATASET}?query=${encodeURIComponent(query)}`);
  for (const [k, v] of Object.entries(params)) url += `&$${k}=${encodeURIComponent(JSON.stringify(v))}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
};

/** Upload one file to the asset library and return its id. */
async function uploadAsset(file) {
  const body = fs.readFileSync(file);
  const url = api(`assets/images/${DATASET}?filename=${encodeURIComponent(path.basename(file))}`);
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'image/jpeg' },
    body,
  }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.document._id;
}

async function mutate(mutations) {
  const r = await fetch(api(`data/mutate/${DATASET}?returnIds=true`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ mutations }),
  }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r;
}

/**
 * Where a new slot goes: after the last slot before it that already exists,
 * and after the listing entry otherwise.
 *
 * By KEY, never by index. images[0] is a position, and a position is only the
 * listing entry until something moves -- a Studio reorder, an image added by
 * hand, a draft edited by somebody who does not know this script exists. Then
 * "after images[0]" quietly means "after whatever is first now", and the
 * mockup lands in front of the product image rather than behind it. The key
 * says what it means, and a product that has not got one is refused rather
 * than guessed at.
 *
 * Computed against the keys the document will have by the time this mutation
 * is applied, not the keys it has now, because the patches are sent in order
 * within one transaction and an earlier one may have created the anchor this
 * one needs.
 */
function anchorFor(name, present) {
  const i = NAMES.indexOf(name);
  for (let j = i - 1; j >= 0; j -= 1) {
    if (present.has(keyFor(NAMES[j]))) return `images[_key=="${keyFor(NAMES[j])}"]`;
  }
  return `images[_key=="${LISTING_KEY}"]`;
}

/** The patches for one product, in the order they must be applied. */
function patchesFor(draftId, title, images, assets) {
  const present = new Set((images || []).map((im) => im?._key).filter(Boolean));
  const out = [];
  for (const name of NAMES) {
    if (!assets[name]) continue;
    const key = keyFor(name);
    const entry = {
      _type: 'image',
      _key: key,
      asset: { _type: 'reference', _ref: assets[name] },
      alt: altFor(title),
    };
    if (present.has(key)) {
      // Replace this entry and only this entry. Addressed by key, so it does
      // not matter where in the array it currently sits.
      out.push({
        op: 'replace',
        name,
        patch: { id: draftId, set: { [`images[_key=="${key}"]`]: entry } },
      });
    } else {
      out.push({
        op: 'insert',
        name,
        patch: { id: draftId, insert: { after: anchorFor(name, present), items: [entry] } },
      });
      present.add(key);
    }
  }
  return out;
}

/**
 * Everything one product needs, as a single transaction.
 *
 * @param draftId    drafts.<published id>
 * @param title      for the alt text
 * @param published  the FULL published document -- required when `draft` is
 *                   null, because it is what the draft is created from
 * @param draft      the existing draft, or null
 * @param assets     {scene: assetId}
 *
 * The create and the patches travel together on purpose. Sent separately, a
 * patch can arrive against a document that was never created -- the create
 * having failed, or the draft having been discarded in the Studio in between --
 * and a patch to a missing document is an error partway through a batch.
 */
function transactionFor(draftId, title, published, draft, assets) {
  const mutations = [];
  if (!draft) mutations.push({ createIfNotExists: { ...published, _id: draftId } });
  // The array actually being patched: the draft's when there is one, since it
  // may already differ from what is published.
  const current = (draft && draft.images) || (published && published.images) || [];
  const ps = patchesFor(draftId, title, current, assets);
  for (const { patch } of ps) mutations.push({ patch });
  return { mutations, ps };
}

export { NAMES, keyFor, altFor, anchorFor, patchesFor, transactionFor, LISTING_KEY };

const main = async () => {
  const unknown = SCENES.filter((s) => !NAMES.includes(s));
  if (unknown.length) {
    console.error(`  --scenes takes ${NAMES.join(', ')}, not '${unknown[0]}'`);
    process.exit(1);
  }
  if (!SLUGS.length && !CATEGORY) {
    console.error('  give --slug (repeatable) or --category');
    process.exit(1);
  }
  if (LIMIT !== null && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
    console.error(`  --limit takes a whole number of products, not '${opt('limit')}'`);
    process.exit(1);
  }
  const where = SLUGS.length ? 'slug.current in $slugs' : 'category == $category';
  const products = await groq(
    `*[_type == "product" && !(_id in path("drafts.**")) && ${where}]{
       _id, title, "slug": slug.current, category, images
     } | order(slug asc)`,
    SLUGS.length ? { slugs: SLUGS } : { category: CATEGORY },
  ) || [];
  const found = products.length;
  // Applied after the query and before anything is planned, so --limit 5 means
  // "the first five by slug", the same five every time. Staging a real upload
  // in batches is only useful if the batches are predictable.
  if (LIMIT !== null) products.length = Math.min(products.length, LIMIT);
  console.log(`  ${products.length} product(s)${found !== products.length ? ` of ${found} (--limit ${LIMIT})` : ''}`
    + `${DRY ? '  (dry run)' : ''}   scenes: ${SCENES.join(', ')}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join('tools', 'mockup', `upload-backup-${stamp}.json`);
  const backup = [];
  const plan = [];
  let missingRenders = 0;
  const noListing = [];

  for (const p of products) {
    const dir = path.join(OUT_DIR, p.slug);
    const files = {};
    const missing = [];
    for (const name of SCENES) {
      const f = path.join(dir, `${name}.jpg`);
      if (fs.existsSync(f)) files[name] = f; else missing.push(name);
    }
    if (missing.length) {
      missingRenders += 1;
      console.log(`  ${p.slug}: no render for ${missing.join(', ')} — skipped`);
      continue;
    }

    const images = p.images || [];
    // The anchor is the listing entry, by key. No index fallback: a product
    // without one is a product whose image order this script cannot reason
    // about, and inserting somewhere plausible is how a mockup ends up in
    // front of the product image on the store grid.
    if (!images.some((im) => im?._key === LISTING_KEY)) {
      noListing.push(p.slug);
      console.log(`  ${p.slug}: no images[_key=="${LISTING_KEY}"] — skipped, nothing safe to anchor to`);
      continue;
    }

    const existing = SCENES.filter((n) => images.some((im) => im?._key === keyFor(n)));
    backup.push({ _id: p._id, slug: p.slug, title: p.title, images });
    plan.push({ product: p, files, images });
    console.log(`  ${p.slug}: ${existing.length ? `replace ${existing.join(', ')}` : 'insert'}`
      + ` ${SCENES.map(keyFor).join(', ')}  (${images.length} image(s) now)`);
  }

  // Written before anything is sent, and on a dry run too.
  fs.writeFileSync(backupPath, JSON.stringify({ when: stamp, dryRun: DRY, scenes: SCENES, documents: backup }, null, 2));
  console.log(`\n  ${plan.length} product(s) to write, ${missingRenders} without renders, `
    + `${noListing.length} without a listing entry to anchor to`);
  if (noListing.length) console.log(`  no listing key: ${noListing.join(', ')}`);
  console.log(`  backup of ${backup.length} document(s) -> ${backupPath}`);

  if (DRY) {
    console.log('\n  sample of the planned patches (asset ids are assigned at upload time):');
    for (const { product, images } of plan.slice(0, 3)) {
      const fake = Object.fromEntries(SCENES.map((n) => [n, `image-<uploaded-${n}>`]));
      const ps = patchesFor(`drafts.${product._id}`, product.title, images, fake);
      console.log(`\n  ${product.slug}`);
      for (const { op, name, patch } of ps) {
        console.log(`    ${op} ${keyFor(name)}: ${JSON.stringify(patch)}`);
      }
    }
    console.log('\n  dry run: nothing uploaded, nothing patched');
    return;
  }

  for (const { product, files, images } of plan) {
    const assets = {};
    for (const name of SCENES) assets[name] = await uploadAsset(files[name]);

    const draftId = `drafts.${product._id}`;
    const draft = await groq('*[_id == $id][0]{_id, images}', { id: draftId });

    // The full published document, only when there is no draft to create from.
    const published = draft ? { images } : await groq('*[_id == $id][0]', { id: product._id });
    const { mutations, ps } = transactionFor(draftId, product.title, published, draft, assets);
    await mutate(mutations);
    console.log(`  ${product.slug}: ${draft ? 'existing draft' : 'draft created'}, `
      + `${ps.map((x) => `${x.op} ${keyFor(x.name)}`).join(', ')} -> ${draftId}`);
  }
  console.log('\n  done. Nothing is live until the drafts are published.');
};

// Only when run, not when imported by test-upload-slots.mjs.
if (process.argv[1] && path.basename(process.argv[1]) === 'upload.mjs') {
  main().catch((e) => { console.error('  failed:', e.message); process.exit(1); });
}
