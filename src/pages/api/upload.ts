export const prerender = false;

import type { APIRoute } from 'astro';
import { getSecret } from 'astro:env/server';
import { createClient } from '@sanity/client';

const getSanityClient = () => {
  const token = getSecret('SANITY_WRITE_TOKEN');
  if (!token) throw new Error('SANITY_WRITE_TOKEN is not configured');

  return createClient({
    projectId: 'lwbwahym',
    dataset: 'production',
    token,
    apiVersion: '2024-01-01',
    useCdn: false,
  });
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ error: 'Content-Type must be multipart/form-data' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file || !(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: 'No file provided' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return new Response(
        JSON.stringify({ error: 'Invalid file type. Allowed: JPG, PNG, WEBP' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({ error: 'File too large. Maximum size is 10MB' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const client = getSanityClient();

    // Convert File to Buffer for Sanity upload
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const asset = await client.assets.upload('image', buffer, {
      filename: file.name,
      contentType: file.type,
    });

    return new Response(
      JSON.stringify({
        url: asset.url,
        assetId: asset._id,
        filename: file.name,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Upload error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to upload file' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
};
