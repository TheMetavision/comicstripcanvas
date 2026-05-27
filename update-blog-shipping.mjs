// update-blog-shipping.mjs
// One-shot script that updates the 5 CSC blog posts to replace
// "free P&P / free UK P&P / all orders include free P&P" wording
// with the new "£50 threshold, £4.95 otherwise" wording.
//
// Strategy:
//   1. Fetch each post by slug (we know the 5 slugs).
//   2. Walk the Portable Text `body` array.
//   3. For each text span containing trigger wording, do a targeted replacement.
//   4. Save as DRAFT (drafts.<id>) — never touches published content.
//   5. You review the diff in Studio, then click Publish per post.
//
// Run:
//   cd C:\Users\chris\Projects\comicstripcanvas
//   $env:SANITY_TOKEN = "<your token, never paste it elsewhere>"
//   node update-blog-shipping.mjs

import { createClient } from '@sanity/client';

const SANITY_TOKEN = process.env.SANITY_TOKEN;
if (!SANITY_TOKEN) {
  console.error('ERROR: SANITY_TOKEN env var not set.');
  console.error('  In PowerShell:  $env:SANITY_TOKEN = "your-token"');
  process.exit(1);
}

const client = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2024-01-01',
  token: SANITY_TOKEN,
  useCdn: false,
});

// Ordered list of find/replace pairs. Specific phrases first; generic fallback last.
// Each replacement preserves the surrounding meaning.
const REPLACEMENTS = [
  // 1. Generic catch-all sentences that say "all orders include..."
  {
    from: 'All orders include free P&P to UK mainland addresses.',
    to: 'FREE UK P&P on orders over £50, otherwise £4.95 flat-rate UK delivery.',
  },
  {
    from: 'All orders include free P&P to UK mainland.',
    to: 'FREE UK P&P on orders over £50, otherwise £4.95 flat-rate UK delivery.',
  },

  // 2. Standalone "Free P&P to UK mainland addresses." (with full stop)
  {
    from: 'Free P&P to UK mainland addresses.',
    to: 'FREE UK P&P on orders over £50, otherwise £4.95 flat-rate UK delivery.',
  },

  // 3. Inline "free P&P to UK mainland addresses" appearing mid-sentence
  {
    from: 'free P&P to UK mainland addresses',
    to: 'FREE UK P&P on orders over £50 (otherwise £4.95)',
  },

  // 4. "free P&P to UK mainland" (no "addresses"), mid-sentence
  {
    from: 'free P&P to UK mainland',
    to: 'FREE UK P&P on orders over £50 (otherwise £4.95)',
  },

  // 5. Defensive catch-all for any remaining "free P&P"
  {
    from: 'free P&P',
    to: 'FREE UK P&P on orders over £50 (otherwise £4.95)',
  },
];

const SLUGS = [
  'canvas-vs-poster-prints',
  'choosing-the-right-size-canvas',
  'fathers-day-gift-ideas-sport-film-music-uk',
  'personalised-gifts-uk',
  'what-is-pop-art-wall-art',
];

/**
 * Apply find/replace to a single Portable Text block's children spans.
 * Returns { updated: bool, block: newBlock } so caller can track diffs.
 */
function patchBlock(block) {
  if (!block || block._type !== 'block' || !Array.isArray(block.children)) {
    return { updated: false, block };
  }

  let changed = false;
  const newChildren = block.children.map((child) => {
    if (child._type !== 'span' || typeof child.text !== 'string') {
      return child;
    }
    let text = child.text;
    for (const { from, to } of REPLACEMENTS) {
      if (text.includes(from)) {
        text = text.split(from).join(to);
        changed = true;
      }
    }
    if (text === child.text) return child;
    return { ...child, text };
  });

  if (!changed) return { updated: false, block };
  return { updated: true, block: { ...block, children: newChildren } };
}

function patchBody(body) {
  if (!Array.isArray(body)) return { updated: false, body };
  let anyChanged = false;
  const newBody = body.map((b) => {
    const { updated, block } = patchBlock(b);
    if (updated) anyChanged = true;
    return block;
  });
  return { updated: anyChanged, body: newBody };
}

async function main() {
  console.log('Fetching 5 blog posts...\n');

  const query = `*[_type == "blogPost" && slug.current in $slugs]{ _id, _rev, _type, title, "slug": slug.current, body }`;
  const posts = await client.fetch(query, { slugs: SLUGS });

  console.log(`Found ${posts.length} of ${SLUGS.length} expected posts.\n`);
  if (posts.length === 0) {
    console.error('No posts returned. Check token has read access to the dataset.');
    process.exit(1);
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const post of posts) {
    const { updated, body } = patchBody(post.body);
    if (!updated) {
      console.log(`  SKIP    "${post.title}" — no matches found`);
      skippedCount++;
      continue;
    }

    // Diff summary: count how many spans changed
    const beforeText = JSON.stringify(post.body);
    const afterText = JSON.stringify(body);
    const beforeLen = beforeText.length;
    const afterLen = afterText.length;

    // Create a DRAFT — never touches published doc directly.
    // Drafts have _id prefixed "drafts.". If the doc doesn't have a drafts.<id>
    // already, Sanity creates one; if it does, we replace its body.
    // We build the draft doc explicitly rather than spreading the projection
    // result (which has flattened slug.current to a string and lacks other fields).
    const draftId = post._id.startsWith('drafts.') ? post._id : `drafts.${post._id}`;

    try {
      // Fetch the FULL document (not the projection) so we don't lose any fields
      // not selected by the GROQ projection.
      const fullDoc = await client.getDocument(post._id);
      if (!fullDoc) {
        console.error(`  ERROR   "${post.title}": full document fetch returned null`);
        continue;
      }

      await client.createOrReplace({
        ...fullDoc,
        _id: draftId,
        _type: fullDoc._type, // explicit, just to be safe
        body,
      });
      console.log(`  DRAFT   "${post.title}" (slug: ${post.slug})`);
      console.log(`          body json size: ${beforeLen} -> ${afterLen}`);
      updatedCount++;
    } catch (err) {
      console.error(`  ERROR   "${post.title}": ${err.message}`);
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`  Drafts created/updated: ${updatedCount}`);
  console.log(`  Skipped (no changes):   ${skippedCount}`);
  console.log('');
  console.log('NEXT: Open Sanity Studio, review each draft, then click Publish.');
  console.log(`      Studio: https://comicstripcanvas.sanity.studio/`);
  console.log('');
  console.log('NOTHING IS LIVE YET — drafts are private to the studio until you publish.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
