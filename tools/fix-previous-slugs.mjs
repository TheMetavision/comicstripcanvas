#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Remove the previousSlugs entries that block publishing.
 *
 *   node tools/fix-previous-slugs.mjs --category comic-book-icons
 *   node tools/fix-previous-slugs.mjs --category comic-book-icons --apply
 *   node tools/fix-previous-slugs.mjs --category comic-book-icons --lowercase
 *
 * Dry run by default. --apply writes. --lowercase keeps the old behaviour of
 * lower-casing the entry instead of dropping it.
 *
 * ── Why removal and not lower-casing ───────────────────────────────────────
 *
 * The schema requires every previousSlugs entry to be lower case, eight
 * published comic icons carry one that is not, and the Studio will not publish
 * a document that fails validation -- which is how this surfaced, as a mockup
 * draft that changed nothing but the images array and could not be published.
 *
 * Lower-casing satisfies the schema and achieves nothing else. Every one of the
 * eight lower-cases onto a slug that a LIVE product is using -- the cover
 * version of the same subject -- so src/integrations/slug-redirects.mjs skips
 * it rather than taking that product off the site, and the build emits zero
 * generated redirects today and would emit zero afterwards. Checked rather than
 * assumed, through the integration's own redirectLines() against the build's
 * own query: the _redirects block is byte-identical either way.
 *
 * So the choice is between two entries that both do nothing, and the
 * lower-cased one is the worse of the two: "ed-sheeran" sitting in
 * ed-sheeran-icon's previousSlugs reads as a claim on a slug another product is
 * using, and the next person to read it has to rediscover that the build
 * silently drops it. Removing it says the same thing -- no redirect -- without
 * the misdirection.
 *
 * What is lost is the record that the rename happened. That record is not doing
 * any work here: it cannot become a redirect while the old slug belongs to a
 * live product, and if that product is ever retired the entry would have to be
 * re-added deliberately anyway, because it would then change what the URL does.
 *
 * ── Both the published document and its draft ──────────────────────────────
 *
 * The mockup upload creates drafts from published content, so every one of
 * these drafts carries the same bad value. Fixing only the published document
 * would leave the draft failing validation, and publish.mjs holds any draft
 * that differs from its published document by more than mockup-* entries --
 * so the mockups would still be unpublishable, for a reason nobody had
 * changed. Both are patched, to the same value, each with its own
 * ifRevisionID so a concurrent Studio edit fails the write rather than losing
 * it.
 *
 * Where a draft's previousSlugs would not end up identical to its published
 * document's, the product is held and neither is touched: that is a draft
 * somebody has edited, and it wants a human.
 *
 * ── Afterwards ─────────────────────────────────────────────────────────────
 *
 *   npx sanity documents validate -y --dataset production --level error
 *
 * run from studio/, should report no previousSlugs errors on any
 * comic-book-icons document, published or draft.
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const APPLY = flag('apply');
const LOWERCASE = flag('lowercase');
const CATEGORY = opt('category');
const PROJECT = 'lwbwahym';
const DATASET = 'production';
const API = 'v2021-10-21';

let _token = null;
const token = () => {
  if (_token) return _token;
  const env = fs.readFileSync('.env', 'utf8');
  _token = (/^SANITY_WRITE_TOKEN\s*=\s*(.+)$/m.exec(env) || [])[1]?.trim().replace(/^["']|["']$/g, '');
  if (!_token) { console.error('  no SANITY_WRITE_TOKEN in .env'); process.exit(1); }
  return _token;
};

const groq = async (q, p = {}) => {
  let url = `https://${PROJECT}.api.sanity.io/${API}/data/query/${DATASET}?query=${encodeURIComponent(q)}`;
  for (const [k, v] of Object.entries(p)) url += `&$${k}=${encodeURIComponent(JSON.stringify(v))}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
};

const mutate = async (mutations) => {
  const r = await fetch(`https://${PROJECT}.api.sanity.io/${API}/data/mutate/${DATASET}?returnIds=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ mutations }),
  }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r;
};

/** The schema's own slug shape: a-z, 0-9 and single hyphens, none at either end. */
export function slugify(s) {
  return String(s).trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const isBad = (s) => typeof s === 'string' && s.trim() !== '' && s !== s.toLowerCase();

/** The corrected array: offenders dropped, or lower-cased under --lowercase. */
export function fixList(list, lowercase = false) {
  const out = [];
  for (const s of list || []) {
    if (!isBad(s)) { out.push(s); continue; }
    if (lowercase) out.push(slugify(s));
  }
  return out;
}

/** set, or unset when nothing is left -- an empty array is not the same as no field. */
export function patchFor(id, rev, after) {
  const base = { id, ifRevisionID: rev };
  return after.length
    ? { patch: { ...base, set: { previousSlugs: after } } }
    : { patch: { ...base, unset: ['previousSlugs'] } };
}

const main = async () => {
  const where = CATEGORY ? ' && category == $category' : '';
  const params = CATEGORY ? { category: CATEGORY } : {};
  const published = await groq(
    `*[_type == "product" && !(_id in path("drafts.**")) && count(previousSlugs) > 0${where}]`
    + '{_id, _rev, "slug": slug.current, category, previousSlugs} | order(slug asc)', params) || [];
  const drafts = await groq(
    `*[_type == "product" && _id in path("drafts.**") && count(previousSlugs) > 0${where}]`
    + '{_id, _rev, "slug": slug.current, previousSlugs}', params) || [];
  const draftFor = new Map(drafts.map((d) => [d._id.replace(/^drafts\./, ''), d]));

  const allSlugs = await groq('*[_type == "product" && defined(slug.current)].slug.current') || [];
  const liveLc = new Set(allSlugs.filter(Boolean).map((s) => String(s).toLowerCase()));

  const plan = [];
  const holds = [];
  for (const p of published) {
    if (!(p.previousSlugs || []).some(isBad)) continue;
    const draft = draftFor.get(p._id);
    const afterPub = fixList(p.previousSlugs, LOWERCASE);
    const afterDraft = draft ? fixList(draft.previousSlugs, LOWERCASE) : null;

    if (draft && JSON.stringify(afterDraft) !== JSON.stringify(afterPub)) {
      holds.push({
        slug: p.slug,
        why: `the draft's previousSlugs would end up ${JSON.stringify(afterDraft)} and the published `
          + `document's ${JSON.stringify(afterPub)} — somebody has edited that draft`,
      });
      continue;
    }

    const notes = [];
    for (const s of (p.previousSlugs || []).filter(isBad)) {
      const lc = slugify(s);
      if (lc === String(p.slug).toLowerCase()) notes.push(`"${lc}" was this product's own current slug — a redirect to itself`);
      else if (liveLc.has(lc)) notes.push(`"${lc}" is a live product's slug — the build already skips it, so this entry emits nothing`);
      else notes.push(`"${lc}" is not in use — this entry WOULD have emitted a redirect`);
      if (LOWERCASE && lc !== s.trim().toLowerCase()) {
        notes.push(`UNSAFE: "${s}" slugifies to "${lc}", not merely to lower case — that changes the URL this entry records`);
      }
    }
    plan.push({ product: p, draft, afterPub, notes });
  }

  const docs = plan.reduce((n, x) => n + 1 + (x.draft ? 1 : 0), 0);
  console.log(`  ${LOWERCASE ? 'LOWERCASE' : 'REMOVE'} mode${APPLY ? '' : '   (dry run — pass --apply to write)'}`);
  console.log(`  ${plan.length} product(s) to fix across ${docs} document(s)`
    + ` (${plan.length} published, ${plan.filter((x) => x.draft).length} draft)`);
  console.log('');

  for (const { product, draft, afterPub, notes } of plan) {
    console.log(`  ${product.slug}   (${product.category})`);
    console.log(`      published  ${JSON.stringify(product.previousSlugs)}  ->  ${afterPub.length ? JSON.stringify(afterPub) : '(field removed)'}`);
    if (draft) {
      console.log(`      draft      ${JSON.stringify(draft.previousSlugs)}  ->  ${afterPub.length ? JSON.stringify(afterPub) : '(field removed)'}`);
    } else {
      console.log('      draft      none');
    }
    for (const n of notes) console.log(`      ${n}`);
    console.log('');
  }

  for (const h of holds) console.log(`  HELD  ${h.slug}: ${h.why}`);
  if (holds.length) console.log('');

  const unsafe = plan.filter((x) => x.notes.some((n) => n.startsWith('UNSAFE:')));
  const wouldHaveRedirected = plan.filter((x) => x.notes.some((n) => n.includes('WOULD have emitted')));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join('tools', `previous-slugs-backup-${stamp}.json`);
  // Written before anything is sent, dry runs included, with both documents.
  fs.writeFileSync(backupPath, JSON.stringify({
    when: stamp, applied: APPLY, mode: LOWERCASE ? 'lowercase' : 'remove', category: CATEGORY || null,
    documents: plan.flatMap(({ product, draft }) => [
      { _id: product._id, _rev: product._rev, slug: product.slug, previousSlugs: product.previousSlugs },
      ...(draft ? [{ _id: draft._id, _rev: draft._rev, slug: draft.slug, previousSlugs: draft.previousSlugs }] : []),
    ]),
  }, null, 2));
  console.log(`  backup of ${docs} document(s) -> ${backupPath}`);

  if (wouldHaveRedirected.length) {
    console.log(`\n  ${wouldHaveRedirected.length} entr(ies) are NOT dead -- their lower-cased form is not in use,`);
    console.log('  so removing them loses a redirect that would otherwise work:');
    for (const x of wouldHaveRedirected) console.log(`    ${x.product.slug}`);
    console.log('  Use --lowercase for those, or remove them knowing what goes.');
  }
  if (unsafe.length) {
    console.log(`\n  ${unsafe.length} entr(ies) would change by more than case under --lowercase. Nothing written.`);
    process.exit(1);
  }

  if (!APPLY) { console.log('\n  dry run: nothing written'); return; }
  if (!plan.length) { console.log('\n  nothing to do'); return; }

  for (const { product, draft, afterPub } of plan) {
    // One transaction per product: the published document and its draft move
    // together or not at all. Half of this applied is a draft that still
    // differs from its published document, which is the state being fixed.
    const mutations = [patchFor(product._id, product._rev, afterPub)];
    if (draft) mutations.push(patchFor(draft._id, draft._rev, afterPub));
    await mutate(mutations);
    console.log(`  ${product.slug}: patched ${draft ? 'published + draft' : 'published'}`);
  }
  console.log('\n  done. Re-run: npx sanity documents validate -y --dataset production --level error');
};

if (process.argv[1] && path.basename(process.argv[1]) === 'fix-previous-slugs.mjs') {
  main().catch((e) => { console.error('  failed:', e.message); process.exit(1); });
}
