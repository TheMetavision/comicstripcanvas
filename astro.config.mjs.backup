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
      filter: (page) =>
        page !== 'https://comicstripcanvas.co.uk/order-confirmation/' &&
        page !== 'https://comicstripcanvas.co.uk/personalise-confirmation/'
    }),
  ],
  output: 'static',
  adapter: netlify(),
  redirects: {
    '/personalised-products': '/personalise/',
    '/personalised-products/': '/personalise/',
  },
});
