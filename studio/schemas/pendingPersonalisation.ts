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
 *
 * netlify/functions/personalise-save.mjs also creates these, from the product
 * builder, at "Add to basket" time — before any payment. Those carry the built
 * scene (recipe + sceneSvg) and Netlify Blob keys for the customer's photos.
 *
 * IMPORTANT: customer photos are never uploaded to Sanity's asset library. Only
 * their Blob keys are stored here, in photoKeys / styledKeys.
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

    // ── built in the product builder ──────────────────────────────────────
    defineField({
      name: 'recipe',
      title: 'Recipe (JSON)',
      type: 'text',
      rows: 8,
      readOnly: true,
      description:
        'The builder recipe as JSON: template, canvas, output spec, panel transforms, ' +
        'box and text settings. The svg field is split out into Scene SVG below.',
    }),
    defineField({
      name: 'sceneSvg',
      title: 'Scene SVG',
      type: 'text',
      rows: 6,
      readOnly: true,
      description:
        'The exported scene with every asset replaced by a token ({{IMAGE:panel-01}}, ' +
        '{{BACKGROUND}}, {{OVERLAY}}, {{LOGO}}). The print renderer swaps the tokens for ' +
        'full-resolution files and rasterises this exact document.',
    }),
    defineField({
      name: 'templateId',
      title: 'Template',
      type: 'string',
      readOnly: true,
      description: 'strip, cover, cover-fullbleed, icon-portrait or icon-landscape.',
    }),
    defineField({
      name: 'printSize',
      title: 'Print Size',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'outputFormat',
      title: 'Output Format',
      type: 'string',
      readOnly: true,
      description: 'poster, standard (canvas standard wrap) or gallery (canvas gallery wrap).',
    }),
    defineField({
      name: 'proofUrl',
      title: 'Proof URL',
      type: 'url',
      description: 'Rendered proof sent to the customer for approval.',
    }),
    defineField({
      name: 'minEffectiveDpi',
      title: 'Lowest Effective DPI',
      type: 'number',
      readOnly: true,
      description:
        'The worst effective DPI across all panels. Below 150 the print will look soft.',
    }),
    defineField({
      name: 'status',
      title: 'Status',
      type: 'string',
      initialValue: 'draft',
      options: {
        list: [
          { title: 'Draft', value: 'draft' },
          { title: 'Awaiting payment', value: 'awaiting_payment' },
          { title: 'Paid', value: 'paid' },
          { title: 'Preparing', value: 'preparing' },
          { title: 'Rendered', value: 'rendered' },
          { title: 'Approved', value: 'approved' },
          { title: 'In production', value: 'in_production' },
          { title: 'Dispatched', value: 'dispatched' },
          { title: 'On hold', value: 'on_hold' },
        ],
        layout: 'dropdown',
      },
    }),
    defineField({
      name: 'photoKeys',
      title: 'Photo Blob Keys',
      type: 'array',
      of: [{ type: 'string' }],
      readOnly: true,
      description:
        'Netlify Blob keys for the customer photos (personalisation/<id>/<panelId>.<ext>). ' +
        'The photos themselves are NEVER uploaded to Sanity.',
    }),
    defineField({
      name: 'styledKeys',
      title: 'Styled Blob Keys',
      type: 'array',
      of: [{ type: 'string' }],
      readOnly: true,
      description: 'Netlify Blob keys for the styled/processed versions of each photo.',
    }),
    defineField({
      name: 'customerNotes',
      title: 'Customer Notes',
      type: 'text',
      rows: 3,
      readOnly: true,
      description: 'Free text from the "Anything we should know?" box at Add to basket.',
    }),
    defineField({
      name: 'consentAt',
      title: 'Consent Given At',
      type: 'datetime',
      readOnly: true,
      description:
        'When the customer confirmed they own the rights to the photos, or have permission ' +
        'to use them, and are happy for us to use them to make their artwork.',
    }),
  ],
  preview: {
    select: {
      title: 'customerTitle',
      style: 'style',
      date: 'createdAt',
      status: 'status',
      template: 'templateId',
    },
    prepare({ title, style, date, status, template }) {
      return {
        title: title || 'Pending personalisation',
        subtitle: `${status ? status + ' — ' : ''}${style || template || '—'} — ${date ? new Date(date).toLocaleString('en-GB') : ''}`,
      };
    },
  },
});
