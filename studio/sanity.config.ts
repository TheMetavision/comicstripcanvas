import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';
import { schemaTypes } from './schemas';
import { BUILD_ACTIONS } from './actions/personalisationActions';
import { OrderPublishAction } from './actions/OrderPublishAction';
import { resolveDocumentActions } from './actions/resolve-actions.mjs';
import { CreateReturnAction } from './actions/CreateReturnAction';
import { SHIPPING_UI } from './lib/shipping-flag.mjs';

// A personalisation group: one workflow stage, newest first.
const personalisations = (S: any, title: string, filter: string, params?: any) => {
  let list = S.documentTypeList('pendingPersonalisation')
    .title(title)
    .filter(filter)
    .defaultOrdering([{ field: 'createdAt', direction: 'desc' }]);
  if (params) list = list.params(params);
  return S.listItem().title(title).child(list);
};

// One shipping queue: orders by shipment status, newest first.
const shippingQueue = (S: any, title: string, filter: string, params?: any) => {
  let list = S.documentTypeList('order')
    .title(title)
    .filter(`_type == "order" && (${filter})`)
    .defaultOrdering([{ field: 'createdAt', direction: 'desc' }]);
  if (params) list = list.params(params);
  return S.listItem().title(title).child(list);
};

// One returns queue. No "create" in these lists: a return is made by the
// /returns page or an order's Create return button, at a private dotted id.
const returnsQueue = (S: any, title: string, filter: string) =>
  S.listItem().title(title).child(
    S.documentTypeList('returnRequest')
      .title(title)
      .filter(`_type == "returnRequest" && (${filter})`)
      .defaultOrdering([{ field: 'requestedAt', direction: 'desc' }])
      .initialValueTemplates([])
  );

/* Sendcloud dispatch and returns. Only in a Studio built with
   SANITY_STUDIO_SHIPPING_ENABLED=true (see lib/shipping-flag.mjs). */
const shippingItems = (S: any) => (SHIPPING_UI ? [
  S.listItem()
    .id('shipping')
    .title('Shipping')
    .icon(() => '\u{1F69A}')
    .child(
      S.list()
        .title('Shipping')
        .items([
          shippingQueue(S, 'Ready to ship', 'shipment.status == "ready_to_ship"'),
          shippingQueue(S, 'Label created', 'shipment.status == "label_created"'),
          shippingQueue(S, 'In transit', 'shipment.status == "in_transit"'),
          /* A carrier problem, a failed label, or a plan with a line the
             bands could not place (until it has shipped). */
          shippingQueue(S, 'Exceptions',
            'shipment.status in ["exception", "returned_to_sender"]'
            + ' || (defined(shipment.planProblem) && !(shipment.status in $shipped))',
            { shipped: ['label_created', 'in_transit', 'delivered'] }),
        ])
    ),
  S.listItem()
    .id('returns')
    .title('Returns')
    .icon(() => '↩️')
    .child(
      S.list()
        .title('Returns')
        .items([
          returnsQueue(S, 'Requested', 'status == "requested"'),
          returnsQueue(S, 'Approved — label pending', 'status == "approved"'),
          returnsQueue(S, 'Label sent', 'status == "label_sent"'),
          returnsQueue(S, 'In transit', 'status == "in_transit"'),
          returnsQueue(S, 'Ready to collect', 'status == "ready_to_collect"'),
          returnsQueue(S, 'Received — refund due', 'status == "received"'),
          S.divider(),
          returnsQueue(S, 'Refunded', 'status == "refunded"'),
          returnsQueue(S, 'Rejected', 'status == "rejected"'),
          returnsQueue(S, 'All returns', 'true'),
        ])
    ),
] : []);

// Custom desk structure for singleton + grouped document types
const structure = (S: any) =>
  S.list()
    .title('Comic Strip Canvas')
    .items([
      // Site Settings singleton
      S.listItem()
        .title('Site Settings')
        .icon(() => '\u2699\uFE0F')
        .child(
          S.document()
            .schemaType('siteSettings')
            .documentId('siteSettings')
            .title('Site Settings')
        ),
      S.divider(),

      // Orders (prominent for production workflow)
      S.listItem()
        .title('Orders')
        .icon(() => '\u{1F4E6}')
        .child(
          S.list()
            .title('Orders')
            .items([
              /* An order with a stock line that resolved no print file. The
                 order is otherwise completely normal -- paid, confirmed, with a
                 picture on the product page -- so nothing else distinguishes
                 it, and it cannot be fulfilled until the artwork exists. A
                 built line is excluded: those are printed from the render on
                 their Personalisations entry and carry no printFile by design.

                 defined(sizeKey) excludes everything written before September
                 2026. Those lines store a title and two labels and nothing a
                 machine can act on, so an absent print file there says nothing
                 about the product -- and without this the list held all
                 fourteen orders in the dataset, every one of them a false
                 alarm. A list that is always full is a list nobody opens. */
              S.listItem()
                .title('Needs attention')
                .child(
                  S.documentTypeList('order')
                    .title('Needs attention — no print file')
                    .filter(
                      '_type == "order" && count(lineItems['
                      + '!defined(printFile) && !defined(buildKind) && defined(sizeKey)'
                      + ']) > 0'
                    )
                    .defaultOrdering([{ field: 'createdAt', direction: 'desc' }])
                ),
              S.divider(),
              S.listItem()
                .title('All orders')
                .child(
                  S.documentTypeList('order')
                    .title('All Orders')
                    .defaultOrdering([{ field: 'createdAt', direction: 'desc' }])
                ),
            ])
        ),

      // Personalisations — artwork built in the product builder. This is the
      // order-in-progress record, so it is grouped by where each one has got to
      // rather than listed flat.
      S.listItem()
        // explicit id so the order email can deep-link to this list
        .id('personalisations')
        .title('Personalisations')
        .icon(() => '\u{1F3A8}')
        .child(
          S.list()
            .title('Personalisations')
            .items([
              personalisations(S, 'Needs attention',
                '_type == "pendingPersonalisation" && status in $s',
                { s: ['paid', 'preparing', 'rendered', 'on_hold'] }),
              personalisations(S, 'In production',
                '_type == "pendingPersonalisation" && status in $s',
                { s: ['approved', 'in_production'] }),
              personalisations(S, 'Dispatched',
                '_type == "pendingPersonalisation" && status == "dispatched"'),
              S.divider(),
              // Abandoned or unpaid builds: kept visible rather than hidden, but last.
              // Documents from the older checkout flow (personalise.mjs) carry no
              // status at all, so they are folded in here instead of being unreachable.
              personalisations(S, 'Drafts',
                '_type == "pendingPersonalisation" && (status in $s || !defined(status))',
                { s: ['draft', 'awaiting_payment'] }),
            ])
        ),

      ...shippingItems(S),

      // Contact Submissions (separate workflow from Orders — public enquiries)
      S.listItem()
        .title('Contact Submissions')
        .icon(() => '\u{1F4E8}')
        .child(
          S.documentTypeList('contactSubmission')
            .title('Contact Submissions')
            .defaultOrdering([{ field: 'submittedAt', direction: 'desc' }])
        ),
      S.divider(),

      // Products
      S.listItem()
        .title('Products')
        .icon(() => '\u{1F5BC}\uFE0F')
        .child(
          S.list()
            .title('Products')
            .items([
              S.listItem()
                .title('All Products')
                .child(S.documentTypeList('product').title('All Products')),
              S.divider(),
              S.listItem()
                .title('Comic Book Covers')
                .child(
                  S.documentTypeList('product')
                    .title('Comic Book Covers')
                    .filter('_type == "product" && category == "comic-book-covers"')
                ),
              S.listItem()
                .title('Comic Book Icons')
                .child(
                  S.documentTypeList('product')
                    .title('Comic Book Icons')
                    .filter('_type == "product" && category == "comic-book-icons"')
                ),
              S.listItem()
                .title('Comic Book Strips')
                .child(
                  S.documentTypeList('product')
                    .title('Comic Book Strips')
                    .filter('_type == "product" && category == "comic-book-strips"')
                ),
              S.listItem()
                .title('Personalised')
                .child(
                  S.documentTypeList('product')
                    .title('Personalised')
                    .filter('_type == "product" && category == "personalised"')
                ),
            ])
        ),

      // Blog
      S.listItem()
        .title('Blog Posts')
        .icon(() => '\u{1F4DD}')
        .child(
          S.documentTypeList('blogPost')
            .title('Blog Posts')
            .defaultOrdering([{ field: 'publishedAt', direction: 'desc' }])
        ),

      // Testimonials
      S.listItem()
        .title('Testimonials')
        .icon(() => '\u2B50')
        .child(S.documentTypeList('testimonial').title('Testimonials')),

      // FAQs
      S.listItem()
        .title('FAQs')
        .icon(() => '\u2754')
        .child(
          S.documentTypeList('faq')
            .title('FAQs')
            .defaultOrdering([{ field: 'sortOrder', direction: 'asc' }])
        ),
    ]);

export default defineConfig({
  name: 'comic-strip-canvas',
  title: 'Comic Strip Canvas',
  projectId: 'lwbwahym',
  dataset: 'production',
  plugins: [structureTool({ structure })],
  schema: {
    types: schemaTypes,
    /* Never "new return request" from the Studio's create menu: it would get
       a random, publicly readable id. Returns are made at returnRequest.<ref>
       by the returns page or the order's Create return button. */
    templates: (prev) => prev.filter((t) => t.schemaType !== 'returnRequest'),
  },
  document: {
    /* Orders publish through the guarded action; builds lose every action
       that could create or publish a draft and gain Approve / Hold /
       Re-render. The list per type, and why, is in actions/resolve-actions.mjs. */
    actions: (prev, context) =>
      resolveDocumentActions(prev, context, {
        OrderPublishAction,
        buildExtras: BUILD_ACTIONS,
        orderExtras: SHIPPING_UI ? [CreateReturnAction] : [],
      }),
  },
});
