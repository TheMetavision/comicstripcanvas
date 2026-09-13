/**
 * A word list for customer-written text.
 *
 * This is a speed bump, not a gate. The gate is that nothing is printed until
 * somebody at the shop has looked at the proof and approved it, and that has
 * not changed. What this catches is the obvious: the person trying it on, the
 * slur typed into a masthead to see whether the shop notices. Anything
 * cleverer than a word list gets past it, and is caught by the same human who
 * would have caught it anyway.
 *
 * It runs in two places -- the builder, so the customer is told before they
 * spend, and the save endpoint, because a browser check is a courtesy rather
 * than a control. The list lives here and is mirrored into the bundle the
 * builder ships, the same arrangement PRICES has.
 *
 * MATCHING. Whole words, case-insensitive, after a light normalisation that
 * folds the usual substitutions (4 for a, 1 for i, 0 for o, $ for s) and
 * collapses repeated letters, so "f u c k" and "fuuuck" are the same word as
 * far as this is concerned. Spaces between single letters are closed up for
 * the same reason. That does produce the occasional false positive on a real
 * word; the message says what to do about it.
 */

/* Deliberately short and deliberately obvious. A long list is not a better
   filter -- it is a longer list of words to argue about, and every entry is a
   word a customer might legitimately want on a cover about themselves. */
const BLOCKED = [
  // the ordinary profanity anyone would expect a printed gift to refuse
  'fuck', 'shit', 'cunt', 'bastard', 'wanker', 'bollocks', 'prick', 'twat',
  'arsehole', 'asshole', 'dickhead', 'motherfucker', 'bellend',
  // slurs, which are the ones that actually matter
  'nigger', 'nigga', 'faggot', 'tranny', 'retard', 'paki', 'chink', 'spastic',
  'kike', 'gypo', 'gyppo', 'wog',
  /* A sentinel with no other meaning, so the filter can be exercised end to end
     without putting any of the above in a test, a log, or a screenshot. */
  'zzblockme',
];

/** What the customer is told. One sentence, and it says what to do next. */
export const MODERATION_MESSAGE =
  'Sorry — we can’t print that wording. Please edit the text and try again, ' +
  'or contact us if you think this is a mistake.';

const LEET = { 4: 'a', 3: 'e', 1: 'i', 0: 'o', 5: 's', 7: 't', $: 's', '@': 'a', '!': 'i' };

/**
 * Fold the tricks that make a blocked word look like a different string.
 *
 * Order matters: substitutions first, then single letters separated by spaces
 * or punctuation are closed up, then runs of the same letter are collapsed.
 */
function normalise(text) {
  const folded = String(text || '')
    .toLowerCase()
    .replace(/[43105 7$@!]/g, (c) => (c === ' ' ? ' ' : LEET[c] ?? c))
    .replace(/[^a-z ]+/g, ' ');
  // "f u c k" -> "fuck", without joining ordinary short words like "a b test"
  const joined = folded.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (run) => run.replace(/ /g, ''));
  return joined.replace(/([a-z])\1{1,}/g, '$1').replace(/\s+/g, ' ').trim();
}

const NEEDLES = BLOCKED.map((w) => ({ word: w, folded: normalise(w) }));

/**
 * The blocked words in one string, if any.
 *
 * @returns {string[]} the entries from the list, not the customer's spelling --
 *          what goes in a log should be the rule that fired, not the abuse.
 */
export function blockedWordsIn(text) {
  const hay = ` ${normalise(text)} `;
  return NEEDLES.filter(({ folded }) => hay.includes(` ${folded} `)).map(({ word }) => word);
}

/**
 * Check a whole set of fields at once.
 *
 * @param {Array<{id: string, value: string}>} fields
 * @returns {{ ok: boolean, fields: string[], words: string[] }}
 */
export function moderate(fields) {
  const bad = [];
  const words = new Set();
  for (const f of fields || []) {
    const hits = blockedWordsIn(f?.value);
    if (hits.length) {
      bad.push(f.id || '(unnamed)');
      hits.forEach((w) => words.add(w));
    }
  }
  return { ok: bad.length === 0, fields: bad, words: [...words] };
}
