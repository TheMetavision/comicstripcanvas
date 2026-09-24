import { createClient } from '@sanity/client';
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { prepareScene, rasterise, memoryNote } from './_shared/render.mjs';
import { STUDIO_STORE } from './_shared/studio-uploads.mjs';
import { sceneKey, legacySceneKey, artKey, styleOr, FULL_BLEED } from './_shared/artwork-styles.mjs';
import { faceFor, renderFromScene, fitFlatMaster, readDpi } from './_shared/print-file.mjs';
import { dataUri } from './_shared/scene.mjs';
import {
  PRINT_STORE, keysFromLine, printKeyFor, sourceId, downloadName,
  sceneIdFor, orientationFor,
} from './_shared/order-print.mjs';

/**
 * The print file for one order line, made at the size and finish it was sold at.
 *
 * A background function for the reason every renderer here is one: the largest
 * job is a 6300 x 8700 raster and it measures 20-26 s with a peak around 900 MB.
 * A synchronous function has ten seconds. The memory is declared BELOW, in this
 * file, because the netlify.toml key does not reach the platform -- see the
 * long note in netlify.toml, which cost a silently killed render to write.
 *
 * Idempotent and cached. The key carries the size, the finish, the style and an
 * id for the artwork it was made from, so a second click is a blob read and
 * replacing a product's artwork produces a different key rather than serving
 * the old picture for ever. Nothing here writes to Sanity: an order is a record
 * of what was bought and this is a thing made from it.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  useCdn: false,
  ...(process.env.SANITY_WRITE_TOKEN ? { token: process.env.SANITY_WRITE_TOKEN } : {}),
});

const PRODUCT_FIELDS = `{
  _id, title, "slug": slug.current, edgeColour,
  classicSceneId, "fbSceneId": fullBleed.sceneId,
  "printUrl": printFile.asset->url, "printAssetId": printFile.asset->_id,
  "fullBleedPrintUrl": fullBleed.printFile.asset->url,
  "fullBleedAssetId": fullBleed.printFile.asset->_id,
  "aspect": images[0].asset->metadata.dimensions.aspectRatio,
  "fbAspect": fullBleed.listingImage.asset->metadata.dimensions.aspectRatio
}`;

/** Progress, readable by the status route while this is still going. */
const mark = async (store, key, state, extra = {}) => {
  try {
    await store.setJSON(`${key}.state`, { state, at: new Date().toISOString(), ...extra });
  } catch { /* the render matters more than the note about it */ }
};

/**
 * Only order-print-file.mjs starts this, and that one is behind /admin.
 *
 * Checked here too because a function is permanently addressable at
 * /.netlify/functions/<name>, which no redirect and no edge function covers --
 * so the guard on the caller is not a guard on this. The same shared secret the
 * Studio actions use; the same reasoning as there about what it is worth, which
 * is a speed bump against drive-by traffic rather than real authentication.
 *
 * Unset is a fault everywhere but a developer's machine: refusing outright is
 * how a missing variable gets noticed, and passing everything through is how
 * an open endpoint ships. Mirrors admin-auth.ts.
 */
function refuseUnauthorised(req) {
  const expected = process.env.PERSONALISATION_ACTION_SECRET || '';
  const isLocal = process.env.NETLIFY_DEV === 'true' || process.env.CONTEXT === 'dev';
  if (!expected) {
    if (isLocal) return null;
    console.error('order-print-file: PERSONALISATION_ACTION_SECRET is not set — refusing.');
    return new Response('not configured', { status: 503 });
  }
  const given = req.headers.get('x-csc-action-secret') || '';
  /* Length-independent compare, as the Studio actions do. */
  if (given.length !== expected.length) return new Response('Not found', { status: 404 });
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? null : new Response('Not found', { status: 404 });
}

export default async (req) => {
  const refused = refuseUnauthorised(req);
  if (refused) return refused;

  let job = {};
  try {
    job = await req.json().catch(() => ({}));
    const { orderId, lineKey } = job;
    console.log(`order-print-file: invoked for ${orderId || '(no order)'} / `
      + `${lineKey || '(no line)'} — ${memoryNote()}`);
    if (!orderId || !lineKey) return new Response('Bad job', { status: 400 });

    const prints = getStore(PRINT_STORE);

    const order = await sanity.fetch(
      `*[_type == "order" && _id == $id][0]{ _id, orderNumber, lineItems }`,
      { id: orderId }
    );
    if (!order) return new Response('No such order', { status: 404 });
    const line = (order.lineItems || []).find((l) => l._key === lineKey);
    if (!line) return new Response('No such line', { status: 404 });

    const { sizeKey, finish, style } = keysFromLine(line);
    if (!sizeKey || !finish) {
      const why = `this line records no usable size/finish ("${line.size}" / "${line.format}")`;
      console.error(`order-print-file: ${why}`);
      await mark(prints, `pending/${orderId}/${lineKey}`, 'error', { error: why });
      return new Response(why, { status: 422 });
    }
    if (line.buildKind) {
      const why = 'a built line is printed from its own approved render, not from a stock design';
      await mark(prints, `pending/${orderId}/${lineKey}`, 'error', { error: why });
      return new Response(why, { status: 422 });
    }

    const found = await findProduct(line, lineKey);
    if (found.error) {
      console.error(`order-print-file: ${found.error}`);
      await mark(prints, `pending/${orderId}/${lineKey}`, 'error', { error: found.error });
      return new Response(found.error, { status: 409 });
    }
    const product = found.product;
    if (!product) {
      const why = `no product for "${line.productTitle}"`;
      await mark(prints, `pending/${orderId}/${lineKey}`, 'error', { error: why });
      return new Response(why, { status: 404 });
    }

    const orientation = orientationFor(product, style);
    const face = faceFor(sizeKey, orientation);
    const studio = getStore(STUDIO_STORE);

    /* ---- which route, and what the file is made from ---- */
    const sid = sceneIdFor(
      { classicSceneId: product.classicSceneId, fullBleed: { sceneId: product.fbSceneId } },
      style
    );
    let sceneJson = null, sceneRev = null;
    if (sid) {
      const raw = await studio.get(sceneKey(sid, style))
        || await studio.get(legacySceneKey(sid));
      if (raw) {
        sceneJson = JSON.parse(raw);
        /* The scene's own bytes are the revision. A blob etag would do, but the
           bytes are already here and a hash of them cannot disagree with them. */
        sceneRev = createHash('sha256').update(raw).digest('hex').slice(0, 16);
      }
    }
    const masterUrl = styleOr(style) === FULL_BLEED ? product.fullBleedPrintUrl : product.printUrl;
    const masterId = styleOr(style) === FULL_BLEED ? product.fullBleedAssetId : product.printAssetId;
    const source = sourceId({ sceneRev, masterAssetId: masterId });

    const key = printKeyFor({ orderId, lineKey, sizeKey, finish, style, source });
    const already = await prints.getMetadata(key).catch(() => null);
    if (already) {
      console.log(`order-print-file: already made — ${key}`);
      await mark(prints, `pending/${orderId}/${lineKey}`, 'ready', { key });
      return new Response('Already made', { status: 200 });
    }

    await mark(prints, `pending/${orderId}/${lineKey}`, 'working', { key, sizeKey, finish });

    /* ---- make it ---- */
    const started = Date.now();
    let png, width, height, route;

    if (sceneJson) {
      route = 'scene';
      const origin = process.env.DEPLOY_PRIME_URL || process.env.URL || 'http://localhost:8888';
      const out = await renderFromScene({
        sceneSvg: sceneJson.svg || sceneJson.sceneSvg,
        recipe: sceneJson.recipe || sceneJson,
        template: (sceneJson.recipe || sceneJson).template,
        face,
        finish,
        prepare: prepareScene,
        rasterise,
        origin,
        imageFor: async (panelId) => {
          const buf = await studio.get(artKey(sid, style, panelId), { type: 'arrayBuffer' })
            || await studio.get(artKey(sid, style, panelId, 'jpg'), { type: 'arrayBuffer' });
          if (!buf) throw new Error(`no artwork in the store for panel ${panelId}`);
          return dataUri(Buffer.from(buf), `${panelId}.png`);
        },
      });
      ({ png, width, height } = out);
    } else if (masterUrl) {
      route = 'master';
      const res = await fetch(masterUrl);
      if (!res.ok) throw new Error(`the stored master would not download (${res.status})`);
      const master = Buffer.from(await res.arrayBuffer());
      const out = await fitFlatMaster({
        master,
        face,
        wrapInches: finish === 'standard' ? 1.5 : finish === 'gallery' ? 2.5 : 0,
        edgeColour: product.edgeColour || null,
        wrapMode: 'mirror',
      });
      ({ png, width, height } = out);
      if (out.padded) {
        /* Should never fire now every size is 3:2 and every master 2:3 or 3:2.
           If it does, a master is not the shape the shop sells and somebody
           wants to know before it is printed. */
        console.warn(`order-print-file: PADDED "${product.slug}" — master aspect `
          + `${out.masterAspect.toFixed(4)} against face ${out.faceAspect.toFixed(4)}`);
      }
    } else {
      const why = 'this product has neither a saved design nor a print master';
      console.error(`order-print-file: ${why} (${product.slug})`);
      await mark(prints, `pending/${orderId}/${lineKey}`, 'error', { error: why });
      return new Response(why, { status: 409 });
    }

    await prints.set(key, png, {
      metadata: {
        orderId, lineKey, sizeKey, finish, style, route, source,
        width, height, dpi: readDpi(png) || 300,
        filename: downloadName({
          orderNumber: order.orderNumber, productTitle: line.productTitle,
          sizeKey, finish, style, orientation,
        }),
        madeAt: new Date().toISOString(),
      },
    });
    await mark(prints, `pending/${orderId}/${lineKey}`, 'ready', { key });

    console.log(`order-print-file: ${order.orderNumber} "${line.productTitle}" `
      + `[${route}] ${sizeKey}/${finish} -> ${width}x${height} `
      + `(${Math.round(png.length / 1048576)} MB) in ${Date.now() - started}ms — ${memoryNote()}`);
    return new Response('Made', { status: 200 });
  } catch (err) {
    console.error('order-print-file: failed —', err?.stack || err?.message || err);
    try {
      await mark(getStore(PRINT_STORE), `pending/${job.orderId}/${job.lineKey}`, 'error',
        { error: err?.message || String(err) });
    } catch { /* nothing left to do */ }
    return new Response('Failed', { status: 500 });
  }
};

/**
 * Which product this line is for.
 *
 * Lines written from now on carry productSlug and this is one read. Older ones
 * do not, and the two obvious fallbacks are both traps:
 *
 *   slugifying the title  "Bob Marley" gives bob-marley, and the line was for
 *                         bob-marley-icon.
 *   matching the title    THREE published products are called "Bob Marley" --
 *                         bob-marley-cover, bob-marley-icon and bob-marley.
 *                         Picking the first would print a different picture
 *                         from the one that was bought, and it would look
 *                         entirely plausible doing it.
 *
 * So the line's own _key is tried first, which the webhook built as
 * <slug>-<style>-<format>-<size>-<index> (and, before styles existed, without
 * the style). Every suffix is stripped in turn and each candidate looked up.
 * If that finds nothing, the title is matched -- and an ambiguous title REFUSES
 * rather than choosing. A missing print file is a nuisance; the wrong one
 * reaches a customer's wall.
 */
async function findProduct(line, lineKey) {
  const bySlug = (slug) => sanity.fetch(
    `*[_type == "product" && slug.current == $slug][0]${PRODUCT_FIELDS}`, { slug });

  if (line.productSlug || line.slug) {
    const p = await bySlug(line.productSlug || line.slug);
    if (p) return { product: p };
    return { error: `no product with slug "${line.productSlug || line.slug}"` };
  }

  const parts = String(lineKey || '').split('-');
  for (let take = parts.length - 1; take >= 1; take--) {
    const candidate = parts.slice(0, take).join('-');
    if (!candidate) continue;
    const p = await bySlug(candidate);
    if (p) return { product: p };
  }

  const sameTitle = await sanity.fetch(
    `*[_type == "product" && title == $title]{ "slug": slug.current }`,
    { title: line.productTitle }
  );
  if (sameTitle.length === 1) {
    const p = await bySlug(sameTitle[0].slug);
    if (p) return { product: p };
  }
  if (sameTitle.length > 1) {
    return {
      error: `"${line.productTitle}" matches ${sameTitle.length} products `
        + `(${sameTitle.map((s) => s.slug).join(', ')}) and this line does not say which. `
        + 'Refusing to guess — print from the product itself.',
    };
  }
  return { error: `no product for "${line.productTitle}"` };
}

// Declared HERE, not in netlify.toml: the memory key in that file is not
// applied by the bundler, which is how a studio render was killed mid-rasterise
// with an empty log. The largest job here measured 6300x8700 px at ~900 MB peak.
export const config = { memory: '3gb' };
