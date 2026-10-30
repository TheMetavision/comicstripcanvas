import { defineType, defineField } from 'sanity';
import { ALL_BANDS, BAND_TITLES } from '../../netlify/functions/_shared/parcel-bands.mjs';

/**
 * returnRequest
 * --------------------------------------------------------------------------
 * A customer's change-of-mind return, made by the /returns page
 * (netlify/functions/returns.mjs), or a free-label return for a faulty or
 * wrong item, made by Alan from the order's "Create return" button.
 *
 * Stored at returnRequest.<ref> -- a dotted id, so anonymous reads of the
 * public dataset never return it (tools/check-public-exposure.mjs checks).
 *
 * Alan's part is the decision: status (Approved / Rejected), the parcel band,
 * the free-label flag, which lines, the rejection reason and his notes. Those
 * are the fields guarded-publish takes from a draft; everything else is the
 * server's and always comes from the published document.
 *
 *   Approved  -> shipping-return buys the label and emails it (Label sent)
 *   Rejected  -> the customer is emailed the reason written here
 *   then tracking moves it to In transit / Ready to collect; Received and
 *   Refunded are Alan's. Refunds are made by hand in Stripe, less
 *   postageDeduction unless it is a free label.
 */
const STATUSES = [
  { title: 'Requested', value: 'requested' },
  { title: 'Approved (sends the label)', value: 'approved' },
  { title: 'Rejected (emails the reason)', value: 'rejected' },
  { title: 'Label sent', value: 'label_sent' },
  { title: 'In transit', value: 'in_transit' },
  { title: 'Ready to collect', value: 'ready_to_collect' },
  { title: 'Received', value: 'received' },
  { title: 'Refunded', value: 'refunded' },
];
const STATUS_TITLE: Record<string, string> = Object.fromEntries(STATUSES.map((s) => [s.value, s.title.replace(/ \(.*\)$/, '')]));

export default defineType({
  name: 'returnRequest',
  title: 'Return Request',
  type: 'document',
  fields: [
    defineField({ name: 'returnNumber', title: 'Return', type: 'string', readOnly: true }),
    defineField({
      name: 'status',
      title: 'Status',
      type: 'string',
      options: { list: STATUSES, layout: 'radio' },
      initialValue: 'requested',
      description: 'Approve to buy the return label and email it to the customer. Reject to email them the reason below.',
      validation: (Rule) => Rule.custom((status, ctx) => {
        const doc = ctx.document as any;
        if (status === 'rejected' && !String(doc?.rejectionReason || '').trim()) {
          return 'Write the reason for rejecting: the customer is emailed it.';
        }
        if (status === 'approved' && !doc?.band) return 'Choose the parcel band before approving.';
        return true;
      }),
    }),
    defineField({
      name: 'freeLabel',
      title: 'Faulty / wrong item — free label',
      type: 'boolean',
      initialValue: false,
      description: 'Ticked: no postage is deducted and the email says the label is free. For a faulty, damaged or wrong item.',
    }),
    defineField({
      name: 'band',
      title: 'Parcel band',
      type: 'string',
      options: { list: ALL_BANDS.map((b: string) => ({ title: (BAND_TITLES as Record<string, string>)[b] || b, value: b })) },
      description: 'Filled in for a single item. For more than one item in one box, choose the box.',
    }),
    defineField({
      name: 'rejectionReason',
      title: 'Reason for rejecting',
      type: 'text',
      rows: 3,
      description: 'Sent to the customer word for word if you reject.',
    }),
    defineField({ name: 'alanNotes', title: 'Notes (internal)', type: 'text', rows: 3 }),
    defineField({
      name: 'postageDeduction',
      title: 'Deduct from refund (£)',
      type: 'number',
      readOnly: true,
      description: 'The price the shipping service quoted when it bought the label: the figure in the customer’s label email. 0 for a free label. Blank if the service gave no price (see Last problem). Take it off the refund in Stripe.',
    }),
    defineField({ name: 'error', title: '⚠ Last problem', type: 'text', rows: 3, readOnly: true, hidden: ({ value }) => !value }),
    defineField({
      name: 'deliveryDateUnknown',
      title: '⚠ Delivery date unknown',
      type: 'boolean',
      readOnly: true,
      hidden: ({ value }) => !value,
      description: 'No recorded delivery, so the 14-day window could not be checked. Judge it yourself.',
    }),
    defineField({ name: 'deliveredAt', title: 'Delivered', type: 'datetime', readOnly: true, hidden: ({ value }) => !value }),
    defineField({ name: 'windowEndsOn', title: '14 days end', type: 'string', readOnly: true, hidden: ({ value }) => !value }),
    defineField({
      name: 'lines',
      title: 'Items',
      type: 'array',
      description: 'Remove any item that is not coming back.',
      of: [{
        type: 'object',
        name: 'returnLine',
        fields: [
          { name: 'productTitle', type: 'string', title: 'Product', readOnly: true },
          { name: 'format', type: 'string', title: 'Format', readOnly: true },
          { name: 'size', type: 'string', title: 'Size', readOnly: true },
          { name: 'quantity', type: 'number', title: 'Qty' },
          { name: 'unitPrice', type: 'number', title: 'Unit price (£)', readOnly: true },
          { name: 'lineKey', type: 'string', title: 'Order line', readOnly: true },
          { name: 'formatKey', type: 'string', title: 'Format key', readOnly: true, hidden: true },
          { name: 'sizeKey', type: 'string', title: 'Size key', readOnly: true, hidden: true },
        ],
        preview: {
          select: { title: 'productTitle', format: 'format', size: 'size', qty: 'quantity' },
          prepare: ({ title, format, size, qty }: any) => ({ title: `${title} × ${qty || 1}`, subtitle: [format, size].filter(Boolean).join(' / ') }),
        },
      }],
    }),
    defineField({ name: 'reasonLabel', title: 'Reason', type: 'string', readOnly: true }),
    defineField({ name: 'customerNotes', title: 'Customer notes', type: 'text', rows: 3, readOnly: true }),
    defineField({ name: 'order', title: 'Order', type: 'reference', to: [{ type: 'order' }], weak: true, readOnly: true }),
    defineField({ name: 'orderNumber', title: 'Order number', type: 'string', readOnly: true }),
    defineField({ name: 'customerName', title: 'Customer', type: 'string', readOnly: true }),
    defineField({ name: 'customerEmail', title: 'Customer email', type: 'string', readOnly: true }),
    defineField({ name: 'carrier', title: 'Carrier', type: 'string', readOnly: true }),
    defineField({ name: 'option', title: 'Shipping option', type: 'string', readOnly: true }),
    defineField({ name: 'quotedPrice', title: 'Label quoted price (£)', type: 'number', readOnly: true }),
    defineField({ name: 'trackingNumber', title: 'Tracking number', type: 'string', readOnly: true }),
    defineField({ name: 'trackingUrl', title: 'Tracking link', type: 'url', readOnly: true }),
    defineField({ name: 'labelId', title: 'Label id', type: 'string', readOnly: true }),
    defineField({ name: 'parcelId', title: 'Sendcloud parcel id', type: 'string', readOnly: true }),
    defineField({ name: 'customerInstructions', title: 'Instructions sent to the customer', type: 'text', rows: 3, readOnly: true }),
    defineField({ name: 'test', title: 'Test label', type: 'boolean', readOnly: true, hidden: ({ value }) => !value }),
    defineField({ name: 'requestedAt', title: 'Requested', type: 'datetime', readOnly: true }),
    defineField({ name: 'labelSentAt', title: 'Label emailed', type: 'datetime', readOnly: true }),
    defineField({ name: 'rejectionEmailSentAt', title: 'Decline emailed', type: 'datetime', readOnly: true }),
    defineField({ name: 'readyToCollectAt', title: 'Ready to collect', type: 'datetime', readOnly: true }),
    defineField({ name: 'receivedAt', title: 'Received', type: 'datetime', readOnly: true }),
    defineField({
      name: 'events',
      title: 'Tracking events (newest 30)',
      type: 'array',
      readOnly: true,
      of: [{
        type: 'object',
        name: 'shipmentEvent',
        fields: [
          { name: 'at', type: 'datetime', title: 'At' },
          { name: 'status', type: 'string', title: 'Status' },
          { name: 'statusCode', type: 'number', title: 'Code' },
          { name: 'carrierStatus', type: 'string', title: 'Carrier says' },
          { name: 'kind', type: 'string', title: 'Meaning' },
          { name: 'test', type: 'boolean', title: 'Test' },
        ],
      }],
    }),
    defineField({ name: 'source', title: 'Made by', type: 'string', readOnly: true, description: 'customer (the /returns page) or studio (Create return on the order).' }),
    defineField({ name: 'returnRef', title: 'Service reference', type: 'string', readOnly: true }),
    defineField({ name: 'orderId', title: 'Order id', type: 'string', readOnly: true, hidden: true }),
    defineField({ name: 'reason', title: 'Reason key', type: 'string', readOnly: true, hidden: true }),
    defineField({ name: 'claimedAt', title: 'Claimed', type: 'datetime', readOnly: true, hidden: true }),
  ],
  preview: {
    select: { n: 'returnNumber', name: 'customerName', status: 'status', free: 'freeLabel', unknown: 'deliveryDateUnknown' },
    prepare: ({ n, name, status, free, unknown }: any) => ({
      title: `${n || 'Return'} — ${name || ''}`,
      subtitle: [STATUS_TITLE[status] || status, free ? 'free label' : null, unknown ? '⚠ delivery date unknown' : null].filter(Boolean).join(' · '),
    }),
  },
  orderings: [{ title: 'Newest first', name: 'requestedDesc', by: [{ field: 'requestedAt', direction: 'desc' }] }],
});
