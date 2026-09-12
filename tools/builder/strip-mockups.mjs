#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));

/**
 * Take the lifestyle mockups back out of products.
 *
 *   node tools/builder/strip-mockups.mjs [--category <slug>] [--id <docId>] [--apply]
 *   node tools/builder/strip-mockups.mjs --restore tools/builder/mockup-backup-<ts>.json
 *
 * An entry is removed only if ALL of these hold:
 *
 *   its alt matches /lifestyle mockup/i
 *   it is not images[0]          -- that slot is the product image the whole
 *                                   site reads, whatever it happens to be called
 *   it is not keyed "listing"    -- the rendered product image, belt and braces
 *
 * Anything else is left alone. A product carrying only its listing image is a
 * no-op and is not patched at all.
 *
 * NOTHING IS DELETED FROM THE ASSET LIBRARY. Only the references in images[]
 * go; every asset stays where it is, which is what makes --restore possible
 * weeks later rather than only while the backup file is fresh.
 *
 * A dry run is the default, and it still writes the restore file -- so the
 * backup exists before anyone has had the chance to need it. --apply writes one
 * too, because applying without a way back is not a thing this should offer.
 *
 * Published documents and their drafts are handled separately, as they are:
 * each is its own document with its own images[], patched by its own id.
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const APPLY = flag('apply');
const RESTORE = opt('restore');
const CATEGORY = opt('category');
/* One document, by id. Narrower than --category and the only safe way to try
   --apply against the real dataset: without it the default scope is every
   product there is. Takes the id exactly, so a draft needs its drafts. prefix. */
const ONLY_ID = opt('id');
const CATEGORIES = ['comic-book-covers', 'comic-book-icons', 'comic-book-strips'];

/** The one thing this looks for. */
const MOCKUP_ALT = /lifestyle mockup/i;
/** The rendered product image. Never removed, whatever its alt says. */
const LISTING_KEY = 'listing';

const BACKUP_DIR = 'tools/builder';

function sanityClient() {
  let token = process.env.SANITY_WRITE_TOKEN;
  if (!token && fs.existsSync('.env')) {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === 'SANITY_WRITE_TOKEN') token = line.slice(i + 1).trim();
    }
  }
  if (!token) throw new Error('SANITY_WRITE_TOKEN is not set (env or .env)');
  const { createClient } = require('@sanity/client');
  return createClient({
    projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
    token, useCdn: false,
    /* raw, so a published document and its draft are two documents rather than
       one overlaid on the other. Each has its own images[] and each is patched
       by its own id. */
    perspective: 'raw',
  });
}

/**
 * Which entries of this product's images[] are lifestyle mockups that may go.
 * Returns them with the index they were found at, newest-last, so a restore can
 * put them back where they were.
 */
function doomedEntries(images) {
  const list = Array.isArray(images) ? images : [];
  const out = [];
  list.forEach((entry, index) => {
    if (!entry) return;
    if (index === 0) return;                       // the product image, always
    if (entry._key === LISTING_KEY) return;        // the rendered one, always
    if (!MOCKUP_ALT.test(entry.alt || '')) return; // only what was asked for
    out.push({ index, _key: entry._key, alt: entry.alt || null, ref: entry.asset?._ref || null, entry });
  });
  return out;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
const kb = (n) => `${Math.round(n / 1024)} KB`;

function table(rows, cols) {
  const w = cols.map(([k, label]) => Math.max(label.length, ...rows.map((r) => String(r[k] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ');
  console.log(line(cols.map(([, l]) => l)));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(cols.map(([k]) => r[k])));
}

/* ---------------------------------------------------------------- strip --- */

async function strip(sanity) {
  if (CATEGORY && !CATEGORIES.includes(CATEGORY)) {
    throw new Error(`--category must be one of ${CATEGORIES.join(', ')}`);
  }
  const filter = (CATEGORY ? ' && category == $category' : '') + (ONLY_ID ? ' && _id == $id' : '');
  const params = { ...(CATEGORY ? { category: CATEGORY } : {}), ...(ONLY_ID ? { id: ONLY_ID } : {}) };
  const products = await sanity.fetch(
    `*[_type == "product"${filter}] | order(title asc){ _id, title, category, "slug": slug.current, images }`,
    params
  );
  if (ONLY_ID && !products.length) throw new Error(`no product with _id ${ONLY_ID}`);

  const plan = [];
  for (const p of products) {
    const doomed = doomedEntries(p.images);
    if (!doomed.length) continue;
    plan.push({ product: p, doomed });
  }

  console.log(`${products.length} product document(s)${CATEGORY ? ` in ${CATEGORY}` : ''}${ONLY_ID ? ` matching ${ONLY_ID}` : ''}`
    + `, ${plan.length} with lifestyle mockups to remove`
    + (APPLY ? '' : '  —  DRY RUN, nothing will be written'));
  console.log('');

  if (!plan.length) {
    console.log('Nothing to do.');
    return { plan, backupFile: null, failures: 0 };
  }

  table(plan.map(({ product, doomed }) => ({
    product: `${product.title || '(untitled)'}${product._id.startsWith('drafts.') ? ' · draft' : ''}`,
    slug: product.slug || '—',
    images: (product.images || []).length,
    remove: doomed.length,
    keys: doomed.map((d) => `${d._key}@${d.index}`).join(' '),
  })), [['product', 'PRODUCT'], ['slug', 'SLUG'], ['images', 'IMAGES'], ['remove', 'REMOVE'], ['keys', 'KEY@INDEX']]);

  /* The backup is written whichever mode this is, and BEFORE any patch. */
  const backup = {
    createdAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    category: CATEGORY || null,
    note: 'Assets are NOT deleted by strip-mockups; every ref below still exists in the library.',
    products: plan.map(({ product, doomed }) => ({
      _id: product._id,
      title: product.title || null,
      imagesBefore: (product.images || []).length,
      removed: doomed.map((d) => ({ index: d.index, _key: d._key, alt: d.alt, ref: d.ref, entry: d.entry })),
    })),
  };
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backupFile = path.join(BACKUP_DIR, `mockup-backup-${stamp()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 1));
  const totalEntries = plan.reduce((n, p) => n + p.doomed.length, 0);
  console.log('');
  console.log(`restore file: ${backupFile}  (${totalEntries} entr${totalEntries === 1 ? 'y' : 'ies'}, ${kb(fs.statSync(backupFile).size)})`);

  if (!APPLY) {
    console.log('');
    console.log('Dry run. Re-run with --apply to remove them, or keep the file above to restore later.');
    return { plan, backupFile, failures: 0 };
  }

  console.log('');
  let failures = 0, patched = 0, removed = 0;
  for (const { product, doomed } of plan) {
    try {
      await sanity
        .patch(product._id)
        .unset(doomed.map((d) => `images[_key=="${d._key}"]`))
        .commit();
      patched++; removed += doomed.length;
      console.log(`  removed ${doomed.length} from ${product._id}`);
    } catch (err) {
      failures++;
      console.error(`  FAILED ${product._id}: ${err.message}`);
    }
  }
  console.log('');
  console.log(`${patched} product(s) patched, ${removed} entr${removed === 1 ? 'y' : 'ies'} removed, `
    + `${failures} failure(s). No assets were deleted.`);
  return { plan, backupFile, failures };
}

/* -------------------------------------------------------------- restore --- */

async function restore(sanity, file) {
  if (!fs.existsSync(file)) throw new Error(`no such backup: ${file}`);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(backup.products)) throw new Error(`${file} is not a mockup backup`);

  console.log(`restoring from ${file}  (taken ${backup.createdAt}, mode ${backup.mode})`);
  console.log('');

  let failures = 0, put = 0, skipped = 0;
  for (const rec of backup.products) {
    try {
      const doc = await sanity.getDocument(rec._id);
      if (!doc) { console.log(`  skipped ${rec._id} — the document is gone`); skipped += rec.removed.length; continue; }
      const images = Array.isArray(doc.images) ? doc.images.slice() : [];

      /* Lowest index first, so each insertion lands before the next one is
         placed and the original order rebuilds itself. An entry already back in
         place is left alone, which makes running this twice harmless. */
      const back = [...rec.removed].sort((a, b) => a.index - b.index);
      let added = 0;
      for (const r of back) {
        if (images.some((i) => i && i._key === r._key)) { skipped++; continue; }
        const at = Math.min(Math.max(r.index, 1), images.length);   // never index 0
        images.splice(at, 0, r.entry);
        added++;
      }
      if (!added) { console.log(`  ${rec._id} — already complete`); continue; }
      await sanity.patch(rec._id).set({ images }).commit();
      put += added;
      console.log(`  restored ${added} to ${rec._id} (${images.length} images now)`);
    } catch (err) {
      failures++;
      console.error(`  FAILED ${rec._id}: ${err.message}`);
    }
  }
  console.log('');
  console.log(`${put} entr${put === 1 ? 'y' : 'ies'} restored, ${skipped} already present or orphaned, ${failures} failure(s).`);
  return { failures };
}

/* ----------------------------------------------------------------- main --- */

async function main() {
  if (APPLY && RESTORE) throw new Error('--apply and --restore do different things; pick one');
  const sanity = sanityClient();
  const { failures } = RESTORE ? await restore(sanity, RESTORE) : await strip(sanity);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(`\nstrip-mockups: ${err.message}`);
  process.exit(1);
});
