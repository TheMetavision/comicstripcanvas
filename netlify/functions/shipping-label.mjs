import { shippingEnabled, shippingRequest } from './_shared/shipping-client.mjs';

/**
 * shipping-label.mjs
 * --------------------------------------------------------------------------
 * GET /admin/shipping/label/<labelId>   the label PDF, to print
 *
 * The Studio's "Print label" links and the team's "Label ready" email point
 * here. The PDF lives on the shipping service, which only hands a brand its own
 * labels and only on a signed request -- so this proxies it, signing with
 * SHIPPING_SECRET, which never reaches a browser.
 *
 * UNDER /admin ON PURPOSE, like the print files: admin-auth.ts guards /admin/*
 * with Basic Auth. A label is a customer's name and address. netlify.toml
 * rewrites the address to this function, and closes /api/shipping-label, and
 * the function refuses anything whose path did not come in under /admin/ --
 * /.netlify/functions/<name> is reachable whatever the redirects say.
 */
export async function handleLabel(req, { env = process.env, request = shippingRequest } = {}) {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const url = new URL(req.url);
  if (!/^\/admin\/shipping\/label\//.test(url.pathname)) return new Response('Not found', { status: 404 });
  if (!shippingEnabled(env)) return new Response('Shipping is not enabled', { status: 404 });

  const labelId = decodeURIComponent(url.pathname.split('/').pop() || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(labelId)) return new Response('Bad label id', { status: 400 });

  try {
    const pdf = await request(`label?labelId=${encodeURIComponent(labelId)}`, { method: 'GET', env });
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="label-${labelId}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (err) {
    const status = err?.code === 'not_found' ? 404 : 502;
    console.error(`shipping-label: ${labelId}: ${err?.code || ''} ${err?.message || err}`);
    return new Response(status === 404 ? 'No such label for this shop' : 'The shipping service did not return the label', { status });
  }
}

export default (req) => handleLabel(req);

// NOTE: no `export const config = { path }` -- see netlify.toml.
