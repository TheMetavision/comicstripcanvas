import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { internalOrigin } from './_shared/origin.mjs';
import { docIdFor } from './_shared/pp-id.mjs';
import { PHOTO_STORE, keepOriginalThumb } from './_shared/thumb.mjs';

/**
 * Save a build we have edited on the customer's behalf, and re-render it.
 *
 *   POST /admin/api/personalisation-edit-save
 *   { id, recipe, rev }            -> { ok, status, editCount, tokenRevoked }
 *
 * WHY THIS IS NOT personalise-save
 * --------------------------------
 * personalise-save is public and refuses anything that is not a draft, which is
 * exactly right: after payment the document is the record of what was sold and
 * what a reviewer approved, and a public endpoint has no business rewriting it.
 * That lock is not relaxed for this. This is a different endpoint, behind Basic
 * Auth, that allows precisely the three statuses where an edit still makes
 * sense and refuses the rest.
 *
 * WHAT IT KEEPS
 * -------------
 * The customer's own design, the first time we touch it and never again. Two
 * reasons and either would do on its own: somebody has to be able to see what
 * was changed on their behalf, and if an edit makes it worse there has to be
 * something to go back to. Written with setIfMissing, so the tenth edit still
 * compares against what they made rather than against our ninth attempt.
 *
 * WHAT IT REFUSES
 * ---------------
 * in_production and dispatched. The customer has clicked approve; what they
 * approved is what gets printed, and an edit after that point is a different
 * picture arriving at the press with their approval attached to it. The refusal
 * says so, because the reviewer needs to know it is a policy and not a bug.
 *
 * THE OLD PROOF LINK
 * ------------------
 * Saving from `approved` revokes the unused approveToken. The email is already
 * in their inbox with a working button on it, and that button says "this is the
 * artwork" about a picture that no longer exists. Revoking it makes the link
 * show the expired page, which is the honest answer, and the new proof carries
 * a new token.
 */
const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

const RENDER_STORE = 'renders';
/** Where the customer's own proof is kept once we start editing over it. */
export const ORIGINAL_PROOF = 'proof-customer.png';

/** The statuses an edit still means something in. */
export const EDITABLE = new Set(['rendered', 'on_hold', 'approved']);
/** Past here the customer has approved, and what they approved is what prints. */
export const APPROVED_BY_CUSTOMER = new Set(['in_production', 'dispatched']);

/**
 * Why a given status cannot be edited, in words a reviewer can act on.
 */
export function refusalFor(status) {
  if (EDITABLE.has(status)) return null;
  if (APPROVED_BY_CUSTOMER.has(status)) {
    return 'The customer has already approved this artwork, so it cannot be changed here — '
      + 'what they approved is what goes to print. If it genuinely has to change, put it on '
      + 'hold first and tell them why.';
  }
  if (status === 'draft' || status === 'awaiting_payment') {
    return 'This build has not been paid for yet, so it is still the customer\'s to finish.';
  }
  if (status === 'paid' || status === 'preparing') {
    return 'This build is still being rendered. Wait for the proof, then edit it.';
  }
  return `A build with status "${status || 'none'}" cannot be edited here.`;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  /* Guarded by /admin, and checked here as well: every function stays
     addressable at /.netlify/functions/<name>, which no redirect covers. */
  const path = new URL(req.url).pathname;
  if (!/^\/admin\//.test(path)) {
    console.warn(`personalisation-edit-save: refused a call off the guarded path (${path})`);
    return json({ ok: false, error: 'Not found' }, 404);
  }

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Bad JSON' }, 400); }

  const { id, rev } = body || {};
  if (!isId(id)) return json({ ok: false, error: 'Invalid id' }, 400);

  let recipe = body && body.recipe;
  if (typeof recipe === 'string') {
    try { recipe = JSON.parse(recipe); } catch { return json({ ok: false, error: 'Recipe is not valid JSON' }, 400); }
  }
  if (!recipe || typeof recipe !== 'object' || !recipe.template) {
    return json({ ok: false, error: 'Recipe is missing its template' }, 400);
  }
  const { svg: sceneSvg, ...recipeRest } = recipe;
  if (typeof sceneSvg !== 'string' || !sceneSvg.trim()) {
    return json({ ok: false, error: 'The recipe carries no scene' }, 400);
  }
  /* The same guard the other save paths have: an inlined image is a
     multi-megabyte document that the renderer cannot use and the platform may
     refuse, and every exporter here tokenises its images. */
  if (/href\s*=\s*["']?\s*data:/i.test(sceneSvg)) {
    return json({
      ok: false,
      error: 'The scene has an image inlined as data: — it must reference its panels by token.',
    }, 400);
  }

  const doc = await sanity.getDocument(docIdFor(id));
  if (!doc || doc._type !== 'pendingPersonalisation') {
    return json({ ok: false, error: 'Unknown personalisation' }, 404);
  }
  const refusal = refusalFor(doc.status);
  if (refusal) {
    console.warn(`personalisation-edit-save: refused ${id} — status is ${JSON.stringify(doc.status ?? null)}`);
    return json({ ok: false, error: refusal, status: doc.status ?? null, refused: true }, 409);
  }

  /* The template cannot change. The photographs were styled for this layout and
     the panels are named by it, so a cover's recipe saved over a strip would
     point the renderer at panels that do not exist. */
  if (doc.templateId && recipe.template !== doc.templateId) {
    return json({
      ok: false,
      error: `This build is a ${doc.templateId}, not a ${recipe.template}.`,
    }, 400);
  }

  const wasApproved = doc.status === 'approved';
  const now = new Date().toISOString();
  const out = recipe.output || {};
  const dpis = Array.isArray(recipe.panels)
    ? recipe.panels.map((p) => p && p.effectiveDpi).filter((d) => typeof d === 'number')
    : [];

  const set = {
    recipe: JSON.stringify(recipeRest),
    sceneSvg,
    editedAt: now,
    editCount: (typeof doc.editCount === 'number' ? doc.editCount : 0) + 1,
    /* Re-derived from the recipe we were handed, exactly as finalise does, so
       the Studio's summary of the build does not describe the old one. */
    printSize: out.faceInches ? `${out.faceInches[0]} × ${out.faceInches[1]} in` : (doc.printSize || ''),
    outputFormat: out.format || doc.outputFormat || '',
    /* preparing is in the render job's renderable set, so it will pick this up.
       The previous proof is cleared in the same patch: an edited design whose
       page still shows last week's proof is worse than one showing none. */
    status: 'preparing',
  };
  if (dpis.length) set.minEffectiveDpi = Math.min(...dpis);

  const unset = ['renderError', 'proofUrl'];
  let tokenRevoked = false;
  if (wasApproved) {
    /* The approval belonged to a design that no longer exists, and so did the
       link. Both go: a live token would let the customer approve artwork they
       have not seen, and approvedAt would claim a reviewer signed off on this. */
    unset.push('approveToken', 'approvedAt');
    tokenRevoked = !!doc.approveToken;
  }

  /* The customer's own proof, kept before anything overwrites it.
     The re-render writes renders/<id>/proof.png in place, so by the time anyone
     asks "what did they actually design?" the picture is gone. Copied on the
     first edit only -- the same rule as customerOriginal, and for the same
     reason: the tenth edit should still be comparable with what they made.
     Best-effort: failing to keep a copy is not a reason to refuse the edit, and
     it is said out loud rather than swallowed. */
  const keepingOriginal = !(doc.customerOriginal && doc.customerOriginal.sceneSvg);
  let originalProofKept = false;
  if (keepingOriginal) {
    try {
      const renders = getStore(RENDER_STORE);
      const was = await renders.get(`renders/${id}/proof.png`, { type: 'arrayBuffer' });
      if (was) {
        await renders.set(`renders/${id}/${ORIGINAL_PROOF}`, was, {
          metadata: { id, kind: 'customer-proof', keptAt: now },
        });
        originalProofKept = true;
      }
    } catch (err) {
      console.error(`personalisation-edit-save: could not keep the customer's proof for ${id}:`, err.message);
    }
  }

  /* And their basket thumbnail, which the re-render replaces with one of the
     edited design. Not tied to keepingOriginal: a build first edited before
     thumbnails were regenerated still holds the customer's own snapshot, and
     keepOriginalThumb only ever copies when no copy exists yet. Best-effort for
     the same reason as the proof -- and if it fails here the renderer tries
     again, and will not replace thumb.jpg until a copy is safe. */
  let originalThumbKept = false;
  try {
    originalThumbKept = (await keepOriginalThumb(getStore(PHOTO_STORE), id, now)) === 'kept';
  } catch (err) {
    console.error(`personalisation-edit-save: could not keep the customer's thumbnail for ${id}:`, err.message);
  }

  try {
    let patch = sanity.patch(docIdFor(id));
    /* ifRevisionID, because the renderer patches these same documents and the
       read above is seconds old. Only when the editor told us which revision it
       was working from -- a caller that did not say cannot be held to one. */
    if (typeof rev === 'string' && rev) patch = patch.ifRevisionId(rev);
    await patch
      /* setIfMissing, and this is the whole point: the customer's design is kept
         the FIRST time we edit and never again. */
      .setIfMissing({
        customerOriginal: {
          recipe: typeof doc.recipe === 'string' ? doc.recipe : '',
          sceneSvg: typeof doc.sceneSvg === 'string' ? doc.sceneSvg : '',
          savedAt: now,
        },
      })
      .set(set)
      .unset(unset)
      .commit();
  } catch (err) {
    if (err && (err.statusCode === 409 || /revision/i.test(err.message || ''))) {
      console.warn(`personalisation-edit-save: ${id} moved under the editor — refusing`);
      return json({
        ok: false,
        error: 'This build changed while you were editing it — reopen it and make the change again.',
        conflict: true,
      }, 409);
    }
    console.error(`personalisation-edit-save: could not save ${id}:`, err.message);
    return json({ ok: false, error: 'Could not save this design' }, 500);
  }

  /* Then the render, through the same job Re-render uses. Asked for after the
     document is written, so a render can never run against the old scene. */
  const origin = internalOrigin(req);
  let rendering = false;
  let renderError = null;
  try {
    const res = await fetch(`${origin}/api/render-personalisation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    rendering = res.ok;
    if (!res.ok) renderError = `The render job would not start (${res.status})`;
  } catch (err) {
    renderError = `Could not reach the render job: ${err.message}`;
  }
  if (!rendering) {
    /* Say so ON THE DOCUMENT, not only in a log. A build left in `preparing`
       with nothing rendering it is invisible in the Studio, and the sweep reads
       renderError. */
    try {
      await sanity.patch(docIdFor(id)).set({ status: 'on_hold', renderError }).commit();
    } catch (patchErr) {
      console.error(`personalisation-edit-save: could not record the render failure on ${id}:`, patchErr.message);
    }
    return json({ ok: false, error: renderError, status: 'on_hold', tokenRevoked }, 502);
  }

  console.log(`personalisation-edit-save: ${id} edited (${set.editCount}) and queued for re-render`
    + `${tokenRevoked ? ' — the old approve link was revoked' : ''}`);
  return json({
    ok: true,
    status: 'preparing',
    editCount: set.editCount,
    tokenRevoked,
    keptOriginal: keepingOriginal,
    originalProofKept,
    originalThumbKept,
  });
};

// NOTE: deliberately NO `export const config = { path }`.
// /admin/api/personalisation-edit-save is routed by netlify.toml.
