import { defineType, defineField } from 'sanity';
import ProofPanel from '../components/ProofPanel';

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
 * These are NOT throwaway any more. They are the order-in-progress record for
 * builder-made artwork, and the Studio lists them under Personalisations,
 * grouped by status.
 *
 * netlify/functions/personalise-save.mjs also creates these, from the product
 * builder, at "Add to basket" time — before any payment. Those carry the built
 * scene (recipe + sceneSvg) and Netlify Blob keys for the customer's photos.
 *
 * IMPORTANT: customer photos are never uploaded to Sanity's asset library. Only
 * their Blob keys are stored here, in photoKeys / styledKeys.
 */
const STATUSES = [
  { title: 'Draft', value: 'draft' },
  { title: 'Awaiting payment', value: 'awaiting_payment' },
  { title: 'Paid', value: 'paid' },
  { title: 'Preparing', value: 'preparing' },
  { title: 'Rendered', value: 'rendered' },
  { title: 'Approved', value: 'approved' },
  { title: 'In production', value: 'in_production' },
  { title: 'Dispatched', value: 'dispatched' },
  { title: 'On hold', value: 'on_hold' },
];
const STATUS_TITLE: Record<string, string> = Object.fromEntries(
  STATUSES.map((s) => [s.value, s.title])
);

export default defineType({
  name: 'pendingPersonalisation',
  title: 'Pending Personalisation',
  type: 'document',
  fields: [
    // Read-only: the proof, then the state it is in. First in the list so a
    // reviewer sees the artwork and whether it is approvable without scrolling.
    defineField({
      name: 'proofPanel',
      title: 'Proof',
      type: 'string',
      readOnly: true,
      components: { field: ProofPanel },
    }),
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
        'The worst effective DPI across all panels. What counts as soft depends on the output: below 150 for a poster print, below 100 for either canvas wrap.',
    }),
    defineField({
      name: 'renderError',
      title: 'Render Error',
      type: 'text',
      rows: 3,
      readOnly: true,
      description:
        'Why the last render failed. Set alongside status "on hold"; cleared on a successful render.',
    }),
    defineField({
      name: 'status',
      title: 'Status',
      type: 'string',
      initialValue: 'draft',
      options: {
        list: STATUSES,
        layout: 'dropdown',
      },
    }),
    // ── stamped by the Stripe webhook once the order is paid ──────────────
    defineField({
      name: 'stripeSessionId',
      title: 'Stripe Session',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'orderId',
      title: 'Order',
      type: 'string',
      readOnly: true,
      description: 'The order document this build was paid for on.',
    }),

    // ── set by the Studio document actions ────────────────────────────────
    defineField({
      name: 'approvedAt',
      title: 'Approved At',
      type: 'datetime',
      readOnly: true,
      description: 'When a reviewer approved the proof and it went to the customer.',
    }),
    defineField({
      name: 'customerApprovedAt',
      title: 'Customer Approved At',
      type: 'datetime',
      readOnly: true,
      description: 'When the customer clicked Approve in their proof email.',
    }),
    defineField({
      name: 'holdNote',
      title: 'Hold Note',
      type: 'text',
      rows: 3,
      readOnly: true,
      description: 'Why this was put on hold.',
    }),
    defineField({
      name: 'approveToken',
      title: 'Approve Token',
      type: 'string',
      readOnly: true,
      hidden: true,
      description:
        'One-shot capability for the customer\'s Approve link. Cleared when used, so the link cannot be replayed.',
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
      description:
        'Netlify Blob keys for the styled versions. Kept flat and in step with photos[] ' +
        'so anything reading the old shape still works; photos[] is the one to read.',
    }),

    /* One row per panel, replacing the two parallel key arrays as the thing to
       read. The arrays could not say which panel was mid-styling, which had
       failed and why, or that two panels hold the same photograph -- and a
       styling step that can fail per panel needs all three. The arrays are
       still written for compatibility. */
    defineField({
      name: 'photos',
      title: 'Photos',
      type: 'array',
      readOnly: true,
      description:
        'Per-panel styling state. rawKey and styledKey are Netlify Blob keys — the ' +
        'photographs themselves are NEVER uploaded to Sanity.',
      of: [
        {
          type: 'object',
          name: 'styledPhoto',
          fields: [
            { name: 'panel', title: 'Panel', type: 'string' },
            { name: 'rawKey', title: 'Raw Blob Key', type: 'string' },
            { name: 'styledKey', title: 'Styled Blob Key', type: 'string' },
            {
              name: 'sha256',
              title: 'SHA-256 of the raw bytes',
              type: 'string',
              description:
                'Identifies the photograph itself. The same picture dropped into several ' +
                'panels is styled once and the result shared, which is the difference ' +
                'between one model call and twelve.',
            },
            {
              name: 'styleStatus',
              title: 'Style Status',
              type: 'string',
              options: {
                list: [
                  { title: 'Pending', value: 'pending' },
                  { title: 'Styling', value: 'styling' },
                  { title: 'Done', value: 'done' },
                  { title: 'Failed', value: 'failed' },
                  { title: 'Paused (daily limit)', value: 'paused' },
                ],
              },
            },
            { name: 'styleError', title: 'Style Error', type: 'string' },
            { name: 'styledWidth', title: 'Styled Width', type: 'number' },
            { name: 'styledHeight', title: 'Styled Height', type: 'number' },
            { name: 'styledAt', title: 'Styled At', type: 'datetime' },
            {
              name: 'cutoutKey',
              title: 'Cutout Blob Key',
              type: 'string',
              description:
                'RGBA PNG with the background removed, for the standard comic book cover only. ' +
                'Absent everywhere else, and absent on a cover whose cutout failed — which is ' +
                'not an error: the cover still prints from the styled image.',
            },
            { name: 'cutoutWidth', title: 'Cutout Width', type: 'number' },
            { name: 'cutoutHeight', title: 'Cutout Height', type: 'number' },
            {
              name: 'cutoutError',
              title: 'Cutout Error',
              type: 'string',
              description:
                'Why no cutout. Never blocks the order — the panel stays "done" on the styled ' +
                'image and the customer can still check out.',
            },
          ],
          preview: {
            select: { panel: 'panel', status: 'styleStatus', err: 'styleError', w: 'styledWidth', h: 'styledHeight' },
            prepare({ panel, status, err, w, h }: any) {
              return {
                title: `${panel || '?'} — ${status || 'pending'}`,
                subtitle: err || (w && h ? `${w} × ${h}` : ''),
              };
            },
          },
        },
      ],
    }),
    defineField({
      name: 'styleSize',
      title: 'Style Size',
      type: 'string',
      readOnly: true,
      options: {
        list: [
          { title: '2K', value: '2K' },
          { title: '4K', value: '4K' },
        ],
      },
      description:
        'Output size asked of the image model, derived from the template: 4K for the ' +
        'covers, which print largest, 2K for strips and icons. Costs roughly 52s a ' +
        'photo against 36s, which is why it is not simply 4K everywhere.',
    }),
    defineField({
      name: 'styleCalls',
      title: 'Style Calls Used',
      type: 'number',
      readOnly: true,
      description:
        'Every model call this personalisation has made, retries included. Capped at 16 ' +
        'so a stuck retry loop cannot run up a bill; past the cap a panel is marked ' +
        'failed with reason "cap" rather than being called again.',
    }),
    defineField({
      name: 'kind',
      title: 'Kind',
      type: 'string',
      readOnly: true,
      options: {
        list: [
          { title: 'Personalised (customer photos)', value: 'personalised' },
          { title: 'Customised stock design', value: 'customise' },
        ],
      },
      description:
        'What was built. "personalised" is the ordinary flow: the customer’s own photographs, ' +
        'styled by the model. "customise" is a stock design reopened with the customer’s own ' +
        'wording over the shop’s artwork — no photographs, no styling, no model calls, and ' +
        'the artwork below belongs to the product rather than to this document. Absent means ' +
        'personalised: everything built before this existed was.',
    }),
    defineField({
      name: 'productId',
      title: 'Customised Product',
      type: 'string',
      readOnly: true,
      hidden: ({ document }: any) => document?.kind !== 'customise',
      description: 'Which stock product’s design this is a version of.',
    }),
    defineField({
      name: 'artworkStyle',
      title: 'Artwork Style',
      type: 'string',
      readOnly: true,
      hidden: ({ document }: any) => document?.kind !== 'customise',
      description: 'Which of the product’s two styles was customised: classic or fullBleed.',
    }),
    defineField({
      name: 'sceneId',
      title: 'Scene Id',
      type: 'string',
      readOnly: true,
      hidden: ({ document }: any) => document?.kind !== 'customise',
      description: 'The studio scene the design came from; its artwork lives under studio/<this id>/.',
    }),
    defineField({
      name: 'artworkKeys',
      title: 'Artwork Keys',
      type: 'array',
      readOnly: true,
      hidden: ({ document }: any) => document?.kind !== 'customise',
      of: [
        {
          type: 'object',
          name: 'artworkKey',
          fields: [
            { name: 'panel', title: 'Panel', type: 'string' },
            { name: 'key', title: 'Blob key', type: 'string' },
          ],
          preview: {
            select: { title: 'panel', subtitle: 'key' },
          },
        },
      ],
      description:
        'Which blob fills each panel when this is rendered. Resolved on the server from the ' +
        'product’s own scene at Add to basket — never sent by the browser — so a customer ' +
        'cannot point a render at artwork that is not theirs to print. These belong to the ' +
        'STUDIO store and outlive this document: retention must never follow them.',
    }),
    defineField({
      name: 'guardKey',
      title: 'Spend Guard Key',
      type: 'string',
      readOnly: true,
      description:
        'Which rate-limit bucket this build spends from: a salted hash of the visitor ' +
        'address, never the address itself. Written at the first upload and read by ' +
        'the styling job, which is where a call is actually billed and therefore ' +
        'where the count has to be kept. Two builds sharing a value came from the ' +
        'same connection; nothing here can be turned back into an address.',
    }),
    defineField({
      name: 'origin',
      title: 'Spend Origin',
      type: 'string',
      readOnly: true,
      options: {
        list: [
          { title: 'Customer', value: 'customer' },
          { title: 'Studio', value: 'studio' },
        ],
      },
      initialValue: 'customer',
      description:
        'Which daily styling budget this build spends from. Customer builds count against ' +
        'STYLE_DAILY_MAX and studio builds against STUDIO_STYLE_DAILY_MAX, so internal work ' +
        'cannot exhaust the ceiling the live builder depends on, or the other way round. ' +
        'Set once at the upload that creates the build and never afterwards: the job that ' +
        'actually bills runs in the background and reads this rather than the request. ' +
        'Empty on anything written before the two budgets were separated, and read as ' +
        'Customer.',
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
      printSize: 'printSize',
    },
    prepare({ title, style, date, status, template, printSize }) {
      // status · template · print size · date
      const parts = [
        STATUS_TITLE[status] || status,
        template || style,
        printSize,
        date ? new Date(date).toLocaleDateString('en-GB') : null,
      ].filter(Boolean);
      return {
        title: title || 'Pending personalisation',
        subtitle: parts.join(' · '),
      };
    },
  },
});
