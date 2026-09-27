/**
 * What it costs to personalise, said once.
 *
 * The figure lived in the markup in seven places -- two rows in PricingGrid,
 * three style cards on /services, and three sentences on /store/personalised --
 * all reading £10 because all three products happen to charge £10. None of them
 * was wrong, and that is the problem: the only thing keeping them right was
 * that nobody had changed a fee. The moment one did, six pages would quote a
 * price checkout does not charge, and nothing would say so.
 *
 * checkout.mjs has always read personalisationFee off the product document.
 * This makes the pages read the same field, at build time, so the quote and the
 * charge cannot drift apart.
 *
 * ── Why one row when they agree ────────────────────────────────────────────
 *
 * Three rows saying "+£10.00" three times is a table asking the reader to
 * compare three numbers that are the same. When they genuinely differ the
 * per-category breakdown is the only honest thing to show; when they do not, a
 * single line says it faster. Which one appears is decided by the data rather
 * than by a person remembering to update the copy.
 */

/** The three products a personalisation fee can be charged on, in shop order. */
export const FEE_PRODUCTS = [
  { slug: 'personalised-book-covers', label: 'Comic Book Covers', short: 'Cover' },
  { slug: 'personalised-icons', label: 'Comic Book Icons', short: 'Icon' },
  { slug: 'personalised-strips', label: 'Comic Book Strips', short: 'Strip' },
] as const;

export type FeeCategory = { slug: string; label: string; short: string; fee: number };
export type FeeSummary =
  | { same: true; fee: number; categories: FeeCategory[] }
  | { same: false; fee: null; categories: FeeCategory[] };

/** £10.00 — for a price column, where the pence line up. */
export const exactly = (pounds: number) => `£${pounds.toFixed(2)}`;
/** £10, or £10.50 — for prose, where trailing zeroes read like a form. */
export const plainly = (pounds: number) =>
  (Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`);

/**
 * Turn the rows from Sanity into the one question the pages ask: is there a
 * single fee, or does it depend which design you pick?
 *
 * Pure, and separate from the fetch, because "what should the page say" is
 * worth testing without a network. Throws on a missing or nonsensical fee: a
 * fallback number here is exactly the bug this exists to prevent, and a build
 * that stops is cheaper than a page quoting a price nobody will honour.
 */
export function summariseFees(rows: Array<{ slug: string; personalisationFee?: number | null }>): FeeSummary {
  const bySlug = new Map((rows || []).map((r) => [r?.slug, r?.personalisationFee]));

  const categories: FeeCategory[] = FEE_PRODUCTS.map((p) => {
    const fee = bySlug.get(p.slug);
    if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0) {
      throw new Error(
        `No usable personalisationFee in Sanity for "${p.slug}" (got ${JSON.stringify(fee)}). ` +
        'Set it on the product document — the pricing table, the style cards and the ' +
        'personalised page all quote that field, and checkout charges it.'
      );
    }
    return { slug: p.slug, label: p.label, short: p.short, fee };
  });

  const first = categories[0].fee;
  const same = categories.every((c) => c.fee === first);
  return same ? { same: true, fee: first, categories } : { same: false, fee: null, categories };
}

/**
 * Read the three fees at build time and summarise them.
 *
 * The Sanity client is pulled in only when one is actually needed, so that
 * everything above stays importable by a plain `node` test with no project
 * config and no network -- which is what makes the cases worth testing (a fee
 * that differs, a fee that is missing) cheap enough to write.
 */
export async function personalisationFees(
  fetcher?: (q: string, params: Record<string, unknown>) => Promise<any>
): Promise<FeeSummary> {
  let read = fetcher;
  if (!read) {
    const [{ sanityClient }, { personalisationFeesQuery }] =
      await Promise.all([import('./sanity'), import('./queries')]);
    read = (q, params) => sanityClient.fetch(q, params);
    return summariseFees(await read(personalisationFeesQuery, { slugs: FEE_PRODUCTS.map((p) => p.slug) }));
  }
  const { personalisationFeesQuery } = await import('./queries');
  return summariseFees(await read(personalisationFeesQuery, { slugs: FEE_PRODUCTS.map((p) => p.slug) }));
}

/* ── the words ──────────────────────────────────────────────────────────────
   Built here rather than at each call site so that changing how a split fee
   reads is one edit, and so the six places saying it cannot drift into saying
   it six ways. */

/** "Covers £10, Icons £10, Strips £12" — only ever needed when they differ. */
const listed = (s: FeeSummary, money: (n: number) => string) =>
  s.categories.map((c) => `${c.label} ${money(c.fee)}`).join(', ');

/** A price row's worth: "+£10.00 on all personalised designs". */
export const feeLine = (s: FeeSummary) =>
  (s.same ? `+${exactly(s.fee)} on all personalised designs` : listed(s, (n) => `+${exactly(n)}`));

/** A sentence for prose, ending without a full stop so callers can punctuate. */
export const feeSentence = (s: FeeSummary) =>
  (s.same
    ? `+${plainly(s.fee)} personalisation fee on all designs`
    : `Personalisation fee: ${listed(s, plainly)}`);

/** "Add £10 to personalise a Cover, Icon or Strip" / per-design when they differ. */
export const feeAddPhrase = (s: FeeSummary) => {
  if (s.same) {
    const names = s.categories.map((c) => c.short);
    return `Add ${plainly(s.fee)} to personalise a ${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  }
  return `Add ${s.categories.map((c) => `${plainly(c.fee)} for a ${c.short}`).join(', ')}`;
};

/** "Each carries a £10 personalisation fee" / per-design when they differ. */
export const feeEachPhrase = (s: FeeSummary) =>
  (s.same
    ? `Each carries a ${plainly(s.fee)} personalisation fee`
    : `${listed(s, plainly)} is the personalisation fee on each`);
