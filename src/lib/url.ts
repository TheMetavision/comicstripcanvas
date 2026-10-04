// One place that decides what a page URL looks like: absolute, on the main
// domain, with a trailing slash (what Netlify actually serves), no query string.
export const SITE = 'https://comicstripcanvas.co.uk';

export function canonicalUrl(pathOrUrl: string = '/'): string {
  let path = new URL(pathOrUrl, SITE).pathname;
  const last = path.split('/').pop() ?? '';
  if (!path.endsWith('/') && !last.includes('.')) path += '/';
  return SITE + path;
}
