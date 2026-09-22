/**
 * What a product slug is allowed to be.
 *
 * A slug is a URL, and a URL that differs from another only by case is not a
 * different URL in any way a customer or a filesystem cares about. Nine live
 * products reached production with a capital first letter -- `Walter-white`
 * beside `walter-white`, `Mad-max` beside `mad-max` -- and each pair collapsed
 * to ONE page. Whichever of the two was served, the other product was dark:
 * the Walter White cover could not be reached at all, and clicking its card in
 * the store opened the icon instead.
 *
 * Nothing warned. Astro saw two different strings and built two routes; the
 * collision only appears when something downstream folds case, which a
 * filesystem and a CDN both do.
 *
 * So the rule is not "prefer lowercase". It is that a slug which is not
 * already canonical is INVALID, and the two places that can write one -- the
 * studio save path and a person typing in the Studio -- both enforce it.
 */

/** The one transformation. ASCII, lower, hyphens, no hyphens at either end. */
export function productSlug(title, { max = 90, fallback = 'untitled-design' } = {}) {
  const s = String(title == null ? '' : title)
    .toLowerCase()
    .trim()
    /* & is a word, not punctuation: "Batman & Robin" should not become
       "batman-robin", which reads as two unrelated people. */
    .replace(/&/g, ' and ')
    /* Strip accents rather than deleting the letter under them, so "Pelé"
       becomes "pele" and not "pel". */
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    /* Apostrophes close up -- "Wayne's" is "waynes", not "wayne-s". */
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    /* the slice can leave a trailing hyphen behind */
    .replace(/-+$/, '');
  return s || fallback;
}

/**
 * Is this slug already what productSlug would have produced from itself?
 *
 * The check is deliberately idempotence rather than a regex: anything
 * productSlug would change is not canonical, which keeps the rule in one place
 * and makes it impossible for the validator and the generator to disagree.
 */
export function isCanonicalSlug(slug) {
  if (typeof slug !== 'string' || !slug) return false;
  return productSlug(slug) === slug;
}

/** Why it is not canonical, for a message somebody has to act on. */
export function slugProblem(slug) {
  if (typeof slug !== 'string' || !slug.trim()) return 'a slug is required';
  if (slug !== slug.toLowerCase()) return 'must be lower case — a capital letter makes a second URL that collides with the lower-case one';
  if (/^-|-$/.test(slug)) return 'must not start or end with a hyphen';
  if (/--/.test(slug)) return 'must not contain two hyphens in a row';
  if (/[^a-z0-9-]/.test(slug)) return 'may only contain a-z, 0-9 and hyphens';
  if (!isCanonicalSlug(slug)) return `should be "${productSlug(slug)}"`;
  return null;
}
