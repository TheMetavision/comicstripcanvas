// GROQ queries for fetching data from Sanity CMS
// Used across Astro pages to replace placeholder data

// ─── Products ────────────────────────────────────────────────

export const allProductsQuery = `
  *[_type == "product" && category != "personalised"] | order(sortOrder asc) {
    _id,
    title,
    "slug": slug.current,
    category,
    description,
    images[] {
      asset-> { _id, url },
      alt,
      "lqip": asset->metadata.lqip
    },
    accentColor,
    tags,
    featured,
    isPersonalised,
    sortOrder,
    seo
  }
`;

// Every product slug, personalised included. Used ONLY to generate the product
// detail routes. allProductsQuery above deliberately excludes personalised
// products from listings, but those products still need their own pages --
// /store/personalised already links to all three.
export const allProductSlugsQuery = `
  *[_type == "product" && defined(slug.current)] {
    "slug": slug.current
  }
`;

export const productsByCategoryQuery = `
  *[_type == "product" && category == $category] | order(sortOrder asc) {
    _id,
    title,
    "slug": slug.current,
    category,
    description,
    images[] {
      asset-> { _id, url },
      alt,
      "lqip": asset->metadata.lqip
    },
    accentColor,
    tags,
    featured,
    isPersonalised,
    sortOrder
  }
`;

// Personalisation fees by slug. /personalise prices its cards from this so the
// cards, the product pages and checkout.mjs all read the one field in Sanity.
export const personalisationFeesQuery = `
  *[_type == "product" && slug.current in $slugs] {
    "slug": slug.current,
    personalisationFee
  }
`;

/* images[].aspectRatio is which way up that artwork is, so a size reads the way
   the picture is shaped: a cover is 12x18, a strip is 18x12. Nothing on the
   document records orientation and 117 of the 311 products are landscape, so it
   comes from the image the customer is looking at. Explained here rather than
   inside the query: GROQ has no block comments, and one in the query string is
   a parse error at request time rather than at build, so it fails per page. */
export const productBySlugQuery = `
  *[_type == "product" && slug.current == $slug][0] {
    _id,
    title,
    "slug": slug.current,
    category,
    description,
    images[] {
      asset-> { _id, url },
      alt,
      "lqip": asset->metadata.lqip,
      "aspectRatio": asset->metadata.dimensions.aspectRatio
    },
    "printFileUrl": printFile.asset->url,
    classicSceneId,
    customiseFee,
    fullBleed {
      listingImage { asset-> { _id, url }, alt, "lqip": asset->metadata.lqip },
      "printFileUrl": printFile.asset->url,
      sceneId
    },
    accentColor,
    tags,
    featured,
    isPersonalised,
    personalisationFee,
    seo,
    "relatedProducts": *[_type == "product" && category == ^.category && slug.current != $slug][0..2] {
      _id,
      title,
      "slug": slug.current,
      "images": images[0..0] {
        asset-> { _id, url },
        alt
      },
      accentColor
    }
  }
`;

export const featuredProductsQuery = `
  *[_type == "product" && featured == true] | order(sortOrder asc)[0..5] {
    _id,
    title,
    "slug": slug.current,
    category,
    images[0] {
      asset-> { _id, url },
      alt
    },
    accentColor
  }
`;

// ─── Blog ────────────────────────────────────────────────────

export const allBlogPostsQuery = `
  *[_type == "blogPost"] | order(publishedAt desc) {
    _id,
    title,
    "slug": slug.current,
    author,
    publishedAt,
    category,
    excerpt,
    mainImage {
      asset-> { _id, url },
      alt,
      "lqip": asset->metadata.lqip
    }
  }
`;

export const blogPostBySlugQuery = `
  *[_type == "blogPost" && slug.current == $slug][0] {
    _id,
    title,
    "slug": slug.current,
    author,
    publishedAt,
    category,
    excerpt,
    mainImage {
      asset-> { _id, url },
      alt
    },
    body[] {
      ...,
      _type == "image" => {
        asset-> { _id, url },
        alt,
        caption
      }
    },
    seo,
    "relatedPosts": *[_type == "blogPost" && slug.current != $slug] | order(publishedAt desc)[0..2] {
      _id,
      title,
      "slug": slug.current,
      publishedAt,
      excerpt,
      mainImage {
        asset-> { _id, url },
        alt
      }
    }
  }
`;

// ─── Testimonials ────────────────────────────────────────────

export const testimonialsQuery = `
  *[_type == "testimonial" && featured == true] | order(_createdAt desc) {
    _id,
    customerName,
    location,
    rating,
    quote,
    product
  }
`;

// ─── FAQs ────────────────────────────────────────────────────

export const faqsByPageQuery = `
  *[_type == "faq" && (page == $page || page == "both")] | order(sortOrder asc) {
    _id,
    question,
    answer,
    sortOrder
  }
`;

// ─── Site Settings ───────────────────────────────────────────

export const siteSettingsQuery = `
  *[_type == "siteSettings"][0] {
    siteName,
    tagline,
    contactEmail,
    socialLinks,
    announcementBar,
    newsletterHeading
  }
`;
