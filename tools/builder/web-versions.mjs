#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));

/**
 * Web derivatives for stock designs.
 *
 *   node tools/builder/web-versions.mjs [--in <dir>] [--out <dir>]
 *                                       [--force] [--upload] [--dry-run]
 *
 * The studio's print masters are not files on disk: studio-render-background
 * writes them to the Netlify Blobs store "studio" as studio/<id>/print.png.
 * Under `netlify dev` that store is a directory tree, and --in defaults to it.
 * Point --in at any folder of PNGs and it will read those instead.
 *
 * Three derivatives per design, none of them ever upscaled:
 *
 *   <slug>-2000.jpg    sRGB JPEG q85    the web master, and what --upload sends
 *   <slug>-1200.webp   WebP q80         listing
 *   <slug>-400.webp    WebP q80         thumb
 *
 * Metadata is stripped and any embedded profile is converted to sRGB, because
 * a print master carries a print profile and a browser handed one without
 * conversion renders it wrong.
 *
 * --upload attaches the 2000px JPEG to the product as the entry in `images[]`
 * keyed "listing" -- the one the whole frontend reads as images[0]. The key is
 * what makes it idempotent: re-running replaces that entry rather than
 * appending a second copy. Nothing else in images[] is touched, so lifestyle
 * mockups at images[1..] stay where they are.
 *
 * It also removes the old "web-master" entry if the product still has one. The
 * renderer used to write both -- a 1600px PNG and this JPEG -- and they showed
 * as two near-identical thumbnails in the gallery.
 *
 * Designs are matched to products BY ID, not by name. studio-save uses one
 * value for both halves -- the blob goes to studio/<id>/print.png and the
 * product is created as `drafts.<id>` -- so the folder a print master sits in
 * already names its product, and nothing has to be titled to match.
 *
 * A design from a --in folder has no id, so those fall back to matching the
 * filename against the product slug. Designs saved before this convention, or
 * whose product was recreated by hand, need the same treatment: copy the print
 * master into a folder, name it <product-slug>.png, and pass --in.
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const FORCE = flag('force');
const UPLOAD = flag('upload');
const DRY_RUN = flag('dry-run');

/** The local Netlify Blobs directory for the studio store, if there is one. */
function defaultInputDir() {
  const root = '.netlify/blobs-serve/entries';
  if (!fs.existsSync(root)) return null;
  for (const site of fs.readdirSync(root)) {
    const dir = path.join(root, site, 'site%3Astudio', 'studio');
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

const slugify = (s) => (s || '').toString().toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'design';

/** Every print master under `dir`, with the best slug we can give it. */
function findDesigns(dir) {
  const out = [];
  const metaRoot = dir.replace('/entries/', '/metadata/').replace('\\entries\\', '\\metadata\\');

  const consider = (file, idFolder) => {
    let title = null;
    if (idFolder) {
      // The blob store keeps metadata in a parallel tree; the title is the only
      // human name a print master has.
      const metaFile = path.join(metaRoot, idFolder, path.basename(file));
      try { title = JSON.parse(fs.readFileSync(metaFile, 'utf8')).title || null; } catch { /* no metadata */ }
    }
    /* Without a title, the id names it -- every print master is called
       print.png, so the filename would name them all the same thing. */
    const base = title || idFolder || path.basename(file, path.extname(file));
    out.push({ file, slug: slugify(base), title: base, id: idFolder || null });
  };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const printFile = path.join(dir, entry.name, 'print.png');
      if (fs.existsSync(printFile)) consider(printFile, entry.name);
    } else if (/\.png$/i.test(entry.name)) {
      consider(path.join(dir, entry.name), null);
    }
  }

  /* Two designs can carry the same title -- the studio does not stop you --
     and silently writing both to one folder would leave whichever ran last.
     Suffix the collisions with their id instead. */
  const seen = new Map();
  for (const d of out) seen.set(d.slug, (seen.get(d.slug) || 0) + 1);
  for (const d of out) {
    if (seen.get(d.slug) > 1 && d.id) d.slug = `${d.slug}-${d.id.replace(/^studio-/, '').slice(0, 8)}`;
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/* The sizes live with the function that also makes them, so the studio's
   Replace artwork path and this tool cannot drift apart. */
const { DERIVATIVES, LISTING_KEY, LEGACY_WEB_MASTER_KEY, renderDerivative, setListingImage } =
  await import('../../netlify/functions/_shared/derivatives.mjs');

const kb = (n) => `${Math.round(n / 1024)}`;

async function build(sharp, design, outRoot) {
  const dir = path.join(outRoot, design.slug);
  fs.mkdirSync(dir, { recursive: true });
  const srcStat = fs.statSync(design.file);
  const results = [];

  for (const d of DERIVATIVES) {
    const dest = path.join(dir, `${design.slug}-${d.name}`);
    if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= srcStat.mtimeMs) {
      // Read the dimensions back rather than leaving the row blank: a summary
      // that says nothing about the files it skipped is a summary you have to
      // go and check by hand.
      const meta = await sharp(dest).metadata().catch(() => ({}));
      results.push({ ...d, dest, bytes: fs.statSync(dest).size, width: meta.width, height: meta.height, skipped: true });
      continue;
    }
    const { data, info } = await renderDerivative(sharp, design.file, d);
    fs.writeFileSync(dest, data);
    results.push({ ...d, dest, bytes: data.length, width: info.width, height: info.height, skipped: false });
  }
  return { dir, results };
}

/* ---------- Sanity ---------- */

function sanityClient() {
  const envFile = '.env';
  let token = process.env.SANITY_WRITE_TOKEN;
  if (!token && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && line.slice(0, i).trim() === 'SANITY_WRITE_TOKEN') token = line.slice(i + 1).trim();
    }
  }
  if (!token) throw new Error('SANITY_WRITE_TOKEN is not set (env or .env) — needed for --upload');
  const { createClient } = require('@sanity/client');
  return createClient({
    projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11',
    token, useCdn: false,
  });
}

/* Resolve a design to its product.

   By id first, because the link already exists and is exact: studio-save uses
   ONE value for both halves -- the blob goes to studio/<id>/print.png and the
   document is created as `drafts.<id>`. So the folder name a print master sits
   in IS the product id, give or take the draft prefix, and no title or slug has
   to agree with anything. Both forms are tried because publishing a draft drops
   the prefix and keeps the rest.

   Titles are a fallback, not the plan. Two designs can share one, a product can
   be renamed after it is saved, and a folder passed with --in has no id at all
   -- that is the case slug matching is for. */
async function findProduct(sanity, design) {
  if (design.id) {
    const byId = await sanity.fetch(
      '*[_id == $id || _id == $draft][0]{ _id, title, "slug": slug.current, images }',
      { id: design.id, draft: `drafts.${design.id}` }
    );
    if (byId) return { ...byId, matchedBy: 'id' };
  }
  const bySlug = await sanity.fetch(
    '*[_type == "product" && slug.current == $slug][0]{ _id, title, "slug": slug.current, images }',
    { slug: design.slug }
  );
  return bySlug ? { ...bySlug, matchedBy: 'slug' } : null;
}

/**
 * Put the 2000px JPEG into images[] under the listing key, replacing whatever
 * was there before. Sanity has no "upsert into an array", so it is read,
 * rewritten and set -- safe here because the key makes the operation the same
 * whether it has run before or not.
 *
 * The surgery itself is setListingImage, shared with the studio renderer so
 * the tool and the renderer cannot disagree about what a product's images look
 * like. It also drops the stale "web-master" entry, which is how a product
 * uploaded before the two keys were collapsed gets tidied by a re-run.
 */
async function attach(sanity, doc, assetId, alt) {
  const { images, replaced, removedLegacy } = setListingImage(doc.images, assetId, alt);
  await sanity.patch(doc._id).set({ images }).commit();
  return (replaced ? 'replaced' : 'added') + (removedLegacy ? ' +dropped web-master' : '');
}

/* ---------- main ---------- */

async function main() {
  let sharp;
  try { sharp = require('sharp'); }
  catch { throw new Error('sharp is not installed at the repo root — run this from the project directory'); }

  const inDir = opt('in') || defaultInputDir();
  if (!inDir) {
    throw new Error('No input folder. Pass --in <dir>, or run the studio locally so ' +
      '.netlify/blobs-serve holds a print master.');
  }
  if (!fs.existsSync(inDir)) throw new Error(`Input folder does not exist: ${inDir}`);
  const outRoot = opt('out') || 'tools/builder/web-out';

  const designs = findDesigns(inDir);
  if (!designs.length) throw new Error(`No print masters found under ${inDir}`);

  console.log(`in : ${inDir}`);
  console.log(`out: ${outRoot}`);
  console.log(`${designs.length} design(s)${UPLOAD ? (DRY_RUN ? ' — upload: DRY RUN' : ' — uploading') : ''}\n`);

  const sanity = UPLOAD ? sanityClient() : null;
  const rows = [];
  let failures = 0;

  for (const design of designs) {
    let built;
    try {
      built = await build(sharp, design, outRoot);
    } catch (err) {
      failures++;
      rows.push({ slug: design.slug, sizes: 'FAILED', kb: '-', uploaded: err.message.slice(0, 40) });
      continue;
    }

    const sizes = built.results.map((r) => (r.width ? `${r.width}x${r.height}` : '—')).join(' / ');
    const kbs = built.results.map((r) => kb(r.bytes) + (r.skipped ? '*' : '')).join(' / ');
    let uploaded = UPLOAD ? '' : '—';

    if (UPLOAD) {
      const master = built.results.find((r) => r.name === '2000.jpg');
      try {
        const doc = await findProduct(sanity, design);
        if (!doc) {
          uploaded = design.id ? 'no product (id or slug)' : 'no product';
          failures++;
        } else if (DRY_RUN) {
          const has = (doc.images || []).some((i) => i && i._key === LISTING_KEY);
          const stale = (doc.images || []).some((i) => i && i._key === LEGACY_WEB_MASTER_KEY);
          uploaded = `would ${has ? 'replace' : 'add'}${stale ? ' +drop web-master' : ''} ` +
            `on ${doc.slug || doc._id} (by ${doc.matchedBy})`;
        } else {
          const asset = await sanity.assets.upload('image', fs.createReadStream(master.dest), {
            filename: `${design.slug}-2000.jpg`, contentType: 'image/jpeg',
          });
          uploaded = `${await attach(sanity, doc, asset._id, `${design.title} — Comic Strip Canvas`)} (by ${doc.matchedBy})`;
        }
      } catch (err) {
        failures++;
        uploaded = `ERROR ${err.message.slice(0, 40)}`;
      }
    }
    rows.push({ slug: design.slug, sizes, kb: kbs, uploaded });
  }

  const w = (key, min) => Math.max(min, ...rows.map((r) => String(r[key]).length));
  const cols = [['slug', w('slug', 4)], ['sizes', w('sizes', 5)], ['kb', w('kb', 8)], ['uploaded', w('uploaded', 8)]];
  const line = (r) => cols.map(([k, n]) => String(r[k]).padEnd(n)).join('  ');
  console.log(line({ slug: 'DESIGN', sizes: 'SIZES', kb: 'KB', uploaded: 'UPLOADED' }));
  console.log(cols.map(([, n]) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
  console.log('\n* = already up to date, left alone (use --force to rebuild)');

  if (failures) {
    console.error(`\n${failures} failure(s).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nweb-versions: ${err.message}`);
  process.exit(1);
});
