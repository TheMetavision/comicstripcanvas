/**
 * Comic Strip Canvas — Website Images Upload
 *
 * Uploads the general website images (homepage, services, etc.) to Sanity
 * and outputs a reference map you can use to update the Astro pages.
 *
 * Usage:
 *   $env:SANITY_WRITE_TOKEN="your-token-here"
 *   npx tsx upload-website-images.ts
 */

import { createClient } from '@sanity/client';
import * as fs from 'fs';
import * as path from 'path';

const client = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const WEBSITE_IMAGES_DIR = 'C:\\Users\\chris\\Documents\\Comic Strip Canvas\\Website Images';

// Skip patterns for non-website images
const SKIP_PATTERNS = [
  /\.psd$/i,
  /\.ai$/i,
  /\.svg$/i,
];

function isImageFile(filename: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(filename);
}

async function main() {
  console.log('🖼️  Comic Strip Canvas — Website Images Upload');
  console.log('==============================================\n');

  if (!fs.existsSync(WEBSITE_IMAGES_DIR)) {
    console.error(`❌ Folder not found: ${WEBSITE_IMAGES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(WEBSITE_IMAGES_DIR);
  const imageFiles = files.filter(
    (f) => isImageFile(f) && !SKIP_PATTERNS.some((p) => p.test(f))
  );

  console.log(`Found ${imageFiles.length} images to upload\n`);

  const results: { filename: string; sanityId: string; url: string }[] = [];

  for (const file of imageFiles) {
    const filePath = path.join(WEBSITE_IMAGES_DIR, file);

    try {
      console.log(`📸 Uploading: ${file}`);
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(file).toLowerCase();
      const contentType =
        ext === '.png' ? 'image/png' :
        ext === '.webp' ? 'image/webp' :
        'image/jpeg';

      const asset = await client.assets.upload('image', buffer, {
        filename: file,
        contentType,
      });

      results.push({
        filename: file,
        sanityId: asset._id,
        url: asset.url,
      });

      console.log(`   ✅ ${asset.url}`);

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 150));
    } catch (err) {
      console.log(`   ❌ Failed: ${(err as Error).message}`);
    }
  }

  // Write a reference map to a JSON file
  const outputPath = path.join(process.cwd(), 'website-images-map.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

  console.log(`\n==============================================`);
  console.log(`✅ Uploaded ${results.length}/${imageFiles.length} images`);
  console.log(`📄 Reference map saved to: website-images-map.json`);
  console.log(`\nUse the URLs from website-images-map.json to update`);
  console.log(`your homepage, services, and other page images.`);
  console.log(`You can reference them in Astro using the Sanity CDN URLs directly.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
