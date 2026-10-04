import { SITE, canonicalUrl } from './url';

/* Describes the real trader: Comic Strip Canvas is a trading name of The
   Metavision Multimedia Limited, at its registered office. */
export function organizationSchema(logo: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': canonicalUrl('/') + '#organization',
    name: 'Comic Strip Canvas',
    alternateName: 'CSC',
    legalName: 'The Metavision Multimedia Limited',
    url: canonicalUrl('/'),
    logo,
    image: logo,
    description: 'Pop culture wall art: bold comic-book style canvas prints and posters, and personalised artwork from your own photos. A trading name of The Metavision Multimedia Limited, registered in England & Wales.',
    email: 'contact@comicstripcanvas.co.uk',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '167-169 Great Portland Street, 5th Floor',
      addressLocality: 'London',
      postalCode: 'W1W 5PF',
      addressCountry: 'GB',
    },
    vatID: 'GB503753017',
    identifier: {
      '@type': 'PropertyValue',
      propertyID: 'Companies House',
      value: '16282479',
    },
    contactPoint: {
      '@type': 'ContactPoint',
      email: 'contact@comicstripcanvas.co.uk',
      contactType: 'customer service',
    },
    areaServed: { '@type': 'Country', name: 'United Kingdom' },
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: 'Comic Strip Canvas Products',
      itemListElement: [
        ['Comic Book Covers', '/store/comic-book-covers/'],
        ['Comic Book Icons', '/store/comic-book-icons/'],
        ['Comic Book Strips', '/store/comic-book-strips/'],
        ['Personalised Products', '/store/personalised/'],
      ].map(([name, path]) => ({ '@type': 'OfferCatalog', name, url: canonicalUrl(path) })),
    },
    sameAs: [
      'https://www.instagram.com/comicstripcanvas',
      'https://www.facebook.com/ComicStripCanvas/',
      'https://www.tiktok.com/@comicstripcanvas',
      'https://x.com/Comicstripcanv',
    ],
  };
}
