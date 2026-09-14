/**
 * Module resolution hooks, so a deployed function can be CALLED in a test.
 *
 * The functions under netlify/functions are the code that actually runs in
 * production, and until now nothing ever executed one: every test reached for
 * the helpers underneath them instead. That is how a temporal dead zone in
 * personalise-save reached production behind 146 green assertions -- the error
 * is syntactically valid, so `node --check` passes, the Astro build never
 * bundles these files, and no test called the function.
 *
 * Rather than refactor the handlers to take injected clients -- which would be
 * changing the shipped code to suit the tests, and would leave the real import
 * path still untested -- this redirects three bare specifiers to in-memory
 * stubs at resolution time. The handler's own source is imported and run
 * unmodified, exactly as deployed.
 *
 * Registered with module.register() from the test before the handler is
 * imported; hooks run on their own thread, so nothing here can see or share
 * the test's state. The stubs do that, and the test imports the same files.
 */

const STUBS = {
  '@sanity/client': new URL('./sanity-client.mjs', import.meta.url).href,
  '@netlify/blobs': new URL('./netlify-blobs.mjs', import.meta.url).href,
  resend: new URL('./resend.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) return { url: stub, shortCircuit: true, format: 'module' };
  return nextResolve(specifier, context);
}
