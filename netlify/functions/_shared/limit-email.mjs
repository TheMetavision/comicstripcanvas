import { Resend } from 'resend';
import { emailHeader, button, EMAIL_BRAND } from './email.mjs';
import {
  claimStyleLimitNotice, styleLimitCta, styleLimitFor, familyForTemplate,
} from './spend-guard.mjs';

/**
 * "Somebody has run out of style attempts" — to the team, once a day.
 *
 * The builder offers a customer who has used their daily allowance a link to
 * the artwork team, and until now that was the whole mechanism: if they did not
 * follow it, nobody ever knew they had been stopped. This is the other half.
 * The point of it is not the number -- the counters already have that -- it is
 * that a real person wanted something and could not finish it, and somebody
 * should be able to reach them first.
 *
 * Once a day PER VISITOR is enforced by claimStyleLimitNotice, which hands the
 * right to send to exactly one caller through a compare-and-swap on that
 * visitor's own record. Three places can notice this -- the upload, the retry
 * endpoint and the styler -- and a customer who taps Replace eight times
 * notices it eight times, so without the claim this would be a way of emailing
 * yourself repeatedly about one person.
 *
 * SEPARATE from the site-wide breaker email in breaker-email.mjs, and neither
 * silences the other: they are different facts. The breaker means the shop has
 * stopped styling for everyone; this means one customer has used their own
 * allowance while the shop carried on perfectly well. They are claimed on
 * different records, so a day on which both happen sends both.
 *
 * Best-effort by construction, like its sibling: called from paths that have
 * already done their real work, so a Resend outage must cost the email and
 * nothing else. Never throws.
 *
 * NO CUSTOMER DATA. The visitor key is a salted hash and always was; the build
 * id is opaque and is the thing that finds the design in the Studio. No
 * address, no name, no email, no photograph. Everything here is either a
 * number, an id, or one of three words.
 */

let resendClient;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/** Where the Personalisations list lives, the same one the order email links to. */
const STUDIO_PERSONALISATIONS = 'https://comicstripcanvas.sanity.studio/structure/personalisations';

const FAMILY_LABEL = {
  covers: 'comic book cover',
  icons: 'icon',
  strips: 'comic strip',
};

const LIMIT_ENV_LABEL = {
  covers: 'STYLE_LIMIT_COVERS',
  icons: 'STYLE_LIMIT_ICONS',
  strips: 'STYLE_LIMIT_STRIPS',
};

/**
 * @param {object} opts
 * @param {object} opts.store       the spend-guard blob store
 * @param {string} opts.key         the visitor's hashed key — never an address
 * @param {string} opts.buildId     the pendingPersonalisation id
 * @param {string} [opts.templateId] what they were making
 * @param {number} [opts.calls]     how many attempts they had used
 * @param {Date}   [opts.now]
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function notifyStyleLimit({
  store, key, buildId, templateId = null, calls = null, now = new Date(),
}) {
  try {
    if (!store || !key) return { sent: false, reason: 'no visitor to claim against' };

    const family = familyForTemplate(templateId);
    const claimed = await claimStyleLimitNotice(store, key, now, { family, buildId });
    if (!claimed) return { sent: false, reason: 'already notified about this visitor today' };

    const resend = getResend();
    if (!resend) {
      console.warn(
        `spend-guard: ${key} ran out of ${family} attempts but RESEND_API_KEY is not set — no email sent`
      );
      return { sent: false, reason: 'no RESEND_API_KEY' };
    }

    const limit = styleLimitFor(family);
    const label = FAMILY_LABEL[family] || family;
    const envVar = LIMIT_ENV_LABEL[family] || 'the limit for that family';
    const to = process.env.TEAM_EMAIL || process.env.EMAIL_FROM || 'orders@comicstripcanvas.co.uk';
    const site = process.env.URL || EMAIL_BRAND.site;
    /* The same link the customer was given, so replying to them and reading
       what they were offered are the same thing. Absolute here because an
       email has no origin to resolve a path against. */
    const contact = `${site}${styleLimitCta(buildId)}`;
    const when = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
      to: [to],
      subject: `🎨 A customer has used their ${label} style attempts for today`,
      html: `
        <div style="font-family: ${EMAIL_BRAND.sans}; max-width: 640px; margin: 0 auto; background: #ffffff;">
          ${emailHeader}
          <div style="padding: 32px 24px;">
            <h2 style="margin: 0 0 8px; font-size: 22px; color: ${EMAIL_BRAND.dark};">
              Somebody could not finish their design
            </h2>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              A customer building a <strong>${label}</strong> has used all
              ${limit} of their style attempts for today${calls == null ? '' : ` (${calls} used)`}.
              They have been shown the message offering our artwork team and a link to the
              contact form. Their photos and their build are saved &mdash; nothing is lost, and
              their attempts come back over the next 24 hours.
            </p>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              They may not write in. If you would rather reach them first, the design is in the
              Studio under the reference below &mdash; the photographs they uploaded are already
              on it.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"
                   style="width: 100%; margin: 0 0 22px; border-collapse: collapse; font-family: ${EMAIL_BRAND.sans}; font-size: 14px;">
              <tr>
                <td style="padding: 8px 12px; background: #f5f5f5; color: #666; width: 40%;">Build reference</td>
                <td style="padding: 8px 12px; background: #f5f5f5; color: #111; font-family: monospace;">${buildId || 'unknown'}</td>
              </tr>
              <tr>
                <td style="padding: 8px 12px; color: #666;">Limit reached</td>
                <td style="padding: 8px 12px; color: #111;">${label} &mdash; ${limit} a day (${envVar})</td>
              </tr>
              <tr>
                <td style="padding: 8px 12px; background: #f5f5f5; color: #666;">When</td>
                <td style="padding: 8px 12px; background: #f5f5f5; color: #111;">${when}</td>
              </tr>
              <tr>
                <td style="padding: 8px 12px; color: #666;">Visitor</td>
                <td style="padding: 8px 12px; color: #111; font-family: monospace;">${key}</td>
              </tr>
            </table>
            <p style="color: #777; line-height: 1.6; margin: 0 0 22px; font-size: 13px;">
              The visitor reference is a salted hash, not an address &mdash; it is only there so two
              refusals can be told apart. Nothing in this email identifies anybody.
            </p>
            ${button(STUDIO_PERSONALISATIONS, 'Open the Studio')}
            <p style="color: #444; line-height: 1.7; margin: 22px 0 18px; font-size: 15px; text-align: center;">
              <a href="${contact}" style="color: ${EMAIL_BRAND.pink}; font-weight: bold;">
                The contact form they were sent to
              </a>
            </p>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              To give everyone more room, change <strong>${envVar}</strong> in the Netlify
              environment variables. It is read per request, so no deploy is needed.
            </p>
            <p style="color: #777; line-height: 1.7; margin: 0; font-size: 13px;">
              One email per visitor per day, however many times they try.
              ${site}
            </p>
          </div>
        </div>`,
    });
    if (error) {
      // Resend reports a rejected send by returning an error, not by throwing.
      console.error(
        'spend-guard: style-limit email rejected:',
        typeof error === 'string' ? error : error.message || 'unknown'
      );
      return { sent: false, reason: 'resend rejected the send' };
    }
    console.warn(
      `spend-guard: ${key} ran out of ${family} attempts on ${buildId || 'an unknown build'} — notified ${to}`
    );
    return { sent: true };
  } catch (err) {
    console.error('spend-guard: style-limit email failed:', err.message);
    return { sent: false, reason: err.message };
  }
}
