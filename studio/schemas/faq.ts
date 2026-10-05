import { defineType, defineField } from 'sanity';

export default defineType({
  name: 'faq',
  title: 'FAQ',
  type: 'document',
  fields: [
    defineField({
      name: 'question',
      title: 'Question',
      type: 'string',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'answer',
      title: 'Answer',
      type: 'text',
      rows: 5,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'sortOrder',
      title: 'Sort Order',
      type: 'number',
      initialValue: 0,
      description: 'Lower numbers appear first. Answers may use {title} (product pages) and {fee} (personalisation fee).',
    }),
    defineField({
      name: 'page',
      title: 'Display On Page',
      type: 'string',
      options: {
        list: [
          { title: 'Services / Pricing', value: 'services' },
          { title: 'Personalisation', value: 'personalise' },
          { title: 'Both', value: 'both' },
          { title: 'Product pages (all curated products)', value: 'product' },
          { title: 'Comic Book Covers category', value: 'comic-book-covers' },
          { title: 'Comic Book Icons category', value: 'comic-book-icons' },
          { title: 'Comic Book Strips category', value: 'comic-book-strips' },
        ],
      },
      initialValue: 'services',
    }),
  ],
  preview: {
    select: { title: 'question', subtitle: 'page' },
  },
  orderings: [
    { title: 'Sort Order', name: 'sortOrderAsc', by: [{ field: 'sortOrder', direction: 'asc' }] },
  ],
});
