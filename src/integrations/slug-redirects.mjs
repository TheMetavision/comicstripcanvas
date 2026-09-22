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
 * ── Why the from-path is lowercased, and why some entries are dropped ───────
 *
 * Netlify folds the case of a request path BEFORE it matches redirect rules.
 * /store/Walter-white and /store/walter-white arrive as the same request. Two
 * consequences, and both were found the hard way:
 *
 *   A rule whose source differs from its target only by case can never fire.
 *   Six such rules were written by hand and were dead on arrival -- the old
 *   capitalised URLs silently resolved to the lower-case page instead.
 *
 *   Worse, a rule whose lower-cased source is ANOTHER live product's slug
 *   takes that product off the site. `walter-white-icon` carries
 *   previousSlugs ["Walter-white"], which lower-cases to `walter-white` --
 *   the Walter White COVER. Emitting that redirect would send every visitor
 *   to the cover straight to the icon, which is the exact bug this whole
 *   branch exists to fix, reintroduced by its own fix.
 *
 * So: lower-case the source, and drop anything that would shadow a live
 * product or could never match. Say out loud what was dropped -- a silently
 * skipped redirect is how the first one went unnoticed.
 */
import fs from 'node:fs';
import path from 'node:path';

const MARKER = '# --- generated from product previousSlugs[] — do not edit by hand ---';

/**
 * One 301 per old slug, and the reason for every one not emitted.
 *
 * @param {Array<{slug: string, previousSlugs?: string[]}>} products
 * @param {Iterable<string>} liveSlugs every slug currently in use, so a rule
 *        cannot be written that shadows one
 * @returns {{lines: string[], skipped: Array<{from: string, to: string, why: string}>}}
 */
export function redirectLines(products, liveSlugs = []) {
  const live = new Set([...liveSlugs].filter(Boolean).map((s) => String(s).toLowerCase()));
  const lines = [];
  const skipped = [];
  const seen = new Set();

  for (const p of products || []) {
    const to = p?.slug;
    if (!to) continue;
    const toLc = String(to).toLowerCase();

    for (const raw of p.previousSlugs || []) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const from = raw.trim().toLowerCase();

      if (from === toLc) {
        skipped.push({ from: raw, to, why: 'differs from the current slug only by case — Netlify folds the path before matching, so the rule could never fire' });
        continue;
      }
      if (live.has(from)) {
        skipped.push({ from: raw, to, why: `"${from}" is a live product's slug — a redirect here would take that product off the site` });
        continue;
      }
      if (seen.has(from)) {
        skipped.push({ from: raw, to, why: 'another product already claims this old slug — the second rule would be unreachable' });
        continue;
      }
      seen.add(from);
      lines.push(`/store/${from}  /store/${to}/  301`);
    }
  }
  return { lines: lines.sort(), skipped };
}

export default function slugRedirects({ client, query } = {}) {
  return {
    name: 'csc:slug-redirects',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        let data;
        try {
          data = await client.fetch(query);
        } catch (err) {
          /* Do not fail the build over this. A missing redirect is a 404 on an
             old URL; a failed build is the whole site. Say so loudly instead. */
          logger.warn(`could not read previousSlugs from Sanity: ${err.message}`);
          return;
        }

        const { renamed = [], allSlugs = [] } = data || {};
        const { lines, skipped } = redirectLines(renamed, allSlugs);

        for (const s of skipped) {
          logger.warn(`redirect NOT written: /store/${s.from} -> /store/${s.to}/ — ${s.why}`);
        }

        if (!lines.length) {
          logger.info(`no slug redirects to write${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
          return;
        }

        const file = path.join(dir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '_redirects');
        let existing = '';
        try { existing = fs.readFileSync(file, 'utf8'); } catch (e) { /* none yet */ }

        /* Replace our own block if it is already there, so a rebuild does not
           stack copies of the same rules. */
        const at = existing.indexOf(MARKER);
        const head = at === -1 ? existing : existing.slice(0, at).replace(/\s+$/, '') + '\n';
        const block = `\n${MARKER}\n${lines.join('\n')}\n`;
        fs.writeFileSync(file, head + block);
        logger.info(`wrote ${lines.length} slug redirect(s) into _redirects${skipped.length ? `, skipped ${skipped.length}` : ''}`);
      },
    },
  };
}
