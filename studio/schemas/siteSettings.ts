import { defineType, defineField } from 'sanity';

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
