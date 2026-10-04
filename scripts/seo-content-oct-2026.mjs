/**
 * scripts/seo-content-oct-2026.mjs — blog SEO titles and descriptions from
 * the October 2026 audit (limits: titles 60, descriptions 155).
 *
 *   node --env-file=.env scripts/seo-content-oct-2026.mjs            dry run: prints old → new, writes the plan
 *   node --env-file=.env scripts/seo-content-oct-2026.mjs --apply    applies the plan written by the dry run
 *
 * The dry run records each document's _rev. --apply patches a document only
 * if it is unchanged since then (ifRevisionID) and has no open draft, so
 * anything edited in Studio in between is skipped and reported, not
 * overwritten. Needs SANITY_WRITE_TOKEN in .env.
 */
import fs from 'node:fs';
import { createClient } from '@sanity/client';

const PLAN = new URL('./seo-content-oct-2026.plan.json', import.meta.url);
const MAX = { 'seo.metaTitle': 60, 'seo.metaDescription': 155 };

/** [_type, slug, field path, new value] */
const EDITS = [
  ['blogPost', 'fathers-day-gift-ideas-sport-film-music-uk', 'seo.metaTitle',
    "Father's Day Gifts for Sport, Film and Music Fans"],
  ['blogPost', 'fathers-day-gift-ideas-sport-film-music-uk', 'seo.metaDescription',
    "Your dad has a legend: a footballer, a film, a musician who shaped him. Give him bold, made-to-order comic art of them for his wall."],
  ['blogPost', 'personalised-gifts-uk', 'seo.metaTitle',
    'The Ultimate Personalised Gift: Comic Book Art'],
  ['blogPost', 'what-is-pop-art-wall-art', 'seo.metaTitle',
    'What Is Pop Art Wall Art? Why It Suits Your Home'],
  ['product', 'personalised-icons', 'seo.metaTitle', 'Personalised Comic Icon From Your Photo'],
  ['product', 'personalised-book-covers', 'seo.metaTitle', 'Personalised Comic Book Cover From Your Photo'],
  ['product', 'personalised-strips', 'seo.metaTitle', 'Personalised Comic Strip From Your Photos'],
];

const client = createClient({
  projectId: 'lwbwahym', dataset: 'production', apiVersion: '2024-12-01',
  token: process.env.SANITY_WRITE_TOKEN, useCdn: false, perspective: 'raw',
});
const get = (doc, path) => path.split('.').reduce((o, k) => o?.[k], doc);

async function dryRun() {
  const plan = [];
  for (const [type, slug, path, next] of EDITS) {
    if (next.length > MAX[path]) throw new Error(`${slug}: new value is ${next.length} chars (> ${MAX[path]})`);
    const doc = await client.fetch(`*[_type == $type && slug.current == $slug && !(_id in path("drafts.**"))][0]`, { type, slug });
    if (!doc) { console.log(`MISSING  ${type} ${slug}`); continue; }
    const old = get(doc, path) ?? '';
    if (old === next) { console.log(`SAME     ${slug} ${path}`); continue; }
    plan.push({ _id: doc._id, _rev: doc._rev, slug, path, old, next });
    console.log(`${slug} ${path}\n  old (${old.length}): ${old}\n  new (${next.length}): ${next}`);
  }
  fs.writeFileSync(PLAN, JSON.stringify(plan, null, 2));
  console.log(`\n${plan.length} change(s) planned. Run with --apply to write them.`);
}

async function apply() {
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  // One patch per document, so several fields on one document share its _rev.
  const byDoc = new Map();
  for (const p of plan) byDoc.set(p._id, [...(byDoc.get(p._id) || []), p]);
  let done = 0;
  for (const [id, edits] of byDoc) {
    const label = `${edits[0].slug} (${edits.map((e) => e.path).join(', ')})`;
    const draft = await client.fetch(`count(*[_id == $id])`, { id: `drafts.${id}` });
    if (draft) { console.log(`SKIP (open draft)       ${label}`); continue; }
    try {
      await client.patch(id).ifRevisionId(edits[0]._rev).setIfMissing({ seo: {} })
        .set(Object.fromEntries(edits.map((e) => [e.path, e.next]))).commit();
      console.log(`DONE     ${label}`); done += edits.length;
    } catch (e) {
      console.log(`SKIP (edited since dry run) ${label}: ${e.message}`);
    }
  }
  console.log(`
${done}/${plan.length} applied.`);
}

await (process.argv.includes('--apply') ? apply() : dryRun());
