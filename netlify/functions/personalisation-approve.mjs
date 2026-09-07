import { createClient } from '@sanity/client';

/**
 * The customer's Approve link: GET /api/personalisation-approve?id=<id>&t=<token>
 *
 * The token is a one-shot capability minted when the proof email is sent. A
 * valid hit moves the build into production and clears the token, so the link
 * cannot be replayed — a second click, or anyone else's copy of the email, gets
 * the expired page.
 *
 * Nothing here reveals the print file, the photos, or anything about the order.
 * Both outcomes are plain pages: a customer clicking a link in an email should
 * not need JavaScript or a login.
 */

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const isId = (s) => typeof s === 'string' && /^pp-[0-9a-f]{32}$/.test(s);
const isToken = (s) => typeof s === 'string' && /^[0-9a-f]{48}$/.test(s);

const page = (status, title, body) =>
  new Response(
    `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} | Comic Strip Canvas</title>
<style>
  body { margin:0; background:#111; color:#F5F5F5; min-height:100vh; display:flex;
         align-items:center; justify-content:center; padding:24px;
         font:400 16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; }
  .card { max-width:520px; background:#1A1A1A; border:4px solid #000; box-shadow:6px 6px 0 #000;
          padding:32px; text-align:center; }
  h1 { margin:0 0 12px; font-size:26px; color:#FFF200; letter-spacing:.02em; }
  p { margin:0 0 12px; color:#ccc; }
  a { color:#EC008C; }
</style>
</head>
<body><div class="card"><h1>${title}</h1>${body}</div></body>
</html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
    }
  );

const expired = () =>
  page(410, 'This link has expired',
    `<p>This approval link has already been used, or it is no longer valid.</p>
     <p>If you still need to approve or change your artwork, just reply to the email
        we sent you and we&rsquo;ll sort it out.</p>
     <p><a href="https://comicstripcanvas.co.uk">comicstripcanvas.co.uk</a></p>`);

export default async (req, context) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return page(405, 'This link has expired', '<p>Nothing to see here.</p>');
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const token = searchParams.get('t');

  // Malformed input is answered exactly like a spent token, so the endpoint
  // cannot be used to work out which ids or tokens exist.
  if (!isId(id) || !isToken(token)) {
    console.log('personalisation-approve: refusing a malformed link');
    return expired();
  }

  try {
    const doc = await sanity.getDocument(id);
    if (!doc || !doc.approveToken) return expired();

    // Length-checked above, so a plain compare is fine here.
    if (doc.approveToken !== token) {
      console.log(`personalisation-approve: wrong token for ${id}`);
      return expired();
    }
    if (doc.status !== 'approved') {
      // Already moved on, or pulled back by the shop after the email went out.
      console.log(`personalisation-approve: ${id} is "${doc.status}", not awaiting approval`);
      return expired();
    }

    // Spend the token in the same patch that advances the status, so a double
    // click cannot produce two transitions.
    await sanity
      .patch(id)
      .set({ status: 'in_production', customerApprovedAt: new Date().toISOString() })
      .unset(['approveToken'])
      .commit();

    console.log(`personalisation-approve: ${id} approved by the customer — in production`);
    return page(200, 'Thank you — that&rsquo;s approved',
      `<p>Your artwork is approved and going into production.</p>
       <p>We&rsquo;ll email you again when it&rsquo;s on its way.</p>
       <p><a href="https://comicstripcanvas.co.uk">comicstripcanvas.co.uk</a></p>`);
  } catch (err) {
    console.error('personalisation-approve: failed:', err.message);
    return page(500, 'Something went wrong',
      `<p>We couldn&rsquo;t record your approval just then. Please reply to your
          email and we&rsquo;ll do it by hand.</p>`);
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// /api/personalisation-approve is routed by the forced /api/* redirect in
// netlify.toml (/api/* -> /.netlify/functions/:splat), like every other function.
