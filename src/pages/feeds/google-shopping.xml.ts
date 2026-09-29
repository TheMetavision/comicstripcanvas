export const prerender = false;

import type { APIRoute } from 'astro';
import { createClient } from '@sanity/client';
import imageUrlBuilder from '@sanity/image-url';
import { SIZE_INCHES, SIZE_NAME, sizeWH, orientationFromAspect }
  from '../../../netlify/functions/_shared/sizes.mjs';

// Uncached, even though this runs per request rather than at build. A stale
// price in a shopping feed gets items disapproved by Google, which is a worse
// outcome than a slower response -- and the caller is a crawler, not a
// customer waiting on a page. Each request costs one live API read.
const sanityClient = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2024-01-01',
  useCdn: false,
});

const builder = imageUrlBuilder(sanityClient);

/* The site's own price table, imported rather than copied. This used to be a
   second hand-maintained matrix, which is one place to forget when a price
   changes -- and a feed that disagrees with the page it links to is how items
   get disapproved. */
import { PRICES } from '../../data/products';

const FORMAT_LABELS: Record<string, string> = {
  poster: 'Poster Print',
  'canvas-standard': 'Canvas Standard Frame',
  'canvas-gallery': 'Canvas Gallery Frame',
};

/* Google's own spelling: no quote mark, "in" spelled out. The numbers still come
   from _shared/sizes.mjs. The offer id is built from a size CODE further down
   (small=s, medium=m, large=l), not from this text, so changing a dimension here
   updates the size attribute on existing offers rather than minting new ids. */
const SIZE_LABELS: Record<string, string> = {
  small: `${SIZE_NAME.small} ${SIZE_INCHES.small[0]}x${SIZE_INCHES.small[1]}in`,
  medium: `${SIZE_NAME.medium} ${SIZE_INCHES.medium[0]}x${SIZE_INCHES.medium[1]}in`,
  large: `${SIZE_NAME.large} ${SIZE_INCHES.large[0]}x${SIZE_INCHES.large[1]}in`,
};

/* g:size takes the dimensions and nothing else -- "Large 24x16in" is a
   description, and Google groups variants by the literal value. The orientation
   is applied per product below, because a strip is 18x12 and a cover 12x18 from
   the same entry, and the size shown on the landing page has to be the one in
   the feed. */
const sizeAttr = (key: string, orient: string) => {
  const wh = sizeWH(key, orient);
  return wh ? `${wh[0]}x${wh[1]}in` : '';
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
    /* personalisationFee is the fee the customer actually pays on top, from the
       same field checkout.mjs prices from. classicSceneId and the full-bleed
       scene id say whether the design can be reopened through "Customise this
       design", which decides the returns label.

       NO BLOCK COMMENTS INSIDE THE QUERY. GROQ has no C-style comment syntax,
       so one in here parses as part of the projection and the whole feed
       answers 500 -- which is what it did until this was run once. Use GROQ's
       own line comments, or say it out here as this does. */
    const query = `*[_type == "product"] | order(sortOrder asc) {
      _id,
      title,
      "slug": slug.current,
      category,
      description,
      "images": images[]{asset->{url, "aspectRatio": metadata.dimensions.aspectRatio}, alt},
      tags,
      isPersonalised,
      personalisationFee,
      classicSceneId,
      "fullBleedSceneId": fullBleed.sceneId,
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

      const productUrl = `${SITE_URL}/store/${product.slug}/`;
      const category = CATEGORY_LABELS[product.category] || product.category;
      /* Which way up, from the artwork itself: there is no orientation field on
         a product and a third of the shop is landscape, so g:size would be
         wrong for a third of the feed if it were assumed. */
      const orientation = orientationFromAspect(product.images?.[0]?.asset?.aspectRatio);

      /* THE FEE. A personalised product's listed price is the print plus the
         personalisation, because that is the least the customer can pay: there
         is no way to buy one without it. Quoting the bare print price is an
         underquote, and Google checks the feed price against the landing page.
         In POUNDS on the document -- customiseFee is in pence, which is a trap
         worth knowing about; this one is not that one. */
      const fee = product.isPersonalised && typeof product.personalisationFee === 'number'
        && Number.isFinite(product.personalisationFee)
        ? product.personalisationFee
        : 0;
      if (product.isPersonalised && !fee) {
        /* Loud, and the item is left out rather than sent at the wrong price.
           An underpriced item that Google approves is worse than a missing one:
           somebody clicks it expecting the price they were shown. */
        console.error(`google-shopping: "${product.slug}" is personalised but has no `
          + `personalisationFee (got ${JSON.stringify(product.personalisationFee)}) — omitted from the feed`);
        continue;
      }

      /* WHAT THIS ITEM IS, not what the product could also be sold as.
         Nearly every product in the shop has a studio scene and so CAN be
         reopened through "Customise this design" -- but that is a separate
         purchase at a separate price, and it is not in this feed. Every item
         here is either a plain print or one of the three builder products.
         A plain print carries the full 14-day right to change your mind, so
         labelling one "personalised" because the design happens to also be
         customisable would tell Google the customer has no such right, which
         contradicts the refund policy and is untrue of the thing being sold.
         Labelling on `customisable` did exactly that to 2,250 of 2,799 items.
         If customise variants are ever listed as items of their own, they get
         the personalised label -- they are made to specification. */
      const returnsLabel = product.isPersonalised ? 'personalised' : 'standard';
      const description = product.description
        ? truncate(product.description, 4900)
        : `${category} — bold pop culture wall art from Comic Strip Canvas`;

      // Generate 9 variants: 3 formats × 3 sizes
      for (const format of FORMATS) {
        for (const size of SIZES) {
          const price = PRICES[format][size] + fee;
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
      <g:size>${xmlEscape(sizeAttr(size, orientation))}</g:size>
      <g:return_policy_label>${returnsLabel}</g:return_policy_label>
      <g:product_type>${xmlEscape(`Home & Garden > Decor > Artwork > Posters, Prints, & Visual Artwork > ${category}`)}</g:product_type>
      <g:google_product_category>500044</g:google_product_category>
      <g:custom_label_0>${xmlEscape(category)}</g:custom_label_0>
      <g:custom_label_1>${xmlEscape(formatLabel)}</g:custom_label_1>
      <g:custom_label_2>${xmlEscape(sizeLabel)}</g:custom_label_2>
      <g:custom_label_3>${product.isPersonalised ? 'personalised' : 'standard'}</g:custom_label_3>
      <g:custom_label_4>${product.featured ? 'featured' : 'catalogue'}</g:custom_label_4>
      <g:shipping>
        <g:country>GB</g:country>
        <g:service>Standard</g:service>
        <g:price>4.95 GBP</g:price>
      </g:shipping>
      <g:free_shipping_threshold>
        <g:country>GB</g:country>
        <g:price_threshold>50.00 GBP</g:price_threshold>
      </g:free_shipping_threshold>
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
