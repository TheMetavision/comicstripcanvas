import { Resend } from 'resend';
import { emailHeader, button, EMAIL_BRAND } from './email.mjs';

/**
 * "A Studio draft of an order or build has been sitting there" — to the team.
 *
 * A draft is a copy of the document taken when somebody started editing it,
 * and the server never writes to it. The longer it sits, the more of what the
 * server wrote since it would roll back if it were published. The guarded
 * Publish on orders (studio/lib/guarded-publish.mjs) and the read-only build
 * form are the locks; this is the smoke alarm for anything that gets past
 * them -- a draft made by a script, a release version, a Studio not yet
 * redeployed.
 *
 * AGE IS LAST CHANGE, NOT CREATION. A draft's _createdAt is copied from the
 * published document when the Studio makes it -- the two stale order drafts
 * discarded on 5 October 2026 were made on the 2nd and claimed May -- so the
 * only honest clock is _updatedAt: how long since anybody touched it.
 *
 * Sends nothing when there is nothing to report. Never throws.
 */

export const MAX_AGE_HOURS = 24;
const TYPES = ['order', 'pendingPersonalisation'];
const STUDIO = 'https://comicstripcanvas.sanity.studio';

let resendClient;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** drafts.order.x -> order.x; versions.<release>.order.x -> order.x */
export const publishedIdOf = (id) => id.replace(/^drafts\./, '').replace(/^versions\.[^.]+\./, '');

/**
 * Drafts and release versions of orders and builds untouched for longer than
 * maxAgeHours, oldest first.
 */
export async function findStaleDrafts(sanity, { now = new Date(), maxAgeHours = MAX_AGE_HOURS } = {}) {
  const cutoff = new Date(now.getTime() - maxAgeHours * 3600_000).toISOString();
  const rows = await sanity.fetch(
    `*[(_id in path("drafts.**") || _id in path("versions.**")) && _type in $types && _updatedAt < $cutoff]
       | order(_updatedAt asc){ _id, _type, _updatedAt, orderNumber, customerTitle }`,
    { types: TYPES, cutoff }
  );
  return rows.map((r) => ({
    ...r,
    publishedId: publishedIdOf(r._id),
    ageHours: Math.floor((now.getTime() - Date.parse(r._updatedAt)) / 3600_000),
  }));
}

const studioLink = (d) =>
  `${STUDIO}/intent/edit/id=${encodeURIComponent(d.publishedId)};type=${d._type}`;

export function staleDraftsEmail(drafts, maxAgeHours = MAX_AGE_HOURS) {
  const n = drafts.length;
  const subject = `⚠ ${n} Studio draft${n === 1 ? '' : 's'} left open over ${maxAgeHours} hours`;
  const rows = drafts.map((d, i) => `
              <tr>
                <td style="padding: 8px 12px;${i % 2 ? '' : ' background: #f5f5f5;'} color: #111;">
                  ${d._type === 'order' ? 'Order' : 'Build'} ${esc(d.orderNumber || d.customerTitle || '')}
                  <br><span style="font-family: monospace; font-size: 12px; color: #666;">${esc(d._id)}</span>
                </td>
                <td style="padding: 8px 12px;${i % 2 ? '' : ' background: #f5f5f5;'} color: #111; white-space: nowrap;">
                  ${d.ageHours} h
                </td>
                <td style="padding: 8px 12px;${i % 2 ? '' : ' background: #f5f5f5;'}">
                  <a href="${esc(studioLink(d))}" style="color: ${EMAIL_BRAND.pink}; font-weight: bold;">Open</a>
                </td>
              </tr>`).join('');
  const html = `
        <div style="font-family: ${EMAIL_BRAND.sans}; max-width: 640px; margin: 0 auto; background: #ffffff;">
          ${emailHeader}
          <div style="padding: 32px 24px;">
            <h2 style="margin: 0 0 8px; font-size: 22px; color: ${EMAIL_BRAND.dark};">
              Unpublished changes are going stale
            </h2>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              ${n === 1 ? 'This draft has' : `These ${n} drafts have`} not been touched for over
              ${maxAgeHours} hours. A draft is a copy taken when somebody started editing, and the
              website never updates it &mdash; so the longer it sits, the more it would undo if it
              were published as it is.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                   style="width: 100%; margin: 0 0 22px; border-collapse: collapse; font-family: ${EMAIL_BRAND.sans}; font-size: 14px;">
              <tr>
                <th align="left" style="padding: 8px 12px; color: #666; font-weight: normal;">Document</th>
                <th align="left" style="padding: 8px 12px; color: #666; font-weight: normal;">Untouched</th>
                <th></th>
              </tr>
              ${rows}
            </table>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              Open each one and either <strong>Publish</strong> it, if the change is still wanted, or
              <strong>Discard changes</strong>. On an order, Publish keeps everything the website has
              written since and only applies the status, tracking, carrier and notes you changed.
            </p>
            ${button(`${STUDIO}/structure`, 'Open the Studio')}
            <p style="color: #777; line-height: 1.7; margin: 22px 0 0; font-size: 13px;">
              Checked daily. No email on a day with nothing to report.
            </p>
          </div>
        </div>`;
  return { subject, html };
}

/**
 * The daily check. Injected reads and sends, so the tests can drive it.
 *
 * @returns {Promise<{ found: number, sent: boolean, reason?: string, drafts?: object[] }>}
 */
export async function runStaleDraftCheck({
  sanity, send, now = new Date(), maxAgeHours = MAX_AGE_HOURS, log = console,
}) {
  let drafts;
  try {
    drafts = await findStaleDrafts(sanity, { now, maxAgeHours });
  } catch (err) {
    log.error(`stale-drafts: could not query drafts: ${err.message}`);
    return { found: 0, sent: false, reason: `query failed: ${err.message}` };
  }
  if (!drafts.length) {
    log.log(`stale-drafts: none older than ${maxAgeHours} h — no email`);
    return { found: 0, sent: false, reason: 'nothing to report', drafts };
  }

  const sender = send || defaultSend;
  const { subject, html } = staleDraftsEmail(drafts, maxAgeHours);
  const to = process.env.TEAM_EMAIL || process.env.EMAIL_FROM || 'orders@comicstripcanvas.co.uk';
  try {
    const result = await sender({
      from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
      to: [to],
      subject,
      html,
    });
    if (result && result.error) {
      const msg = typeof result.error === 'string' ? result.error : result.error.message || 'unknown';
      log.error(`stale-drafts: ${drafts.length} stale draft(s) but Resend rejected the email: ${msg}`);
      return { found: drafts.length, sent: false, reason: `resend rejected: ${msg}`, drafts };
    }
  } catch (err) {
    log.error(`stale-drafts: ${drafts.length} stale draft(s) but the email failed: ${err.message}`);
    return { found: drafts.length, sent: false, reason: err.message, drafts };
  }
  log.warn(`stale-drafts: ${drafts.length} stale draft(s) — emailed ${to}: ${drafts.map((d) => d._id).join(', ')}`);
  return { found: drafts.length, sent: true, drafts };
}

async function defaultSend(message) {
  const resend = getResend();
  if (!resend) return { error: 'RESEND_API_KEY is not set' };
  return resend.emails.send(message);
}
