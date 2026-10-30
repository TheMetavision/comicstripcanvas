/**
 * Format + size -> the shipping service's parcel band, and the parcel plan an
 * order is proposed with.
 *
 * The bands are refs into metavision-shipping's config/shipping.json, where the
 * real box sizes and weights live. This file only says which box a thing goes
 * in. It never guesses: a line it cannot place is reported as a problem and the
 * order is flagged for Alan, because a wrong band is a label for the wrong
 * box -- a surcharge, or a parcel the carrier refuses.
 *
 *   poster 12x8 -> P1 (hard-backed envelope)   18x12 -> P3   24x16 -> P4 (tubes)
 *   standard canvas                             CS1 / CS3 / CS4
 *   gallery canvas                              CG1 / CG3 / CG4
 *
 * Keys, never labels: order lines carry formatKey / sizeKey since the
 * September 2026 stamping (see webhook.mjs). The labels are for humans and
 * have changed once already, so an older line with only labels is flagged
 * rather than parsed.
 */

export const BANDS = {
  poster: { small: 'P1', medium: 'P3', large: 'P4' },
  'canvas-standard': { small: 'CS1', medium: 'CS3', large: 'CS4' },
  'canvas-gallery': { small: 'CG1', medium: 'CG3', large: 'CG4' },
};

/** Every band this shop can use, for the Studio's band pickers. */
export const ALL_BANDS = Object.values(BANDS).flatMap((s) => Object.values(s));

export const BAND_TITLES = {
  P1: 'P1 — poster 12×8 (hard-backed envelope)',
  P3: 'P3 — poster 18×12 (tube)',
  P4: 'P4 — poster 24×16 (tube)',
  CS1: 'CS1 — standard canvas 12×8',
  CS3: 'CS3 — standard canvas 18×12',
  CS4: 'CS4 — standard canvas 24×16',
  CG1: 'CG1 — gallery canvas 12×8',
  CG3: 'CG3 — gallery canvas 18×12',
  CG4: 'CG4 — gallery canvas 24×16',
};

/** The band for a format and size key, or null. */
export const bandFor = (formatKey, sizeKey) => BANDS[formatKey]?.[sizeKey] ?? null;

/**
 * Lines that are not a thing in a box. The legacy personalise flow wrote its
 * artwork fee as a line of its own with format '—'; there is nothing to post.
 */
export const isNonPhysical = (line) =>
  !line || line.format === '—' || /^artwork fee$/i.test(String(line.productTitle || '').trim());

/** The band for one order line: { band } or { problem }. */
export function bandForLine(line) {
  if (!line.formatKey || !line.sizeKey) {
    return { problem: `"${line.productTitle || 'a line'}" (${line.format || '?'} / ${line.size || '?'}) has no format/size key — choose its band by hand` };
  }
  const band = bandFor(line.formatKey, line.sizeKey);
  if (!band) {
    return { problem: `"${line.productTitle || 'a line'}" is ${line.formatKey} / ${line.sizeKey}, which has no parcel band — choose one by hand` };
  }
  return { band };
}

/**
 * The plan an order starts with: one parcel per physical item, so a line of
 * two posters is two parcels. Alan combines them in the Studio before shipping
 * (two posters in one tube) by editing the plan.
 *
 * @returns {{ plan: object[], problems: string[] }}
 *   A line that could not be placed is still planned, with no band, so the plan
 *   shows the whole order and dispatch refuses it until a band is chosen.
 */
export function proposeParcelPlan(lineItems = []) {
  const plan = [];
  const problems = [];
  for (const line of Array.isArray(lineItems) ? lineItems : []) {
    if (isNonPhysical(line)) continue;
    const { band, problem } = bandForLine(line);
    if (problem) problems.push(problem);
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
    for (let i = 0; i < qty; i++) {
      const parcelRef = String(plan.length + 1);
      plan.push({
        _key: `p${parcelRef}`,
        _type: 'plannedParcel',
        parcelRef,
        ...(band ? { band } : {}),
        items: [{ _key: `i${parcelRef}`, _type: 'plannedItem', title: [line.productTitle, line.format, line.size].filter(Boolean).join(' — '), lineKey: line._key, quantity: 1 }],
      });
    }
  }
  return { plan, problems };
}

/**
 * Check a plan (possibly edited in the Studio) against the order before any
 * label is bought. Every problem is listed, not just the first.
 */
export function validateParcelPlan(plan, lineItems = []) {
  const problems = [];
  const lines = new Map((lineItems || []).map((l) => [l._key, l]));
  if (!Array.isArray(plan) || !plan.length) return ['The parcel plan is empty'];
  const refs = new Set();
  const planned = new Map();
  for (const p of plan) {
    const ref = String(p?.parcelRef ?? '').trim();
    const label = `Parcel ${ref || '(no ref)'}`;
    if (!ref) problems.push('A parcel has no parcel ref');
    else if (!/^[A-Za-z0-9_-]{1,32}$/.test(ref)) problems.push(`${label}: the parcel ref may only use letters, digits, - and _`);
    else if (refs.has(ref)) problems.push(`${label}: the parcel ref is used twice`);
    refs.add(ref);
    if (!p?.band) problems.push(`${label} has no band`);
    else if (!ALL_BANDS.includes(p.band)) problems.push(`${label}: "${p.band}" is not a known band`);
    const items = Array.isArray(p?.items) ? p.items : [];
    if (!items.length) problems.push(`${label} has nothing in it`);
    for (const it of items) {
      const line = lines.get(it?.lineKey);
      if (!line) { problems.push(`${label} lists a line that is not on this order (${it?.lineKey || 'blank'})`); continue; }
      const q = Math.floor(Number(it.quantity) || 0);
      if (q < 1) problems.push(`${label}: quantity for "${line.productTitle}" must be at least 1`);
      planned.set(it.lineKey, (planned.get(it.lineKey) || 0) + Math.max(q, 0));
    }
  }
  for (const line of lineItems || []) {
    if (isNonPhysical(line)) continue;
    const want = Math.max(1, Math.floor(Number(line.quantity) || 1));
    const got = planned.get(line._key) || 0;
    if (got !== want) problems.push(`"${line.productTitle}": ${want} ordered, ${got} in the parcel plan`);
  }
  return problems;
}

/** The item list the service puts on the label and customs data. */
export function parcelItems(parcel, lineItems = []) {
  const lines = new Map((lineItems || []).map((l) => [l._key, l]));
  return (parcel.items || []).map((it) => {
    const line = lines.get(it.lineKey) || {};
    const qty = Math.max(1, Math.floor(Number(it.quantity) || 1));
    return {
      description: [line.productTitle, line.format, line.size].filter(Boolean).join(' — ').slice(0, 120) || 'Print',
      qty,
      valueGBP: Math.round((Number(line.unitPrice) || 0) * qty * 100) / 100,
      sku: [line.productSlug, line.formatKey, line.sizeKey].filter(Boolean).join('-') || undefined,
    };
  });
}

/** The service's view of where a parcel goes. Name and address only. */
export function recipientFor(order) {
  const a = order.shippingAddress || {};
  return {
    name: order.customerName || '',
    addressLine1: a.line1 || '',
    addressLine2: a.line2 || '',
    houseNumber: '',
    city: a.city || '',
    postalCode: a.postcode || '',
    countryCode: (a.country || '').toUpperCase(),
    email: '',
    phone: '',
  };
}

/* ------------------------------------------------------------------ carriers */

/** The service reports Sendcloud's carrier code; the order schema has its own list. */
const CARRIERS = [
  [/^royal[_-]?mail/i, 'royal-mail', 'Royal Mail'],
  [/^(hermes|evri)/i, 'evri', 'Evri'],
  [/^inpost/i, 'inpost', 'InPost'],
  [/^dpd/i, 'dpd', 'DPD'],
  [/^ups/i, 'ups', 'UPS'],
];

/** { carrier, carrierOther } for the order document. */
export function mapCarrier(code) {
  const s = String(code || '');
  for (const [re, value] of CARRIERS) if (re.test(s)) return { carrier: value, carrierOther: null };
  return { carrier: 'other', carrierOther: s ? s.replace(/[_:].*$/, '').replace(/^\w/, (c) => c.toUpperCase()) : 'Courier' };
}

/** The name a customer reads. */
export function carrierName(code) {
  const s = String(code || '');
  for (const [re, , name] of CARRIERS) if (re.test(s)) return name;
  if (/^sendcloud/i.test(s)) return 'Sendcloud (test)';
  return s || 'Courier';
}
