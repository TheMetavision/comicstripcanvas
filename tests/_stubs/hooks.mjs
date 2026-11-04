/**
 * Module resolution for tests/_email-samples.mjs: every client an email path
 * touches is an in-memory stub, so rendering an email can never send one.
 * Resend, Netlify Blobs and Gemini are the handler-test stubs as they are;
 * Sanity and Stripe are thin wrappers over them (sanity.mjs, stripe.mjs) that
 * add the few answers the order emails need.
 */
const tools = (f) => new URL(`../../tools/builder/_stubs/${f}`, import.meta.url).href;
const STUBS = {
  '@sanity/client': new URL('./sanity.mjs', import.meta.url).href,
  stripe: new URL('./stripe.mjs', import.meta.url).href,
  resend: tools('resend.mjs'),
  '@netlify/blobs': tools('netlify-blobs.mjs'),
  '@google/genai': tools('google-genai.mjs'),
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) return { url: stub, shortCircuit: true, format: 'module' };
  return nextResolve(specifier, context);
}
