import { defineType, defineField } from 'sanity';
import PrintFileLinks from '../components/PrintFileLinks';
import ShipmentPanel from '../components/ShipmentPanel';
import { SHIPPING_UI } from '../lib/shipping-flag.mjs';
import { ALL_BANDS, BAND_TITLES } from '../../netlify/functions/_shared/parcel-bands.mjs';

const BAND_OPTIONS = ALL_BANDS.map((b: string) => ({ title: (BAND_TITLES as Record<string, string>)[b] || b, value: b }));

const SHIPMENT_STATUSES = [
  { title: 'Not shipped', value: 'none' },
  { title: 'Ready to ship (buys the labels)', value: 'ready_to_ship' },
  { title: 'Label created', value: 'label_created' },
  { title: 'In transit', value: 'in_transit' },
  { title: 'Delivered', value: 'delivered' },
  { title: 'Exception', value: 'exception' },
  { title: 'Returned to sender', value: 'returned_to_sender' },
];

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
    /* The print files, above the lines they belong to: this is what somebody
       opening an order to fulfil it has come for. Read-only and stores nothing
       -- the panel is drawn from lineItems below. */
    defineField({
      name: 'printFiles',
      title: 'Print Files',
      type: 'string',
      readOnly: true,
      components: { field: PrintFileLinks },
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
              name: 'artworkStyle',
              type: 'string',
              title: 'Artwork Style',
              description:
                'Which of the product’s artwork styles was bought. Anything ordered before ' +
                'the second style existed, and every product that only has one, is Classic.',
            },
            {
              name: 'buildKind',
              type: 'string',
              title: 'Built',
              description:
                'Set when this line is artwork a customer built rather than a stock design: ' +
                '"personalised" (their photographs) or "customise" (their wording on ours). ' +
                'Those are fulfilled from the proof they approved, under Personalisations — ' +
                'which is why Print File below is empty on them.',
            },
            {
              name: 'printFile',
              type: 'url',
              title: 'Print File',
              description:
                'THE FILE TO PRINT for this line, resolved for its style when the order was ' +
                'paid. A snapshot on purpose: the product’s artwork can be replaced later, ' +
                'and what was bought is what gets printed.',
            },
            {
              name: 'artworkStyleLabel',
              type: 'string',
              title: 'Style (as shown)',
              description:
                'Set only where the product offers a choice of artwork styles — which today ' +
                'means covers. An icon or a strip has one style and is not a cover, so naming ' +
                '“Classic cover” on those lines was simply wrong, and an absent value here ' +
                'means “this product had nothing to choose”.',
            },
            {
              name: 'listingImageRef',
              title: 'Image As Bought',
              type: 'image',
              description:
                'The listing image this customer was looking at when they ordered, pinned to ' +
                'the asset itself. Replacing a product’s artwork later uploads a NEW asset, so ' +
                'this keeps pointing at the picture that was actually bought — which is what we ' +
                'owe them, whatever the product page shows now.',
            },
            {
              name: 'productRef',
              title: 'Product Reference',
              type: 'reference',
              to: [{ type: 'product' }],
            },
            /* The machine half of the line, written by the webhook since the
               September 2026 stamping. The labels above are for a human and
               have changed once already; anything that has to MAKE something
               from this line -- the print-file renderer -- reads these. */
            { name: 'productSlug', type: 'string', title: 'Product Slug', readOnly: true },
            { name: 'sizeKey', type: 'string', title: 'Size Key', readOnly: true },
            { name: 'formatKey', type: 'string', title: 'Format Key', readOnly: true },
            { name: 'orientation', type: 'string', title: 'Orientation', readOnly: true },
            /* The build a personalised or customised line was for, stamped by the
               webhook since October 2026. Its print is downloaded from Print Files. */
            { name: 'personalisationId', type: 'string', title: 'Build', readOnly: true },
          ],
          preview: {
            select: {
              title: 'productTitle',
              format: 'format',
              size: 'size',
              qty: 'quantity',
              price: 'unitPrice',
              style: 'artworkStyle',
              styleLabel: 'artworkStyleLabel',
              printFile: 'printFile',
              buildKind: 'buildKind',
              sizeKey: 'sizeKey',
              media: 'listingImageRef',
            },
            prepare({ title, format, size, qty, price, style, styleLabel, printFile, buildKind, sizeKey, media }) {
              /* The style goes in the SUBTITLE, where a picker sees it without
                 opening the line. A two-style product is two orders that look
                 identical until you read which file to print -- and a one-style
                 product should say nothing at all, rather than call an icon a
                 cover. Older lines have no label stored, so full bleed still
                 names itself from the style and classic stays quiet. */
              const styleName = styleLabel
                || (style === 'fullBleed' ? 'Full bleed' : null);
              /* A built line is fulfilled from its own approved render, so an
                 empty Print File is correct there and must not be shouted
                 about. On a stock line it means there is nothing to print.

                 And only on a line the current webhook wrote. Everything before
                 September 2026 stored a title and two labels and nothing a
                 machine can act on -- those lines are not missing a file, they
                 predate one being attached, and flagging them lit up all
                 fourteen orders in the dataset at once. sizeKey is the mark of
                 a stamped line; the panel above resolves the product for the
                 rest and shows its current master. */
              const printMissing = !printFile && !buildKind && Boolean(sizeKey);
              return {
                title: printMissing ? `⚠ PRINT FILE MISSING — ${title}` : `${title}`,
                subtitle: `${styleName ? styleName + ' · ' : ''}${format} / ${size} × ${qty} — £${((price || 0) * (qty || 1)).toFixed(2)}`,
                media,
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
      name: 'repeatWelcomeCode',
      title: '⚠ Repeat welcome code',
      type: 'text',
      rows: 3,
      readOnly: true,
      description: 'A first-order welcome code (POW10) used by an email that already has a paid order. The order stands; it is flagged so you can decide whether to follow up.',
      hidden: ({ value }) => !value,
    }),
    defineField({
      name: 'marketingConsent',
      title: 'Marketing consent',
      type: 'string',
      readOnly: true,
      description: "refused: ticked \"Don't send me offers or referral emails\" in the basket, so no friend code, no MailerLite sequence and no day-21 referral email. not_asked: did not tick it (UK soft opt-in). opt_in / opt_out: Stripe's old checkbox, on orders before 13 Oct 2026; opt_out is treated like refused.",
    }),
    defineField({
      name: 'referralCode',
      title: 'Their friend code (PAL-)',
      type: 'string',
      readOnly: true,
      description: "This buyer's own give-10%/get-10% code, created when the order shipped.",
      hidden: ({ value }) => !value,
    }),
    defineField({
      name: 'referredBy',
      title: 'Referred by',
      type: 'object',
      readOnly: true,
      hidden: ({ value }) => !value,
      fields: [
        { name: 'code', title: 'Friend code used', type: 'string' },
        { name: 'referrerEmail', title: 'Referrer email', type: 'string' },
        { name: 'referrerOrder', title: 'Referrer order', type: 'string' },
        { name: 'rewardCode', title: 'Thank-you code sent (THANKS-)', type: 'string' },
      ],
    }),
    defineField({
      name: 'referralError',
      title: '⚠ Referral thank-you failed',
      type: 'text',
      rows: 2,
      readOnly: true,
      hidden: ({ value }) => !value,
    }),
    defineField({
      name: 'discountAmount',
      title: 'Discount (£)',
      type: 'number',
      readOnly: true,
      description: 'Promotion code discount on the goods, from Stripe. Shipping is never discounted.',
      hidden: ({ value }) => !value,
    }),
    defineField({
      name: 'discountCode',
      title: 'Discount Code',
      type: 'string',
      readOnly: true,
      hidden: ({ value }) => !value,
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
          { title: 'Evri', value: 'evri' },
          { title: 'InPost', value: 'inpost' },
          { title: 'DPD', value: 'dpd' },
          { title: 'Other', value: 'other' },
        ],
        layout: 'radio',
      },
      description: 'Auto-detected from line items at dispatch time (Canvas → UPS, Poster only → Royal Mail). Leave blank for auto-detect, or set manually + tick "Override carrier" below to force a specific carrier. Set from the shipping service for a Sendcloud shipment.',
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
    /* ── Sendcloud dispatch (SHIPPING_ENABLED) ────────────────────────────
       Hidden unless the Studio was built with SANITY_STUDIO_SHIPPING_ENABLED.
       Alan owns shipment.status and parcelPlan (they are in guarded-publish's
       OPERATOR_FIELDS); everything else under shipment is the server's. */
    defineField({
      name: 'shipmentLabels',
      title: 'Shipment — labels',
      type: 'string',
      readOnly: true,
      hidden: !SHIPPING_UI,
      components: { field: ShipmentPanel },
    }),
    defineField({
      name: 'shipment',
      title: 'Shipment',
      type: 'object',
      hidden: !SHIPPING_UI,
      options: { collapsible: true, collapsed: false },
      fields: [
        {
          name: 'status',
          title: 'Shipment status',
          type: 'string',
          options: { list: SHIPMENT_STATUSES, layout: 'dropdown' },
          description:
            'Set "Ready to ship" and publish to buy one label per parcel in the plan below. '
            + 'The team is emailed the print links; the customer is emailed when the carrier first scans it. '
            + 'After an Exception, fix the cause and set "Ready to ship" again: labels already bought are not bought twice.',
        },
        { name: 'planProblem', title: 'Plan problem', type: 'text', rows: 2, readOnly: true, hidden: ({ value }: any) => !value },
        { name: 'error', title: 'Last error', type: 'text', rows: 3, readOnly: true, hidden: ({ value }: any) => !value },
        { name: 'labelCreatedAt', title: 'Labels created', type: 'datetime', readOnly: true },
        { name: 'dispatchedAt', title: 'First carrier scan', type: 'datetime', readOnly: true },
        { name: 'deliveredAt', title: 'Delivered', type: 'datetime', readOnly: true },
        {
          name: 'parcels',
          title: 'Parcels',
          type: 'array',
          readOnly: true,
          of: [{
            type: 'object',
            name: 'shipmentParcel',
            fields: [
              { name: 'parcelRef', type: 'string', title: 'Parcel' },
              { name: 'band', type: 'string', title: 'Band' },
              { name: 'parcelId', type: 'string', title: 'Sendcloud parcel id' },
              { name: 'shipmentId', type: 'string', title: 'Sendcloud shipment id' },
              { name: 'carrier', type: 'string', title: 'Carrier' },
              { name: 'option', type: 'string', title: 'Shipping option' },
              { name: 'quotedPrice', type: 'number', title: 'Quoted price (£)' },
              { name: 'trackingNumber', type: 'string', title: 'Tracking number' },
              { name: 'trackingUrl', type: 'url', title: 'Tracking link' },
              { name: 'labelId', type: 'string', title: 'Label id' },
              { name: 'status', type: 'string', title: 'Status' },
              { name: 'statusText', type: 'string', title: 'Carrier status' },
              { name: 'test', type: 'boolean', title: 'Test label' },
            ],
            preview: {
              select: { ref: 'parcelRef', band: 'band', carrier: 'carrier', status: 'status', tracking: 'trackingNumber' },
              prepare: ({ ref, band, carrier, status, tracking }: any) => ({
                title: `Parcel ${ref} · ${band || '?'}`,
                subtitle: [carrier, status, tracking].filter(Boolean).join(' · '),
              }),
            },
          }],
        },
        {
          name: 'events',
          title: 'Tracking events (newest 30)',
          type: 'array',
          readOnly: true,
          of: [{
            type: 'object',
            name: 'shipmentEvent',
            fields: [
              { name: 'at', type: 'datetime', title: 'At' },
              { name: 'parcelRef', type: 'string', title: 'Parcel' },
              { name: 'status', type: 'string', title: 'Status' },
              { name: 'statusCode', type: 'number', title: 'Code' },
              { name: 'carrierStatus', type: 'string', title: 'Carrier says' },
              { name: 'kind', type: 'string', title: 'Meaning' },
              { name: 'test', type: 'boolean', title: 'Test' },
            ],
            preview: {
              select: { at: 'at', parcel: 'parcelRef', status: 'status', kind: 'kind' },
              prepare: ({ at, parcel, status, kind }: any) => ({
                title: `${status || kind || 'Event'}${parcel ? ` — parcel ${parcel}` : ''}`,
                subtitle: at ? new Date(at).toLocaleString('en-GB') : '',
              }),
            },
          }],
        },
        { name: 'dispatchClaimedAt', title: 'Dispatch claimed', type: 'datetime', readOnly: true, hidden: true },
      ],
    }),
    defineField({
      name: 'parcelPlan',
      title: 'Parcel plan',
      type: 'array',
      hidden: !SHIPPING_UI,
      description:
        'One parcel per item to start with. To send two posters in one tube, delete one parcel, add its line '
        + 'to the other parcel (or raise that line\'s quantity to 2), and pick the band for the combined parcel. '
        + 'Edit before setting "Ready to ship".',
      of: [{
        type: 'object',
        name: 'plannedParcel',
        fields: [
          { name: 'parcelRef', type: 'string', title: 'Parcel ref', description: '1, 2, 3… unique on this order. Never reuse a ref that already has a label for a different box.' },
          { name: 'band', type: 'string', title: 'Band', options: { list: BAND_OPTIONS } },
          {
            name: 'items',
            title: 'Contents',
            type: 'array',
            of: [{
              type: 'object',
              name: 'plannedItem',
              fields: [
                { name: 'title', type: 'string', title: 'Item', readOnly: true, description: 'For reading only; the line is matched by its key.' },
                { name: 'lineKey', type: 'string', title: 'Line key', description: 'Which order line. To move an item into another parcel, copy it from its parcel and paste it there.' },
                { name: 'quantity', type: 'number', title: 'Quantity', initialValue: 1 },
              ],
              preview: {
                select: { title: 'title', line: 'lineKey', qty: 'quantity' },
                prepare: ({ title, line, qty }: any) => ({ title: `${title || line || '?'} × ${qty || 1}` }),
              },
            }],
          },
        ],
        preview: {
          select: { ref: 'parcelRef', band: 'band', items: 'items' },
          prepare: ({ ref, band, items }: any) => ({
            title: `Parcel ${ref || '?'} · ${band || 'NO BAND'}`,
            subtitle: `${(items || []).length} line(s)`,
          }),
        },
      }],
    }),
    defineField({
      name: 'shippingEmailClaimedAt',
      title: 'Shipping email claimed',
      type: 'datetime',
      readOnly: true,
      hidden: true,
      description: 'Set while the dispatch email is being sent, so it can never go twice.',
    }),
    defineField({
      name: 'isPersonalised',
      title: 'Personalised Order',
      type: 'boolean',
      initialValue: false,
      readOnly: true,
    }),
    defineField({
      name: 'personalisationDetails',
      title: 'Personalisation Details',
      type: 'object',
      readOnly: true,
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
        /* From the old proofing workflow, removed in C2. Twelve orders from
           before then still carry it; declared so the Studio knows the field,
           read-only so nothing restarts a workflow that no longer exists. */
        {
          name: 'proofStatus',
          type: 'string',
          title: 'Proof Status (old workflow)',
          readOnly: true,
          hidden: ({ value }: any) => !value,
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
    // Pre-migration _id, set by tools/migrate-private-ids.mjs.
    defineField({ name: 'legacyId', title: 'Legacy ID', type: 'string', readOnly: true, hidden: true }),
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
