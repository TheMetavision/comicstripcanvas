import { createClient } from '@sanity/client';

const sanity = createClient({
  projectId: 'lwbwahym',
  dataset: 'production',
  apiVersion: '2026-04-11',
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // A wrong or missing Content-Type makes req.formData() throw, which the
  // catch below would report as a 500 — but that's a malformed request, not a
  // server fault. Check up front and reject with 400. The two types accepted
  // here are the ones req.formData() itself supports.
  const contentType = req.headers.get('content-type') || '';
  const isFormEncoded =
    contentType.includes('multipart/form-data') ||
    contentType.includes('application/x-www-form-urlencoded');

  if (!isFormEncoded) {
    return new Response(
      JSON.stringify({
        error: 'Content-Type must be multipart/form-data or application/x-www-form-urlencoded',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // The wizard posts multipart/form-data with a single field named "file".
    // A declared-but-malformed body still throws, so that's a 400 too.
    let formData;
    try {
      formData = await req.formData();
    } catch {
      return new Response(JSON.stringify({ error: 'Malformed form data' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Netlify Functions 2.0 exposes the standard Request API, so the file is a
    // Blob. Convert it to a Buffer for @sanity/client's assets.upload().
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const asset = await sanity.assets.upload('image', buffer, {
      filename: file.name || 'upload.jpg',
      contentType: file.type || 'image/jpeg',
    });

    // The wizard reads `url` and pushes it into photoUrls[], which
    // personalise.mjs then stores on the pendingPersonalisation doc.
    return new Response(
      JSON.stringify({ url: asset.url, assetId: asset._id }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Upload error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to upload file' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// NOTE: deliberately NO `export const config = { path }` here.
// This site routes /api/* via the forced redirect in netlify.toml
// (/api/* -> /.netlify/functions/:splat). An inline config.path collides
// with that forced rewrite and causes a 404, so we rely on the redirect,
// exactly like the working contact function does.
