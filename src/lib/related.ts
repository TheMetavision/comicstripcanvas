import { THEME_BY_SLUG, NEAR, type Theme } from '../data/themes';

export interface RelatedCandidate {
  slug: string;
  title: string;
  category?: string;
  isPersonalised?: boolean;
  [k: string]: unknown;
}

/** Stable pseudo-random order: the same page always shows the same picks, but
 *  different pages draw differently from the same theme (FNV-1a of the pair). */
function score(a: string, b: string): number {
  let h = 2166136261;
  for (const ch of `${a}|${b}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const norm = (t: string) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Pick `n` products for "You might also like":
 *  1. the same subject in another format (Leo Messi Cover <-> Icon),
 *  2. the same theme (horror, football, rock...),
 *  3. a neighbouring theme, then
 *  4. the same category, so a product with no theme still gets three.
 * Never the product itself, never a personalised product, no duplicates.
 */
export function pickRelated(current: { slug: string; title: string; category?: string },
  candidates: RelatedCandidate[], n = 3): RelatedCandidate[] {
  const pool = candidates.filter((c) => c && c.slug && c.slug !== current.slug && !c.isPersonalised);
  const byScore = (list: RelatedCandidate[]) =>
    [...list].sort((x, y) => score(current.slug, x.slug) - score(current.slug, y.slug));
  const theme = THEME_BY_SLUG[current.slug] as Theme | undefined;

  const tiers: RelatedCandidate[][] = [
    pool.filter((c) => norm(c.title) === norm(current.title)),
    theme ? byScore(pool.filter((c) => THEME_BY_SLUG[c.slug] === theme)) : [],
    theme ? byScore(pool.filter((c) => NEAR[theme].includes(THEME_BY_SLUG[c.slug] as Theme))) : [],
    byScore(pool.filter((c) => c.category === current.category)),
    byScore(pool),
  ];
  const out: RelatedCandidate[] = [];
  for (const tier of tiers) {
    for (const c of tier) {
      if (out.length >= n) return out;
      if (!out.some((o) => o.slug === c.slug)) out.push(c);
    }
  }
  return out;
}
