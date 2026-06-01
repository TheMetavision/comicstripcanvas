import { defineType, defineField } from 'sanity';

// ─────────────────────────────────────────────────────────────────────────────
// contactSubmission
// Records every contact-form submission. The Netlify Function writes new
// entries with status='new'; the team triages them inside the Studio.
// ─────────────────────────────────────────────────────────────────────────────

export default defineType({
  name: 'contactSubmission',
  title: 'Contact Submission',
  type: 'document',
  groups: [
    { name: 'submission', title: 'Submission', default: true },
    { name: 'meta', title: 'Metadata' },
  ],
  fields: [
    defineField({
      name: 'refCode',
      title: 'Reference Code',
      type: 'string',
      group: 'submission',
      readOnly: true,
      description: 'Human-readable identifier (e.g. MSG-LQPGW3RH) generated at submission time.',
    }),
    defineField({
      name: 'status',
      title: 'Status',
      type: 'string',
      group: 'submission',
      options: {
        list: [
          { title: 'New', value: 'new' },
          { title: 'Read', value: 'read' },
          { title: 'Replied', value: 'replied' },
          { title: 'Archived', value: 'archived' },
          { title: 'Spam', value: 'spam' },
        ],
        layout: 'radio',
      },
      initialValue: 'new',
    }),

    // ── Submitter ────────────────────────────────────────────────────
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      group: 'submission',
      readOnly: true,
    }),
    defineField({
      name: 'email',
      title: 'Email',
      type: 'string',
      group: 'submission',
      readOnly: true,
    }),
    defineField({
      name: 'phone',
      title: 'Phone',
      type: 'string',
      group: 'submission',
      readOnly: true,
      description: 'Optional. Sometimes helpful for commission discussions where a call is easier than email.',
    }),
    defineField({
      name: 'subject',
      title: 'Subject',
      type: 'string',
      group: 'submission',
      readOnly: true,
    }),
    defineField({
      name: 'message',
      title: 'Message',
      type: 'text',
      group: 'submission',
      readOnly: true,
      rows: 8,
    }),

    // ── Metadata captured by the endpoint ────────────────────────────
    defineField({
      name: 'submittedAt',
      title: 'Submitted At',
      type: 'datetime',
      group: 'meta',
      readOnly: true,
    }),
    defineField({
      name: 'pageUri',
      title: 'Page URI',
      type: 'string',
      group: 'meta',
      readOnly: true,
      description: 'The page the submission came from.',
    }),
    defineField({
      name: 'userAgent',
      title: 'User Agent',
      type: 'string',
      group: 'meta',
      readOnly: true,
      description: 'Browser UA string. Helps identify bot patterns if spam slips through.',
    }),
    defineField({
      name: 'submitterIp',
      title: 'Submitter IP (hashed)',
      type: 'string',
      group: 'meta',
      readOnly: true,
      description: "SHA-256 hash of the submitter's IP, used only for rate-limit deduplication. Not the raw IP, to keep this GDPR-clean.",
    }),
  ],

  preview: {
    select: {
      title: 'name',
      subtitle: 'subject',
      status: 'status',
      refCode: 'refCode',
    },
    prepare({ title, subtitle, status, refCode }) {
      const emoji: Record<string, string> = {
        new: '\u{1F4E5}',
        read: '\u{1F441}\uFE0F',
        replied: '\u2709\uFE0F',
        archived: '\u{1F5C4}\uFE0F',
        spam: '\u{1F6AB}',
      };
      return {
        title: `${emoji[status || 'new'] || '\u2753'} ${title || '(no name)'}`,
        subtitle: `${refCode || ''}${subtitle ? ' \u00B7 ' + subtitle : ''}`,
      };
    },
  },

  orderings: [
    {
      title: 'Newest First',
      name: 'submittedDesc',
      by: [{ field: 'submittedAt', direction: 'desc' }],
    },
    {
      title: 'Status',
      name: 'statusAsc',
      by: [
        { field: 'status', direction: 'asc' },
        { field: 'submittedAt', direction: 'desc' },
      ],
    },
  ],
});
