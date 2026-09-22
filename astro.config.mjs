// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import netlify from '@astrojs/netlify';
import sitemap from '@astrojs/sitemap';
import { createClient } from '@sanity/client';
import slugRedirects from './src/integrations/slug-redirects.mjs';

/* Its own client, not src/lib/sanity.ts: that module is TypeScript and this
   config is plain JS loaded before the TS pipeline exists. useCdn:false for the
   same reason it is false there -- a build must not bake in stale content. */
const redirectClient = createClient({
  projectId: 'lwbwahym', dataset: 'production', apiVersion: '2026-04-11', useCdn: false,
});
/* Both halves in one query: the products that were renamed, and EVERY slug in
   use. The second is what stops a generated redirect shadowing a live product
   -- see the header of slug-redirects.mjs for the one that would have. */
const PREVIOUS_SLUGS_QUERY = `{
  "renamed": *[_type == "product" && count(previousSlugs) > 0]{"slug": slug.current, previousSlugs},
  "allSlugs": *[_type == "product" && defined(slug.current)].slug.current
}`;

export default defineConfig({
  site: 'https://comicstripcanvas.co.uk',
  integrations: [
    tailwind(),
    sitemap({
      // /personalise-confirmation was removed when the old form went; it now
      // 301s to /personalise, so there is nothing left to exclude for it.
      filter: (page) =>
        page !== 'https://comicstripcanvas.co.uk/order-confirmation/' &&
        !page.startsWith('https://comicstripcanvas.co.uk/admin/')
    }),
    slugRedirects({ client: redirectClient, query: PREVIOUS_SLUGS_QUERY }),
  ],
  output: 'static',
  adapter: netlify(),
  redirects: {
    // One entry only. Astro normalises trailing slashes before it builds the
    // route table, so listing '/personalised-products/' as well is the same
    // route twice and the router warns about the collision. The single rule
    // still covers both spellings: it emits `/personalised-products` into
    // _redirects, and Netlify matches that with or without the trailing slash.
    '/personalised-products': '/personalise/',
  },
});
