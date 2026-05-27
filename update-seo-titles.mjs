/**
 * Comic Strip Canvas — Sitewide SEO Title & Meta Description Updater
 *
 * This script sets seo.metaTitle and seo.metaDescription on every product
 * in Sanity using category-based templates.
 *
 * BEFORE RUNNING:
 * 1. Replace YOUR_SANITY_API_TOKEN below with a token that has write access.
 *    Get one from: https://sanity.io/manage → Comic Strip Canvas → API → Tokens
 * 2. Run from your project root: node update-seo-titles.mjs
 *
 * BaseLayout appends " | Comic Strip Canvas" to all titles automatically,
 * so templates here are kept to ~38 chars to keep the full title under 60.
 */

import { createClient } from '@sanity/client';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TOKEN = 'skrrtxJcu8z3WJuBLu9rTjMUjmphPJQZZjBWxW8jdWlXeWZ4tImwxnDfanY1ny7x9IZ1cZ6q5itmpswkCDxXU4rLnMwmyDD4XpsWJz3K724d4w5inNan9gIwdCjIdchZ1WS40FUcibJ6ayG47mK7lqZfJ8MEcMTHjoHuTmi45RVL8Vhlnovr'; // ← replace this
const PROJECT_ID = 'lwbwahym';
const DATASET = 'production';
// ─────────────────────────────────────────────────────────────────────────────

const client = createClient({
  projectId: PROJECT_ID,
  dataset: DATASET,
  apiVersion: '2024-01-01',
  token: TOKEN,
  useCdn: false,
});

// Title templates by category
// BaseLayout appends " | Comic Strip Canvas" so keep these under ~38 chars
function buildTitle(title, category) {
  switch (category) {
    case 'comic-book-icons':
      return `${title} | Comic Icon Art UK`;
    case 'comic-book-covers':
      return `${title} | Comic Cover Art UK`;
    case 'comic-book-strips':
      return `${title} | Comic Strip Art UK`;
    case 'personalised':
      return `Personalised ${title} | Comic Art UK`;
    default:
      return `${title} | Comic Art Print UK`;
  }
}

// Meta description templates by category
// Descriptions don't get the brand suffix appended — target 140–155 chars
function buildDescription(title, category) {
  switch (category) {
    case 'comic-book-icons':
      return `${title} immortalised in bold comic book icon art. Pop culture canvas print, framed print or poster in 3 sizes from £9.99. Made to order in the UK. Free P&P.`;
    case 'comic-book-covers':
      return `${title} reimagined as a dramatic comic book cover star. Canvas print, framed print or poster in 3 sizes from £9.99. Made to order in the UK. Free P&P.`;
    case 'comic-book-strips':
      return `${title} — bold multi-panel comic strip wall art. Canvas print, framed print or poster in 3 sizes from £9.99. Made to order in the UK. Free P&P.`;
    case 'personalised':
      return `Personalised ${title} comic art made from your photo. Hand-illustrated comic canvas, framed or poster. From £9.99. Made to order. Free UK P&P.`;
    default:
      return `${title} comic art print. Canvas, framed print or poster in 3 sizes from £9.99. Made to order in the UK. Free P&P.`;
  }
}

async function run() {
  if (TOKEN === 'YOUR_SANITY_API_TOKEN') {
    console.error('❌  Please replace YOUR_SANITY_API_TOKEN with your actual Sanity write token.');
    process.exit(1);
  }

  console.log('📡  Fetching all products from Sanity...');
  const products = await client.fetch(
    `*[_type == "product"]{_id, title, category, slug, seo}`
  );

  console.log(`✅  Found ${products.length} products.\n`);

  let updated = 0;
  let skipped = 0;

  for (const product of products) {
    const newTitle = buildTitle(product.title, product.category);
    const newDesc = buildDescription(product.title, product.category);

    // Skip if title is already set to something custom (non-template)
    // Remove this check if you want to overwrite everything
    if (product.seo?.metaTitle && !product.seo.metaTitle.includes('| Comic')) {
      console.log(`⏭️   Skipping ${product.title} — has custom SEO title already`);
      skipped++;
      continue;
    }

    try {
      await client
        .patch(product._id)
        .set({
          seo: {
            metaTitle: newTitle,
            metaDescription: newDesc,
          },
        })
        .commit();

      console.log(`✅  ${product.title} → "${newTitle}"`);
      updated++;
    } catch (err) {
      console.error(`❌  Failed to update ${product.title}:`, err.message);
    }
  }

  console.log(`\n🎉  Done. Updated: ${updated} | Skipped: ${skipped} | Total: ${products.length}`);
}

run();
