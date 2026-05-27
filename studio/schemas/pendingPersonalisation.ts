import { defineType, defineField } from 'sanity';

/**
 * pendingPersonalisation
 * --------------------------------------------------------------------------
 * A short-lived document created by netlify/functions/personalise.mjs at the
 * moment a personalised checkout is started. It holds the full personalisation
 * brief — including ALL uploaded photo URLs with no length limit — so the data
 * does not have to travel through Stripe metadata (which is capped at 500
 * characters per field).
 *
 * The webhook (netlify/functions/webhook.mjs) reads this document after a
 * successful payment, copies the data onto the real `order` document, and then
 * deletes this pending document.
 *
 * Documents that are never claimed (customer abandoned checkout) can be safely
 * bulk-deleted at any time — they contain no payment information.
 */
export default defineType({
  name: 'pendingPersonalisation',
  title: 'Pending Personalisation',
  type: 'document',
  // Hidden from the main Studio desk structure — these are transient.
  fields: [
    defineField({
      name: 'style',
      title: 'Style',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'customerTitle',
      title: 'Name/Title Text',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'captionText',
      title: 'Caption Text',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'instructions',
      title: 'Special Instructions',
      type: 'text',
      rows: 3,
      readOnly: true,
    }),
    defineField({
      name: 'uploadedImages',
      title: 'Uploaded Images',
      type: 'array',
      of: [{ type: 'url' }],
      readOnly: true,
      description: 'Full list of customer-uploaded photo URLs — no length limit.',
    }),
    defineField({
      name: 'createdAt',
      title: 'Created At',
      type: 'datetime',
      readOnly: true,
    }),
  ],
  preview: {
    select: {
      title: 'customerTitle',
      style: 'style',
      date: 'createdAt',
    },
    prepare({ title, style, date }) {
      return {
        title: title || 'Pending personalisation',
        subtitle: `${style || '—'} — ${date ? new Date(date).toLocaleString('en-GB') : ''}`,
      };
    },
  },
});
