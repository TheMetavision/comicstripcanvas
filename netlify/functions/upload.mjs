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

  try {
    // The wizard posts multipart/form-data with a single field named "file".
    const formData = await req.formData();
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

export const config = {
  path: '/api/upload',
};
