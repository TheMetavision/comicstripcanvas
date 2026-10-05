import { getStore } from '@netlify/blobs';
import type { Config } from '@netlify/edge-functions';
import { checkBasicAuth, runningLocally } from '../edge-lib/basic-auth.mjs';
import { sanityQuery } from '../edge-lib/sanity-read.mjs';
import { docIdFor } from '../functions/_shared/pp-id.mjs';
import {
  RENDER_STORE, printKey, downloadAllowed, printStaleness, printDownloadName, describePrint,
} from '../functions/_shared/personalised-print.mjs';

/**
 * GET /admin/personalisation/<id>/print
 *     → the full-resolution print of a personalised build, streamed from Blobs,
 *       as <orderNumber>-<template>-<size>-<format>.png.
 *
 * WHY AN EDGE FUNCTION: the same reason as print-file-download.ts. A
 * serverless response is capped at 6 MB buffered and 20 MB streamed, and these
 * prints are 30-60 MB. The stream is handed straight to the Response.
 *
 * THREE REFUSALS, each a page a person can read rather than a bare status,
 * because the person who gets one has just clicked "Download" in the Studio:
 *
 *   not approved   409  "Available once the customer approves". Before
 *                       approval the design can still change, and a print of
 *                       it is a print of something nobody has signed off.
 *   no print yet   409  with a button to make one.
 *   stale          409  with a button to re-make it. The print was made from
 *                       an earlier version of the design than the one there
 *                       is now (_shared/personalised-print.mjs says how that is
 *                       decided), so handing it out would print the old one.
 *
 * AUTH IS CHECKED HERE as well as by admin-auth.ts, for the reason given in
 * print-file-download.ts: inline edge functions run in filename order, and
 * "admin-auth" < "personalisation-print-download" is an accident of the
 * alphabet that a rename would undo. Stays inline for the same reason.
 *
 * THE READ uses SANITY_READ_TOKEN, the Viewer token, as the photo route does --
 * the build is at a dotted id that anonymous reads cannot see, and the edge
 * holds no token that can write. Without it this answers 503 rather than
 * falling back to anything.
 */

const page = (status: number, title: string, body: string) =>
  new Response(`<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title} | Comic Strip Canvas admin</title>
<style>
  body { margin:0; background:#111; color:#F5F5F5; min-height:100vh; display:flex; align-items:center;
         justify-content:center; padding:24px; font:400 16px/1.6 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif; }
  .card { max-width:600px; background:#1A1A1A; border:4px solid #000; box-shadow:6px 6px 0 #000; padding:32px; }
  h1 { margin:0 0 12px; font-size:24px; color:#FFF200; }
  p { margin:0 0 14px; color:#ccc; }
  .btn { display:inline-block; margin-top:6px; padding:12px 26px; background:#f5a623; color:#000; font-weight:bold;
         text-decoration:none; border:4px solid #000; box-shadow:4px 4px 0 #000; text-transform:uppercase; letter-spacing:.06em; }
  a { color:#00AEEF; }
</style></head>
<body><div class="card"><h1>${title}</h1>${body}</div></body></html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

const isId = (s: string) => /^pp-[0-9a-f]{32}$/.test(s);

const BUILD_QUERY = `*[_id == $id && _type == "pendingPersonalisation"][0]{
  _id, status, recipe, sceneSvg, editedAt, editCount, templateId, outputFormat, orderNumber, printSize }`;

export default async function handler(req: Request): Promise<Response> {
  const denied = await checkBasicAuth(req, {
    user: Netlify.env.get('ADMIN_BASIC_USER') || '',
    pass: Netlify.env.get('ADMIN_BASIC_PASS') || '',
    isLocal: runningLocally(Netlify.env),
  });
  if (denied) return denied;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return page(405, 'Not allowed', '<p>This address only downloads.</p>');
  }

  // /admin/personalisation/<id>/print
  const segs = new URL(req.url).pathname.split('/').filter(Boolean);
  const id = segs[2] || '';
  if (segs.length !== 4 || segs[3] !== 'print' || !isId(id)) {
    return page(404, 'Not found', '<p>That is not a build\'s print address.</p>');
  }
  const back = `/admin/personalisation/${id}`;

  const token = Netlify.env.get('SANITY_READ_TOKEN') || '';
  if (!token) {
    console.error('personalisation-print: SANITY_READ_TOKEN is not set — cannot read the build');
    return page(503, 'Not configured', '<p>SANITY_READ_TOKEN is not set on this deploy, so the build cannot be read.</p>');
  }
  const doc = await sanityQuery(BUILD_QUERY, { id: docIdFor(id) }, { token });
  if (!doc) return page(404, 'No such build', `<p>There is no build ${esc(id)}.</p>`);

  const allowed = downloadAllowed(doc);
  if (!allowed.ok) {
    return page(409, 'Available once the customer approves', `
      <p>The print file is only handed out once the customer has approved their proof. This build is
         <strong>${esc(doc.status || 'no status')}</strong>.</p>
      <p><a href="${back}">Back to the build</a></p>`);
  }

  /* STRONG: the renderer writes this store and somebody clicks Download a
     moment later -- exactly where eventual consistency serves a missing or
     superseded file. */
  const store = getStore({ name: RENDER_STORE, consistency: 'strong' });
  const key = printKey(id);
  const meta = await store.getMetadata(key).catch(() => null);
  const rendered = (meta?.metadata || null) as Record<string, unknown> | null;
  const rerender = `<a class="btn" href="${back}?action=rerender-print">Re-render print file</a>`;

  const staleness = await printStaleness({ doc, rendered: meta ? rendered || {} : null });
  if (staleness.missing) {
    return page(409, 'No print file yet', `
      <p>No print file has been rendered for this build.</p>
      <p>${rerender}</p>`);
  }
  if (staleness.stale) {
    console.warn(`personalisation-print: refused a stale print for ${id} — ${staleness.why}`);
    return page(409, 'This print file is out of date', `
      <p>${esc(staleness.why)}</p>
      <p>Re-rendering makes a new print from the approved design. The customer's approval and the
         proof are not touched.</p>
      <p>${rerender}</p>`);
  }

  const body = await store.get(key, { type: 'stream' }).catch(() => null);
  if (!body) return page(404, 'The print file is gone', `<p>It was listed but could not be read.</p><p>${rerender}</p>`);

  const headers: Record<string, string> = {
    'Content-Type': 'image/png',
    'Content-Disposition': `attachment; filename="${printDownloadName(doc)}"`,
    /* A customer's artwork, and a file that can be superseded by a re-render:
       never cached anywhere. */
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex',
    'X-Print-Size': describePrint(rendered, doc).replace(/[^\x20-\x7e]/g, 'x'),
  };
  /* Only when the stored note carries it -- a Content-Length that disagrees
     with the body truncates or hangs the download. */
  const bytes = Number(rendered?.bytes);
  if (Number.isFinite(bytes) && bytes > 0) headers['Content-Length'] = String(bytes);

  return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers });
}

/* Inline, NOT netlify.toml -- see the note above about ordering. */
export const config: Config = { path: '/admin/personalisation/*/print' };
