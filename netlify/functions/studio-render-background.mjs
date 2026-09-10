import { getStore } from '@netlify/blobs';
import { DPI, loadFonts, assertFontsPresent, rasterise } from './_shared/render.mjs';

/**
 * Render the print master for a design saved from /admin/studio.
 *
 * studio-save composes the scene, renders the listing image and creates the
 * draft product, all inside one request. The print master cannot go in there:
 * a 4800 x 7200 raster took ~20s locally and the synchronous version timed out
 * at 30s. So it happens here, where there are minutes rather than seconds --
 * the same split the customer flow uses.
 *
 * The scene arrives via the blob store rather than the request body, because
 * it carries its artwork inline and is far too big to post around. It is
 * deleted once the print exists: it was only ever a handoff, and keeping a
 * second copy of the same artwork serves no purpose.
 */

const STUDIO_STORE = 'studio';
const isId = (s) => typeof s === 'string' && /^studio-[0-9a-f]{24}$/.test(s);

export default async (req) => {
  let id = null;
  try {
    const body = await req.json().catch(() => ({}));
    id = body.id;
    const title = body.title || '(untitled)';
    if (!isId(id)) {
      console.error('studio-render: bad or missing id', JSON.stringify(body).slice(0, 200));
      return new Response('Bad id', { status: 400 });
    }

    const store = getStore(STUDIO_STORE);
    const svg = await store.get(`studio/${id}/scene.svg`, { type: 'text' });
    if (!svg) {
      console.error(`studio-render: no scene stored for ${id} — nothing to render`);
      return new Response('No scene', { status: 404 });
    }

    const meta = await store.getMetadata(`studio/${id}/scene.svg`).catch(() => null);
    const printWidth = Number(body.printWidth || meta?.metadata?.printWidth) || 0;
    if (!printWidth) {
      console.error(`studio-render: no print width for ${id}`);
      return new Response('No print width', { status: 400 });
    }

    /* Fonts are not inlined into the scene -- only images are -- so they have to
       be loaded here too, or resvg silently renders the text in something else. */
    const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
    const fonts = await loadFonts(origin);
    assertFontsPresent(svg, fonts.available);

    const print = rasterise(svg, fonts.fontFiles, printWidth);
    const printPng = print.asPng();
    fonts.cleanup();

    /* One rollback. Replacing the artwork on an existing product overwrites the
       only full-resolution copy of what the shop sells, and a redraw that turns
       out wrong is otherwise a door with no handle on the inside. A brand new
       product has no print.png yet, so this costs it nothing. */
    const previous = await store.get(`studio/${id}/print.png`, { type: 'arrayBuffer' }).catch(() => null);
    if (previous) {
      const prevMeta = await store.getMetadata(`studio/${id}/print.png`).catch(() => null);
      await store.set(`studio/${id}/print-prev.png`, previous, {
        metadata: { ...(prevMeta?.metadata || {}), kind: 'print-prev', supersededAt: new Date().toISOString() },
      });
      console.log(`studio-render: kept the previous print master as studio/${id}/print-prev.png`);
    }

    await store.set(`studio/${id}/print.png`, printPng, {
      metadata: { id, kind: 'print', title, width: print.width, height: print.height, dpi: DPI },
    });
    await store.delete(`studio/${id}/scene.svg`);

    console.log(
      `studio-render: "${title}" ${id} -> print ${print.width} x ${print.height} px ` +
      `(${printPng.length} B) @ ${DPI}dpi`
    );
    return new Response('Rendered', { status: 200 });
  } catch (err) {
    console.error(`studio-render: ${id} failed:`, err.message);
    // The draft product and its listing image already exist, so a failure here
    // costs the print master and nothing else. It can be re-run for the same id
    // as long as the scene is still in the store.
    return new Response('Failed', { status: 500 });
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// studio-save posts to /api/studio-render, which netlify.toml rewrites to this
// function by name -- the same arrangement as render-personalisation.
