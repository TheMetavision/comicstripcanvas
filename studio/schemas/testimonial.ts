import { defineType, defineField } from 'sanity';

export default defineType({
  name: 'testimonial',
  title: 'Testimonial',
  type: 'document',
  fields: [
    defineField({
      name: 'customerName',
      title: 'Customer Name',
      type: 'string',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'location',
      title: 'Location',
      type: 'string',
    }),
    defineField({
      name: 'rating',
      title: 'Rating',
      type: 'number',
      validation: (Rule) => Rule.min(1).max(5).integer(),
      initialValue: 5,
    }),
    defineField({
      name: 'quote',
      title: 'Quote',
      type: 'text',
      rows: 4,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'product',
      title: 'Product Purchased',
      type: 'string',
      description: 'e.g. "Comic Icons Canvas", "Personalised Comic Book Cover"',
    }),
    defineField({
      name: 'featured',
      title: 'Featured',
      type: 'boolean',
      initialValue: true,
      description: 'Show on homepage testimonial carousel',
    }),
  ],
  preview: {
    select: {
      title: 'customerName',
      subtitle: 'location',
    },
  },
});
