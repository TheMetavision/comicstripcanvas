import { defineType, defineField } from 'sanity';

export default defineType({
  name: 'product',
  title: 'Product',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: { source: 'title', maxLength: 96 },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'category',
      title: 'Category',
      type: 'string',
      options: {
        list: [
          { title: 'Comic Book Covers', value: 'comic-book-covers' },
          { title: 'Comic Book Icons', value: 'comic-book-icons' },
          { title: 'Comic Book Strips', value: 'comic-book-strips' },
          { title: 'Personalised', value: 'personalised' },
        ],
        layout: 'radio',
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 4,
    }),
    defineField({
      name: 'images',
      title: 'Product Images',
      type: 'array',
      of: [
        {
          type: 'image',
          options: { hotspot: true },
          fields: [
            {
              name: 'alt',
              title: 'Alt Text',
              type: 'string',
            },
          ],
        },
      ],
      validation: (Rule) => Rule.min(1).error('At least one image is required'),
    }),
    defineField({
      name: 'artworkHistory',
      title: 'Artwork History',
      type: 'array',
      readOnly: true,
      description:
        'The last five times this product’s artwork was replaced from the studio builder, ' +
        'or its product image was taken over by a render or a web-versions upload. ' +
        'Written by studio-save and the renderer; the previous print master is kept in the ' +
        'studio blob store as print-prev.png for one rollback.',
      of: [
        {
          type: 'object',
          name: 'artworkChange',
          fields: [
            { name: 'at', title: 'When', type: 'datetime' },
            { name: 'sceneId', title: 'Scene / product id', type: 'string' },
            { name: 'by', title: 'By', type: 'string' },
            { name: 'template', title: 'Template', type: 'string' },
            {
              name: 'prevPrintFileAssetId',
              title: 'Previous print file asset',
              type: 'string',
              description: 'What printFile pointed at before this redraw — the way back if it was wrong.',
            },
            {
              name: 'prevListingAssetId',
              title: 'Previous product image asset',
              type: 'string',
              description:
                'What images[0] pointed at before this change took that slot. Set when a render ' +
                'or a web-versions upload replaces a product image somebody else chose — the ' +
                'hand-curated catalogue products keep their gallery, but their first image is ' +
                'taken over, and this is the way back to it.',
            },
          ],
          preview: {
            select: { at: 'at', by: 'by', template: 'template' },
            prepare({ at, by, template }: any) {
              return {
                title: at ? new Date(at).toLocaleString('en-GB') : 'unknown date',
                subtitle: [by, template].filter(Boolean).join(' · '),
              };
            },
          },
        },
      ],
    }),
    defineField({
      name: 'printFile',
      title: 'High-Res Print File',
      type: 'file',
      description: 'The production-quality file used for printing. Not shown on the frontend.',
    }),
    defineField({
      name: 'accentColor',
      title: 'Accent Colour',
      type: 'string',
      options: {
        list: [
          { title: 'Red (Magenta)', value: '#EC008C' },
          { title: 'Yellow', value: '#FFF200' },
          { title: 'Cyan', value: '#00AEEF' },
        ],
      },
      initialValue: '#EC008C',
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [{ type: 'string' }],
      options: { layout: 'tags' },
      description: 'e.g. film, music, sport, tv, football, boxing',
    }),
    defineField({
      name: 'featured',
      title: 'Featured Product',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'isPersonalised',
      title: 'Personalised Product',
      type: 'boolean',
      initialValue: false,
      description: 'Enable for products that use the personalisation workflow',
    }),
    defineField({
      name: 'personalisationFee',
      title: 'Personalisation Fee (£)',
      type: 'number',
      hidden: ({ document }: any) => !document?.isPersonalised,
      validation: (Rule: any) => Rule.min(0),
      description:
        'Artwork fee added on top of the print price for a personalised build. Read at checkout by netlify/functions/checkout.mjs -- changing it here changes what customers are charged, with no deploy.',
    }),
    defineField({
      name: 'sortOrder',
      title: 'Sort Order',
      type: 'number',
      initialValue: 0,
      description: 'Lower numbers appear first. Used for manual ordering within categories.',
    }),
    defineField({
      name: 'seo',
      title: 'SEO',
      type: 'object',
      fields: [
        { name: 'metaTitle', title: 'Meta Title', type: 'string' },
        { name: 'metaDescription', title: 'Meta Description', type: 'text', rows: 3 },
        {
          name: 'ogImage',
          title: 'Open Graph Image',
          type: 'image',
        },
      ],
      options: { collapsible: true, collapsed: true },
    }),
  ],
  preview: {
    select: {
      title: 'title',
      category: 'category',
      media: 'images.0',
    },
    prepare({ title, category, media }) {
      const categoryLabels: Record<string, string> = {
        'comic-book-covers': 'Covers',
        'comic-book-icons': 'Icons',
        'comic-book-strips': 'Strips',
        'personalised': 'Personalised',
      };
      return {
        title,
        subtitle: categoryLabels[category] || category,
        media,
      };
    },
  },
  orderings: [
    { title: 'Sort Order', name: 'sortOrderAsc', by: [{ field: 'sortOrder', direction: 'asc' }] },
    { title: 'Title A-Z', name: 'titleAsc', by: [{ field: 'title', direction: 'asc' }] },
  ],
});
