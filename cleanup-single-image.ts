/**
 * Comic Strip Canvas — Remove Single-Image Products
 *
 * Finds and deletes any product documents in Sanity that have
 * only one image (incomplete listings).
 *
 * Usage:
 *   $env:SANITY_WRITE_TOKEN="your-token-here"
 *   npx tsx cleanup-single-image.ts
 */

import { createClient } from '@sanity/client';

const client = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

async function main() {
  console.log('🧹 Finding products with only 1 image...\n');

  const products = await client.fetch(`
    *[_type == "product"] {
      _id,
      title,
      category,
      "imageCount": count(images)
    }
  `);

  const singleImage = products.filter((p: any) => p.imageCount <= 1);

  if (singleImage.length === 0) {
    console.log('✅ No single-image products found. All listings look complete.');
    return;
  }

  console.log(`Found ${singleImage.length} products with 1 or fewer images:\n`);

  for (const p of singleImage) {
    console.log(`  ❌ ${p.title} (${p.category}) — ${p.imageCount} image(s)`);
  }

  console.log(`\n🗑️  Deleting ${singleImage.length} incomplete products...`);

  const transaction = client.transaction();
  for (const p of singleImage) {
    transaction.delete(p._id);
  }
  await transaction.commit();

  console.log(`\n✅ Deleted ${singleImage.length} products.`);

  // Show remaining count
  const remaining = await client.fetch(`count(*[_type == "product"])`);
  console.log(`📦 Products remaining: ${remaining}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
