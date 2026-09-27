/**
 * What the shop says it costs to personalise — one row, or three?
 *
 *   node tools/builder/personalisation-fee-tests.mjs
 *
 * The figure used to be typed into the markup in seven places, all reading £10
 * because all three products happen to charge £10. Nothing was wrong, and that
 * was the danger: the only thing keeping six pages honest was that nobody had
 * changed a fee. These tests are mostly about the day somebody does.
 *
 * summariseFees is pure, so the interesting cases -- fees that differ, a fee
 * that is missing, a fee of zero -- can be put to it directly instead of being
 * staged in Sanity.
 */
import {
  summariseFees, personalisationFees, FEE_PRODUCTS,
  feeLine, feeSentence, feeAddPhrase, feeEachPhrase, exactly, plainly,
} from '../../src/lib/personalisation-fee.ts';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const rows = (covers, icons, strips) => [
  { slug: 'personalised-book-covers', personalisationFee: covers },
  { slug: 'personalised-icons', personalisationFee: icons },
  { slug: 'personalised-strips', personalisationFee: strips },
];

/* ─────────────────────────────────────────────── 1. they all agree */

say('\n1. ALL THREE THE SAME — ONE ROW\n');
{
  const s = summariseFees(rows(10, 10, 10));
  ok(s.same === true, 'the summary says there is one fee', String(s.same));
  ok(s.fee === 10, 'and what it is', String(s.fee));
  ok(s.categories.length === 3, 'while still knowing all three', String(s.categories.length));

  ok(feeLine(s) === '+£10.00 on all personalised designs',
    'the price row is a single line', feeLine(s));
  ok(feeSentence(s) === '+£10 personalisation fee on all designs',
    'and the prose says it once', feeSentence(s));
  ok(!/covers/i.test(feeSentence(s)),
    'without listing categories nobody needs to compare');
  ok(feeAddPhrase(s) === 'Add £10 to personalise a Cover, Icon or Strip',
    'the FAQ reads naturally', feeAddPhrase(s));
  ok(feeEachPhrase(s) === 'Each carries a £10 personalisation fee',
    'and so does the other one', feeEachPhrase(s));
}

/* ─────────────────────────────────────── 2. one of them is changed */

say('\n2. ONE FEE CHANGED — SEPARATE ROWS\n');
{
  const s = summariseFees(rows(10, 10, 12));
  ok(s.same === false, 'the summary stops claiming a single fee', String(s.same));
  ok(s.fee === null, 'and refuses to name one');
  ok(s.categories.map((c) => c.fee).join(',') === '10,10,12',
    'each category keeps its own amount', s.categories.map((c) => `${c.short} ${c.fee}`).join(', '));

  const line = feeLine(s);
  ok(/Comic Book Covers \+£10\.00/.test(line) && /Comic Book Strips \+£12\.00/.test(line),
    'the price row lists them with the right amounts', line);
  ok(!/all personalised designs/.test(line), 'and drops the one-line claim');
  ok(/£12/.test(feeSentence(s)) && /£10/.test(feeSentence(s)),
    'the prose carries both figures', feeSentence(s));
  ok(/£12 for a Strip/.test(feeAddPhrase(s)), 'including in the FAQ', feeAddPhrase(s));

  /* The case that matters most: the one that changed must not be quoted at the
     old price anywhere. */
  for (const [name, text] of [['line', feeLine(s)], ['sentence', feeSentence(s)],
    ['add', feeAddPhrase(s)], ['each', feeEachPhrase(s)]]) {
    ok(/12/.test(text), `the new Strips fee appears in the ${name}`, text);
  }

  /* And a change on a different category moves with it. */
  const covers = summariseFees(rows(15, 10, 10));
  ok(covers.categories[0].fee === 15 && covers.same === false,
    'a change to Covers is reported against Covers',
    covers.categories.map((c) => `${c.short} ${c.fee}`).join(', '));
}

/* ──────────────────────────────────────────── 3. a fee is missing */

say('\n3. A MISSING FEE STOPS THE BUILD\n');
{
  const cases = [
    ['undefined', rows(10, 10, undefined)],
    ['null', rows(10, null, 10)],
    ['a string', rows('10', 10, 10)],
    ['NaN', rows(10, NaN, 10)],
    ['negative', rows(10, 10, -5)],
    ['the row absent entirely', [{ slug: 'personalised-book-covers', personalisationFee: 10 }]],
    ['nothing at all', []],
  ];
  for (const [what, input] of cases) {
    let threw = null;
    try { summariseFees(input); } catch (e) { threw = e; }
    ok(!!threw, `${what} throws rather than guessing`);
    if (threw) ok(/personalisationFee/.test(threw.message) && /Sanity/.test(threw.message),
      '   and the message says where to fix it', threw.message.slice(0, 96) + '…');
  }
  /* A build that stops is the point: the alternative is six pages quoting a
     price checkout will not charge, and nothing saying so. */
  let fromLoader = null;
  await personalisationFees(async () => rows(10, undefined, 10)).catch((e) => { fromLoader = e; });
  ok(!!fromLoader, 'and the loader propagates it, so the build fails');
}

/* ──────────────────────────────────────────────── 4. the details */

say('\n4. THE DETAILS\n');
{
  ok(exactly(10) === '£10.00', 'a price column keeps its pence', exactly(10));
  ok(plainly(10) === '£10', 'prose does not', plainly(10));
  ok(plainly(10.5) === '£10.50', 'unless there are any', plainly(10.5));
  ok(exactly(12.5) === '£12.50', 'and the column agrees', exactly(12.5));

  const free = summariseFees(rows(0, 0, 0));
  ok(free.same === true && free.fee === 0,
    'free personalisation is a fee, not a missing one', JSON.stringify(free.fee));
  ok(feeLine(free) === '+£0.00 on all personalised designs', 'and reads as one', feeLine(free));

  ok(FEE_PRODUCTS.map((p) => p.slug).join(',') ===
     'personalised-book-covers,personalised-icons,personalised-strips',
    'the three products are named once, in shop order');

  /* Order is the shop's, not Sanity's: the query can return rows in any order
     and the table must not reshuffle between builds. */
  const shuffled = summariseFees([
    { slug: 'personalised-strips', personalisationFee: 12 },
    { slug: 'personalised-book-covers', personalisationFee: 10 },
    { slug: 'personalised-icons', personalisationFee: 11 },
  ]);
  ok(shuffled.categories.map((c) => c.short).join(',') === 'Cover,Icon,Strip',
    'however the rows arrive', shuffled.categories.map((c) => c.short).join(','));
  ok(shuffled.categories.map((c) => c.fee).join(',') === '10,11,12',
    'with each fee still on its own product', shuffled.categories.map((c) => c.fee).join(','));
}

/* ───────────────────────────────────── 5. what actually got built */

say('\n5. IN THE BUILT SITE\n');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const DIST = path.resolve(new URL('../../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const read = (p) => fs.readFileSync(path.join(DIST, p), 'utf8');

  if (!fs.existsSync(path.join(DIST, 'services', 'index.html'))) {
    say('  no dist/ — run "npm run build" to check the rendered pages. Skipping.');
  } else {
    const services = read('services/index.html');
    const personalised = read('store/personalised/index.html');

    /* The fees in Sanity are all £10 today, so this is the one-row case. */
    ok(services.split('All personalised designs').length - 1 === 1,
      'the pricing table shows ONE personalisation row',
      `${services.split('All personalised designs').length - 1} row(s)`);
    ok(services.split('+£10.00').length - 1 === 1,
      'quoting £10.00 once, not once per category',
      `${services.split('+£10.00').length - 1} occurrence(s)`);
    ok(!/Comic Book Covers (&amp;|&) Icons/.test(services),
      'and the old hand-written two-row table is gone');

    /* Each style card still quotes its own product's fee. */
    ok(services.split('Personalisation: +£10').length - 1 === 3,
      'all three style cards quote their own fee', 'three cards');

    for (const phrase of [
      '+£10 personalisation fee on all designs',
      'Each carries a £10 personalisation fee',
      'Add £10 to personalise a Cover, Icon or Strip',
    ]) ok(personalised.includes(phrase), `the personalised page says "${phrase}"`);

    ok(!personalised.includes('+£10 for Covers, Icons and Strips'),
      'and none of the hand-written copy survives');
  }
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
