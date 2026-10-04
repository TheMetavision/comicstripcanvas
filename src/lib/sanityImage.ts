// Builds sized, auto-format Sanity CDN URLs. Non-Sanity URLs pass through untouched.
const WIDTHS = [320, 480, 640, 800, 1024, 1280, 1600, 1920, 2400];

function originalSize(url: string): { width: number; height: number } | null {
  const m = url.match(/-(\d+)x(\d+)\.\w+(?:\?|$)/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function originalWidth(url: string): number | null {
  return originalSize(url)?.width ?? null;
}

export function sanityImg(
  url: string | undefined | null,
  w: number,
  opts: { h?: number; q?: number; fit?: 'max' | 'crop' | 'clip' } = {}
): string {
  if (!url || !url.includes('cdn.sanity.io/images/')) return url ?? '';
  const u = new URL(url);
  u.searchParams.set('w', String(Math.round(w)));
  if (opts.h) u.searchParams.set('h', String(Math.round(opts.h)));
  u.searchParams.set('auto', 'format');
  u.searchParams.set('q', String(opts.q ?? 75));
  u.searchParams.set('fit', opts.fit ?? (opts.h ? 'crop' : 'max'));
  return u.toString();
}

/** srcset up to 2x the largest rendered width, never above the original. */
export function sanitySrcset(url: string | undefined | null, maxRenderedW: number, opts: { q?: number } = {}): string | undefined {
  if (!url || !url.includes('cdn.sanity.io/images/')) return undefined;
  const cap = Math.min(maxRenderedW * 2, originalWidth(url) ?? Infinity);
  const ws = WIDTHS.filter(w => w <= cap);
  if (!ws.length) ws.push(Math.min(maxRenderedW * 2, originalWidth(url) ?? maxRenderedW * 2));
  return ws.map(w => `${sanityImg(url, w, opts)} ${w}w`).join(', ');
}

/**
 * Intrinsic width/height attributes for an <img>, from the asset filename
 * (Sanity names assets <hash>-<w>x<h>.<ext>). Scaled down to `w` so the
 * attributes stay modest; only the ratio matters for layout.
 */
export function sanityDims(url: string | undefined | null, w: number): { width: number; height: number } | Record<string, never> {
  const o = url ? originalSize(url) : null;
  if (!o) return {};
  return { width: Math.round(w), height: Math.round((w * o.height) / o.width) };
}

// Local files in /public go through Netlify Image CDN: resized and served as
// WebP, from this domain. Pass the file's real width so srcset never upscales.
const LOCAL_WIDTHS = [320, 480, 640, 800, 1024, 1280, 1600, 1920];

export function localImg(path: string, w: number): string {
  return `/.netlify/images?url=${encodeURIComponent(path)}&w=${Math.round(w)}&fm=webp&q=75`;
}

/** srcset up to 2x the largest rendered width, never above the original. */
export function localSrcset(path: string, maxRenderedW: number, originalW: number): string {
  const cap = Math.min(maxRenderedW * 2, originalW);
  const ws = LOCAL_WIDTHS.filter(w => w <= cap);
  if (!ws.length) ws.push(cap);
  return ws.map(w => `${localImg(path, w)} ${w}w`).join(', ');
}
