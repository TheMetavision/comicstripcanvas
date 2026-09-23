/**
 * Filtering a grid of products, for every page that shows one.
 *
 * The store's All Products page has had a search box since it was built, and
 * the three category pages have not. Rather than write the search three more
 * times, the rule that decides what a search matches lives here once, and the
 * pages differ only in what they hand it.
 *
 * ── What the search actually matches ───────────────────────────────────────
 *
 * TITLE ONLY, case-insensitively, as a substring. Not description, not tags,
 * not category. That is what All Products has always done and this keeps it,
 * because the point of the change is that a customer who has used one page
 * cannot tell the other apart -- a category page that quietly searched
 * descriptions too would return things the All Products page does not, for the
 * same typing, and that is a worse surprise than the missing box was.
 *
 * Widening it is a deliberate change to make in one place later, which is most
 * of why this file exists.
 *
 * ── Pure decisions, then a thin binding ────────────────────────────────────
 *
 * Everything above initProductFilter is strings in, booleans out, and is what
 * the tests exercise: no DOM, because a browser between the test and the
 * answer is three more things that can fail. The binding underneath is kept
 * deliberately thin for the same reason -- it only reads the page, asks the
 * functions above, and toggles display.
 */

/** Trimmed and lower-cased, and safe on null. */
export const normalise = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Does this title match what was typed?
 *
 * An empty or whitespace-only query matches EVERYTHING, which is what makes
 * clearing the box restore the full list rather than empty it.
 */
export function matchesQuery(title, query) {
  const q = normalise(query);
  if (!q) return true;
  return normalise(title).includes(q);
}

/**
 * Does this product belong to the category being shown?
 *
 * 'all', empty, and null all mean "no category filter". A category PAGE never
 * passes anything else -- its grid only ever contains its own products -- so
 * this is really for the All Products page's buttons.
 */
export function matchesCategory(category, active) {
  const a = normalise(active);
  if (!a || a === 'all') return true;
  return normalise(category) === a;
}

/**
 * Which of these rows should be on screen.
 *
 * Takes plain objects rather than elements so it can be tested without a DOM,
 * and returns a boolean per row in the order given.
 *
 * @param {Array<{title?: string, category?: string}>} rows
 * @param {{query?: string, category?: string}} state
 * @returns {boolean[]}
 */
export function decideVisibility(rows, { query = '', category = 'all' } = {}) {
  return (rows || []).map(
    (r) => matchesCategory(r?.category, category) && matchesQuery(r?.title, query),
  );
}

/** How many of them that is -- the number the empty state turns on. */
export function visibleCount(rows, state) {
  return decideVisibility(rows, state).filter(Boolean).length;
}

/* ------------------------------------------------------------ the binding */

/**
 * Wire a grid up to whichever controls the page actually has.
 *
 * Every control is optional, which is the whole point: a category page passes
 * an input and nothing else, All Products passes the lot, and both get exactly
 * the same matching behaviour because both end up in decideVisibility.
 *
 * Reads title and category off the data- attributes the page already writes
 * onto each row, so nothing here needs to know how a ProductCard is built.
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.grid          the container of .product-item rows
 * @param {HTMLInputElement|null} opts.input    the search box
 * @param {HTMLElement|null} [opts.noResults]   shown when nothing matches
 * @param {HTMLSelectElement|null} [opts.sortSelect]
 * @param {NodeListOf<Element>|Element[]} [opts.categoryButtons]
 * @param {(btn: Element) => void} [opts.onCategoryChange] paint the active button
 * @returns {{ apply: () => void } | null}
 */
export function initProductFilter({
  grid,
  input,
  noResults = null,
  sortSelect = null,
  categoryButtons = [],
  onCategoryChange = null,
} = {}) {
  if (!grid) return null;

  const items = Array.from(grid.querySelectorAll('.product-item'));
  let activeCategory = 'all';

  const rowOf = (el) => ({
    title: el.dataset.title || '',
    category: el.dataset.category || '',
  });

  function apply() {
    const query = input ? input.value : '';
    const shown = decideVisibility(items.map(rowOf), { query, category: activeCategory });
    let visible = 0;
    items.forEach((el, i) => {
      if (shown[i]) { el.style.display = ''; visible++; } else { el.style.display = 'none'; }
    });
    if (noResults) noResults.classList.toggle('hidden', visible > 0);
    grid.classList.toggle('hidden', visible === 0);
  }

  function sortItems() {
    const val = sortSelect && sortSelect.value;
    if (!val) return;
    const sorted = [...items];
    if (val === 'price-asc') {
      sorted.sort((a, b) => parseFloat(a.dataset.price || '0') - parseFloat(b.dataset.price || '0'));
    } else if (val === 'price-desc') {
      sorted.sort((a, b) => parseFloat(b.dataset.price || '0') - parseFloat(a.dataset.price || '0'));
    } else if (val === 'name-az') {
      sorted.sort((a, b) => (a.dataset.title || '').localeCompare(b.dataset.title || ''));
    }
    sorted.forEach((item) => grid.appendChild(item));
  }

  if (input) input.addEventListener('input', apply);

  Array.from(categoryButtons || []).forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.category || 'all';
      if (onCategoryChange) onCategoryChange(btn);
      apply();
    });
  });

  if (sortSelect) {
    sortSelect.addEventListener('change', () => { sortItems(); apply(); });
  }

  return { apply };
}
