#!/usr/bin/env node
/**
 * tools/check-public-exposure.mjs
 *
 * Asks the PUBLIC Sanity query API — no token, exactly what anyone on the
 * internet can do — how many customer documents it can see. Counts only;
 * prints no document content.
 *
 *   node tools/check-public-exposure.mjs
 *
 * Exit code 1 if any of DOC_TYPES is visible. WATCH types are reported but
 * don't fail the check (not yet moved to dotted ids).
 */
const PROJECT = 'lwbwahym';
const DATASET = 'production';
const DOC_TYPES = ['order', 'contactSubmission', 'orderCounter'];
const WATCH = ['pendingPersonalisation'];

const URL_BASE = `https://${PROJECT}.api.sanity.io/v2024-12-01/data/query/${DATASET}`;
const query = `{
  ${[...DOC_TYPES, ...WATCH].map((t) => `"${t}": count(*[_type == "${t}"])`).join(',\n  ')},
  "all": count(*[_type in ${JSON.stringify(DOC_TYPES)}])
}`;

// process.exitCode rather than process.exit(): exiting while fetch sockets
// are still closing trips a libuv assertion on Windows (Node 24).
const res = await fetch(`${URL_BASE}?query=${encodeURIComponent(query)}`); // deliberately anonymous
if (!res.ok) {
  console.error(`Query failed: HTTP ${res.status}`);
  process.exitCode = 2;
} else {
  const result = (await res.json()).result;
  console.log(`\n  Anonymous (public API) visibility — ${new Date().toISOString()}\n`);
  for (const t of DOC_TYPES) console.log(`  ${result[t] > 0 ? 'EXPOSED' : 'ok     '}  ${t.padEnd(24)} ${result[t]}`);
  for (const t of WATCH) console.log(`  ${result[t] > 0 ? 'WARN   ' : 'ok     '}  ${t.padEnd(24)} ${result[t]}   (not migrated yet)`);
  console.log(`\n  count(*[_type in ${JSON.stringify(DOC_TYPES)}]) = ${result.all}\n`);
  process.exitCode = result.all > 0 ? 1 : 0;
}
