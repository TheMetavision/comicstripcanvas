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
        .icon(() => '⚙️')
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
        .icon(() => '📦')
        .child(
          S.documentTypeList('order')
            .title('Orders')
            .defaultOrdering([{ field: 'createdAt', direction: 'desc' }])
        ),
      S.divider(),

      // Products
      S.listItem()
        .title('Products')
        .icon(() => '🖼️')
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
        .icon(() => '📝')
        .child(
          S.documentTypeList('blogPost')
            .title('Blog Posts')
            .defaultOrdering([{ field: 'publishedAt', direction: 'desc' }])
        ),

      // Testimonials
      S.listItem()
        .title('Testimonials')
        .icon(() => '⭐')
        .child(S.documentTypeList('testimonial').title('Testimonials')),

      // FAQs
      S.listItem()
        .title('FAQs')
        .icon(() => '❓')
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
