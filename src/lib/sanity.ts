import { createClient } from '@sanity/client';
import imageUrlBuilder from '@sanity/image-url';
import type { SanityImageSource } from '@sanity/image-url/lib/types/types';

// useCdn: false deliberately. Almost every consumer of this client runs at
// BUILD time, and the CDN lags a publish -- so a build kicked off by the Sanity
// webhook could bake in the very content that triggered it. That was observed:
// a build straight after a copy edit still had the old text, and the next build
// was correct. Prices are read this way too, which makes a stale build worse
// than a slower one.
//
// Note there are other clients in the tree that do not come through here:
// src/pages/store/personalised.astro (build time, also uncached) and
// src/pages/feeds/google-shopping.xml.ts (per request). All three are uncached.
export const sanityClient = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  useCdn: false,
});

const builder = imageUrlBuilder(sanityClient);

export function urlFor(source: SanityImageSource) {
  return builder.image(source);
}
