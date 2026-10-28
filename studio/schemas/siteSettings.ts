import { defineType, defineField, type ValidationContext } from 'sanity';

// Seasonal campaign fields that must be filled before the campaign can go on.
function requiredWhenEnabled(value: unknown, ctx: ValidationContext) {
  const enabled = (ctx.parent as { enabled?: boolean } | undefined)?.enabled;
  // An image cleared in Studio can linger as { _type: 'image' } with no asset.
  const empty = !value || (typeof value === 'object' && !(value as { asset?: unknown }).asset);
  return enabled && empty ? 'Required while the campaign is on' : true;
}

export default defineType({
  name: 'siteSettings',
  title: 'Site Settings',
  type: 'document',
  fields: [
    defineField({
      name: 'siteName',
      title: 'Site Name',
      type: 'string',
      initialValue: 'Comic Strip Canvas',
    }),
    defineField({
      name: 'tagline',
      title: 'Tagline',
      type: 'string',
      initialValue: 'Bold Pop Culture Wall Art UK',
    }),
    defineField({
      name: 'contactEmail',
      title: 'Contact Email',
      type: 'string',
    }),
    defineField({
      name: 'socialLinks',
      title: 'Social Media Links',
      type: 'object',
      fields: [
        { name: 'instagram', title: 'Instagram URL', type: 'url' },
        { name: 'facebook', title: 'Facebook URL', type: 'url' },
        { name: 'tiktok', title: 'TikTok URL', type: 'url' },
        { name: 'twitter', title: 'X / Twitter URL', type: 'url' },
      ],
      options: { collapsible: true, collapsed: false },
    }),
    defineField({
      name: 'announcementBar',
      title: 'Announcement Bar',
      type: 'object',
      fields: [
        { name: 'enabled', title: 'Show Announcement Bar', type: 'boolean', initialValue: false },
        { name: 'text', title: 'Announcement Text', type: 'string' },
        {
          name: 'linkUrl',
          title: 'Link URL (optional)',
          type: 'string',
        },
      ],
      options: { collapsible: true, collapsed: true },
    }),
    defineField({
      name: 'seasonalCampaign',
      title: 'Seasonal campaign',
      description:
        'Swaps the homepage hero art and adds snow between the start and end dates. Reusable: change the art, text and dates for each season.',
      type: 'object',
      options: { collapsible: true, collapsed: true },
      fieldsets: [
        { name: 'dates', title: 'Dates' },
        { name: 'art', title: 'Hero art' },
        { name: 'copy', title: 'Hero text (empty fields fall back to the normal hero text)' },
        { name: 'effects', title: 'Effects' },
      ],
      fields: [
        { name: 'enabled', title: 'Campaign on', type: 'boolean', initialValue: false },
        { name: 'label', title: 'Label (internal only)', type: 'string', description: 'e.g. "Christmas 2026"' },
        {
          name: 'startDate',
          title: 'Start',
          type: 'datetime',
          fieldset: 'dates',
          validation: (Rule) => Rule.custom(requiredWhenEnabled),
        },
        {
          name: 'endDate',
          title: 'End',
          type: 'datetime',
          fieldset: 'dates',
          validation: (Rule) =>
            Rule.custom((value, ctx) => {
              const required = requiredWhenEnabled(value, ctx);
              if (required !== true) return required;
              const start = (ctx.parent as { startDate?: string } | undefined)?.startDate;
              if (value && start && Date.parse(value as string) <= Date.parse(start)) {
                return 'End must be after start';
              }
              return true;
            }),
        },
        {
          name: 'heroImageDesktop',
          title: 'Hero image (desktop)',
          type: 'image',
          options: { hotspot: true },
          description: '16:9, min 2400px wide, keep left third clear for text',
          fieldset: 'art',
          validation: (Rule) => Rule.custom(requiredWhenEnabled),
        },
        {
          name: 'heroImageMobile',
          title: 'Hero image (mobile)',
          type: 'image',
          options: { hotspot: true },
          description: '4:5, min 1200px wide, keep top third clear',
          fieldset: 'art',
        },
        {
          name: 'heroImageAlt',
          title: 'Hero image alt text',
          type: 'string',
          fieldset: 'art',
          validation: (Rule) => Rule.custom(requiredWhenEnabled),
        },
        { name: 'eyebrow', title: 'Eyebrow (speech bubble)', type: 'string', fieldset: 'copy' },
        { name: 'headlineLine1', title: 'Headline line 1', type: 'string', fieldset: 'copy' },
        { name: 'headlineLine2', title: 'Headline line 2 (yellow)', type: 'string', fieldset: 'copy' },
        { name: 'body', title: 'Body text', type: 'string', fieldset: 'copy' },
        { name: 'snow', title: 'Snowfall over the homepage hero', type: 'boolean', initialValue: true, fieldset: 'effects' },
        {
          name: 'snowCap',
          title: 'Snow-capped edges (hero top, announcement bar)',
          type: 'boolean',
          initialValue: true,
          fieldset: 'effects',
        },
      ],
    }),
    defineField({
      name: 'newsletterHeading',
      title: 'Newsletter Section Heading',
      type: 'string',
      initialValue: 'For all the latest news, deals and more...',
    }),
  ],
  preview: {
    prepare() {
      return { title: 'Site Settings' };
    },
  },
});
