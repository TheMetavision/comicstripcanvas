/**
 * Shared email chrome.
 *
 * webhook.mjs and order-shipped.mjs had byte-identical copies of this header;
 * the proof email in personalisation-action.mjs would have made a third. One
 * component instead, so the brand only has to be changed in one place.
 *
 * Table layout with inline styles throughout, because Gmail strips <style>
 * blocks and Outlook renders through Word, which ignores most modern CSS. What
 * survives in both is a single-column table with attributes and inline styles.
 */

export const EMAIL_BRAND = {
  // The 440x440 EmailLogo.png asset out of Sanity, requested at 2x and shown at
  // 140px so it stays sharp on retina displays.
  logo: 'https://cdn.sanity.io/images/lwbwahym/production/d3b36041ed3eb60d6ef9e6a6353c30ab79363be4-440x440.png',
  logoWidth: 140,
  yellow: '#FFF200',
  pink: '#EC008C',
  cyan: '#00AEEF',
  dark: '#111111',
  site: 'https://comicstripcanvas.co.uk',
  sans: "Arial, Helvetica, sans-serif",
};

const LOGO_2X = `${EMAIL_BRAND.logo}?w=280&amp;h=280&amp;fit=max`;

/**
 * Charcoal bar, logo, tagline, then a 4px comic-pink rule. Sits directly on
 * top of a white body.
 */
export const emailHeader = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
    <tr>
      <td align="center" bgcolor="${EMAIL_BRAND.dark}" style="background: ${EMAIL_BRAND.dark}; padding: 28px 24px 24px;">
        <img src="${LOGO_2X}" alt="Comic Strip Canvas"
             width="${EMAIL_BRAND.logoWidth}" height="${EMAIL_BRAND.logoWidth}"
             style="display: block; margin: 0 auto; width: ${EMAIL_BRAND.logoWidth}px; height: ${EMAIL_BRAND.logoWidth}px; border: 0; outline: none; text-decoration: none;" />
        <p style="margin: 14px 0 0; font-family: ${EMAIL_BRAND.sans}; font-size: 13px; letter-spacing: 1px; color: #777777; text-align: center;">BOLD POP CULTURE WALL ART</p>
      </td>
    </tr>
    <tr>
      <td height="4" bgcolor="${EMAIL_BRAND.pink}" style="background: ${EMAIL_BRAND.pink}; height: 4px; line-height: 4px; font-size: 0;">&nbsp;</td>
    </tr>
  </table>`;

/**
 * The site's .btn-primary as an email-safe button: comic-yellow, black text,
 * 4px black border. The border and background live on the <td> so Outlook draws
 * them; padding is on the <a> so the whole block is clickable.
 */
export const button = (href, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 auto; border-collapse: separate;">
    <tr>
      <td align="center" bgcolor="${EMAIL_BRAND.yellow}"
          style="background: ${EMAIL_BRAND.yellow}; border: 4px solid #000000; box-shadow: 4px 4px 0 #000000;">
        <a href="${href}"
           style="display: inline-block; padding: 14px 34px; font-family: ${EMAIL_BRAND.sans}; font-size: 17px; font-weight: bold; line-height: 1.2; color: #000000; text-decoration: none; text-transform: uppercase; letter-spacing: 0.1em;">${label}</a>
      </td>
    </tr>
  </table>`;
