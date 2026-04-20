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
      "lqip": asset->metadata.lqip
    },
    "printFileUrl": printFile.asset->url,
    accentColor,
    tags,
    featured,
    isPersonalised,
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
