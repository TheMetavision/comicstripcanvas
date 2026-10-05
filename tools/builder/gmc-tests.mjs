/**
 * What Google and a customer are told about price and returns, and whether the
 * two agree.
 *
 *   npm run build && node tools/builder/gmc-tests.mjs
 *
 * Three surfaces have to say the same thing about one product: the shopping
 * feed, the Product schema on the landing page, and the returns policy a person
 * can read. A disagreement between the first two gets items disapproved; a
 * disagreement with the third is worse than that, because somebody acts on it.
 *
 * The feed itself is server-rendered and needs a live Sanity read, so it is
 * checked against its own source here and against a running server by hand --
 * see the note in the commit. What IS checked end to end is the built HTML: the
 * schema on every product page, and the wording on the two policy pages.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DIST = path.join(REPO, 'dist');
const SRC = path.join(REPO, 'src');

let pass = 0, fail = 0;
const say = console.log.bind(console);
const ok = (c, l, e = '') => {
  if (c) { pass++; say(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; say(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};

if (!fs.existsSync(path.join(DIST, 'refund-policy/index.html'))) {
  say('\nNo dist/ — run "npm run build" first.\n');
  process.exit(1);
}

const read = (rel) => fs.readFileSync(path.join(DIST, rel), 'utf8');
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&mdash;/g, '—').replace(/&rsquo;/g, '’')
  .replace(/&ldquo;|&rdquo;/g, '"').replace(/&nbsp;/g, ' ')
  /* &amp; LAST, so an &amp;amp; in the source does not decode to a bare & here
     and hide exactly the double-escaping this file is checking for elsewhere. */
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const productSchema = (html) => {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const d = JSON.parse(m[1]);
      if (d['@type'] === 'Product') return d;
    } catch { /* another block */ }
  }
  return null;
};

/* ═════════ 1. the refund policy */

say('\n1. THE REFUND POLICY SAYS WHAT IT MUST\n');
{
  const t = text(read('refund-policy/index.html'));
  ok(/Last updated: September 2026/.test(t), 'it is dated September 2026');

  /* The statutory right, for the products it applies to. */
  ok(/14 days from the day you receive it/i.test(t), '14 days from delivery to change your mind');
  ok(/further 14 days from telling us/i.test(t), 'and a further 14 days to send it back');
  ok(/unused and returned in its original packaging/i.test(t), 'unused, original packaging');
  ok(/You pay the cost of return postage/i.test(t), 'the customer pays return postage');
  ok(/unless the item is faulty or we sent you the wrong thing/i.test(t),
    '  unless it is faulty or wrong');
  ok(/price of the item plus the original standard delivery charge/i.test(t),
    'the refund includes the original delivery charge');
  ok(/within 14 days of receiving the item back/i.test(t), 'refunded within 14 days of the return');
  ok(/proof of posting/i.test(t), '  or of proof of posting');
  ok(/reduce the refund if the item has been handled more than was necessary/i.test(t),
    'and may be reduced for handling beyond inspection');

  /* The exemption, and its reason. */
  ok(/does not apply to personalised items/i.test(t), 'personalised items are exempt');
  ok(/Customise this design/i.test(t), '  and so are customised designs, by name');
  ok(/made to your specification/i.test(t), '  because they are made to specification');
  ok(/does not affect your rights if the item arrives faulty/i.test(t),
    '  which does not touch their rights on a faulty item');

  /* Faults, unchanged. */
  ok(/within 48 hours of delivery with photographs/i.test(t), 'the 48-hour photo report is kept');
  ok(/We cover the cost of the return/i.test(t), 'we pay to return a faulty item');
  ok(/replacement or a full refund/i.test(t), 'and they choose replacement or refund');

  /* The proof wording, kept verbatim as asked. */
  ok(/You approve your layout in the builder before ordering/i.test(t),
    'the proof-approval wording is kept');

  /* APPROVAL ENDS THE CHANGE-OF-MIND ROUTE, NOT EVERY ROUTE.
     It used to say approval meant the order "cannot be cancelled or refunded",
     full stop -- which reads as: approve this and a faulty print is your
     problem. It is not, and saying so was the one sentence on the page that
     could talk somebody out of a right they have. */
  ok(/printing begins\. The order cannot be cancelled for a change of mind once approved/i.test(t),
    'approval ends the change-of-mind route');
  ok(/your rights for faulty items are unaffected/i.test(t),
    '  and says plainly that faults are not covered by that');
  ok(!/cannot be cancelled or refunded/i.test(t),
    '  with the unqualified version gone');

  /* And what must no longer be there: the blanket refusal. */
  ok(!/unable to accept returns or offer refunds for change of mind/i.test(t),
    'the blanket "no returns on anything" is gone');
}

/* ═════════ 2. the terms do not contradict it */

say('\n2. THE TERMS AGREE WITH IT\n');
{
  const html = read('terms-and-conditions/index.html');
  const t = text(html);
  ok(/Returns\s*&\s*Cancellation/i.test(t), 'the terms have a returns section');
  ok(/statutory 14-day right to cancel/i.test(t), 'stating the 14-day right');
  ok(/exempt from that right/i.test(t), 'and the personalised exemption');
  ok(/href="\/refund-policy\/"/.test(html), 'and it links to the refund policy');
  ok(/forms part of these terms/i.test(t), 'which it says forms part of the terms');

  /* The line that used to read as the reason there were no returns. */
  ok(!/All products are made to order\./.test(t),
    '"All products are made to order." no longer stands next to a returns policy');
  ok(/printed to order rather than held in stock/i.test(t), '  it explains the dispatch time instead');

  /* The personalised paragraph must not claim an unqualified finality. */
  ok(/cannot be cancelled for a change of mind/i.test(t),
    'approval makes an order final for a CHANGE OF MIND specifically');
  ok(!/the order is final and cannot be cancelled\./.test(t),
    '  not unqualified, which would have contradicted the fault route');
}

/* ═════════ 3. the Product schema on a standard product */

say('\n3. THE SCHEMA ON A STANDARD PRODUCT\n');
const PRICES = {
  poster: { small: 9.99, medium: 12.99, large: 16.99 },
  'canvas-standard': { small: 26.99, medium: 31.99, large: 44.99 },
  'canvas-gallery': { small: 28.99, medium: 33.99, large: 46.99 },
};
/* A stock product -- any one; they all share the price table. Sections 3 and 5
   both need one, because only stock products link per variant. */
const STOCK_SLUG = fs.readdirSync(path.join(DIST, 'store'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('personalised'))
  .map((d) => d.name)[0];
{
  const slug = STOCK_SLUG;
  const d = productSchema(read(`store/${slug}/index.html`));
  ok(!!d, `${slug}: there is a Product schema`);
  ok(d.offers.length === 9, '  nine offers, one per variant', String(d.offers.length));
  ok(d.sku === slug, '  with a sku', d.sku);

  const byUrl = Object.fromEntries(d.offers.map((o) => [o.url.split('?')[1], o]));
  let priced = 0, urls = 0, gbp = 0, avail = 0;
  for (const [format, sizes] of Object.entries(PRICES)) {
    for (const [size, price] of Object.entries(sizes)) {
      const o = byUrl[`format=${format}&size=${size}`];
      if (!o) continue;
      urls++;
      if (Number(o.price) === price) priced++;
      if (o.priceCurrency === 'GBP') gbp++;
      if (o.availability === 'https://schema.org/InStock') avail++;
    }
  }
  ok(urls === 9, '  every variant has its own ?format=&size= url', String(urls));
  ok(priced === 9, '  at the price the site charges', `${priced}/9`);
  ok(gbp === 9, '  in GBP', `${gbp}/9`);
  ok(avail === 9, '  and marked in stock', `${avail}/9`);

  const rp = d.offers[0].hasMerchantReturnPolicy;
  ok(rp && rp.returnPolicyCategory.endsWith('MerchantReturnFiniteReturnWindow'),
    '  a standard product takes returns', rp && rp.returnPolicyCategory.split('/').pop());
  ok(rp && rp.merchantReturnDays === 14, '  for 14 days', String(rp && rp.merchantReturnDays));
  ok(rp && rp.returnFees.endsWith('ReturnShippingFees'),
    '  with the customer paying the postage');
  ok(d.offers[0].shippingDetails?.shippingRate?.value === '4.95', '  and the shipping rate is stated');

  ok(!('lowPrice' in (d.offers || {})) && !Array.isArray(d.offers) === false,
    '  offers is a list, not an AggregateOffer');
}

/* ═════════ 4. and on a personalised one, where the fee is not optional */

say('\n4. THE SCHEMA ON A PERSONALISED PRODUCT\n');
{
  const html = read('store/personalised-strips/index.html');
  const d = productSchema(html);
  ok(!!d, 'personalised-strips: there is a Product schema');

  /* ONE offer since 2966fd0, at the "From" price, linked to the bare page --
     the same single item the shopping feed lists. The page has no format or
     size buttons (the builder owns both) and ignores ?format=&size=, so nine
     per-variant offers named prices the landing page never showed. */
  ok(Array.isArray(d.offers) && d.offers.length === 1, 'exactly one offer', String(d.offers?.length));
  const offer = d.offers[0] || {};
  ok(offer.url === `${new URL(offer.url || 'https://x/').origin}/store/personalised-strips/`,
    '  linked to the bare page, no ?format=&size=', offer.url);
  ok(!('name' in offer), '  with no per-variant name');

  /* The fee is not optional, so the one price must include it. The page states
     the fee in words ("plus £N personalisation") and the From price as data;
     the offer has to be the cheapest print plus exactly that fee, and the same
     number the page shows. */
  const feeOnPage = Number((text(html).match(/plus £(\d+(?:\.\d+)?) personalisation/) || [])[1]);
  ok(feeOnPage > 0, 'the page states a personalisation fee', `£${feeOnPage}`);
  ok(Number(offer.price) === Number((PRICES.poster.small + feeOnPage).toFixed(2)),
    '  the offer is the smallest poster plus that fee, not the bare 9.99',
    `${offer.price} = ${PRICES.poster.small} + ${feeOnPage}`);
  const fromOnPage = (html.match(/data-from-price="([\d.]+)"/) || [])[1];
  ok(fromOnPage && Number(offer.price) === Number(fromOnPage),
    '  and the same "From" price the page shows', `${offer.price} vs ${fromOnPage}`);

  const rp = offer.hasMerchantReturnPolicy;
  ok(rp && rp.returnPolicyCategory.endsWith('MerchantReturnNotPermitted'),
    'a personalised product takes no change-of-mind return',
    rp && rp.returnPolicyCategory.split('/').pop());
  ok(!('merchantReturnDays' in (rp || {})),
    '  and quotes no window, which would contradict that');
}

/* ═════════ 5. the landing page honours the link it is sent */

say('\n5. THE PAGE OPENS ON THE VARIANT IT WAS LINKED TO\n');
{
  const src = fs.readFileSync(path.join(SRC, 'pages/store/[slug].astro'), 'utf8');
  /* Since 2966fd0 the selected variant is decided once, by pick(), seeded from
     the query -- the shape changed, the behaviour did not. */
  ok(/new URLSearchParams\(location\.search\)/.test(src), 'the page reads the query');
  ok(/pick\(formatBtns, 'format', \w+\.get\('format'\)\)/.test(src)
    && /pick\(sizeBtns, 'size', \w+\.get\('size'\)\)/.test(src),
    '  and seeds both format and size from it');
  /* The reason this matters, asserted rather than trusted: the feed and the
     schema both link this way, and until this existed every such link opened on
     poster/small and showed £9.99 whatever had been advertised. */
  /* A STOCK page: since 2966fd0 only stock products link per variant -- a
     personalised one links to its bare page (section 4). */
  const built = read(`store/${STOCK_SLUG}/index.html`);
  ok(/format=poster&(amp;)?size=large/.test(built),
    `  and the schema really does link that way (${STOCK_SLUG})`);
}

/* ═════════ 6. the feed source, for the two faults that were in it */

say('\n6. THE FEED\n');
{
  const feed = fs.readFileSync(path.join(SRC, 'pages/feeds/google-shopping.xml.ts'), 'utf8');

  /* The double escape. The literal carried &amp; and xmlEscape escaped the
     ampersand of the entity again, so the text node read "&amp;". */
  ok(!/xmlEscape\(`Home &amp;/.test(feed),
    'product_type no longer double-escapes its ampersands');
  ok(/xmlEscape\(`Home & Garden/.test(feed), '  it passes a real ampersand to the escaper once');

  /* g:size on every STOCK item. Since 2966fd0 a personalised product is one
     item with no size chosen yet, so the template writes g:size only when it
     is given one -- and every stock variant is. */
  ok(/<g:size>\$\{xmlEscape\(f\.size\)\}<\/g:size>/.test(feed), 'the item template writes g:size when given one');
  ok(/size: sizeAttr\(size, orientation\)/.test(feed), '  and every stock variant is given one');
  const personalisedItem = feed.slice(feed.indexOf('if (product.isPersonalised) {'),
    feed.indexOf('continue;', feed.indexOf('if (product.isPersonalised) {')));
  ok(personalisedItem && !/size:|groupId:/.test(personalisedItem),
    '  while a personalised item has neither a size nor a variant group');
  ok(/<g:return_policy_label>\$\{returnsLabel\}/.test(feed), 'and g:return_policy_label');
  ok(/const returnsLabel = product\.isPersonalised \? 'personalised' : 'standard'/.test(feed),
    '  which is personalised only for what is actually made to order');
  ok(/PRICES\[format\]\[size\] \+ fee/.test(feed), 'the price includes the personalisation fee');
  ok(/import \{ PRICES \} from '\.\.\/\.\.\/data\/products'/.test(feed),
    'and the price table is the shared one, not a second copy');

  /* GROQ has no block comments. One in the query took the whole feed to a 500
     until it was run. */
  const query = feed.slice(feed.indexOf('const query = `'), feed.indexOf('`;', feed.indexOf('const query = `')));
  ok(!query.includes('/*'), 'the GROQ query carries no block comment');
}

/* ═════════ 7. one delivery promise, in one form of words */

say('\n7. UK-WIDE, AND FREE AT FIFTY\n');
{
  /* WHY THE WORDING MATTERS AT THE BOUNDARY. Checkout gives free delivery when
     the subtotal is >= 5000 pence, so a GBP 50.00 order ships free -- and
     "free on orders OVER GBP 50" tells that customer the opposite. One word,
     and the only place it shows is the till. */
  const checkout = fs.readFileSync(path.join(REPO, 'netlify/functions/checkout.mjs'), 'utf8');
  ok(/subtotalPence >= FREE_SHIPPING_THRESHOLD_PENCE/.test(checkout),
    'checkout is free AT fifty pounds, not above it');
  const cart = fs.readFileSync(path.join(REPO, 'src/stores/cart.ts'), 'utf8');
  ok(/total >= FREE_SHIPPING_THRESHOLD/.test(cart), 'and the cart agrees with it');
  /* And the line the customer reads at the till, which is the last thing they
     see before paying and was the last place still saying "over". */
  ok(/FREE UK delivery \(orders of £50 and over\)/.test(checkout),
    'and the Stripe line says so in the same words as the site');
  ok(!/orders over £50/.test(checkout), '  with nothing left saying "over £50"');

  /* EVERY built page, walked, rather than a list somebody remembered to write.
     The list version missed /personalise/ and all five blog posts -- both of
     which carry this copy, and neither of which I thought of. A hand-written
     list of pages to check is a list of pages somebody has to keep correct
     forever, and the one that matters is always the one not on it. */
  const allPages = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'index.html') allPages.push(path.relative(DIST, full).split(path.sep).join('/'));
    }
  })(DIST);

  const withMainland = [];
  const withOver = [];
  for (const rel of allPages) {
    const raw = read(rel);
    if (/mainland/i.test(raw)) withMainland.push(rel);
    /* The phrase, not the number: "under £50" and "£50 and over" are both fine
       and both contain the amount. */
    if (/(over|above)\s*£50\b/i.test(text(raw))) withOver.push(rel);
  }
  say(`  (${allPages.length} built pages walked)`);
  ok(allPages.length > 200, 'the whole build is being read, not a sample',
    `${allPages.length} pages`);

  /* NOT ALL OF THIS COPY IS IN THIS REPOSITORY.
     /services/ and /personalise/ render the same two faq documents, and the
     five blog posts are Sanity documents too. Those are writes to the live
     dataset, which is somebody's decision and not this branch's.
     Named rather than filtered out: an exception list that has to be correct is
     a gap somebody can act on, where a quiet skip is a gap nobody sees again.
     update-shipping-wording.mjs covers all seven. */
  const FROM_SANITY = [
    'services/index.html',
    'personalise/index.html',
    'blog/canvas-vs-poster-prints/index.html',
    'blog/choosing-the-right-size-canvas/index.html',
    'blog/fathers-day-gift-ideas-sport-film-music-uk/index.html',
    'blog/personalised-gifts-uk/index.html',
    'blog/what-is-pop-art-wall-art/index.html',
  ];
  const repoPages = (list) => list.filter((rel) => !FROM_SANITY.includes(rel));
  const sanityPages = (list) => list.filter((rel) => FROM_SANITY.includes(rel));

  ok(repoPages(withMainland).length === 0,
    'no page written in this repo says "mainland" any more',
    repoPages(withMainland).join(', '));
  ok(repoPages(withOver).length === 0,
    'and none of them promises free delivery only OVER fifty',
    repoPages(withOver).join(', '));

  /* The exception list TOLERATES those pages, it does not require them to be
     wrong. Requiring it would turn this suite red the moment the Sanity copy is
     fixed -- a test that fails because somebody did the thing it was asking for
     is a test that gets deleted rather than read.
     So: still wrong is reported and allowed; once clean it says exactly what to
     delete, and passes either way. What is NOT allowed is a page outside the
     list being wrong, which is the assertion above. */
  const stillWrong = [...new Set([...sanityPages(withMainland), ...sanityPages(withOver)])];
  if (stillWrong.length) {
    say(`  ....  OUTSTANDING, in Sanity rather than here: ${stillWrong.join(', ')}`);
    say('        Fix with:  node --env-file=.env update-shipping-wording.mjs --apply --publish');
    say('        Then rebuild, and delete FROM_SANITY from this file.');
  } else {
    say('  ....  the Sanity copy is fixed — delete FROM_SANITY and the two helpers');
    say('        below it from this file; the strict checks above then cover every page.');
  }
  ok(true, `the Sanity-sourced pages are accounted for: ${stillWrong.length} outstanding`,
    stillWrong.length ? FROM_SANITY.join(', ') : 'none — the list can go');

  /* And the replacement is actually there, rather than the phrase simply
     having been deleted.
     Against the pages that PROMISE free delivery, not against every page that
     contains "£50": the cart drawer is on all of them and its placeholder reads
     "Add £50.00 more for FREE UK P&P", which promises nothing and is replaced
     the moment anything is in the basket. Counting that as delivery copy made
     five pages look unfixed when they were not.
     Read from the raw HTML, because on most of these the promise is in the meta
     description, which stripping tags throws away. */
  const promises = allPages.filter((rel) =>
    /(FREE UK P&(amp;|#38;)?P on orders|FREE P&(amp;|#38;)?P on orders|free postage)/i.test(read(rel)));
  const saysIt = promises.filter((rel) => /£50 and over/i.test(read(rel)));
  ok(promises.length >= 8, 'a good number of pages do promise free delivery',
    `${promises.length} of ${allPages.length}`);
  ok(repoPages(promises).every((rel) => saysIt.includes(rel)),
    'and every one written here says "£50 and over"',
    `${saysIt.length} of ${promises.length}`);

  /* The shipping policy is the page people are sent to for the detail. */
  const ship = text(read('shipping-policy/index.html'));
  ok(/UK Delivery Rates/i.test(ship), 'the shipping policy heading is UK-wide');
  ok(/FREE P&P on orders of £50 and over/i.test(ship), '  and states the threshold correctly');
  ok(/anywhere in the UK/i.test(ship), '  and says the price is the same anywhere in the UK');
  ok(/ship to UK addresses only/i.test(ship), '  and that we ship UK-wide');

  /* llms.txt is copy too -- it is what a model repeats about the shop. */
  const llms = fs.readFileSync(path.join(REPO, 'public/llms.txt'), 'utf8');
  ok(!/mainland/i.test(llms), 'llms.txt drops "mainland"');
  ok(/£50 and over/.test(llms), '  and uses the same wording as the site');

  /* The structured data Google reads for the FAQ carries the same sentence. */
  const base = read('index.html');
  ok(!/Currently we ship to UK mainland/.test(base),
    'the FAQ structured data is updated with everything else');
}

/* ═════════ 8. one claim, checked across the whole build */

say('\n8. NO PAGE OVERSTATES WHAT APPROVAL COSTS YOU\n');
{
  /* Its own walk, deliberately small and self-contained: this is one sentence
     to keep out of the entire site, and it can appear on any page that talks
     about proofs -- the refund policy, the terms, a FAQ answer rendered from
     Sanity, a blog post. Checking a list of pages would be checking the pages
     somebody remembered. */
  const all = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'index.html') all.push(path.relative(DIST, full).split(path.sep).join('/'));
    }
  })(DIST);

  /* "cannot be cancelled or refunded" is the flat version, and the one that
     talks somebody out of a right they have: approval ends the change-of-mind
     route and touches nothing about a faulty print. */
  const flat = all.filter((rel) => /cannot be cancelled or refunded/i.test(text(read(rel))));
  ok(flat.length === 0,
    `no page says approval means "cannot be cancelled or refunded" (${all.length} pages walked)`,
    flat.join(', '));

  /* And the qualified version is actually present, rather than the claim having
     simply been deleted and the customer left to guess. */
  const refund = text(read('refund-policy/index.html'));
  ok(/cannot be cancelled for a change of mind once approved/i.test(refund),
    'the refund policy still says what approval DOES end');
  ok(/rights for faulty items are unaffected/i.test(refund), '  and what it does not');

  /* The terms make the same claim in their own words and must carry the same
     carve-out. This was fixed alongside the returns policy; asserted here so
     the two cannot drift apart again. */
  const terms = text(read('terms-and-conditions/index.html'));
  ok(/cannot be cancelled for a change of mind/i.test(terms),
    'the terms qualify it the same way');
  ok(/faulty, damaged or not as approved/i.test(terms),
    '  and name the route that stays open');

  /* THE TERMS SAY IT TWICE, in two sections, and both have to carry the
     carve-out. The personalised section was fixed with the returns policy; the
     AI-interpretation paragraph further down still said approval made the order
     "final" full stop, which is the same overstatement in shorter words and
     sits immediately before the sentence explaining that an interpretation
     differing from the photograph is not a fault. Exactly the place a customer
     is deciding whether they have any comeback at all. */
  ok(!/the order is final\./i.test(terms),
    'and no section of the terms leaves "the order is final" standing alone');
  const approvals = terms.match(/cannot be cancelled for a change of mind/gi) || [];
  ok(approvals.length === 2,
    '  both places that say it are qualified, not just the first',
    `${approvals.length} occurrence(s)`);
  ok(/your rights for faulty items are unaffected/i.test(terms),
    '  the AI paragraph carries the same carve-out as the refund policy');

  /* Folding that carve-out in left the closing sentence saying "faulty" twice.
     What it uniquely covered -- statutory rights, and damaged goods -- had to
     survive the fold rather than be tidied away with the duplication. */
  ok(/Nothing here affects your statutory rights/i.test(terms),
    '  statutory rights survive the rewrite');
  ok(/damaged goods/i.test(terms), '  and so does our position on damaged goods');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
