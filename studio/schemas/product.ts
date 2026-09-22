import { defineType, defineField } from 'sanity';
import RenderStatus from '../components/RenderStatus';

/**
 * One entry in an artwork history: what was replaced, when, and by what.
 *
 * Defined once and used twice -- the product's own history, and the full-bleed
 * slot's. Two copies of this would be two shapes the moment one of them gained
 * a field, and the thing they record is a rollback path.
 */
const artworkChange = {
  type: 'object',
  name: 'artworkChange',
  fields: [
    { name: 'at', title: 'When', type: 'datetime' },
    { name: 'sceneId', title: 'Scene / product id', type: 'string' },
    { name: 'by', title: 'By', type: 'string' },
    { name: 'template', title: 'Template', type: 'string' },
    {
      name: 'prevPrintFileAssetId',
      title: 'Previous print file asset',
      type: 'string',
      description: 'What printFile pointed at before this redraw — the way back if it was wrong.',
    },
    {
      name: 'prevListingAssetId',
      title: 'Previous product image asset',
      type: 'string',
      description:
        'What images[0] pointed at before this change took that slot. Set when a render ' +
        'or a web-versions upload replaces a product image somebody else chose — the ' +
        'hand-curated catalogue products keep their gallery, but their first image is ' +
        'taken over, and this is the way back to it.',
    },
  ],
  preview: {
    select: { at: 'at', by: 'by', template: 'template' },
    prepare({ at, by, template }: any) {
      return {
        title: at ? new Date(at).toLocaleString('en-GB') : 'unknown date',
        subtitle: [by, template].filter(Boolean).join(' · '),
      };
    },
  },
};

export default defineType({
  name: 'product',
  title: 'Product',
  type: 'document',
  fields: [
    /* Sits first so the banner is the first thing above the Publish button.
       Written by studio-save when it hands off to the renderer and cleared by
       the renderer once the artwork is attached; while it is set, a render is
       in flight and publishing would strand that artwork on the draft. */
    defineField({
      name: 'renderStartedAt',
      title: 'Render in progress',
      type: 'datetime',
      readOnly: true,
      components: { field: RenderStatus },
    }),
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      /*
       * slugify AND validation, both, and the validation is the important half.
       *
       * Generate has always lowercased. What nothing stopped was somebody
       * TYPING into this field, and nine products reached production with a
       * capital first letter that way -- `Walter-white` beside `walter-white`,
       * `Mad-max` beside `mad-max`. A slug that differs from another only by
       * case is not a different URL once a filesystem or a CDN folds it, so
       * each pair collapsed to one page and left the other product with no
       * reachable URL at all. Nothing warned, at any layer.
       *
       * These rules are the ones in netlify/functions/_shared/slug.mjs. They
       * are repeated rather than imported because this Studio is a separate
       * package with its own build, and a cross-package import here would be a
       * build-time risk taken for six lines. slug-tests.mjs reads this file and
       * fails if the two drift apart.
       */
      options: {
        source: 'title',
        maxLength: 96,
        slugify: (input: string) =>
          String(input ?? '')
            .toLowerCase()
            .trim()
            .replace(/&/g, ' and ')
            .normalize('NFKD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/['’`]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 90)
            .replace(/-+$/, ''),
      },
      validation: (Rule) =>
        Rule.required().custom((value?: { current?: string }) => {
          const slug = value?.current;
          if (!slug) return 'A slug is required';
          if (slug !== slug.toLowerCase()) {
            return 'Slugs must be lower case — a capital letter makes a second URL that collides with the lower-case one, and one of the two products becomes unreachable';
          }
          if (/^-|-$/.test(slug)) return 'Slugs must not start or end with a hyphen';
          if (/--/.test(slug)) return 'Slugs must not contain two hyphens in a row';
          if (/[^a-z0-9-]/.test(slug)) return 'Slugs may only contain a-z, 0-9 and hyphens';
          return true;
        }),
    }),
    defineField({
      name: 'previousSlugs',
      title: 'Previous slugs',
      description:
        'Every slug this product used to have. The build turns each one into a 301 to the current slug, '
        + 'so renaming a product is one edit here instead of two — this field and a hand-written line in _redirects.',
      type: 'array',
      of: [{ type: 'string' }],
      options: { layout: 'tags' },
      validation: (Rule) =>
        Rule.unique().custom((list?: string[], context?: any) => {
          const current = context?.document?.slug?.current;
          for (const s of list ?? []) {
            if (typeof s !== 'string' || !s.trim()) return 'Empty entries are not allowed';
            if (s === current) return `"${s}" is the current slug — a redirect to itself is a loop`;
            if (s !== s.toLowerCase()) return `"${s}" must be lower case`;
          }
          return true;
        }),
    }),
    defineField({
      name: 'category',
      title: 'Category',
      type: 'string',
      options: {
        list: [
          { title: 'Comic Book Covers', value: 'comic-book-covers' },
          { title: 'Comic Book Icons', value: 'comic-book-icons' },
          { title: 'Comic Book Strips', value: 'comic-book-strips' },
          { title: 'Personalised', value: 'personalised' },
        ],
        layout: 'radio',
      },
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 4,
    }),
    defineField({
      name: 'images',
      title: 'Product Images',
      type: 'array',
      of: [
        {
          type: 'image',
          options: { hotspot: true },
          fields: [
            {
              name: 'alt',
              title: 'Alt Text',
              type: 'string',
            },
          ],
        },
      ],
      validation: (Rule) => Rule.min(1).error('At least one image is required'),
    }),
    defineField({
      name: 'artworkHistory',
      title: 'Artwork History',
      type: 'array',
      readOnly: true,
      description:
        'The last five times this product’s artwork was replaced from the studio builder, ' +
        'or its product image was taken over by a render or a web-versions upload. ' +
        'Written by studio-save and the renderer; the previous print master is kept in the ' +
        'studio blob store as print-prev.png for one rollback.',
      of: [artworkChange],
    }),
    defineField({
      name: 'printFile',
      title: 'High-Res Print File',
      type: 'file',
      description: 'The production-quality file used for printing. Not shown on the frontend.',
    }),
    defineField({
      name: 'classicSceneId',
      title: 'Classic Scene Id',
      type: 'string',
      readOnly: true,
      description:
        'Which studio scene produced the Classic artwork above. The print master for it is ' +
        'kept at studio/<this id>/classic/print.png in the blob store.',
    }),
    defineField({
      name: 'fullBleed',
      title: 'Full Bleed Style',
      type: 'object',
      description:
        'A SECOND artwork style for this product, sold at the same price. Optional and ' +
        'absent on almost everything: a product without it simply has one style, and the ' +
        'product page shows no choice. images[] and printFile above are the Classic style ' +
        'and are never touched by a full-bleed save. Written by the studio builder’s ' +
        '“Replace artwork on existing product…” with Style set to Full bleed.',
      options: { collapsible: true, collapsed: true },
      fields: [
        {
          name: 'listingImage',
          title: 'Product Image',
          type: 'image',
          options: { hotspot: true },
          fields: [{ name: 'alt', title: 'Alt Text', type: 'string' }],
          description: 'Shown as the main product image when the customer picks Full bleed.',
        },
        {
          name: 'printFile',
          title: 'High-Res Print File',
          type: 'file',
          description: 'What fulfilment prints for a Full bleed order. Never the Classic file.',
        },
        {
          name: 'sceneId',
          title: 'Scene Id',
          type: 'string',
          readOnly: true,
          description: 'Print master at studio/<this id>/fullBleed/print.png.',
        },
        {
          name: 'artworkHistory',
          title: 'Artwork History',
          type: 'array',
          readOnly: true,
          of: [artworkChange],
          description: 'The last five times the full-bleed artwork was replaced.',
        },
      ],
      preview: {
        select: { media: 'listingImage', scene: 'sceneId' },
        prepare({ media, scene }: any) {
          return { title: 'Full bleed', subtitle: scene || 'no artwork yet', media };
        },
      },
    }),
    defineField({
      name: 'accentColor',
      title: 'Accent Colour',
      type: 'string',
      options: {
        list: [
          { title: 'Red (Magenta)', value: '#EC008C' },
          { title: 'Yellow', value: '#FFF200' },
          { title: 'Cyan', value: '#00AEEF' },
        ],
      },
      initialValue: '#EC008C',
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [{ type: 'string' }],
      options: { layout: 'tags' },
      description: 'e.g. film, music, sport, tv, football, boxing',
    }),
    defineField({
      name: 'featured',
      title: 'Featured Product',
      type: 'boolean',
      initialValue: false,
    }),
    defineField({
      name: 'isPersonalised',
      title: 'Personalised Product',
      type: 'boolean',
      initialValue: false,
      description: 'Enable for products that use the personalisation workflow',
    }),
    defineField({
      name: 'personalisationFee',
      title: 'Personalisation Fee (£)',
      type: 'number',
      hidden: ({ document }: any) => !document?.isPersonalised,
      validation: (Rule: any) => Rule.min(0),
      description:
        'Artwork fee added on top of the print price for a personalised build. Read at checkout by netlify/functions/checkout.mjs -- changing it here changes what customers are charged, with no deploy.',
    }),
    defineField({
      name: 'customiseFee',
      title: 'Customise Fee (pence)',
      type: 'number',
      initialValue: 500,
      validation: (Rule: any) => Rule.min(0).integer(),
      description:
        'What "Customise this design" costs on top of the print price, IN PENCE — 500 is £5. ' +
        'Read at checkout by netlify/functions/checkout.mjs, so changing it changes what ' +
        'customers are charged with no deploy. Only offered on a product whose artwork was ' +
        'drawn in the studio, because only those have a scene to reopen.',
    }),
    defineField({
      name: 'sortOrder',
      title: 'Sort Order',
      type: 'number',
      initialValue: 0,
      description: 'Lower numbers appear first. Used for manual ordering within categories.',
    }),
    defineField({
      name: 'seo',
      title: 'SEO',
      type: 'object',
      fields: [
        { name: 'metaTitle', title: 'Meta Title', type: 'string' },
        { name: 'metaDescription', title: 'Meta Description', type: 'text', rows: 3 },
        {
          name: 'ogImage',
          title: 'Open Graph Image',
          type: 'image',
        },
      ],
      options: { collapsible: true, collapsed: true },
    }),
  ],
  preview: {
    select: {
      title: 'title',
      category: 'category',
      media: 'images.0',
    },
    prepare({ title, category, media }) {
      const categoryLabels: Record<string, string> = {
        'comic-book-covers': 'Covers',
        'comic-book-icons': 'Icons',
        'comic-book-strips': 'Strips',
        'personalised': 'Personalised',
      };
      return {
        title,
        subtitle: categoryLabels[category] || category,
        media,
      };
    },
  },
  orderings: [
    { title: 'Sort Order', name: 'sortOrderAsc', by: [{ field: 'sortOrder', direction: 'asc' }] },
    { title: 'Title A-Z', name: 'titleAsc', by: [{ field: 'title', direction: 'asc' }] },
  ],
});
