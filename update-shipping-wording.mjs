// update-shipping-wording.mjs
//
// The two copy fixes that could not be made in the repository, because this
// copy lives in Sanity: "UK mainland" -> "UK", and "over £50" -> "of £50 and
// over". The site pages were done on fix/gmc-returns-and-feed; these are the
// FAQ answers rendered on /services/ and the five blog posts.
//
// WHY THE WORDING MATTERS. Checkout gives free delivery when the subtotal is
// >= £50, so a £50.00 order ships free and "over £50" tells that customer the
// opposite. And we deliver to the whole UK at one price, so "mainland" turns
// away the customers most likely to be checking.
//
//   node update-shipping-wording.mjs                  read, report, write nothing
//   node update-shipping-wording.mjs --apply          write DRAFTS to review
//   node update-shipping-wording.mjs --apply --publish  ...and publish them
//
// DRY RUN BY DEFAULT, and --apply alone writes drafts rather than published
// documents -- the same shape as update-blog-shipping.mjs, which is the script
// that put most of this wording there in the first place.
//
// READ THIS BEFORE RUNNING --apply ALONE: a draft changes nothing a customer or
// Google can see. The site builds from published content, so /services/ keeps
// the old answer until the drafts are published, either in the Studio or by
// adding --publish here.
//
// NOTHING IS TOUCHED UNLESS IT STILL MATCHES. Every replacement is an exact
// string, and a field whose text has moved on since this was written is
// reported and left alone rather than guessed at. The manifest below says how
// many replacements each document should take, so "nothing matched" shows up as
// a warning instead of a silent success.

import { createClient } from '@sanity/client';

const TOKEN = process.env.SANITY_WRITE_TOKEN || process.env.SANITY_TOKEN;
if (!TOKEN) {
  console.error('ERROR: no Sanity token.');
  console.error('  PowerShell:  $env:SANITY_WRITE_TOKEN = "<token>"');
  console.error('  or load the repo .env:  node --env-file=.env update-shipping-wording.mjs');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');
const PUBLISH = process.argv.includes('--publish');

const client = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2024-01-01',
  token: TOKEN,
  useCdn: false,
});

/* ─────────────────────────── what to change ───────────────────────────
 *
 * Ordered, and specific before general: the FAQ sentences are whole clauses
 * that would otherwise be half-rewritten by the generic pair beneath them.
 */
const REPLACEMENTS = [
  // -- the two FAQ answers, which phrase it their own way
  {
    from: 'Currently we ship to mainland UK only.',
    to: 'Currently we ship to UK addresses only, at one price wherever you are.',
  },
  {
    from: 'All orders include free P&P on UK mainland orders over £50 (£4.95 below that).',
    to: 'FREE UK P&P on orders of £50 and over, otherwise £4.95.',
  },
  {
    from: 'Free P&P on UK mainland orders over £50 (£4.95 below that).',
    to: 'FREE UK P&P on orders of £50 and over, otherwise £4.95.',
  },
  // -- the blog posts, which all use one of these two forms
  { from: 'on orders over £50', to: 'on orders of £50 and over' },
  { from: 'delivery to UK mainland addresses', to: 'delivery to UK addresses' },
  // -- and a catch-all for any "mainland" left anywhere, which should be none
  { from: 'UK mainland addresses', to: 'UK addresses' },
  { from: 'UK mainland', to: 'the UK' },
  { from: 'mainland UK', to: 'the UK' },
];

/**
 * What each document is expected to take, so a document that matches nothing
 * is a WARNING rather than a quiet pass. Somebody editing an answer in the
 * Studio between this being written and being run is exactly the case that
 * should stop and be looked at.
 */
const EXPECTED = {
  'Fb3E332TZkLq5toNtJoeWA': { what: 'FAQ — Do you ship internationally?', fields: ['answer'], min: 2 },
  '425b57e8-c869-4478-be7e-8b2e960368c0': { what: 'FAQ — personalised canvas delivery time', fields: ['answer'], min: 1 },
  'KpYSwvFDOc0m4VLTD8arQH': { what: 'blog — what-is-pop-art-wall-art', fields: ['body'], min: 1 },
  'KpYSwvFDOc0m4VLTD8arjd': { what: 'blog — canvas-vs-poster-prints', fields: ['body'], min: 1 },
  'htrMui7M7v6ADvapqduV5L': { what: 'blog — choosing-the-right-size-canvas', fields: ['body'], min: 1 },
  'htrMui7M7v6ADvapqduVOx': { what: 'blog — personalised-gifts-uk', fields: ['body'], min: 2 },
  'p2CdXGQXtkkzhWtxbxICkj': { what: 'blog — fathers-day-gift-ideas...', fields: ['body'], min: 2 },
};

/** Apply the pairs to one string. Returns the new text and what it did. */
function patchText(text) {
  if (typeof text !== 'string') return { text, hits: [] };
  let out = text;
  const hits = [];
  for (const { from, to } of REPLACEMENTS) {
    if (!out.includes(from)) continue;
    const n = out.split(from).length - 1;
    out = out.split(from).join(to);
    hits.push({ from, to, n });
  }
  return { text: out, hits };
}

/** The same, through a Portable Text body's spans. */
function patchBody(body) {
  if (!Array.isArray(body)) return { body, hits: [] };
  const hits = [];
  const next = body.map((block) => {
    if (!block || block._type !== 'block' || !Array.isArray(block.children)) return block;
    let changed = false;
    const children = block.children.map((child) => {
      if (child._type !== 'span' || typeof child.text !== 'string') return child;
      const r = patchText(child.text);
      if (r.text === child.text) return child;
      changed = true;
      hits.push(...r.hits);
      return { ...child, text: r.text };
    });
    return changed ? { ...block, children } : block;
  });
  return { body: next, hits };
}

const short = (s, n = 74) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function main() {
  console.log(APPLY
    ? `\nAPPLYING — writing ${PUBLISH ? 'and PUBLISHING' : 'DRAFTS only'}.\n`
    : '\nDRY RUN — reading only. Nothing is written.\n');

  const ids = Object.keys(EXPECTED);
  const docs = await client.fetch('*[_id in $ids]{_id,_type,_rev,title,question,answer,body,"slug":slug.current}', { ids });
  console.log(`${docs.length} of ${ids.length} documents found.\n`);

  const missing = ids.filter((id) => !docs.some((d) => d._id === id));
  missing.forEach((id) => console.log(`  ! NOT FOUND  ${id}  (${EXPECTED[id].what})`));

  let changed = 0, clean = 0, warned = 0;

  for (const doc of docs) {
    const spec = EXPECTED[doc._id];
    const label = `${spec.what}`;
    const set = {};
    let hits = [];

    if (spec.fields.includes('answer') && typeof doc.answer === 'string') {
      const r = patchText(doc.answer);
      if (r.text !== doc.answer) { set.answer = r.text; hits.push(...r.hits); }
    }
    if (spec.fields.includes('body')) {
      const r = patchBody(doc.body);
      if (r.hits.length) { set.body = r.body; hits.push(...r.hits); }
    }

    const total = hits.reduce((n, h) => n + h.n, 0);
    if (!total) {
      /* Either it has already been done, or the text has moved on. Both are
         worth a line: the second is the one that matters. */
      const stale = JSON.stringify(doc).match(/over £50|mainland/i);
      console.log(stale
        ? `  ! NO MATCH   ${label}\n      still contains ${JSON.stringify(stale[0])} but not in any form this script knows.\n      Look at it by hand rather than letting this script guess.`
        : `  = ALREADY OK ${label}`);
      if (stale) warned++; else clean++;
      continue;
    }
    if (total < spec.min) {
      console.log(`  ! FEWER THAN EXPECTED  ${label} — ${total} replacement(s), expected at least ${spec.min}`);
      warned++;
    }

    console.log(`  ${APPLY ? 'WRITE' : 'would'}  ${label}  (${total} replacement${total === 1 ? '' : 's'})`);
    for (const h of hits) {
      console.log(`      ${h.n}x  ${short(h.from)}`);
      console.log(`       ->  ${short(h.to)}`);
    }

    if (!APPLY) { changed++; continue; }

    try {
      /* The FULL document, not the projection: the projection flattens slug and
         drops every field it did not ask for, and createOrReplace would write
         that flattened shape back. */
      const full = await client.getDocument(doc._id);
      if (!full) { console.log(`      ERROR: could not re-read ${doc._id}`); warned++; continue; }
      const draftId = doc._id.startsWith('drafts.') ? doc._id : `drafts.${doc._id}`;
      await client.createOrReplace({ ...full, ...set, _id: draftId });
      console.log(`      draft written: ${draftId}`);

      if (PUBLISH) {
        /* Published directly from the same values, rather than by promoting the
           draft, so what goes live is exactly what was printed above. */
        await client.patch(doc._id).set(set).commit();
        await client.delete(draftId).catch(() => {});
        console.log('      published, and the draft cleared');
      }
      changed++;
    } catch (err) {
      console.log(`      ERROR: ${err.message}`);
      warned++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  to change:      ${changed}`);
  console.log(`  already right:  ${clean}`);
  console.log(`  needing a look: ${warned}`);
  if (missing.length) console.log(`  not found:      ${missing.length}`);

  if (!APPLY) {
    console.log('\nNothing was written.');
    console.log('  node --env-file=.env update-shipping-wording.mjs --apply            drafts to review');
    console.log('  node --env-file=.env update-shipping-wording.mjs --apply --publish  drafts AND live');
  } else if (!PUBLISH) {
    console.log('\nDRAFTS ONLY — the live site still shows the old wording.');
    console.log('  Publish each in the Studio, or re-run with --publish.');
    console.log('  Studio: https://comicstripcanvas.sanity.studio/');
  } else {
    console.log('\nPublished. The site picks this up on its next build —');
    console.log('  the Sanity webhook fires one on content changes.');
    console.log('  Then: rebuild, and remove services/index.html from FROM_SANITY');
    console.log('  in tools/builder/gmc-tests.mjs (it says so itself when it passes).');
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
