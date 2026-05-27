import { defineType, defineField } from 'sanity';

/**
 * orderCounter
 * --------------------------------------------------------------------------
 * A single-document counter that tracks the last order number issued.
 * There is exactly ONE document of this type, with the fixed _id
 * 'orderCounter'. The webhook (netlify/functions/webhook.mjs) reads and
 * atomically increments it to allocate sequential order numbers (CSC-1001,
 * CSC-1002, ...).
 *
 * Do not delete this document or edit lastOrderNumber by hand unless you
 * intend to change the numbering sequence. It is created automatically by
 * the webhook on first run if it does not already exist.
 */
export default defineType({
  name: 'orderCounter',
  title: 'Order Counter',
  type: 'document',
  fields: [
    defineField({
      name: 'lastOrderNumber',
      title: 'Last Order Number',
      type: 'number',
      readOnly: true,
      description: 'The last numeric order value issued. Next order will be this + 1.',
    }),
  ],
  preview: {
    select: {
      last: 'lastOrderNumber',
    },
    prepare({ last }) {
      return {
        title: 'Order Counter',
        subtitle: `Last issued: CSC-${last || 1000}`,
      };
    },
  },
});
