#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Put the rendered mockups onto products, reversibly.
 *
 *   node tools/mockup/upload.mjs --slug walter-white-icon
 *   node tools/mockup/upload.mjs --category comic-book-icons --dry-run
 *
 * Reads tools/mockup/out/<slug>/{room,studio,poster}.jpg and appends them to
 * the product's images[] as entries 1, 2 and 3, each with alt
 *
 *     "<title> lifestyle mockup — Comic Strip Canvas"
 *
 * The alt is the contract. strip-mockups.mjs finds these entries by matching
 * /lifestyle mockup/i and nothing else, so the wording is not decoration: get
 * it wrong and the mockups become unremovable by the tool built to remove them.
 *
 * ── What it will not touch ─────────────────────────────────────────────────
 *
 * images[0], and any entry keyed "listing". images[0] is the product image the
 * whole site reads -- the store grid, the feed, the cards -- and the listing
 * entry is the rendered artwork itself. Both are checked before any mutation is
 * built, and a product whose slot 0 looks wrong is skipped rather than fixed,
 * because a mockup tool quietly rearranging product images is exactly the kind
 * of helpfulness nobody asked for.
 *
 * ── Drafts only ────────────────────────────────────────────────────────────
 *
 * Every patch goes to drafts.<id>, created from the published document if there
 * is not one already. Nothing this writes is visible to a customer until
 * somebody opens the Studio and presses Publish. That is deliberate: these are
 * generated pictures going onto live product pages, and they should be looked
 * at by a person first.
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

const PROJECT = 'lwbwahym';
const DATASET = 'production';
const NAMES = ['room', 'studio', 'poster'];
const LISTING_KEY = 'listing';
const altFor = (title) => `${title} lifestyle mockup — Comic Strip Canvas`;

const env = fs.readFileSync('.env', 'utf8');
const TOKEN = (/^SANITY_WRITE_TOKEN\s*=\s*(.+)$/m.exec(env) || [])[1]?.trim().replace(/^["']|["']$/g, '');
if (!TOKEN) { console.error('  no SANITY_WRITE_TOKEN in .env'); process.exit(1); }

const api = (p) => `https://${PROJECT}.api.sanity.io/v2021-10-21/${p}`;
const groq = async (query, params = {}) => {
  let url = api(`data/query/${DATASET}?query=${encodeURIComponent(query)}`);
  for (const [k, v] of Object.entries(params)) url += `&$${k}=${encodeURIComponent(JSON.stringify(v))}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
};

/** Upload one file to the asset library and return its id. */
async function uploadAsset(file) {
  const body = fs.readFileSync(file);
  const url = api(`assets/images/${DATASET}?filename=${encodeURIComponent(path.basename(file))}`);
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/jpeg' },
    body,
  }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.document._id;
}

async function mutate(mutations) {
  const r = await fetch(api(`data/mutate/${DATASET}?returnIds=true`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ mutations }),
  }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r;
}

const main = async () => {
  if (!SLUGS.length && !CATEGORY) {
    console.error('  give --slug (repeatable) or --category');
    process.exit(1);
  }
  const where = SLUGS.length ? 'slug.current in $slugs' : 'category == $category';
  const products = await groq(
    `*[_type == "product" && !(_id in path("drafts.**")) && ${where}]{
       _id, title, "slug": slug.current, category, images
     } | order(slug asc)`,
    SLUGS.length ? { slugs: SLUGS } : { category: CATEGORY },
  ) || [];
  console.log(`  ${products.length} product(s)${DRY ? '  (dry run)' : ''}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join('tools', 'mockup', `upload-backup-${stamp}.json`);
  const backup = [];
  const plan = [];

  for (const p of products) {
    const dir = path.join(OUT_DIR, p.slug);
    const files = NAMES.map((n) => path.join(dir, `${n}.jpg`));
    const missing = files.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      console.log(`  ${p.slug}: no renders yet (${missing.length} of 3 missing) — skipped`);
      continue;
    }
    const images = p.images || [];
    if (!images.length) {
      console.log(`  ${p.slug}: images[] is empty — skipped, slot 0 must already hold the product image`);
      continue;
    }
    const already = images.filter((im) => /lifestyle mockup/i.test(im?.alt || '')).length;
    if (already) {
      console.log(`  ${p.slug}: already carries ${already} mockup(s) — skipped, strip them first`);
      continue;
    }
    backup.push({ _id: p._id, slug: p.slug, title: p.title, images });
    plan.push({ product: p, files });
    console.log(`  ${p.slug}: would add 3 at images[1..3], keeping ${images.length} existing`
      + ` (slot 0 = ${images[0]?._key === LISTING_KEY ? 'listing' : images[0]?._key || 'unkeyed'})`);
  }

  // Written before anything is sent, and on a dry run too.
  fs.writeFileSync(backupPath, JSON.stringify({ when: stamp, dryRun: DRY, documents: backup }, null, 2));
  console.log(`\n  backup of ${backup.length} document(s) -> ${backupPath}`);

  if (DRY) { console.log('  dry run: nothing uploaded, nothing patched'); return; }

  for (const { product, files } of plan) {
    const entries = [];
    for (const f of files) {
      const assetId = await uploadAsset(f);
      entries.push({
        _type: 'image',
        _key: crypto.randomBytes(6).toString('hex'),
        asset: { _type: 'reference', _ref: assetId },
        alt: altFor(product.title),
      });
    }
    const draftId = `drafts.${product._id}`;
    const draft = await groq('*[_id == $id][0]{_id}', { id: draftId });
    const mutations = [];
    if (!draft) {
      // createIfNotExists from the published document, so the draft starts as
      // a faithful copy and the patch below is the only difference.
      const full = await groq('*[_id == $id][0]', { id: product._id });
      mutations.push({ createIfNotExists: { ...full, _id: draftId } });
    }
    mutations.push({
      patch: {
        id: draftId,
        // insert after images[0]: never before it, never replacing it
        insert: { after: 'images[0]', items: entries },
      },
    });
    await mutate(mutations);
    console.log(`  ${product.slug}: 3 mockup(s) added to ${draftId}`);
  }
  console.log(`\n  done. Nothing is live until the drafts are published.`);
};

main().catch((e) => { console.error('  failed:', e.message); process.exit(1); });
