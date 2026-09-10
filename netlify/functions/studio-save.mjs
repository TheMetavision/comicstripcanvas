import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { DPI, dataUri, prepareScene } from './_shared/render.mjs';

/**
 * Turn a design built in the Studio-mode builder into a draft catalogue product.
 *
 * The shop builds a piece at /admin/studio exactly as a customer would, then
 * saves it here. This function is deliberately light: it validates the request,
 * composes the scene through the same code path as a paid customer build (see
 * _shared/render.mjs), writes that one composed SVG to Blobs, makes the document
 * write, and hands off.
 *
 * It rasterises NOTHING. The print master, the listing image, the web master,
 * the rollback copy and every Sanity asset upload belong to
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
 * only artworkHistory here and, through the renderer, images[_key="listing"],
 * images[_key="web-master"] and printFile. Title, slug, price, description,
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
 * is selling, which is precisely what the asset library is for. The source
 * photographs stay in the browser in studio mode and are not persisted anywhere.
 */

const STUDIO_STORE = 'studio';
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
    const products = await sanity.fetch(
      `*[_type == "product" && (title match $m || slug.current match $m)]
         | order(_updatedAt desc)[0...12]{
           _id, title, "slug": slug.current,
           "draft": _id in path("drafts.**"),
           "image": images[0].asset->url, "updatedAt": _updatedAt
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

  // The photos arrive with the request and are never written anywhere: they are
  // read into the scene and dropped when this handler returns.
  const images = new Map();
  for (const [field, value] of form.entries()) {
    if (!field.startsWith('image:') || typeof value === 'string') continue;
    const panelId = field.slice('image:'.length);
    const buf = Buffer.from(await value.arrayBuffer());
    images.set(panelId, dataUri(buf, value.name || 'photo.jpg'));
  }
  if (!images.size) return json({ error: 'No images were supplied' }, 400);

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

  let scene;
  try {
    scene = await prepareScene({
      sceneSvg,
      recipe,
      origin,
      imageFor: async (panelId) => images.get(panelId),
    });
  } catch (err) {
    console.error('studio-save: could not prepare the scene:', err.message);
    return json({ error: err.message }, 400);
  }

  try {
    const name = replacing ? (target.doc.title || 'artwork') : title;
    const store = getStore(STUDIO_STORE);

    /* The composed scene, with its artwork already inlined, is the whole handoff.
       Everything that turns it into pictures -- the print master, the listing,
       the web master, and every Sanity asset upload -- happens in
       studio-render-background, which has minutes rather than seconds. This
       function does not rasterise anything. */
    await store.set(`studio/${id}/scene.svg`, scene.svg, {
      metadata: { id, kind: 'scene', title: name, printWidth: scene.printWidth, dpi: DPI },
    });

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

    scene.cleanup();

    /* The renderer does the rest, and is told which document to attach the
       pictures to -- it cannot work that out from the blob id alone once a
       product can be redrawn. */
    const printWidth = scene.printWidth;
    fetch(`${origin}/api/studio-render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, docId, title: name, printWidth, replacing }),
    }).catch((err) => console.error(`studio-save: could not start the render for ${id}:`, err.message));

    console.log(
      `studio-save: ${replacing ? 'replacing artwork on' : 'created'} ${docId} ("${name}") — ${wrote}; ` +
      `scene stored, print ${printWidth}px and artwork queued`
    );

    return json({
      ok: true,
      mode: replacing ? 'replace' : 'create',
      id, docId, wrote, title: name,
      category: replacing ? undefined : category,
      studioUrl: `${STUDIO_HOST}/intent/edit/id=${replacing ? target.base : id};type=product/`,
      artwork: { status: 'rendering' },
      print: { width: printWidth, status: 'rendering' },
      rollback: `studio/${id}/print-prev.png`,
    });
  } catch (err) {
    scene.cleanup();
    console.error('studio-save: failed:', err.message);
    return json({ error: err.message }, 500);
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/studio-save is routed by the forced /api/* redirect in netlify.toml,
// like every other function in this directory.
