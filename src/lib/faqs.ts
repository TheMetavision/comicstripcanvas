/**
 * FAQs for product and category pages, read from Sanity `faq` documents.
 *
 * Answers may carry two tokens, filled at build time:
 *   {title} - the product's title (product pages only)
 *   {fee}   - the personalisation fee, read from the same product fields that
 *             checkout charges (see personalisation-fee.ts), so the FAQ cannot
 *             quote a different fee from the one the customer pays.
 *
 * Fetches are memoised per page key: the shared product FAQ is read once per
 * build rather than once for each of the ~300 product pages.
 */
import { sanityClient } from './sanity';
import { faqsExactPageQuery } from './queries';
import { personalisationFees, plainly } from './personalisation-fee';

export type Faq = { _id: string; question: string; answer: string; sortOrder?: number };

const cache = new Map<string, Promise<Faq[]>>();
let feeText: Promise<string> | null = null;

function fee(): Promise<string> {
  if (!feeText) {
    feeText = personalisationFees().then((s) =>
      s.same ? plainly(s.fee) : `from ${plainly(Math.min(...s.categories.map((c) => c.fee)))}`
    );
  }
  return feeText;
}

export async function faqsFor(page: string, vars: Record<string, string> = {}): Promise<Faq[]> {
  if (!cache.has(page)) cache.set(page, sanityClient.fetch(faqsExactPageQuery, { page }));
  const [rows, feeValue] = await Promise.all([cache.get(page)!, fee()]);
  const fill = (t: string) =>
    (t || '').replace(/\{(\w+)\}/g, (m, k) => (k === 'fee' ? feeValue : vars[k] ?? m));
  return (rows || []).map((f) => ({ ...f, question: fill(f.question), answer: fill(f.answer) }));
}

export const faqPageSchema = (faqs: Faq[]) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((f) => ({
    '@type': 'Question',
    name: f.question,
    acceptedAnswer: { '@type': 'Answer', text: f.answer },
  })),
});
