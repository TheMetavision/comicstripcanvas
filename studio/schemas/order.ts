import { defineType, defineField } from 'sanity';

export default defineType({
  name: 'order',
  title: 'Order',
  type: 'document',
  fields: [
    defineField({
      name: 'orderNumber',
      title: 'Order Number',
      type: 'string',
      readOnly: true,
      description: 'Human-readable order reference, e.g. CSC-1001',
    }),
    defineField({
      name: 'stripeSessionId',
      title: 'Stripe Session ID',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'customerName',
      title: 'Customer Name',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'customerEmail',
      title: 'Customer Email',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'shippingAddress',
      title: 'Shipping Address',
      type: 'object',
      readOnly: true,
      fields: [
        { name: 'line1', type: 'string', title: 'Line 1' },
        { name: 'line2', type: 'string', title: 'Line 2' },
        { name: 'city', type: 'string', title: 'City' },
        { name: 'county', type: 'string', title: 'County' },
        { name: 'postcode', type: 'string', title: 'Postcode' },
        { name: 'country', type: 'string', title: 'Country' },
      ],
    }),
    defineField({
      name: 'lineItems',
      title: 'Line Items',
      type: 'array',
      readOnly: true,
      of: [
        {
          type: 'object',
          fields: [
            { name: 'productTitle', type: 'string', title: 'Product' },
            { name: 'format', type: 'string', title: 'Format' },
            { name: 'size', type: 'string', title: 'Size' },
            { name: 'quantity', type: 'number', title: 'Qty' },
            { name: 'unitPrice', type: 'number', title: 'Unit Price (£)' },
            {
              name: 'productRef',
              title: 'Product Reference',
              type: 'reference',
              to: [{ type: 'product' }],
            },
          ],
          preview: {
            select: {
              title: 'productTitle',
              format: 'format',
              size: 'size',
              qty: 'quantity',
              price: 'unitPrice',
            },
            prepare({ title, format, size, qty, price }) {
              return {
                title: `${title}`,
                subtitle: `${format} / ${size} × ${qty} — £${((price || 0) * (qty || 1)).toFixed(2)}`,
              };
            },
          },
        },
      ],
    }),
    defineField({
      name: 'shippingCost',
      title: 'Shipping Cost (£)',
      type: 'number',
      readOnly: true,
      description: 'Actual P&P charged. 0 = free shipping.',
    }),
    defineField({
      name: 'totalAmount',
      title: 'Total Amount (£)',
      type: 'number',
      readOnly: true,
    }),
    defineField({
      name: 'stripePaymentId',
      title: 'Stripe Payment Intent ID',
      type: 'string',
      readOnly: true,
    }),
    defineField({
      name: 'status',
      title: 'Order Status',
      type: 'string',
      options: {
        list: [
          { title: 'Received', value: 'received' },
          { title: 'In Production', value: 'in-production' },
          { title: 'Dispatched', value: 'dispatched' },
          { title: 'Delivered', value: 'delivered' },
          { title: 'Cancelled', value: 'cancelled' },
          { title: 'Refunded', value: 'refunded' },
        ],
        layout: 'radio',
      },
      initialValue: 'received',
      description: 'Setting this to Dispatched (with a Tracking Number filled in) will automatically send a shipping notification email to the customer.',
      validation: (Rule) =>
        Rule.custom((status, context) => {
          const tracking = context.document?.trackingNumber;
          if ((status === 'dispatched' || status === 'delivered') && !tracking) {
            return 'Add a Tracking Number before marking the order Dispatched or Delivered.';
          }
          return true;
        }),
    }),
    defineField({
      name: 'trackingNumber',
      title: 'Tracking Number',
      type: 'string',
      description: 'Add when dispatched. ⚠ Adding this and setting status to Dispatched will trigger an automatic shipping email to the customer.',
    }),
    defineField({
      name: 'carrier',
      title: 'Carrier',
      type: 'string',
      options: {
        list: [
          { title: 'UPS', value: 'ups' },
          { title: 'Royal Mail', value: 'royal-mail' },
          { title: 'Other', value: 'other' },
        ],
        layout: 'radio',
      },
      description: 'Auto-detected from line items at dispatch time (Canvas → UPS, Poster only → Royal Mail). Leave blank for auto-detect, or set manually + tick "Override carrier" below to force a specific carrier.',
    }),
    defineField({
      name: 'carrierOverride',
      title: 'Override carrier',
      type: 'boolean',
      initialValue: false,
      description: 'Tick this if you want to manually override the auto-detected carrier. Otherwise the system will pick UPS / Royal Mail based on line items.',
    }),
    defineField({
      name: 'carrierOther',
      title: 'Other Carrier Name',
      type: 'string',
      description: 'If carrier = Other, enter the carrier name here (e.g. "Evri", "DPD"). The shipping email will show this name and a plain tracking number (no auto link).',
      hidden: ({ document }) => document?.carrier !== 'other',
    }),
    defineField({
      name: 'notes',
      title: 'Production Notes',
      type: 'text',
      rows: 4,
      description: 'Internal notes for the production team',
    }),
    defineField({
      name: 'isPersonalised',
      title: 'Personalised Order',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'personalisationDetails',
      title: 'Personalisation Details',
      type: 'object',
      hidden: ({ document }) => !document?.isPersonalised,
      fields: [
        { name: 'style', type: 'string', title: 'Style Chosen' },
        { name: 'customerTitle', type: 'string', title: 'Name/Title Text' },
        { name: 'captionText', type: 'string', title: 'Speech Bubble/Caption' },
        { name: 'instructions', type: 'text', title: 'Special Instructions', rows: 3 },
        {
          name: 'uploadedImages',
          title: 'Uploaded Images',
          type: 'array',
          of: [{ type: 'url' }],
          description: 'URLs to customer-uploaded images',
        },
      ],
      options: { collapsible: true, collapsed: false },
    }),
    defineField({
      name: 'shippingEmailSent',
      title: 'Shipping Email Sent',
      type: 'boolean',
      initialValue: false,
      readOnly: true,
      description: 'Set automatically once the dispatch notification email has been sent to the customer.',
    }),
    defineField({
      name: 'shippingEmailSentAt',
      title: 'Shipping Email Sent At',
      type: 'datetime',
      readOnly: true,
      description: 'Timestamp of when the shipping notification was sent.',
    }),
    defineField({
      name: 'notifyError',
      title: 'Notification Error',
      type: 'string',
      readOnly: true,
      description: 'Set automatically if the order could not be emailed (e.g. missing/invalid customer email). Blank = no problem.',
    }),
    defineField({
      name: 'customerEmailError',
      title: 'Customer Email Error',
      type: 'string',
      readOnly: true,
      description: 'Set automatically if the customer confirmation email failed to send. Blank = sent OK.',
    }),
    defineField({
      name: 'teamEmailError',
      title: 'Team Email Error',
      type: 'string',
      readOnly: true,
      description: 'Set automatically if the team notification email failed to send. Blank = sent OK.',
    }),
    defineField({
      name: 'createdAt',
      title: 'Order Date',
      type: 'datetime',
      readOnly: true,
    }),
    defineField({
      name: 'paidAt',
      title: 'Paid At',
      type: 'datetime',
      readOnly: true,
      description: 'When payment was confirmed and the order was created. Set automatically.',
    }),
  ],
  preview: {
    select: {
      orderNumber: 'orderNumber',
      customer: 'customerName',
      status: 'status',
      total: 'totalAmount',
      date: 'createdAt',
    },
    prepare({ orderNumber, customer, status, total, date }) {
      const statusLabels: Record<string, string> = {
        received: '📥 Received',
        'in-production': '🎨 In Production',
        dispatched: '📦 Dispatched',
        delivered: '✅ Delivered',
        cancelled: '🚫 Cancelled',
        refunded: '💸 Refunded',
      };
      return {
        title: `${orderNumber ? orderNumber + ' — ' : ''}${customer || 'Unknown Customer'}`,
        subtitle: `${statusLabels[status] || status} — £${(total || 0).toFixed(2)} — ${date ? new Date(date).toLocaleDateString('en-GB') : ''}`,
      };
    },
  },
  orderings: [
    { title: 'Newest First', name: 'dateDesc', by: [{ field: 'createdAt', direction: 'desc' }] },
    { title: 'Status', name: 'statusAsc', by: [{ field: 'status', direction: 'asc' }] },
  ],
});
