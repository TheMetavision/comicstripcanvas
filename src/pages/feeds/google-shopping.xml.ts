export const prerender = false;

import type { APIRoute } from 'astro';
import { createClient } from '@sanity/client';
import imageUrlBuilder from '@sanity/image-url';

const sanityClient = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2024-01-01',
  useCdn: true,
});

const builder = imageUrlBuilder(sanityClient);

// Pricing matrix — must match what the site actually charges
const PRICES: Record<string, Record<string, number>> = {
  poster: { small: 9.99, medium: 12.99, large: 16.99 },
  'canvas-standard': { small: 26.99, medium: 31.99, large: 44.99 },
  'canvas-gallery': { small: 28.99, medium: 33.99, large: 46.99 },
};

const FORMAT_LABELS: Record<string, string> = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas Standard Frame',
  'canvas-gallery': 'Canvas Gallery Frame',
};

const SIZE_LABELS: Record<string, string> = {
  small: 'Small 12x8in',
  medium: 'Medium 16x12in',
  large: 'Large 24x16in',
};

const CATEGORY_LABELS: Record<string, string> = {
  'comic-book-covers': 'Comic Book Covers',
  'comic-book-icons': 'Comic Book Icons',
  'comic-book-strips': 'Comic Book Strips',
  personalised: 'Personalised',
};

const FORMATS = ['poster', 'canvas-standard', 'canvas-gallery'];
const SIZES = ['small', 'medium', 'large'];

const SITE_URL = 'https://comicstripcanvas.co.uk';
const BRAND = 'Comic Strip Canvas';

// Escape XML special characters in text content
function xmlEscape(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(str: string, max: number): string {
  if (!str) return '';
  return str.length > max ? str.substring(0, max - 3) + '...' : str;
}

export const GET: APIRoute = async () => {
  try {
    const query = `*[_type == "product"] | order(sortOrder asc) {
      _id,
      title,
      "slug": slug.current,
      category,
      description,
      "images": images[]{asset->{url}, alt},
      tags,
      isPersonalised,
      featured
    }`;

    const products = await sanityClient.fetch(query);

    const now = new Date().toISOString();
    const items: string[] = [];

    for (const product of products) {
      const mainImage = product.images?.[0]?.asset?.url;
      if (!mainImage) continue; // Skip products without images

      // Generate optimised image URL (Google requires under 16MB, recommends 800x800+)
      const optimisedImage = `${mainImage}?w=1200&h=1200&fit=max&auto=format`;

      const productUrl = `${SITE_URL}/store/${product.slug}`;
      const category = CATEGORY_LABELS[product.category] || product.category;
      const description = product.description
        ? truncate(product.description, 4900)
        : `${category} — bold pop culture wall art from Comic Strip Canvas`;

      // Generate 9 variants: 3 formats × 3 sizes
      for (const format of FORMATS) {
        for (const size of SIZES) {
          const price = PRICES[format][size];
          const formatLabel = FORMAT_LABELS[format];
          const sizeLabel = SIZE_LABELS[size];

          // Short codes for ID to stay under Google's 50-char limit
          // poster=p, canvas-standard=cs, canvas-gallery=cg | small=s, medium=m, large=l
          const formatCode = format === 'poster' ? 'p' : format === 'canvas-standard' ? 'cs' : 'cg';
          const sizeCode = size === 'small' ? 's' : size === 'medium' ? 'm' : 'l';

          // Truncate slug if needed — 50 char limit minus "-XX-X" = ~44 chars max for slug
          const slugForId = product.slug.length > 44 ? product.slug.substring(0, 44) : product.slug;
          const itemId = `${slugForId}-${formatCode}-${sizeCode}`;

          const itemGroupId = product.slug;
          const variantTitle = `${product.title} — ${formatLabel} (${sizeLabel})`;

          items.push(`
    <item>
      <g:id>${xmlEscape(itemId)}</g:id>
      <g:item_group_id>${xmlEscape(itemGroupId)}</g:item_group_id>
      <g:title>${xmlEscape(truncate(variantTitle, 150))}</g:title>
      <g:description>${xmlEscape(description)}</g:description>
      <g:link>${xmlEscape(productUrl)}?format=${format}&amp;size=${size}</g:link>
      <g:image_link>${xmlEscape(optimisedImage)}</g:image_link>
      <g:availability>in stock</g:availability>
      <g:price>${price.toFixed(2)} GBP</g:price>
      <g:brand>${xmlEscape(BRAND)}</g:brand>
      <g:condition>new</g:condition>
      <g:identifier_exists>no</g:identifier_exists>
      <g:product_type>${xmlEscape(`Home &amp; Garden > Decor > Artwork > Posters, Prints, &amp; Visual Artwork > ${category}`)}</g:product_type>
      <g:google_product_category>500044</g:google_product_category>
      <g:custom_label_0>${xmlEscape(category)}</g:custom_label_0>
      <g:custom_label_1>${xmlEscape(formatLabel)}</g:custom_label_1>
      <g:custom_label_2>${xmlEscape(sizeLabel)}</g:custom_label_2>
      <g:custom_label_3>${product.isPersonalised ? 'personalised' : 'standard'}</g:custom_label_3>
      <g:custom_label_4>${product.featured ? 'featured' : 'catalogue'}</g:custom_label_4>
      <g:shipping>
        <g:country>GB</g:country>
        <g:service>Standard</g:service>
        <g:price>0.00 GBP</g:price>
      </g:shipping>
      <g:shipping_weight>0.5 kg</g:shipping_weight>
    </item>`);
        }
      }
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Comic Strip Canvas — Google Shopping Feed</title>
    <link>${SITE_URL}</link>
    <description>Bold pop culture wall art. Canvas prints, framed prints, and posters in comic book style.</description>
    <lastBuildDate>${now}</lastBuildDate>${items.join('')}
  </channel>
</rss>`;

    return new Response(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (error: any) {
    console.error('Feed generation error:', error);
    return new Response(`<?xml version="1.0"?><error>${xmlEscape(error.message || 'Feed error')}</error>`, {
      status: 500,
      headers: { 'Content-Type': 'application/xml' },
    });
  }
};
