#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Publish the drafts that upload.mjs made, and only those.
 *
 *   node tools/mockup/publish.mjs --category comic-book-icons --dry-run
 *   node tools/mockup/publish.mjs --category comic-book-icons --limit 5
 *   node tools/mockup/publish.mjs --slug walter-white-icon
 *
 * upload.mjs writes mockups to drafts.<id> so a person can look at them before
 * they go live. This is the other half: it publishes a draft when the ONLY
 * thing that draft did was gain mockup entries, and refuses -- loudly, by
 * name -- when anything else differs.
 *
 * ── Why it refuses rather than publishes ───────────────────────────────────
 *
 * A draft is shared state. The Studio writes to the same document, so by the
 * time this runs a draft may also carry a price correction somebody was part
 * way through, a retitle, a new description, an image added by hand. Publishing
 * that draft because it happens to contain a mockup would push all of it live
 * at once, and nobody asked for the rest of it to go live -- least of all the
 * person who left it half finished.
 *
 * So the test is not "does this draft contain a mockup". It is "is a mockup the
 * only difference". Everything else is held and listed, and a human decides.
 *
 * ── What counts as no difference ───────────────────────────────────────────
 *
 * _id, _rev, _createdAt and _updatedAt are ignored: they differ between a draft
 * and its published document by definition and say nothing about content. They
 * are stripped at the TOP LEVEL only -- _key, _type and _ref inside the images
 * array are content, and two images arrays that differ in a _key differ.
 *
 * Everything else is compared deeply, with object keys sorted so that field
 * order cannot masquerade as a change.
 *
 * ── What counts as gaining a mockup ────────────────────────────────────────
 *
 * Entries keyed mockup-* (mockup-poster today; mockup-room and mockup-studio
 * when those scenes come back). The draft may have mockup entries the published
 * document does not. It may NOT have changed or dropped one that is already
 * published: that is an edit to something live, not an addition, and it is held
 * for the same reason as a retitle. Re-publishing a corrected mockup is a real
 * thing to want, but it should be a decision, not a side effect of this run.
 *
 * ── The backup ─────────────────────────────────────────────────────────────
 *
 * Every run writes publish-backup-<timestamp>.json holding each PUBLISHED
 * document as it was before anything was sent -- dry runs included. That is the
 * state a publish overwrites, so it is the state worth keeping.
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
const LIMIT = opt('limit') === null ? null : Number(opt('limit'));
const BATCH = opt('batch') === null ? 10 : Number(opt('batch'));

const PROJECT = 'lwbwahym';
const DATASET = 'production';
// The actions API is newer than the rest of this folder's endpoints and is
// versioned separately; sanity.action.document.publish does not exist on the
// 2021 API this project otherwise uses.
const API = 'v2021-10-21';
const ACTIONS_API = 'v2024-05-23';

const MOCKUP_PREFIX = 'mockup-';
// Differ between a draft and its published document by definition.
const SYSTEM_FIELDS = new Set(['_id', '_rev', '_createdAt', '_updatedAt']);

let _token = null;
const token = () => {
  if (_token) return _token;
  const env = fs.readFileSync('.env', 'utf8');
  _token = (/^SANITY_WRITE_TOKEN\s*=\s*(.+)$/m.exec(env) || [])[1]?.trim().replace(/^["']|["']$/g, '');
  if (!_token) { console.error('  no SANITY_WRITE_TOKEN in .env'); process.exit(1); }
  return _token;
};

const groq = async (query, params = {}) => {
  let url = `https://${PROJECT}.api.sanity.io/${API}/data/query/${DATASET}?query=${encodeURIComponent(query)}`;
  for (const [k, v] of Object.entries(params)) url += `&$${k}=${encodeURIComponent(JSON.stringify(v))}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.result;
};

const act = async (actions, dryRun = false) => {
  const url = `https://${PROJECT}.api.sanity.io/${ACTIONS_API}/data/actions/${DATASET}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ actions, dryRun }),
  }).then((x) => x.json());
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r;
};

const publishAction = (id) => ({
  actionType: 'sanity.action.document.publish',
  draftId: `drafts.${id}`,
  publishedId: id,
});

/** A value with every object's keys in a fixed order, so field order is not a diff. */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((a, k) => { a[k] = stable(v[k]); return a; }, {});
  }
  return v;
}

const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** The document without the fields that always differ between draft and published. */
function stripSystem(doc) {
  const out = {};
  for (const k of Object.keys(doc || {})) if (!SYSTEM_FIELDS.has(k)) out[k] = doc[k];
  return out;
}

const isMockup = (im) => typeof im?._key === 'string' && im._key.startsWith(MOCKUP_PREFIX);
const byKey = (images) => new Map((images || []).filter(isMockup).map((im) => [im._key, im]));

/**
 * Whether this draft may be published, and if not, why not.
 *
 * @returns {state, summary, gained}
 *   state 'no-draft'    nothing to do
 *         'identical'   the draft matches what is already published
 *         'publishable' the draft gained mockup entries and changed nothing else
 *         'held'        something else differs; summary names it
 */
function classify(published, draft) {
  if (!draft) return { state: 'no-draft', summary: '', gained: [] };

  const p = stripSystem(published);
  const d = stripSystem(draft);
  const reasons = [];

  // 1. Every field except images, in both directions so a deletion counts.
  const fields = new Set([...Object.keys(p), ...Object.keys(d)]);
  fields.delete('images');
  const changed = [...fields].filter((k) => !same(p[k], d[k])).sort();
  if (changed.length) reasons.push(changed.join(', '));

  // 2. The images that are not mockups must be untouched, in place and in order.
  const pNon = (p.images || []).filter((im) => !isMockup(im));
  const dNon = (d.images || []).filter((im) => !isMockup(im));
  if (!same(pNon, dNon)) reasons.push('images: non-mockup entries differ');

  // 3. A mockup already published may not be changed or dropped here.
  const pMock = byKey(p.images);
  const dMock = byKey(d.images);
  for (const [key, entry] of pMock) {
    if (!dMock.has(key)) reasons.push(`images: ${key} removed from the draft`);
    else if (!same(entry, dMock.get(key))) reasons.push(`images: ${key} changed rather than added`);
  }

  const gained = [...dMock.keys()].filter((k) => !pMock.has(k)).sort();
  if (reasons.length) return { state: 'held', summary: reasons.join('; '), gained };
  if (!gained.length) return { state: 'identical', summary: '', gained: [] };
  return { state: 'publishable', summary: `gains ${gained.join(', ')}`, gained };
}

export { classify, stripSystem, stable, same, isMockup, SYSTEM_FIELDS, MOCKUP_PREFIX };

const main = async () => {
  if (!SLUGS.length && !CATEGORY) {
    console.error('  give --slug (repeatable) or --category');
    process.exit(1);
  }
  if (LIMIT !== null && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
    console.error(`  --limit takes a whole number of products, not '${opt('limit')}'`);
    process.exit(1);
  }
  if (!Number.isInteger(BATCH) || BATCH < 1) {
    console.error(`  --batch takes a whole number of actions, not '${opt('batch')}'`);
    process.exit(1);
  }

  const where = SLUGS.length ? 'slug.current in $slugs' : 'category == $category';
  const params = SLUGS.length ? { slugs: SLUGS } : { category: CATEGORY };
  // Whole documents, not a projection: the comparison is "does anything at all
  // differ", which a projection would quietly answer for a subset of the fields.
  const published = await groq(
    `*[_type == "product" && !(_id in path("drafts.**")) && ${where}] | order(slug.current asc)`,
    params,
  ) || [];

  const found = published.length;
  if (LIMIT !== null) published.length = Math.min(published.length, LIMIT);
  console.log(`  ${published.length} product(s)${found !== published.length ? ` of ${found} (--limit ${LIMIT})` : ''}`
    + `${DRY ? '  (dry run)' : ''}`);

  // Fetched by type rather than by a list of ids: 244 ids in a query string is
  // a ten-kilobyte URL, and the id list is exactly what we already know.
  const drafts = await groq('*[_id in path("drafts.**") && _type == "product"]') || [];
  const draftById = new Map(drafts.map((d) => [d._id, d]));

  const publishable = [];
  const held = [];
  let noDraft = 0;
  let identical = 0;

  for (const p of published) {
    const draft = draftById.get(`drafts.${p._id}`);
    const { state, summary } = classify(p, draft);
    if (state === 'no-draft') { noDraft += 1; continue; }
    if (state === 'identical') {
      identical += 1;
      console.log(`  ${p.slug?.current || p._id}: draft matches what is published — nothing to publish`);
      continue;
    }
    if (state === 'held') {
      held.push({ slug: p.slug?.current || p._id, summary });
      console.log(`  ${p.slug?.current || p._id}: HELD — ${summary}`);
      continue;
    }
    publishable.push({ product: p, summary });
    console.log(`  ${p.slug?.current || p._id}: ${summary}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join('tools', 'mockup', `publish-backup-${stamp}.json`);
  // The PUBLISHED documents, as they are before anything is sent. That is what
  // a publish overwrites, so that is the way back.
  fs.writeFileSync(backupPath, JSON.stringify({
    when: stamp, dryRun: DRY,
    documents: publishable.map(({ product }) => product),
  }, null, 2));

  console.log('');
  console.log(`  publishable      ${publishable.length}`);
  console.log(`  held for review  ${held.length}`);
  console.log(`  no draft         ${noDraft}`);
  if (identical) console.log(`  already matching ${identical}`);
  console.log(`  backup of ${publishable.length} published document(s) -> ${backupPath}`);

  if (held.length) {
    console.log('\n  held:');
    for (const h of held) console.log(`    ${h.slug.padEnd(34)} ${h.summary}`);
  }

  if (DRY) {
    if (publishable.length) {
      // The actions API validates a batch without applying it. Worth doing:
      // everything else here can be tested offline, but whether the endpoint,
      // the API version and the action shape are right is only knowable by
      // asking Sanity, and the alternative is finding out during the real run.
      const sample = publishable.slice(0, BATCH).map(({ product }) => publishAction(product._id));
      console.log(`\n  validating ${sample.length} action(s) against the API with dryRun...`);
      console.log(`    ${JSON.stringify(sample[0])}`);
      try {
        await act(sample, true);
        console.log('    accepted: endpoint, API version and action shape are right');
      } catch (e) {
        console.log(`    REJECTED: ${e.message}`);
        console.log('    the real run would fail the same way -- fix this before publishing');
      }
    }
    console.log('\n  dry run: nothing published');
    return;
  }
  if (!publishable.length) { console.log('\n  nothing to publish'); return; }

  for (let i = 0; i < publishable.length; i += BATCH) {
    const chunk = publishable.slice(i, i + BATCH);
    await act(chunk.map(({ product }) => publishAction(product._id)));
    console.log(`  published ${i + chunk.length}/${publishable.length}`);
  }
  console.log('\n  done.');
};

// Only when run, not when imported by test-publish.mjs.
if (process.argv[1] && path.basename(process.argv[1]) === 'publish.mjs') {
  main().catch((e) => { console.error('  failed:', e.message); process.exit(1); });
}
