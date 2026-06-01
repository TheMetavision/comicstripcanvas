import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import { schemaTypes } from './schemas';

// Custom desk structure for singleton + grouped document types
const structure = (S: any) =>
  S.list()
    .title('Comic Strip Canvas')
    .items([
      // Site Settings singleton
      S.listItem()
        .title('Site Settings')
        .icon(() => '\u2699\uFE0F')
        .child(
          S.document()
            .schemaType('siteSettings')
            .documentId('siteSettings')
            .title('Site Settings')
        ),
      S.divider(),

      // Orders (prominent for production workflow)
      S.listItem()
        .title('Orders')
        .icon(() => '\u{1F4E6}')
        .child(
          S.documentTypeList('order')
            .title('Orders')
            .defaultOrdering([{ field: 'createdAt', direction: 'desc' }])
        ),

      // Contact Submissions (separate workflow from Orders — public enquiries)
      S.listItem()
        .title('Contact Submissions')
        .icon(() => '\u{1F4E8}')
        .child(
          S.documentTypeList('contactSubmission')
            .title('Contact Submissions')
            .defaultOrdering([{ field: 'submittedAt', direction: 'desc' }])
        ),
      S.divider(),

      // Products
      S.listItem()
        .title('Products')
        .icon(() => '\u{1F5BC}\uFE0F')
        .child(
          S.list()
            .title('Products')
            .items([
              S.listItem()
                .title('All Products')
                .child(S.documentTypeList('product').title('All Products')),
              S.divider(),
              S.listItem()
                .title('Comic Book Covers')
                .child(
                  S.documentTypeList('product')
                    .title('Comic Book Covers')
                    .filter('_type == "product" && category == "comic-book-covers"')
                ),
              S.listItem()
                .title('Comic Book Icons')
                .child(
                  S.documentTypeList('product')
                    .title('Comic Book Icons')
                    .filter('_type == "product" && category == "comic-book-icons"')
                ),
              S.listItem()
                .title('Comic Book Strips')
                .child(
                  S.documentTypeList('product')
                    .title('Comic Book Strips')
                    .filter('_type == "product" && category == "comic-book-strips"')
                ),
              S.listItem()
                .title('Personalised')
                .child(
                  S.documentTypeList('product')
                    .title('Personalised')
                    .filter('_type == "product" && category == "personalised"')
                ),
            ])
        ),

      // Blog
      S.listItem()
        .title('Blog Posts')
        .icon(() => '\u{1F4DD}')
        .child(
          S.documentTypeList('blogPost')
            .title('Blog Posts')
            .defaultOrdering([{ field: 'publishedAt', direction: 'desc' }])
        ),

      // Testimonials
      S.listItem()
        .title('Testimonials')
        .icon(() => '\u2B50')
        .child(S.documentTypeList('testimonial').title('Testimonials')),

      // FAQs
      S.listItem()
        .title('FAQs')
        .icon(() => '\u2754')
        .child(
          S.documentTypeList('faq')
            .title('FAQs')
            .defaultOrdering([{ field: 'sortOrder', direction: 'asc' }])
        ),
    ]);

export default defineConfig({
  name: 'comic-strip-canvas',
  title: 'Comic Strip Canvas',
  projectId: 'lwbwahym',
  dataset: 'production',
  plugins: [structureTool({ structure })],
  schema: {
    types: schemaTypes,
  },
});
