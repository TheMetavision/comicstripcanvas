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
      description: 'Lower numbers appear first',
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
