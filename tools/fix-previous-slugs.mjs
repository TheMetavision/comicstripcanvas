#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lower-case the previousSlugs entries that fail Studio validation.
 *
 *   node tools/fix-previous-slugs.mjs              # dry run, the default
 *   node tools/fix-previous-slugs.mjs --apply
 *   node tools/fix-previous-slugs.mjs --category comic-book-icons --apply
 *
 * The schema requires every previousSlugs entry to be lower case, and eight
 * published products carry one that is not. The Studio refuses to publish those
 * documents until they are fixed, which is how this was found: a mockup draft
 * that changed nothing but the images array could not be published, because the
 * document it was a draft of had been failing validation since long before.
 *
 * ── This changes no redirects. That is worth being clear about ─────────────
 *
 * src/integrations/slug-redirects.mjs already lower-cases every entry before it
 * writes a rule, because Netlify folds the case of a request path before it
 * matches anything. So the case stored in Sanity has never reached the site.
 * Checked rather than assumed: the generated _redirects block is byte-identical
 * before and after, and the same entries are skipped for the same reasons.
 *
 * What this fixes is the Studio refusing to publish. Nothing else.
 *
 * ── Every one of the eight is already dead ─────────────────────────────────
 *
 * Each one lower-cases onto a slug that is in use by a LIVE product -- the
 * cover version of the same subject -- so the build skips it rather than
 * taking that product off the site. `michael-jordan` also lower-cases to the
 * product's own current slug, which would be a redirect to itself.
 *
 * They therefore produce no redirect today and will produce none afterwards.
 * Lower-casing keeps the record of the rename and satisfies the schema;
 * deleting them would do the same and leave less misleading data behind, since
 * a lower-cased entry reads as a claim on a slug another product is using. That
 * is a content decision, so this tool does the conservative half and says so.
 *
 * ── Published documents only ───────────────────────────────────────────────
 *
 * As asked. Note that seven DRAFTS carry the same bad values, and publishing
 * one of those later puts the bad value straight back. They are listed at the
 * end of every run.
 */

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};

const APPLY = flag('apply');
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

/** The schema's own slug shape: a-z, 0-9 and single hyphens, no hyphen at either end. */
export function slugify(s) {
  return String(s).trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const isBad = (s) => typeof s === 'string' && s.trim() !== '' && s !== s.toLowerCase();

export { };

const main = async () => {
  const where = CATEGORY ? ' && category == $category' : '';
  const products = await groq(
    `*[_type == "product" && !(_id in path("drafts.**")) && count(previousSlugs) > 0${where}]`
    + `{_id, _rev, "slug": slug.current, category, previousSlugs} | order(slug asc)`,
    CATEGORY ? { category: CATEGORY } : {},
  ) || [];

  const allSlugs = await groq('*[_type == "product" && defined(slug.current)]{"slug": slug.current, "draft": _id in path("drafts.**")}') || [];
  const liveLc = new Set(allSlugs.map((s) => String(s.slug).toLowerCase()));

  // Every previous slug anyone claims, so a fix cannot silently duplicate one.
  const claimed = new Map();
  for (const p of products) {
    for (const s of p.previousSlugs || []) {
      const lc = slugify(s);
      if (!lc) continue;
      if (!claimed.has(lc)) claimed.set(lc, []);
      claimed.get(lc).push(p.slug);
    }
  }

  const plan = [];
  let unsafe = 0;
  for (const p of products) {
    const before = p.previousSlugs || [];
    if (!before.some(isBad)) continue;

    const after = before.map((s) => (isBad(s) ? slugify(s) : s));
    const notes = [];
    for (const s of before.filter(isBad)) {
      const lc = s.trim().toLowerCase();
      const sl = slugify(s);
      if (sl !== lc) {
        // Lower-casing cannot change which URL a rule matches; anything more
        // can. If slugify had to do more than change case, the old URL this
        // entry stands for is not the string we would be writing.
        notes.push(`UNSAFE: "${s}" slugifies to "${sl}", not merely "${lc}" — that changes the URL this entry records`);
        unsafe += 1;
      }
      if (sl === String(p.slug).toLowerCase()) notes.push(`COLLIDES: "${sl}" is this product's own current slug — a redirect to itself`);
      if (liveLc.has(sl)) notes.push(`COLLIDES: "${sl}" is a live product slug — the build skips it rather than taking that product off the site`);
      const others = (claimed.get(sl) || []).filter((o) => o !== p.slug);
      if (others.length) notes.push(`COLLIDES: "${sl}" is also claimed as a previous slug by ${others.join(', ')}`);
    }
    plan.push({ product: p, before, after, notes });
  }

  console.log(`  ${products.length} published product(s) with previousSlugs`
    + `${CATEGORY ? ` in ${CATEGORY}` : ''}; ${plan.length} need fixing`
    + `${APPLY ? '' : '  (dry run — pass --apply to write)'}`);
  console.log('');

  for (const { product, before, after, notes } of plan) {
    console.log(`  ${product.slug}   (${product.category})`);
    console.log(`      before  ${JSON.stringify(before)}`);
    console.log(`      after   ${JSON.stringify(after)}`);
    for (const n of notes) console.log(`      ${n}`);
    console.log('');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join('tools', `previous-slugs-backup-${stamp}.json`);
  // Written before anything is sent, dry runs included.
  fs.writeFileSync(backupPath, JSON.stringify({
    when: stamp, applied: APPLY, category: CATEGORY || null,
    documents: plan.map(({ product, before }) => ({
      _id: product._id, _rev: product._rev, slug: product.slug, previousSlugs: before,
    })),
  }, null, 2));
  console.log(`  backup of ${plan.length} document(s) -> ${backupPath}`);

  const collides = plan.filter((x) => x.notes.some((n) => n.startsWith('COLLIDES'))).length;
  console.log(`  ${collides} of ${plan.length} would collide with a live or claimed slug`
    + ' — they produce no redirect now and none afterwards');
  if (unsafe) {
    console.log(`\n  ${unsafe} entr(ies) would change by more than case. Not writing anything.`);
    console.log('  Fix those by hand: the string is the old URL, and rewriting it loses the redirect.');
    process.exit(1);
  }

  // Drafts carry their own copy, and publishing one puts the bad value back.
  const badDrafts = await groq(
    '*[_type == "product" && _id in path("drafts.**") && count(previousSlugs) > 0]{"slug": slug.current, previousSlugs}',
  ) || [];
  const stillBad = badDrafts.filter((d) => (d.previousSlugs || []).some(isBad));
  if (stillBad.length) {
    console.log(`\n  NOTE: ${stillBad.length} draft(s) still carry a non-lower-case entry. This tool`);
    console.log('  patches published documents only, so publishing one of these later puts the');
    console.log('  bad value straight back:');
    for (const d of stillBad) console.log(`    ${String(d.slug).padEnd(34)} ${JSON.stringify((d.previousSlugs || []).filter(isBad))}`);
  }

  if (!APPLY) { console.log('\n  dry run: nothing written'); return; }
  if (!plan.length) { console.log('\n  nothing to do'); return; }

  for (const { product, after } of plan) {
    await mutate([{
      patch: {
        id: product._id,
        // Only if the document has not moved since it was read: this is a live
        // published document and somebody may be editing it in the Studio.
        ifRevisionID: product._rev,
        set: { previousSlugs: after },
      },
    }]);
    console.log(`  ${product.slug}: previousSlugs set`);
  }
  console.log('\n  done.');
};

if (process.argv[1] && path.basename(process.argv[1]) === 'fix-previous-slugs.mjs') {
  main().catch((e) => { console.error('  failed:', e.message); process.exit(1); });
}
