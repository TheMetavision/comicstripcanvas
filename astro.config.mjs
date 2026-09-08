// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import netlify from '@astrojs/netlify';
import sitemap from '@astrojs/sitemap';

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
  ],
  output: 'static',
  adapter: netlify(),
  redirects: {
    '/personalised-products': '/personalise/',
    '/personalised-products/': '/personalise/',
  },
});
