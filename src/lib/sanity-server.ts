import { createClient } from '@sanity/client';

/**
 * The authenticated client, for server-rendered admin pages ONLY.
 *
 * Never import this from anything that ships to the browser. Customer documents
 * (pendingPersonalisation, order, contactSubmission) live at dotted _ids, which
 * the tokenless client in ./sanity.ts cannot read. Read-only by preference:
 * SANITY_READ_TOKEN is a Viewer token; SANITY_WRITE_TOKEN, which every function
 * already holds, is the fallback so the pages work before the read token is set.
 * Read at request time (process.env), not inlined at build.
 */
const token = process.env.SANITY_READ_TOKEN || process.env.SANITY_WRITE_TOKEN || '';

export const sanityServerClient = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  useCdn: false,
  token,
});
