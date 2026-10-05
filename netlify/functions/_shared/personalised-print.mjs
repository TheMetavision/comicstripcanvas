/**
 * The print file of a personalised build: who may have it, whether it is
 * still the right picture, and what it is called.
 *
 * Shared by the renderer that writes it, the edge function that streams it,
 * the admin page and the Studio panels that offer it -- so "is this print
 * current" has one answer, not four.
 *
 * BROWSER-SAFE: no Node built-ins, no blob or Sanity client. The Studio
 * bundles this, and order-print-tests walks everything the Studio imports.
 * The fingerprint uses Web Crypto, which the browser, the edge (Deno) and
 * the functions (Node 20) all have as globalThis.crypto.
 */

export const RENDER_STORE = 'renders';
export const printKey = (id) => `renders/${id}/print.png`;

/** Approved by the customer, or past it: the only statuses a print is handed out in. */
export const DOWNLOAD_STATUSES = ['in_production', 'dispatched'];
export const AWAITING_APPROVAL = 'Available once the customer approves';

/**
 * What the print was made FROM: the stored recipe string and the scene, the
 * two things the renderer reads. Any edit or recipe change changes it.
 * Hex, truncated -- it identifies a version, it is not a security boundary.
 */
export async function printFingerprint({ recipe, sceneSvg }) {
  const bytes = new TextEncoder().encode(`${recipe || ''}\n${sceneSvg || ''}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** May this build's print be downloaded at all? */
export function downloadAllowed(doc) {
  if (!doc) return { ok: false, code: 404, why: 'No such build.' };
  if (!DOWNLOAD_STATUSES.includes(doc.status)) {
    return {
      ok: false,
      code: 409,
      awaitingApproval: true,
      why: `${AWAITING_APPROVAL}. This build is "${doc.status || 'no status'}".`,
    };
  }
  return { ok: true };
}

/**
 * Was the stored print made from the design as it is now?
 *
 * `rendered` is what was recorded with the print -- the blob's metadata, or
 * the printFile summary on the document; both carry the same fields.
 *
 *   fingerprint recorded   the print is current exactly when it matches the
 *                          design's fingerprint now. Also refused if it was
 *                          rendered before the last admin edit, whatever the
 *                          fingerprint says.
 *   no fingerprint         a print made before this was recorded. Fine if the
 *                          design was never edited -- a paid build's recipe
 *                          cannot change any other way -- and refused if it
 *                          was, because nothing proves it post-dates the edit.
 *
 * @returns {Promise<{ stale: boolean, why?: string }>}
 */
export async function printStaleness({ doc, rendered }) {
  if (!rendered) return { stale: true, missing: true, why: 'No print file has been rendered for this build yet.' };

  const editedAt = doc.editedAt ? Date.parse(doc.editedAt) : NaN;
  const renderedAt = rendered.renderedAt ? Date.parse(rendered.renderedAt) : NaN;
  if (Number.isFinite(editedAt) && Number.isFinite(renderedAt) && renderedAt < editedAt) {
    return {
      stale: true,
      why: `This print was rendered ${rendered.renderedAt}, before the design was last edited `
        + `(${doc.editedAt}). It would print the old design.`,
    };
  }

  if (rendered.fingerprint) {
    const now = await printFingerprint(doc);
    return now === rendered.fingerprint
      ? { stale: false }
      : { stale: true, why: 'The design has changed since this print was rendered. It would print the old design.' };
  }

  const edited = (typeof doc.editCount === 'number' && doc.editCount > 0) || !!doc.editedAt;
  return edited
    ? {
      stale: true,
      why: 'This print was rendered before prints recorded which version of the design they '
        + 'show, and the design has been edited since it was paid for -- so nothing proves the '
        + 'print shows the edited version.',
    }
    : { stale: false };
}

const recipeOf = (doc) => {
  try { return typeof doc.recipe === 'string' ? JSON.parse(doc.recipe) : (doc.recipe || {}); } catch { return {}; }
};
const part = (s) => String(s || '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/** <orderNumber>-<template>-<size>-<format>.png, e.g. CSC-1006-cover-large-standard.png */
export function printDownloadName(doc) {
  const size = recipeOf(doc).output?.sizeKey;
  const parts = [doc.orderNumber || doc._id || 'build', doc.templateId, size, doc.outputFormat].map(part).filter(Boolean);
  return `${parts.join('-')}.png`;
}

/** "7200 × 4800 px · 24 × 16 in at 300 dpi", from whatever was recorded. */
export function describePrint(rendered, doc = {}) {
  if (!rendered || !rendered.width || !rendered.height) return doc.printSize ? `${doc.printSize}` : '';
  const px = `${rendered.width} × ${rendered.height} px`;
  const inches = Array.isArray(rendered.fileInches) && rendered.fileInches.length === 2
    ? `${rendered.fileInches[0]} × ${rendered.fileInches[1]} in`
    : (doc.printSize || '');
  const dpi = rendered.dpi ? ` at ${rendered.dpi} dpi` : '';
  return inches ? `${px} · ${inches}${dpi}` : `${px}${dpi}`;
}

/**
 * The one thing every button needs to know, for any surface that has the
 * build document and its recorded print summary (doc.printFile).
 *
 * Those surfaces -- the admin page, the Studio -- cannot read the blob store,
 * so they go by doc.printFile. A build rendered before that was recorded has
 * none, which does not mean it has no print: `unrecorded` offers the download
 * anyway and lets the edge route, which CAN read the stored file, decide. An
 * edited build in that position is shown stale straight away, because the
 * route's legacy rule would refuse it whatever it found.
 *
 * @returns {Promise<{ state: 'awaiting'|'missing'|'stale'|'ready'|'unrecorded', why?: string, size: string }>}
 */
export async function printPanelState(doc, rendered = doc && doc.printFile) {
  const allowed = downloadAllowed(doc);
  if (!allowed.ok) return { state: 'awaiting', why: AWAITING_APPROVAL, size: '' };
  if (!rendered) {
    const legacy = await printStaleness({ doc, rendered: {} });
    return legacy.stale
      ? { state: 'stale', why: legacy.why, size: doc.printSize || '' }
      : {
        state: 'unrecorded',
        why: 'Rendered before print sizes were recorded; the download checks it is current.',
        size: doc.printSize || '',
      };
  }
  const s = await printStaleness({ doc, rendered });
  if (s.missing) return { state: 'missing', why: s.why, size: '' };
  if (s.stale) return { state: 'stale', why: s.why, size: describePrint(rendered, doc) };
  return { state: 'ready', size: describePrint(rendered, doc) };
}

/* ---------------------------------------------------- which build is a line */

const FORMAT_OF = { poster: 'poster', 'canvas-standard': 'standard', 'canvas-gallery': 'gallery' };
const TEMPLATE_FAMILY = (t) => (t || '').startsWith('cover') ? 'cover' : (t || '').startsWith('icon') ? 'icon' : t;
const FAMILY_OF_SLUG = {
  'personalised-book-covers': 'cover',
  'personalised-icons': 'icon',
  'personalised-strips': 'strip',
};

/**
 * The build an order line was for.
 *
 * A line stamped since this was written carries personalisationId and the
 * answer is that. Older lines do not: they are matched among the builds paid
 * on the same order by template family, size and finish -- and if that leaves
 * anything but exactly one, the answer is "cannot tell", never a guess. A
 * wrong guess here is the wrong customer's artwork at the press.
 *
 * @param {object} line   the order line
 * @param {object[]} builds  every build whose orderId is this order
 * @returns {{ build?: object, why?: string }}
 */
export function buildForLine(line, builds = []) {
  if (line && line.personalisationId) {
    const b = builds.find((x) => x && (x._id || '').endsWith(line.personalisationId));
    return b ? { build: b } : { why: `Build ${line.personalisationId} was not found on this order.` };
  }
  if (!builds.length) return { why: 'No build was paid for on this order.' };
  const recipeSize = (b) => recipeOf(b).output?.sizeKey;
  const fits = builds.filter((b) =>
    (!line.formatKey || FORMAT_OF[line.formatKey] === b.outputFormat)
    && (!line.sizeKey || recipeSize(b) === line.sizeKey)
    && (!line.productSlug || !FAMILY_OF_SLUG[line.productSlug]
      || FAMILY_OF_SLUG[line.productSlug] === TEMPLATE_FAMILY(b.templateId)));
  if (fits.length === 1) return { build: fits[0] };
  return {
    why: fits.length
      ? `${fits.length} builds on this order match this line — open them from Personalisations.`
      : 'No build on this order matches this line\'s size and finish.',
  };
}
