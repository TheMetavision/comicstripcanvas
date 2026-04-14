import { defineType, defineField } from 'sanity';

export default defineType({
  name: 'order',
  title: 'Order',
  type: 'document',
  fields: [
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
        ],
        layout: 'radio',
      },
      initialValue: 'received',
    }),
    defineField({
      name: 'trackingNumber',
      title: 'Tracking Number',
      type: 'string',
      description: 'Add when dispatched',
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
        {
          name: 'proofStatus',
          title: 'Proof Status',
          type: 'string',
          options: {
            list: [
              { title: 'Awaiting Proof', value: 'awaiting-proof' },
              { title: 'Proof Sent', value: 'proof-sent' },
              { title: 'Approved', value: 'approved' },
              { title: 'Revisions Requested', value: 'revisions' },
            ],
          },
          initialValue: 'awaiting-proof',
        },
      ],
      options: { collapsible: true, collapsed: false },
    }),
    defineField({
      name: 'createdAt',
      title: 'Order Date',
      type: 'datetime',
      readOnly: true,
    }),
  ],
  preview: {
    select: {
      customer: 'customerName',
      status: 'status',
      total: 'totalAmount',
      date: 'createdAt',
    },
    prepare({ customer, status, total, date }) {
      const statusLabels: Record<string, string> = {
        received: '📥 Received',
        'in-production': '🎨 In Production',
        dispatched: '📦 Dispatched',
        delivered: '✅ Delivered',
      };
      return {
        title: customer || 'Unknown Customer',
        subtitle: `${statusLabels[status] || status} — £${(total || 0).toFixed(2)} — ${date ? new Date(date).toLocaleDateString('en-GB') : ''}`,
      };
    },
  },
  orderings: [
    { title: 'Newest First', name: 'dateDesc', by: [{ field: 'createdAt', direction: 'desc' }] },
    { title: 'Status', name: 'statusAsc', by: [{ field: 'status', direction: 'asc' }] },
  ],
});
