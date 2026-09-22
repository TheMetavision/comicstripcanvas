/**
 * Turn every product's previousSlugs[] into a 301, at build time.
 *
 * Renaming a product used to be two edits in two places: the slug in Sanity,
 * and a hand-written line in public/_redirects. Nothing paired them, so the
 * second was easy to forget and the old URL simply 404'd. Now the old slug goes
 * in previousSlugs[] next to the new one, and this puts the redirect in.
 *
 * It APPENDS to what Astro has already written to dist/_redirects rather than
 * replacing it: public/_redirects carries the WordPress migration rules and is
 * maintained by hand, and those must survive. Netlify takes the FIRST matching
 * rule, so appending also means a hand-written rule always wins over a
 * generated one -- which is the right way round if the two ever disagree.
 *
 * Runs at astro:build:done, after the static files are in place.
 */
import fs from 'node:fs';
import path from 'node:path';

const MARKER = '# --- generated from product previousSlugs[] — do not edit by hand ---';

/** One 301 per old slug. Exported so a test can check the text without a build. */
export function redirectLines(products) {
  const out = [];
  const seen = new Set();
  for (const p of products || []) {
    const to = p?.slug;
    if (!to) continue;
    for (const from of p.previousSlugs || []) {
      if (typeof from !== 'string' || !from.trim()) continue;
      /* A redirect to itself is a loop, and a duplicate from-slug would make
         the second rule unreachable -- neither is worth emitting. */
      if (from === to || seen.has(from)) continue;
      seen.add(from);
      out.push(`/store/${from}  /store/${to}/  301`);
    }
  }
  return out.sort();
}

export default function slugRedirects({ client, query } = {}) {
  return {
    name: 'csc:slug-redirects',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        let products = [];
        try {
          products = await client.fetch(query);
        } catch (err) {
          /* Do not fail the build over this. A missing redirect is a 404 on an
             old URL; a failed build is the whole site. Say so loudly instead. */
          logger.warn(`could not read previousSlugs from Sanity: ${err.message}`);
          return;
        }

        const lines = redirectLines(products);
        if (!lines.length) { logger.info('no previousSlugs to redirect'); return; }

        const file = path.join(dir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '_redirects');
        let existing = '';
        try { existing = fs.readFileSync(file, 'utf8'); } catch (e) { /* none yet */ }

        /* Replace our own block if it is already there, so a rebuild does not
           stack copies of the same rules. */
        const at = existing.indexOf(MARKER);
        const head = at === -1 ? existing : existing.slice(0, at).replace(/\s+$/, '') + '\n';
        const block = `\n${MARKER}\n${lines.join('\n')}\n`;
        fs.writeFileSync(file, head + block);
        logger.info(`wrote ${lines.length} slug redirect(s) into _redirects`);
      },
    },
  };
}
