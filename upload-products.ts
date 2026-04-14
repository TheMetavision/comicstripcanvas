/**
 * Comic Strip Canvas — Bulk Product Upload Script
 *
 * Scans your local image folders, uploads product images + lifestyle mockups
 * to Sanity, and creates product documents for all designs.
 *
 * Usage:
 *   $env:SANITY_WRITE_TOKEN="your-token-here"
 *   npx tsx upload-products.ts
 *
 * Prerequisites:
 *   - npm install @sanity/client (already installed)
 *   - SANITY_WRITE_TOKEN env var set
 *
 * This script will:
 *   1. Delete all existing placeholder products from Sanity
 *   2. Scan Comic Book Covers, Comic Icons, Comic Strips folders
 *   3. For each design subfolder: upload main image + lifestyle mockups
 *   4. Create product document in Sanity with generated title, slug, description
 *   5. Handle Personalised subfolders as a fourth category
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

// ─── CONFIGURATION ──────────────────────────────────────────
// Update this path to your local Comic Strip Canvas folder
const BASE_DIR = 'C:\\Users\\chris\\Documents\\Comic Strip Canvas';

const CATEGORIES = [
  {
    folder: 'Comic Book Covers',
    sanityCategory: 'comic-book-covers',
    mainFilePatterns: ['ComicBookCover(Web).jpg', 'ComicBookCover(Web).jpeg', 'ComicBookCover.jpg', 'ComicBookCover.jpeg'],
    descriptionTemplate: (name: string) =>
      `${name} reimagined as a bold, vintage-style comic book cover. Dynamic composition with classic comic-book colour palette and dramatic halftone shading. Available as poster print, standard canvas, or gallery canvas.`,
    accentColor: '#EC008C',
  },
  {
    folder: 'Comic Icons',
    sanityCategory: 'comic-book-icons',
    mainFilePatterns: ['ComicIcon(Web).jpg', 'ComicIcon(Web).jpeg', 'ComicIcon.jpg', 'ComicIcon.jpeg'],
    descriptionTemplate: (name: string) =>
      `${name} transformed into a striking pop-art comic icon. Bold graphic portrait with vivid primary colours and clean comic-book lines. Available as poster print, standard canvas, or gallery canvas.`,
    accentColor: '#FFF200',
  },
  {
    folder: 'Comic Strips',
    sanityCategory: 'comic-book-strips',
    mainFilePatterns: ['ComicStrip(Web).jpg', 'ComicStrip(Web).jpeg', 'ComicStrip.jpg', 'ComicStrip.jpeg'],
    descriptionTemplate: (name: string) =>
      `${name} captured in a dynamic multi-panel comic strip. Action, humour, and iconic moments brought to life in classic comic-book storytelling style. Available as poster print, standard canvas, or gallery canvas.`,
    accentColor: '#00AEEF',
  },
];

// Files to SKIP (mug mockups, PSDs, numbered variants, misc)
const SKIP_PATTERNS = [
  /^mug/i,
  /^white-glossy-mug/i,
  /mug_mockup/i,
  /\.psd$/i,
  /^ComicIcon\d+\.jpe?g$/i,       // ComicIcon1.jpg, ComicIcon2.jpg etc
  /^IMG_\d+\.jpe?g$/i,            // IMG_1221.JPG etc
  /^Photo/i,                       // Photo*.jpg
  /^39DzesH/i,                     // Random hash filenames
  /^CB Example/i,                  // Personalised examples handled separately
];

// Files to INCLUDE as lifestyle/wall mockups
const MOCKUP_PATTERNS = [
  /mockup_Lifestyle/i,
  /mockup_Wall/i,
  /mockup_Person/i,
];

function shouldSkip(filename: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(filename));
}

function isMockup(filename: string): boolean {
  return MOCKUP_PATTERNS.some((pattern) => pattern.test(filename));
}

function isImageFile(filename: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(filename);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 96);
}

async function uploadImage(filePath: string, filename: string): Promise<any> {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filename).toLowerCase();
  const contentType =
    ext === '.png' ? 'image/png' :
    ext === '.webp' ? 'image/webp' :
    'image/jpeg';

  const asset = await client.assets.upload('image', buffer, {
    filename,
    contentType,
  });

  return {
    _type: 'image',
    _key: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    alt: filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
    asset: {
      _type: 'reference',
      _ref: asset._id,
    },
  };
}

async function processDesignFolder(
  folderPath: string,
  designName: string,
  category: typeof CATEGORIES[0],
  sortOrder: number,
  isPersonalised: boolean = false,
): Promise<void> {
  const files = fs.readdirSync(folderPath);

  // Find main product image
  let mainFile: string | null = null;
  for (const pattern of category.mainFilePatterns) {
    const found = files.find((f) => f.toLowerCase() === pattern.toLowerCase());
    if (found) {
      mainFile = found;
      break;
    }
  }

  if (!mainFile) {
    // Fallback: look for any image that starts with the category prefix and isn't a mockup
    const prefix = category.mainFilePatterns[0].split('(')[0].split('.')[0].toLowerCase();
    mainFile = files.find(
      (f) =>
        f.toLowerCase().startsWith(prefix.toLowerCase()) &&
        isImageFile(f) &&
        !isMockup(f) &&
        !shouldSkip(f) &&
        !f.includes('mockup')
    ) || null;
  }

  if (!mainFile) {
    console.log(`  ⚠ No main image found for "${designName}" — skipping`);
    return;
  }

  // Collect lifestyle/wall mockup images
  const mockupFiles = files.filter(
    (f) => isImageFile(f) && isMockup(f) && !shouldSkip(f)
  );

  // Upload main image first
  console.log(`  📸 Uploading main: ${mainFile}`);
  const images = [];

  try {
    const mainImage = await uploadImage(
      path.join(folderPath, mainFile),
      mainFile
    );
    mainImage.alt = `${designName} — Comic Strip Canvas`;
    images.push(mainImage);
  } catch (err) {
    console.log(`  ❌ Failed to upload main image for "${designName}": ${(err as Error).message}`);
    return;
  }

  // Upload mockups
  for (const mockupFile of mockupFiles) {
    try {
      console.log(`  📸 Uploading mockup: ${mockupFile}`);
      const mockupImage = await uploadImage(
        path.join(folderPath, mockupFile),
        mockupFile
      );
      mockupImage.alt = `${designName} lifestyle mockup — Comic Strip Canvas`;
      images.push(mockupImage);
    } catch (err) {
      console.log(`  ⚠ Failed to upload mockup ${mockupFile}: ${(err as Error).message}`);
    }
  }

  // Generate slug
  const slug = slugify(designName);

  // Create product document
  const title = isPersonalised
    ? `Personalised ${category.folder.replace('Comic ', 'Comic Book ').replace('Book Book', 'Book')} — ${designName}`
    : designName;

  const description = isPersonalised
    ? `Personalised ${category.folder.toLowerCase()} artwork example. Transform your own photos into bold comic-book style art. Artwork fee applies.`
    : category.descriptionTemplate(designName);

  const sanityCategory = isPersonalised ? 'personalised' : category.sanityCategory;

  await client.create({
    _type: 'product',
    title,
    slug: { _type: 'slug', current: isPersonalised ? `personalised-${slug}` : slug },
    category: sanityCategory,
    description,
    images,
    accentColor: category.accentColor,
    tags: isPersonalised ? ['personalised', category.sanityCategory.replace('comic-book-', '')] : [],
    featured: false,
    isPersonalised,
    sortOrder,
  });

  console.log(`  ✅ Created: ${title} (${images.length} images)`);
}

async function processPersonalisedFolder(
  folderPath: string,
  category: typeof CATEGORIES[0],
  startOrder: number,
): Promise<number> {
  const persFolder = path.join(folderPath, 'Personalised');
  if (!fs.existsSync(persFolder)) {
    return startOrder;
  }

  const files = fs.readdirSync(persFolder);
  const imageFiles = files.filter((f) => isImageFile(f) && !shouldSkip(f));

  // Check if there are subfolders (design-per-subfolder) or flat files
  const subfolders = files.filter((f) =>
    fs.statSync(path.join(persFolder, f)).isDirectory()
  );

  if (subfolders.length > 0) {
    // Subfolder structure
    let order = startOrder;
    for (const sub of subfolders) {
      await processDesignFolder(
        path.join(persFolder, sub),
        sub,
        category,
        order++,
        true,
      );
    }
    return order;
  }

  // Flat file structure — group by base name pattern or upload individually
  // For personalised examples, we'll create one product per main image variant
  const mainImages = imageFiles.filter((f) => {
    const lower = f.toLowerCase();
    return (
      (lower.startsWith('comicbookcover') || lower.startsWith('comicicon') || lower.startsWith('comicstrip')) &&
      !lower.includes('mockup')
    );
  });

  // Also grab CB Example files
  const exampleImages = imageFiles.filter((f) => /^CB Example/i.test(f));

  const allMainImages = [...mainImages, ...exampleImages];

  if (allMainImages.length === 0) {
    console.log(`  ⚠ No personalised images found in ${persFolder}`);
    return startOrder;
  }

  // Find matching mockups for the personalised folder
  const mockupFiles = imageFiles.filter((f) => isMockup(f));

  // Create one personalised example product with all images
  const categoryLabel = category.folder;
  const images = [];

  for (const imgFile of allMainImages.slice(0, 6)) {
    try {
      console.log(`  📸 Uploading personalised: ${imgFile}`);
      const img = await uploadImage(path.join(persFolder, imgFile), imgFile);
      img.alt = `Personalised ${categoryLabel} example — Comic Strip Canvas`;
      images.push(img);
    } catch (err) {
      console.log(`  ⚠ Failed: ${imgFile}`);
    }
  }

  // Add a few mockups
  for (const mockFile of mockupFiles.slice(0, 4)) {
    try {
      console.log(`  📸 Uploading personalised mockup: ${mockFile}`);
      const img = await uploadImage(path.join(persFolder, mockFile), mockFile);
      img.alt = `Personalised ${categoryLabel} lifestyle mockup — Comic Strip Canvas`;
      images.push(img);
    } catch (err) {
      console.log(`  ⚠ Failed: ${mockFile}`);
    }
  }

  if (images.length > 0) {
    const styleLabel = categoryLabel.replace('Comic ', '');
    await client.create({
      _type: 'product',
      title: `Your Photo as a ${styleLabel.endsWith('s') ? styleLabel.slice(0, -1) : styleLabel}`,
      slug: { _type: 'slug', current: `personalised-${slugify(styleLabel)}` },
      category: 'personalised',
      description: `Transform your favourite photos into personalised ${categoryLabel.toLowerCase()} artwork. Upload your photo, choose your style, and we'll create a bold, vibrant comic-book masterpiece just for you. Artwork fee applies.`,
      images,
      accentColor: category.accentColor,
      tags: ['personalised', category.sanityCategory.replace('comic-book-', '')],
      featured: false,
      isPersonalised: true,
      sortOrder: startOrder,
    });
    console.log(`  ✅ Created personalised: Your Photo as a ${styleLabel} (${images.length} images)`);
  }

  return startOrder + 1;
}

async function main() {
  console.log('🚀 Comic Strip Canvas — Bulk Product Upload');
  console.log('============================================\n');

  // Verify base directory exists
  if (!fs.existsSync(BASE_DIR)) {
    console.error(`❌ Base directory not found: ${BASE_DIR}`);
    console.error('Update the BASE_DIR variable in this script to match your folder path.');
    process.exit(1);
  }

  // Step 1: Delete existing placeholder products
  console.log('🗑️  Deleting existing placeholder products...');
  const existingProducts = await client.fetch('*[_type == "product"]._id');
  if (existingProducts.length > 0) {
    const transaction = client.transaction();
    for (const id of existingProducts) {
      transaction.delete(id);
    }
    await transaction.commit();
    console.log(`   Deleted ${existingProducts.length} existing products.\n`);
  } else {
    console.log('   No existing products to delete.\n');
  }

  // Step 2: Process each category
  let totalProducts = 0;
  let totalImages = 0;

  for (const category of CATEGORIES) {
    const categoryPath = path.join(BASE_DIR, category.folder);

    if (!fs.existsSync(categoryPath)) {
      console.log(`⚠ Category folder not found: ${categoryPath} — skipping`);
      continue;
    }

    console.log(`\n📂 Processing: ${category.folder}`);
    console.log('─'.repeat(50));

    const entries = fs.readdirSync(categoryPath);
    const designFolders = entries.filter((entry) => {
      const fullPath = path.join(categoryPath, entry);
      return fs.statSync(fullPath).isDirectory() && entry !== 'Personalised';
    });

    console.log(`   Found ${designFolders.length} designs\n`);

    let sortOrder = 1;
    for (const designFolder of designFolders.sort()) {
      console.log(`\n🎨 ${designFolder}`);
      try {
        await processDesignFolder(
          path.join(categoryPath, designFolder),
          designFolder,
          category,
          sortOrder++,
        );
        totalProducts++;
      } catch (err) {
        console.log(`  ❌ Error processing "${designFolder}": ${(err as Error).message}`);
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Process personalised subfolder
    console.log(`\n🎨 Processing personalised examples for ${category.folder}...`);
    const newOrder = await processPersonalisedFolder(categoryPath, category, sortOrder);
    if (newOrder > sortOrder) totalProducts++;
  }

  console.log('\n\n============================================');
  console.log(`✅ Upload complete!`);
  console.log(`   Products created: ${totalProducts}`);
  console.log(`\nNext steps:`);
  console.log(`   1. Open https://comicstripcanvas.sanity.studio`);
  console.log(`   2. Check Products → each category to verify images`);
  console.log(`   3. Mark your best products as "Featured"`);
  console.log(`   4. Add tags (film, music, sport, tv) to products for filtering`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
