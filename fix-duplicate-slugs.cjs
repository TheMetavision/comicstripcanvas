// fix-duplicate-slugs.cjs
//
// Comic Strip Canvas — Duplicate Product Slug Migration
//
// Finds all products with duplicate slugs and appends the category
// suffix to make each slug unique. Example:
//   ayrton-senna (icon)  -> ayrton-senna-icon
//   ayrton-senna (cover) -> ayrton-senna-cover
//
// For "covers" we use "-cover" (singular), for "icons" we use "-icon",
// for "strips" we use "-strip", to keep slugs clean and SEO-friendly.
//
// Run: node fix-duplicate-slugs.cjs

const { createClient } = require('@sanity/client');
const fs = require('fs');
const path = require('path');

// Load SANITY_WRITE_TOKEN from .env
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.error('❌ .env file not found. Create one with SANITY_WRITE_TOKEN=...');
  process.exit(1);
}
const envContent = fs.readFileSync(envPath, 'utf-8');
const tokenMatch = envContent.match(/SANITY_WRITE_TOKEN=([^\r\n]+)/);
if (!tokenMatch) {
  console.error('❌ SANITY_WRITE_TOKEN not found in .env');
  process.exit(1);
}
const token = tokenMatch[1].trim();

const client = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  token,
  apiVersion: '2024-01-01',
  useCdn: false,
});

// Map category to short suffix
const CATEGORY_SUFFIX = {
  'comic-book-covers': 'cover',
  'comic-book-icons': 'icon',
  'comic-book-strips': 'strip',
  personalised: 'personalised',
};

async function run() {
  console.log('📦 Fetching all products...');
  const products = await client.fetch(`*[_type == "product" && defined(slug.current)]{
    _id,
    title,
    "slug": slug.current,
    category
  } | order(slug asc)`);

  console.log(`   Total: ${products.length} products`);

  // Group by slug to find duplicates
  const bySlug = {};
  products.forEach((p) => {
    if (!bySlug[p.slug]) bySlug[p.slug] = [];
    bySlug[p.slug].push(p);
  });

  const duplicates = Object.entries(bySlug).filter(([, items]) => items.length > 1);

  if (duplicates.length === 0) {
    console.log('✅ No duplicate slugs found. Nothing to do.');
    return;
  }

  console.log(`\n🔍 Found ${duplicates.length} duplicate slug groups affecting ${duplicates.reduce((n, [, items]) => n + items.length, 0)} products:\n`);

  // Build patch plan
  const patches = [];
  duplicates.forEach(([slug, items]) => {
    console.log(`  "${slug}":`);
    items.forEach((item) => {
      const suffix = CATEGORY_SUFFIX[item.category] || item.category;
      const newSlug = `${slug}-${suffix}`;
      console.log(`    • ${item._id} (${item.category}) → ${newSlug}`);
      patches.push({ _id: item._id, newSlug, oldSlug: slug, category: item.category });
    });
    console.log('');
  });

  // Confirm
  console.log(`\n⚠️  This will update ${patches.length} documents in production.`);
  console.log('   Press Ctrl+C within 5 seconds to abort...\n');
  await new Promise((r) => setTimeout(r, 5000));

  // Run patches one at a time
  console.log('🔧 Applying slug updates...\n');
  let ok = 0;
  let fail = 0;

  for (const p of patches) {
    try {
      await client
        .patch(p._id)
        .set({ 'slug.current': p.newSlug })
        .commit();
      console.log(`  ✅ ${p._id}: ${p.oldSlug} → ${p.newSlug}`);
      ok++;
    } catch (err) {
      console.error(`  ❌ ${p._id}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\n✨ Done. Updated ${ok} documents, ${fail} failed.`);

  if (ok > 0) {
    console.log('\n📌 Next steps:');
    console.log('   1. Your store pages will automatically pick up the new slugs on next build.');
    console.log('   2. Redeploy on Netlify to regenerate the Google Shopping feed with new URLs.');
    console.log('   3. The old duplicate URLs will 404 — consider adding redirects if you had inbound links.');
  }
}

run().catch((err) => {
  console.error('💥 Migration failed:', err);
  process.exit(1);
});
