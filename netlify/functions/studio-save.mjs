import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { DPI, printGeometry } from './_shared/scene.mjs';
import { STUDIO_STORE, uploadIdFromKey } from './_shared/studio-uploads.mjs';
import { startRender } from './_shared/studio-render-trigger.mjs';

/**
 * Turn a design built in the Studio-mode builder into a draft catalogue product.
 *
 * The shop builds a piece at /admin/studio exactly as a customer would, then
 * saves it here. This function is deliberately light: it validates the request,
 * writes the tokenised scene and its blob keys to Blobs, makes the document
 * write, and hands off.
 *
 * IT NEVER CARRIES THE ARTWORK. The request holds the scene SVG, the recipe and
 * one blob key per panel -- a few kilobytes whatever the design weighs. The
 * images went up ahead of it, in chunks, to studio-upload, because Netlify's
 * edge rejects a function request over 6 MB before the function runs and a
 * full-resolution transparent PNG cutout is 20 MB on its own. That failure is a
 * 413 with no body, which is why it used to fail saying nothing at all. Any
 * data: href in the scene is refused here with a reason.
 *
 * It rasterises NOTHING either. The print master, the listing image, the web
 * master, the rollback copy and every Sanity asset upload belong to
 * studio-render-background, which has fifteen minutes rather than ten seconds.
 * They used to happen here and a 4800 x 7200 raster alone measured ~20s, over
 * the synchronous budget in production; the split is what keeps both the create
 * and the replace path inside it.
 *
 * The product is created as an unpublished draft, so nothing appears on the
 * site until someone opens it in the Studio and publishes it.
 *
 * It also REPLACES the artwork on a product that already exists. Pass a
 * productId and it writes to that product instead of creating one, touching
 * only artworkHistory here and, through the renderer, images[_key="listing"]
 * and printFile. Title, slug, price, description,
 * SEO, category, tags and everything else are left exactly as they are -- the
 * point of the mode is that a design can be redrawn without re-entering the
 * shop's own copy.
 *
 * Edits always land on the DRAFT. A published product gets a draft created from
 * it, so the change is reviewed and published deliberately rather than going
 * live the moment somebody presses Save.
 *
 * GET with ?q= searches products by title or slug, drafts included, so the
 * builder can offer a picker. Same secret as everything else here.
 *
 * NOTE ON SANITY ASSETS: the standing rule is that customer photographs never
 * enter Sanity's asset library. That is not what the renderer uploads. The
 * listing and web images are rendered catalogue artwork for a product the shop
 * is selling, which is precisely what the asset library is for. Studio sources
 * are the shop's own prepared artwork, not a customer's photograph, and they go
 * no further than the blob store -- where retention sweeps them after a day.
 */

const STUDIO_HOST = 'https://comicstripcanvas.sanity.studio';

/** Which catalogue a template belongs in. */
const CATEGORY = {
  'cover': 'comic-book-covers',
  'cover-fullbleed': 'comic-book-covers',
  'icon-portrait': 'comic-book-icons',
  'icon-landscape': 'comic-book-icons',
  'strip': 'comic-book-strips',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const newId = () => {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'studio-' + [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
};

const slugify = (s) =>
  s.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'untitled-design';

let sanityClient;
function getSanity() {
  if (sanityClient) return sanityClient;
  if (!process.env.SANITY_WRITE_TOKEN) return null;
  sanityClient = createClient({
    projectId: 'lwbwahym',
    dataset: 'production',
    apiVersion: '2026-04-11',
    token: process.env.SANITY_WRITE_TOKEN,
    useCdn: false,
  });
  return sanityClient;
}

const HISTORY_LIMIT = 5;

export default async (req) => {
  const expected = process.env.PERSONALISATION_ACTION_SECRET;
  if (!expected) {
    console.error('studio-save: PERSONALISATION_ACTION_SECRET is not set — refusing.');
    return json({ error: 'Saving is not configured on this deploy' }, 503);
  }
  if (!sameSecret(req.headers.get('x-csc-action-secret'), expected)) {
    console.warn('studio-save: rejected a call with a bad or missing secret');
    return json({ error: 'Not authorised' }, 401);
  }

  const sanity = getSanity();
  if (!sanity) return json({ error: 'SANITY_WRITE_TOKEN is not set on this deploy' }, 503);

  /* The picker's search. Drafts are included deliberately: a design being
     redrawn is very often one that has never been published, and leaving those
     out would hide exactly the products this mode is for. */
  if (req.method === 'GET') {
    const q = (new URL(req.url).searchParams.get('q') || '').trim();
    if (q.length < 2) return json({ products: [] });
    /* hasListing says whether a render would slot into an entry of its own or
       REPLACE this product's current image. A product with no "listing" entry
       is one of the hand-curated catalogue ones: its images[0] is a picture
       somebody chose, and the render takes that slot. The picker warns before
       the button is pressed rather than after.

       Keep explanations OUT of the query string: GROQ has no block comment, and
       putting one in a projection fails with a parse error that points at the
       projection rather than at the comment. */
    const products = await sanity.fetch(
      `*[_type == "product" && (title match $m || slug.current match $m)]
         | order(_updatedAt desc)[0...12]{
           _id, title, "slug": slug.current,
           "draft": _id in path("drafts.**"),
           "image": images[0].asset->url, "updatedAt": _updatedAt,
           "hasListing": count(images[_key == "listing"]) > 0
         }`,
      { m: `*${q}*` }
    );
    return json({ products });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!(req.headers.get('content-type') || '').includes('multipart/form-data')) {
    return json({ error: 'Content-Type must be multipart/form-data' }, 400);
  }

  let form;
  try { form = await req.formData(); } catch { return json({ error: 'Could not read the upload' }, 400); }

  /* Replacing? Then the product owns its title and this must not overwrite it.
     Creating? Then a title is the one thing we cannot invent. */
  const productId = (form.get('productId') || '').toString().trim();
  const replacing = !!productId;
  const title = (form.get('title') || '').toString().trim();
  if (!replacing && !title) return json({ error: 'A product title is required' }, 400);
  if (replacing && !/^(drafts\.)?[A-Za-z0-9._-]{1,120}$/.test(productId)) {
    return json({ error: 'That product id is not well formed' }, 400);
  }

  const sceneSvg = (form.get('sceneSvg') || '').toString();
  let recipe;
  try { recipe = JSON.parse((form.get('recipe') || '').toString()); }
  catch { return json({ error: 'Recipe is not valid JSON' }, 400); }
  if (!recipe || !recipe.template) return json({ error: 'Recipe is missing its template' }, 400);

  const category = CATEGORY[recipe.template];
  // Only creating needs one. Replacing must not move a product between
  // catalogues just because the template it was redrawn from suggests another.
  if (!replacing && !category) {
    return json({ error: `No catalogue category for template "${recipe.template}"` }, 400);
  }

  /* The artwork is NOT in this request. It went up ahead of it, in chunks, to
     studio-upload -- a full-resolution transparent PNG is 20 MB and Netlify's
     edge rejects a function request over 6 MB before the function ever runs.
     What arrives here is a blob key per panel, a few dozen bytes each. */
  const uploads = new Map();
  for (const [field, value] of form.entries()) {
    if (!field.startsWith('upload:') || typeof value !== 'string') continue;
    const panelId = field.slice('upload:'.length);
    const key = value.trim();
    if (!uploadIdFromKey(key)) {
      return json({ error: `The upload key for panel ${panelId} is not one of ours` }, 400);
    }
    uploads.set(panelId, key);
  }
  if (!uploads.size) return json({ error: 'No artwork was supplied' }, 400);

  /* Inlined artwork is what this endpoint exists to stop. The builder tokenises
     every image it exports, so a data: href means something upstream regressed
     -- and the failure it causes is a 413 from the platform with no body, which
     tells whoever hits it nothing at all. Refuse it here, where there is room
     to say why. */
  if (/href\s*=\s*["']?\s*data:/i.test(sceneSvg)) {
    return json({
      error: 'The scene has an image inlined as data: — artwork must be uploaded to ' +
        '/api/studio-upload first and referenced by its {{IMAGE:...}} token.',
    }, 400);
  }

  /* Every token needs an upload and every upload needs a token. A missing key
     would fail in the renderer, minutes later, with nobody watching. */
  const tokens = [...new Set([...sceneSvg.matchAll(/\{\{IMAGE:([^}]+)\}\}/g)].map((m) => m[1]))];
  if (!tokens.length) return json({ error: 'The scene has no {{IMAGE:...}} token to fill' }, 400);
  const unfilled = tokens.filter((t) => !uploads.has(t));
  if (unfilled.length) {
    return json({ error: `No artwork was uploaded for panel${unfilled.length > 1 ? 's' : ''} ${unfilled.join(', ')}` }, 400);
  }

  /* And the placeholder check, which the renderer repeats. Doing it here too is
     the difference between the shop being told now and finding out from a print
     file with the example graphic in it. */
  const stillExample = (recipe.panels || []).filter((p) => p && p.placeholder).map((p) => p.id);
  if (stillExample.length) {
    return json({ error: `Panel${stillExample.length > 1 ? 's' : ''} ${stillExample.join(', ')} ` +
      'still hold the example graphic, not real artwork' }, 400);
  }

  /* Where the artwork is going. Blobs are keyed on the PUBLISHED id so they
     stay put when a draft is published, and the document write always targets
     the draft. */
  let target = null;
  if (replacing) {
    const base = productId.replace(/^drafts\./, '');
    const [published, draft] = await Promise.all([
      sanity.getDocument(base).catch(() => null),
      sanity.getDocument(`drafts.${base}`).catch(() => null),
    ]);
    const existing = draft || published;
    if (!existing) return json({ error: `No product with id ${base}` }, 404);
    if (existing._type !== 'product') return json({ error: `${base} is not a product` }, 400);
    target = {
      base,
      docId: `drafts.${base}`,
      doc: existing,
      /* A published product with no draft yet needs one made from it, or the
         patch would land on a document that does not exist. */
      needsDraftFrom: !draft && published ? published : null,
      wasPublished: !!published,
    };
  }

  const id = replacing ? target.base : newId();
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
  const { printWidth } = printGeometry(recipe);
  if (!printWidth) return json({ error: 'The recipe does not say how big the print is' }, 400);

  try {
    const name = replacing ? (target.doc.title || 'artwork') : title;
    const store = getStore(STUDIO_STORE);

    /* Every upload must actually be in the store before a document is written
       against it. Checking metadata is a cheap read and turns "the renderer
       failed two minutes later" into "that upload did not finish, try again". */
    const absent = [];
    await Promise.all([...uploads].map(async ([panelId, key]) => {
      const meta = await store.getMetadata(key).catch(() => null);
      if (!meta) absent.push(panelId);
    }));
    if (absent.length) {
      return json({
        error: `The artwork for panel${absent.length > 1 ? 's' : ''} ${absent.sort().join(', ')} ` +
          'is not in the store — the upload did not finish. Drop the image again.',
      }, 409);
    }

    /* Whatever printFile pointed at BEFORE this redraw, recorded now while it is
       still true. The renderer is about to overwrite it, and this reference is
       the only way back to the file the shop was fulfilling from. */
    const prevPrintFile = replacing ? (target.doc.printFile?.asset?._ref || null) : null;

    const entry = {
      _type: 'artworkChange', _key: `h-${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      sceneId: id,
      by: (form.get('by') || '').toString().trim().slice(0, 60) || 'studio',
      template: recipe.template,
      prevPrintFileAssetId: prevPrintFile,
    };

    let docId, wrote;
    if (replacing) {
      /* A published product with no draft yet needs the draft created from it
         first, or the patch has nothing to land on. createIfNotExists loses a
         race to whoever gets there first, which is the right way to lose it. */
      if (target.needsDraftFrom) {
        const { _rev, ...body } = target.needsDraftFrom;
        await sanity.createIfNotExists({ ...body, _id: target.docId });
      }
      docId = target.docId;
      const current = await sanity.getDocument(docId);
      const history = [entry, ...(Array.isArray(current?.artworkHistory) ? current.artworkHistory : [])]
        .slice(0, HISTORY_LIMIT);
      /* ONLY the history. The pictures are the renderer's to write, and the
         shop's own words -- title, slug, price, description, SEO, tags,
         category, variants -- are nobody's to rewrite here. */
      await sanity.patch(docId).set({ artworkHistory: history }).commit();
      wrote = target.needsDraftFrom ? 'created a draft from the published product'
        : (target.wasPublished ? 'updated the existing draft of a published product'
          : 'updated the draft (never published)');
    } else {
      // A `drafts.` id is what "draft" means in Sanity: the document exists and
      // is editable in the Studio, but nothing reaches the site until someone
      // presses Publish.
      docId = `drafts.${id}`;
      await sanity.create({
        _id: docId,
        _type: 'product',
        title,
        slug: { _type: 'slug', current: slugify(title) },
        category,
        isPersonalised: false,
        images: [],
        artworkHistory: [entry],
      });
      wrote = 'created a new draft product';
    }

    /* The handoff is the TOKENISED scene plus the keys to fill it with, not a
       composed document. Composing means base64-ing every photograph into the
       SVG, which for one 20 MB cutout is a 28 MB string this function would
       hold in memory and write to the store -- to be read straight back out
       again by the renderer. So the renderer composes instead, from the same
       {{IMAGE:...}} tokens the customer pipeline already resolves.
       Everything visual -- the print master, the listing, the web master, the
       Sanity uploads -- happens there, where there are minutes rather than
       seconds. This function rasterises nothing.

       Written AFTER the document, and carrying docId: the scene is what makes a
       render re-runnable, and a re-run has to know where to attach the pictures.
       Writing it first meant that a failed document write left a scene nothing
       sweeps, pinning its uploads in the store for ever. */
    await store.set(`studio/${id}/scene.json`, JSON.stringify({
      id, docId, replacing, title: name, svg: sceneSvg, recipe,
      images: Object.fromEntries(uploads),
      printWidth, dpi: DPI,
      savedAt: new Date().toISOString(),
    }), {
      metadata: { id, docId, kind: 'scene', title: name, printWidth, dpi: DPI },
    });

    /* Start the renderer, and WAIT for the platform to accept the job.
       This await is the whole point. It used to be fire-and-forget, and in
       production that means the job is never started at all: a function's
       execution environment is frozen the instant it returns its response, so
       an outbound request that has not completed is suspended mid-flight and
       never resumes. Locally it worked, because `netlify dev` is one long-lived
       process that is never frozen -- which is exactly how this reached
       production. Every other trigger in this codebase awaits (personalise-save
       and personalisation-style to /api/style-photo, webhook and
       personalisation-action to /api/render-personalisation); this one is now
       the same shape as those.

       It costs almost nothing: a background function answers 202 as soon as the
       platform has taken the job, not when the render finishes. */
    const trigger = await startRender({ origin, id, docId, title: name, printWidth, replacing });

    console.log(
      `studio-save: ${replacing ? 'replacing artwork on' : 'created'} ${docId} ("${name}") — ${wrote}; ` +
      `scene stored, print ${printWidth}px; render trigger POST ${trigger.url} -> ` +
      (trigger.ok ? `${trigger.status}` : `FAILED (${trigger.status || trigger.error})`)
    );

    const body = {
      mode: replacing ? 'replace' : 'create',
      id, docId, wrote, title: name,
      category: replacing ? undefined : category,
      studioUrl: `${STUDIO_HOST}/intent/edit/id=${replacing ? target.base : id};type=product/`,
      trigger: { url: trigger.url, status: trigger.status || null },
    };

    /* A save whose renderer never started is NOT a success, however much of it
       worked -- the product would sit there with no images and no printFile and
       nothing to say why. The draft and the scene both survive, so name the
       repair rather than just the failure. */
    if (!trigger.ok) {
      console.error(`studio-save: ${docId} saved but the render did not start — repair with POST /api/studio-render/${id}`);
      return json({
        ...body,
        ok: false,
        error: `The draft was saved but the renderer would not start (${trigger.status ? `HTTP ${trigger.status}` : trigger.error}). ` +
          `Nothing is lost — POST /api/studio-render/${id} with the studio secret to run it again.`,
        repair: `/api/studio-render/${id}`,
      }, 502);
    }

    return json({
      ...body,
      ok: true,
      artwork: { status: 'rendering' },
      print: { width: printWidth, status: 'rendering' },
      rollback: `studio/${id}/print-prev.png`,
    });
  } catch (err) {
    console.error('studio-save: failed:', err.message);
    return json({ error: err.message }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/studio-save is routed by the forced /api/* redirect in netlify.toml,
// like every other function in this directory.
