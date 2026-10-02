import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { docIdFor } from './_shared/pp-id.mjs';

/**
 * A customer's build, in the shape the builder reopens a design from.
 *
 *   GET /admin/api/personalisation-scene/<id>
 *     -> { id, status, template, recipe, sceneSvg, panels: { <panel>: url }, ... }
 *
 * The same shape customise-scene returns, deliberately: the builder already
 * knows how to rebuild a design from a recipe plus a URL per panel, and that
 * path is proven in production. What differs is where it comes from -- a
 * pendingPersonalisation rather than a studio scene -- and that the artwork is
 * the customer's own.
 *
 * UNDER /admin ON PURPOSE. admin-auth.ts challenges for Basic Auth across
 * /admin/*, and this is somebody else's photographs and somebody else's order:
 * the unguessable-id reasoning that makes /api/personalisation-photo acceptable
 * for the customer's own browser is not good enough for a route that hands over
 * a whole build. Checked here as well as at the edge, because every function
 * stays addressable at /.netlify/functions/<name>, which no redirect covers.
 *
 * WHAT IT DOES NOT DO. It does not serve the images. The panel URLs point at
 * /api/personalisation-photo, which already reads the blob key off the document
 * rather than off the URL, already serves the styled image and the cut-out, and
 * is already fronted by the edge function that streams the large ones. A second
 * implementation here would be a second place for that to be got wrong.
 */
const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const RENDER_STORE = 'renders';
/* Kept in step with personalisation-edit-save, which writes it. Named here as
   well rather than imported, so reading this file does not pull the save path
   and its Sanity client in behind it. */
const ORIGINAL_PROOF = 'proof-customer.png';
const ORIGINAL_PROOF_ROUTE = 'original-proof';

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);
const isPanel = (s) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

/**
 * The builder's own finish names, as the order line spells them.
 *
 * Kept in step with CART_FORMAT in product-builder.js. The two vocabularies
 * exist because the basket, the price table and the feeds all speak
 * "canvas-standard" while the geometry speaks "standard", and this is the one
 * place they have to be compared: an editor opened on a poster for an order that
 * bought a canvas would print the wrong sheet.
 */
const ORDERED_FORMAT = { poster: 'poster', standard: 'canvas-standard', gallery: 'canvas-gallery' };

/**
 * What the ORDER says this line is, as opposed to what the recipe says.
 *
 * Only answered when it can be answered without guessing. Order lines do not
 * carry the build id, so a single personalised line is unambiguous and several
 * are not -- and a wrong answer here would either block a legitimate save or
 * wave through the mismatch it exists to catch. `why` says which case it is.
 */
export function orderedLineFor(order, doc) {
  if (!order || !Array.isArray(order.lineItems)) {
    return { formatKey: null, sizeKey: null, why: 'no order line to compare with' };
  }
  const built = order.lineItems.filter((l) => l
    && (l.buildKind === 'personalised' || l.buildKind === 'customise'));
  if (built.length === 1) {
    return { formatKey: built[0].formatKey || null, sizeKey: built[0].sizeKey || null, why: null };
  }
  if (!built.length) {
    return { formatKey: null, sizeKey: null, why: 'the order has no built line' };
  }
  /* Several. Narrow by the product this build belongs to if that is enough. */
  const same = doc.productId
    ? built.filter((l) => l.productId === doc.productId || l.productSlug === doc.productSlug)
    : built;
  if (same.length === 1) {
    return { formatKey: same[0].formatKey || null, sizeKey: same[0].sizeKey || null, why: null };
  }
  return {
    formatKey: null, sizeKey: null,
    why: `the order has ${built.length} built lines and none of them names this build,`
      + ' so the finish cannot be checked against it',
  };
}

/**
 * Which statuses may be opened in the editor.
 *
 * The same three the save allows, for the obvious reason: offering a design for
 * editing that cannot then be saved wastes the reviewer's work. in_production
 * and later are refused because the customer has already approved -- see
 * personalisation-edit-save.
 */
export const EDITABLE = new Set(['rendered', 'on_hold', 'approved']);

export default async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const url = new URL(req.url);
  if (!/^\/admin\//.test(url.pathname)) {
    console.warn(`personalisation-scene: refused a call off the guarded path (${url.pathname})`);
    return json({ error: 'Not found' }, 404);
  }

  const segs = url.pathname.split('/').filter(Boolean);
  /* .../<id> for the scene, .../<id>/original-proof for the picture the
     customer actually designed, kept aside by the first edit. */
  const last = decodeURIComponent(segs[segs.length - 1] || '');
  const wantsOriginal = last === ORIGINAL_PROOF_ROUTE;
  const id = wantsOriginal ? decodeURIComponent(segs[segs.length - 2] || '') : last;
  if (!isId(id)) return json({ error: 'Not found' }, 404);

  if (wantsOriginal) {
    try {
      const bytes = await getStore(RENDER_STORE)
        .get(`renders/${id}/${ORIGINAL_PROOF}`, { type: 'arrayBuffer' });
      if (!bytes) {
        /* Not an error worth a 500: a build nobody has edited has no original
           kept aside, because the live proof still IS the original. */
        return json({ error: 'No original proof is kept for this build' }, 404);
      }
      return new Response(req.method === 'HEAD' ? null : Buffer.from(bytes), {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'private, no-store',
          'X-Robots-Tag': 'noindex',
        },
      });
    } catch (err) {
      console.error(`personalisation-scene: original proof for ${id} failed:`, err.message);
      return json({ error: 'Could not read the original proof' }, 500);
    }
  }

  try {
    const doc = await sanity.getDocument(docIdFor(id));
    if (!doc || doc._type !== 'pendingPersonalisation') {
      return json({ error: 'Unknown personalisation' }, 404);
    }

    /* The order too, when there is one. A draft has no order and nothing to
       compare against, which is not an error. */
    const order = doc.orderId
      ? await sanity.fetch('*[_id == $id][0]{ orderNumber, lineItems }', { id: doc.orderId })
        .catch(() => null)
      : null;
    const ordered = orderedLineFor(order, doc);

    let recipe = null;
    try { recipe = doc.recipe ? JSON.parse(doc.recipe) : null; } catch {
      console.error(`personalisation-scene: ${id} has a recipe that will not parse`);
      return json({ error: 'This build\'s recipe cannot be read' }, 422);
    }
    if (!recipe || !recipe.template) {
      return json({ error: 'This build has no recipe to open' }, 422);
    }

    /* One URL per panel the RECIPE names, and only for panels whose styling
       finished -- an unstyled panel has nothing to show and the endpoint would
       404. photos[] is the authority on what exists, the recipe on what the
       design is made of, so a panel needs to be in both. */
    const done = new Map(
      (doc.photos || [])
        .filter((p) => p && isPanel(p.panel) && p.styleStatus === 'done' && p.styledKey)
        .map((p) => [p.panel, p])
    );
    const panels = {};
    const missing = [];
    for (const p of recipe.panels || []) {
      if (!p || !isPanel(p.id)) continue;
      if (p.placeholder) continue;                      // never filled; nothing to load
      const row = done.get(p.id);
      if (!row) { missing.push(p.id); continue; }
      panels[p.id] = {
        styled: `/api/personalisation-photo/${encodeURIComponent(id)}/${encodeURIComponent(p.id)}`,
        /* Offered only where one exists. The builder decides which to SHOW from
           the recipe's imageVariant, not from which URLs came back -- that
           record is a choice the customer made, and a cut-out being available
           is not the same as its having been chosen. */
        cutout: row.cutoutKey
          ? `/api/personalisation-photo/${encodeURIComponent(id)}/${encodeURIComponent(p.id)}?variant=cutout`
          : null,
      };
    }

    return json({
      id,
      status: doc.status || null,
      editable: EDITABLE.has(doc.status),
      /* Said plainly rather than left to the page to work out, so the editor can
         explain itself instead of simply refusing. */
      whyNotEditable: EDITABLE.has(doc.status) ? null
        : `A build with status "${doc.status || 'none'}" cannot be edited here.`,
      orderNumber: doc.orderNumber || null,
      templateId: doc.templateId || recipe.template,
      template: recipe.template,
      recipe,
      sceneSvg: doc.sceneSvg || null,
      panels,
      /* Named so the page can say so. A panel in the recipe with no finished
         styling means the build was never complete, and opening it would
         silently drop that panel from the design on the next save. */
      missingPanels: missing,
      printSize: doc.printSize || null,
      outputFormat: doc.outputFormat || null,
      /* What was BOUGHT, for the editor to refuse a save against. The recipe is
         what the design says it is; this is what the customer paid for, and the
         two disagreeing is the one difference that cannot be fixed by looking at
         the proof. */
      orderedFormat: ordered.formatKey
        ? (Object.entries(ORDERED_FORMAT).find(([, v]) => v === ordered.formatKey) || [])[0] || null
        : null,
      orderedFormatKey: ordered.formatKey,
      orderedSizeKey: ordered.sizeKey,
      orderedUncheckable: ordered.why,
      customerNotes: doc.customerNotes || '',
      editCount: doc.editCount || 0,
      editedAt: doc.editedAt || null,
      hasCustomerOriginal: !!(doc.customerOriginal && doc.customerOriginal.sceneSvg),
      /* The revision the editor read. It comes back on the save, and the save
         refuses if the document has moved since -- the renderer patches these
         same documents. */
      rev: doc._rev,
    });
  } catch (err) {
    console.error(`personalisation-scene: ${id} failed:`, err.message);
    return json({ error: 'Could not open this build' }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }`.
// /admin/api/* is routed by netlify.toml, like the other admin endpoints. An
// inline config.path collides with the forced rewrite and 404s.
