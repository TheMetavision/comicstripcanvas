import fs from 'node:fs';
import path from 'node:path';

/**
 * Put HTTP Basic Auth in front of /admin/* by appending a rule to dist/_headers.
 *
 * Generated at build time, never committed: the credentials come from
 * ADMIN_BASIC_USER and ADMIN_BASIC_PASS, and the only place they end up is the
 * deploy's own _headers file. Netlify reads Basic-Auth from _headers on the Pro
 * plan; there is no equivalent in netlify.toml, which is why this is a build
 * step rather than a line of config.
 *
 * VERIFY THIS ON A DEPLOY PREVIEW BEFORE TRUSTING IT. Basic-Auth is a Pro-plan
 * feature: the edge consumes the directive and challenges the caller. Where it
 * is NOT supported it is treated as an ordinary custom header and echoed to the
 * client -- which publishes the password to anyone who asks for /admin/. The
 * local CLI does exactly that, so `netlify serve` cannot be used to confirm the
 * rule works; it returns 200 and hands the credentials back in the response.
 * Check a deploy preview for a 401 and for the absence of a Basic-Auth header.
 *
 * /api/* is deliberately NOT protected. Every function lives there -- the
 * customer builder's uploads and status polls, the Studio's own actions, the
 * Stripe webhook -- and a password on any of it would break the shop. The write
 * paths that matter defend themselves: studio-save and the Studio actions
 * refuse without PERSONALISATION_ACTION_SECRET, and this rule is a second layer
 * over the page, not a replacement for that.
 */

const dist = path.resolve(process.argv[2] || 'dist');
const user = (process.env.ADMIN_BASIC_USER || '').trim();
const pass = (process.env.ADMIN_BASIC_PASS || '').trim();

/* Netlify's context: "production", "deploy-preview", "branch-deploy" or "dev".
   Anything that is not dev is a deploy somebody can reach over the internet, so
   a deploy preview with an open /admin is treated as seriously as production. */
const context = process.env.CONTEXT || '';
const onNetlify = process.env.NETLIFY === 'true' && context !== 'dev';

if (!user || !pass) {
  const missing = [!user && 'ADMIN_BASIC_USER', !pass && 'ADMIN_BASIC_PASS'].filter(Boolean).join(' and ');
  if (onNetlify) {
    console.error(
      `\nadmin-headers: ${missing} is not set, so /admin/* would deploy with no password.\n` +
      `  Set both in Site configuration -> Environment variables, then redeploy.\n` +
      `  Context: ${context || '(none)'}.\n`
    );
    process.exit(1);
  }
  console.log(`admin-headers: ${missing} not set — skipping the /admin/* rule (local build).`);
  process.exit(0);
}

/* One space-separated user:pass pair per credential, so neither half may carry
   a space or a colon -- the header would silently parse into something else and
   the password would not work, which is a worse failure than refusing here. */
const bad = (s, what) => {
  if (/\s/.test(s)) return `${what} contains whitespace`;
  if (s.includes(':')) return `${what} contains a colon`;
  return null;
};
const problem = bad(user, 'ADMIN_BASIC_USER') || bad(pass, 'ADMIN_BASIC_PASS');
if (problem) {
  console.error(`\nadmin-headers: ${problem}. Netlify reads Basic-Auth as "user:pass" ` +
    `separated by spaces, so neither may contain either.\n`);
  process.exit(1);
}

if (!fs.existsSync(dist)) {
  console.error(`\nadmin-headers: ${dist} does not exist — run this after the build.\n`);
  process.exit(1);
}

const file = path.join(dist, '_headers');
// Append: the adapter or a future public/_headers may have written rules here
// already, and this owns one path, not the file.
const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\s*$/, '\n') : '';
if (/^\/admin\/\*/m.test(existing)) {
  console.log('admin-headers: dist/_headers already has an /admin/* rule — leaving it alone.');
  process.exit(0);
}

const rule = `${existing ? existing + '\n' : ''}/admin/*\n  Basic-Auth: ${user}:${pass}\n`;
fs.writeFileSync(file, rule, 'utf8');
console.log(`admin-headers: /admin/* protected for user "${user}" (${existing ? 'appended to' : 'created'} dist/_headers).`);
