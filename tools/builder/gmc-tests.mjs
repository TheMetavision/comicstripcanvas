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
{
  const dirs = fs.readdirSync(path.join(DIST, 'store'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('personalised'))
    .map((d) => d.name);
  const slug = dirs[0];
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
  const d = productSchema(read('store/personalised-strips/index.html'));
  ok(!!d, 'personalised-strips: there is a Product schema');
  const byUrl = Object.fromEntries(d.offers.map((o) => [o.url.split('?')[1], o]));

  /* The fee is the difference between every offer and the plain print price,
     and it has to be the SAME difference on all nine -- one fee, not a markup
     that drifts by variant. */
  const gaps = new Set();
  for (const [format, sizes] of Object.entries(PRICES)) {
    for (const [size, price] of Object.entries(sizes)) {
      const o = byUrl[`format=${format}&size=${size}`];
      if (o) gaps.add(Number((Number(o.price) - price).toFixed(2)));
    }
  }
  ok(gaps.size === 1, 'one fee, added to every variant alike', [...gaps].join(', '));
  const fee = [...gaps][0];
  ok(fee > 0, 'and it is actually added', `£${fee}`);

  /* The number Alan named. */
  const large = byUrl['format=poster&size=large'];
  ok(Number(large.price) === 26.99,
    'the Large strip poster is 26.99, not 16.99', large.price);

  const rp = d.offers[0].hasMerchantReturnPolicy;
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
  ok(/preselectFromQuery/.test(src), 'the page reads format and size off the query');
  ok(/q\.get\('format'\)/.test(src) && /q\.get\('size'\)/.test(src), '  both of them');
  /* The reason this matters, asserted rather than trusted: the feed and the
     schema both link this way, and until this existed every such link opened on
     poster/small and showed £9.99 whatever had been advertised. */
  const built = read('store/personalised-strips/index.html');
  ok(/format=poster&(amp;)?size=large/.test(built) || /format=poster&size=large/.test(built),
    '  and the schema really does link that way');
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

  ok(/<g:size>\$\{xmlEscape\(sizeAttr\(/.test(feed), 'every item carries g:size');
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

  /* Every page a customer reads, against both faults. */
  const pages = [
    'index.html', 'services/index.html', 'store/index.html',
    'store/personalised/index.html', 'store/comic-book-icons/index.html',
    'store/comic-book-strips/index.html', 'store/comic-book-covers/index.html',
    'shipping-policy/index.html', 'terms-and-conditions/index.html',
    'refund-policy/index.html', 'order-confirmation/index.html',
  ];
  const withMainland = [];
  const withOver = [];
  const absent = [];
  for (const rel of pages) {
    /* order-confirmation is server-rendered and has no HTML in dist. Skipped
       rather than crashed on, and NAMED, so a page quietly dropping out of the
       build cannot make this section pass by checking nothing. */
    if (!fs.existsSync(path.join(DIST, rel))) { absent.push(rel); continue; }
    const raw = read(rel);
    if (/mainland/i.test(raw)) withMainland.push(rel);
    /* The phrase, not the number: "under GBP 50" and "GBP 50 and over" are both
       fine and both contain the amount. */
    if (/(over|above)\s*£50\b/i.test(text(raw))) withOver.push(rel);
  }
  say(`  (${pages.length - absent.length} pages read${absent.length ? `, ${absent.length} server-rendered and skipped: ${absent.join(', ')}` : ''})`);
  ok(pages.length - absent.length >= 10, 'most of the pages that price delivery are in dist',
    `${pages.length - absent.length}/${pages.length}`);

  /* NOT ALL OF THIS COPY IS IN THIS REPOSITORY.
     /services/ renders its FAQ from Sanity, and two faq documents still carry
     the old wording -- so does every blog post. Those are content writes to the
     live dataset, which is somebody's decision and not this branch's.
     They are named rather than skipped: an exception list that has to be
     correct is a gap somebody can act on, where a quiet filter is a gap nobody
     ever sees again. Clear the two faq documents and this list goes with it. */
  const FROM_SANITY = ['services/index.html'];
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
  const promises = pages.filter((rel) => fs.existsSync(path.join(DIST, rel))
    && /(FREE UK P&(amp;|#38;)?P on orders|FREE P&(amp;|#38;)?P on orders|free postage)/i.test(read(rel)));
  const saysIt = promises.filter((rel) => /£50 and over/i.test(read(rel)));
  ok(promises.length >= 8, 'most of these pages do promise free delivery',
    `${promises.length} of ${pages.length}`);
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

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
