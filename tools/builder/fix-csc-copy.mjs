#!/usr/bin/env node
/**
 * Comic Strip Canvas — copy corrections for the self-serve builder workflow.
 *
 *   npm install @sanity/client
 *   $env:SANITY_TOKEN_CSC="sk..."            # PowerShell
 *   node fix-csc-copy.mjs                    # dry run — prints every change
 *   node fix-csc-copy.mjs --apply            # writes to production
 *
 * Every edit below is idempotent: re-running it changes nothing further.
 * Nothing is deleted; the duplicate FAQ is unpublished by rewriting the
 * survivor and flagging the twin for you to remove by hand in the Studio.
 */
import { createClient } from '@sanity/client';

const APPLY = process.argv.includes('--apply');
const token = process.env.SANITY_TOKEN_CSC;
if (APPLY && !token) {
  console.error('SANITY_TOKEN_CSC is not set — needed for --apply.');
  process.exit(1);
}

const client = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2021-10-21',
  token,
  useCdn: false,
});

// The FAQ `answer` field is plain text, not rich text. An earlier version of
// this script wrote block arrays here, which the Studio shows as [object Object]
// and the site renders the same way. Writing a string overwrites that cleanly.

/* ------------------------------------------------------------------ products */
const PRODUCTS = {
  'personalised-icons': {
    title: 'Your Photo as an Icon',
    description:
      'Turn your favourite photo into a personalised comic icon. Drop your picture ' +
      'straight into the template, position it exactly how you want, add your own ' +
      'quote, and see your layout as you build it. Comic artwork applied automatically. ' +
      'Personalisation fee applies.',
    seo: 'Personalised comic icon made from your own photo. Build your layout online and ' +
      'see it instantly. Comic-styled canvas, framed print or poster. From £9.99. ' +
      'Made to order. Free UK P&P.',
  },
  'personalised-book-covers': {
    title: 'Your Photo as a Book Cover',
    description:
      'Turn your favourite photo into a personalised comic book cover. Drop your picture ' +
      'straight into the template, set your own title, issue number and cover line, and ' +
      'see your layout as you build it. Comic artwork applied automatically. ' +
      'Personalisation fee applies.',
    seo: 'Personalised comic book cover made from your own photo. Build your layout online ' +
      'and see it instantly. Comic-styled canvas, framed print or poster. From £9.99. ' +
      'Made to order. Free UK P&P.',
  },
  'personalised-strips': {
    title: 'Your Photo as a Strip',
    description:
      'Turn your favourite photos into a personalised comic strip. Drop your pictures into ' +
      'the twelve panels, arrange them how you want, choose your border colour, and see ' +
      'your layout as you build it. Comic artwork applied automatically. ' +
      'Personalisation fee applies.',
    seo: 'Personalised comic strip made from your own photos. Build your layout online and ' +
      'see it instantly. Comic-styled canvas, framed print or poster. From £9.99. ' +
      'Made to order. Free UK P&P.',
  },
};

/* ---------------------------------------------------------------------- faqs */
const FAQS = [
  {
    match: 'How does the personalised service work?',
    answer:
      'Choose your style, then drop your photos straight into the template and arrange ' +
      'them yourself — you see your layout on screen as you build it. Add your text, pick ' +
      'your colours, choose your size and format, then order. The comic artwork is applied ' +
      'automatically and your finished artwork is emailed to you for approval before ' +
      'anything is printed.',
  },
  {
    match: 'Will I get to see a proof before you print?',
    answer:
      'Twice over. You see your layout immediately while you build it, so you know exactly ' +
      'where every photo and every word sits. After you order, we check the finished artwork ' +
      'and email it to you — usually within one working day. Nothing goes to print until ' +
      'you approve it.',
  },
  {
    match: 'How do I order a personalised comic canvas?',
    answer:
      'Open the builder on any personalised product page, drop in your photo, position it, ' +
      'add your text and choose your size and format. Add it to your basket and check out. ' +
      'We email the finished artwork for approval, usually within one working day, before ' +
      'anything is printed.',
  },
  {
    match: 'Can I request changes to my proof?',
    answer:
      'Yes. Because you build the layout yourself, the composition, crop and wording are ' +
      'already exactly as you set them. If you want changes to the finished artwork once ' +
      "you've seen it, just reply to the proof email and we'll revise it. We want you to " +
      'love it before we print it.',
  },
  {
    match: 'How long does a personalised canvas take to arrive?',
    answer:
      'Your layout is instant. We email the finished artwork for approval, usually within ' +
      'one working day, and once you approve it production and dispatch takes 3–6 working ' +
      'days. Free P&P on UK mainland orders over £50 (£4.95 below that).',
  },
  {
    match: 'What photo do I need to send for a personalised comic canvas?',
    answer:
      'The bigger the file the better. Photos straight from a phone or camera are ideal; ' +
      'screenshots and pictures saved from social media are usually too small. JPG, PNG and ' +
      'WEBP are all fine. The builder shows the print quality of each photo as you position ' +
      'it and warns you before anything would print soft, so you never have to guess. ' +
      'Covers and Icons take one photo. Strips need a photo in all twelve panels — you can ' +
      'use the same photo more than once if you want to.',
    onlyFirst: true,
  },
  {
    match: 'What is the difference between a personalised Cover, Icon, and Strip?',
    answer:
      'A Comic Book Cover is a bold, magazine-style design with your subject as the star. ' +
      'A Comic Book Icon is a graphic portrait with strong colours and your own quote. ' +
      'A Comic Book Strip tells a story across twelve panels — ideal for a sequence of ' +
      'moments. Covers and Icons carry a £10 personalisation fee; Strips £25, reflecting ' +
      'the twelve-photo layout and the larger print.',
  },
  {
    match: 'How much does a personalised comic canvas cost?',
    answer:
      'Poster prints start from £9.99. Canvas prints start from £26.99 (standard frame) or ' +
      '£28.99 (gallery frame). Add £10 to personalise a Cover or Icon, or £25 for a Strip. ' +
      'Small, Medium and Large are priced separately — see the full price list on the ' +
      'Services page.',
  },
  {
    match: 'What sizes are available?',
    answer:
      'Three sizes: Small (12x8"), Medium (16x12") and Large (24x16"), in portrait or ' +
      'landscape depending on the style. Each is available as a Poster Print, Canvas with ' +
      'Standard Wrap, or Canvas with Gallery Wrap. On canvas, the artwork continues around ' +
      'the frame edge — 1.5" on a standard wrap and 2.5" on a gallery wrap — and the ' +
      'builder shows you exactly which part stays on the front face.',
  },
  {
    match: 'What styles can I choose from?',
    answer:
      'Three styles: Comic Book Covers (bold, dramatic cover layouts), Comic Icons ' +
      '(pop-art graphic portraits) and Comic Strips (twelve-panel sequential layouts). ' +
      'Each is available as a ready-made design or personalised with your own photos.',
  },
];

/* --------------------------------------------------------------------- run */
const changes = [];

const products = await client.fetch(
  '*[_type=="product" && category=="personalised"]{_id,title,slug,description,seo}');

for (const p of products) {
  const spec = PRODUCTS[p.slug?.current];
  if (!spec) continue;
  const patch = {};
  if (p.title !== spec.title) patch.title = spec.title;
  if (p.description !== spec.description) patch.description = spec.description;
  const meta = p.seo?.metaDescription;
  if (meta !== spec.seo) patch['seo.metaDescription'] = spec.seo;
  if (Object.keys(patch).length) changes.push({ id: p._id, label: p.title, patch });
}

const faqs = await client.fetch('*[_type=="faq"]{_id,question,answer}');
const seen = new Set();
for (const spec of FAQS) {
  const hits = faqs.filter((f) => f.question?.trim() === spec.match);
  if (!hits.length) { console.warn(`  ! FAQ not found: "${spec.match}"`); continue; }
  const targets = spec.onlyFirst ? hits.slice(0, 1) : hits;
  for (const f of targets) {
    if (seen.has(f._id)) continue;
    seen.add(f._id);
    changes.push({
      id: f._id, label: `FAQ: ${spec.match}`,
      patch: { answer: spec.answer },
    });
  }
  if (hits.length > 1) {
    console.warn(`  ! "${spec.match}" appears ${hits.length}x — ` +
      `updating the first (${hits[0]._id}); delete the duplicate in the Studio: ` +
      hits.slice(1).map((h) => h._id).join(', '));
  }
}

console.log(`\n${changes.length} document(s) to change:\n`);
for (const c of changes) {
  console.log(`  ${c.label}  [${c.id}]`);
  for (const [k, v] of Object.entries(c.patch)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    console.log(`     ${k}: ${s.slice(0, 110)}${s.length > 110 ? '…' : ''}`);
  }
}

if (!APPLY) {
  console.log('\nDry run — nothing written. Re-run with --apply to commit.');
  process.exit(0);
}

let tx = client.transaction();
for (const c of changes) tx = tx.patch(c.id, { set: c.patch });
const res = await tx.commit();
console.log(`\nApplied. Transaction ${res.transactionId}, ${changes.length} document(s).`);
