import { Resend } from 'resend';
import { emailHeader, EMAIL_BRAND } from './email.mjs';
import { claimBreakerNotice, styleDailyMax, originOr, STUDIO } from './spend-guard.mjs';

/**
 * "The styling budget for today is spent" — to the team, once a day.
 *
 * Once a day is enforced by claimBreakerNotice, which hands the right to send
 * to exactly one caller per UTC day through a compare-and-swap on the same
 * counter the breaker reads. Every other caller that notices the trip stays
 * quiet, so a busy afternoon produces one email rather than one per refusal.
 *
 * Best-effort by construction: this is called from paths that have already done
 * their real work, so a Resend outage must cost the email and nothing else.
 * Never throws.
 */

let resendClient;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

/**
 * @param {object} opts
 * @param {object} opts.store   the spend-guard blob store
 * @param {number} opts.calls   the count that tripped it
 * @param {string} [opts.origin] which budget ran out
 * @param {Date}   [opts.now]
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function notifyBreakerTripped({ store, calls, origin = 'customer', now = new Date() }) {
  try {
    const which = originOr(origin);
    /* Claimed per budget: the studio running out and the shop running out are
       two different facts about two different pots of money, and one email
       must not silence the other. */
    const claimed = await claimBreakerNotice(store, now, which);
    if (!claimed) return { sent: false, reason: 'already notified today' };

    const resend = getResend();
    if (!resend) {
      console.warn('spend-guard: breaker tripped but RESEND_API_KEY is not set — no email sent');
      return { sent: false, reason: 'no RESEND_API_KEY' };
    }
    const max = styleDailyMax(which);
    const studio = which === STUDIO;
    const label = studio ? 'studio' : 'customer';
    const envVar = studio ? 'STUDIO_STYLE_DAILY_MAX' : 'STYLE_DAILY_MAX';
    const to = process.env.TEAM_EMAIL || process.env.EMAIL_FROM || 'orders@comicstripcanvas.co.uk';
    const site = process.env.URL || EMAIL_BRAND.site;

    const { error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Comic Strip Canvas <orders@comicstripcanvas.co.uk>',
      to: [to],
      subject: `⚠️ Comic styling paused (${label}) — ${calls} calls today (limit ${max})`,
      html: `
        <div style="font-family: ${EMAIL_BRAND.sans}; max-width: 640px; margin: 0 auto; background: #ffffff;">
          ${emailHeader}
          <div style="padding: 32px 24px;">
            <h2 style="margin: 0 0 8px; font-size: 22px; color: ${EMAIL_BRAND.dark};">
              The daily ${label} styling limit has been reached
            </h2>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              ${calls} ${label} comic style calls have been made today, against a limit of ${max}.
              New ${label} style calls are paused until the counter resets at midnight UTC.
              ${studio
                ? 'The customer budget is a separate counter and is untouched &mdash; the live '
                  + 'builder keeps working.'
                : 'The studio budget is a separate counter and is untouched.'}
            </p>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              ${studio
                ? 'Paused studio artwork is stored and waiting; it is styled automatically once '
                  + 'the counter resets.'
                : 'Customers can still upload their photos and keep building. Each paused photo '
                  + 'shows &ldquo;We&rsquo;re unusually busy &mdash; your comic style will be '
                  + 'applied shortly&rdquo;, Add to basket stays shut behind it, and the photos '
                  + 'are styled automatically once the counter resets.'}
            </p>
            <p style="color: #444; line-height: 1.7; margin: 0 0 18px; font-size: 15px;">
              To raise the ceiling now, change <strong>${envVar}</strong> in the Netlify
              environment variables. It is read per request, so no deploy is needed &mdash;
              the next poll picks the paused photos up.
            </p>
            <p style="color: #777; line-height: 1.7; margin: 0; font-size: 13px;">
              ${site}
            </p>
          </div>
        </div>`,
    });
    if (error) {
      // Resend reports a rejected send by returning an error, not by throwing.
      console.error(
        'spend-guard: breaker email rejected:',
        typeof error === 'string' ? error : error.message || 'unknown'
      );
      return { sent: false, reason: 'resend rejected the send' };
    }
    console.warn(`spend-guard: the ${label} breaker tripped at ${calls}/${max} — notified ${to}`);
    return { sent: true };
  } catch (err) {
    console.error('spend-guard: breaker email failed:', err.message);
    return { sent: false, reason: err.message };
  }
}
