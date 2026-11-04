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

/* ------------------------------------------------------------ contrast --- */

const hexRgb = (hex) => {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const rgbHex = (rgb) => '#' + rgb.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase();
const luminance = (rgb) => {
  const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two #hex colours (1 when either cannot be read). */
export function contrastRatio(a, b) {
  const x = hexRgb(a); const y = hexRgb(b);
  if (!x || !y) return 1;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A shade of `color` that is readable on `bg`: the colour itself if it
 * already reaches `min` (WCAG 4.5:1 for body text), otherwise the same hue
 * mixed a step at a time towards black (light background) or white (dark
 * background) until it does. So the brand pink stays pink -- a deeper pink on
 * white, a lighter one on the dark footer -- rather than turning grey.
 * Contrast is symmetric, so it also gives a banner background that white (or
 * dark) text can sit on. An unreadable value falls back to near-black/white.
 */
export function readableShade(color, bg = '#ffffff', min = 4.5) {
  const back = hexRgb(bg) || [255, 255, 255];
  const towards = luminance(back) > 0.18 ? [0, 0, 0] : [255, 255, 255];
  const rgb = hexRgb(color);
  if (!rgb) return rgbHex(towards.map((t) => (t ? 245 : 17)));
  const want = min + 0.02;
  for (let i = 0; i <= 100; i++) {
    const mixed = rgb.map((c, k) => c + (towards[k] - c) * (i / 100));
    if (contrastRatio(rgbHex(mixed), rgbHex(back)) >= want) return i ? rgbHex(mixed) : String(color).toUpperCase();
  }
  return rgbHex(towards);
}

/* The lightest-but-one background a brand colour is put on as text: the pale
   panels (#f0f9ff, #f5f5f5, #fff9e6, ...) are all lighter than this, so a
   shade readable here is readable on every one of them and on white. */
const PANEL = '#EEEEEE';
const BASE = { pink: '#EC008C', cyan: '#00AEEF', green: '#28A745', gold: '#B8860B', dark: '#111111' };

export const EMAIL_BRAND = {
  // The 440x440 EmailLogo.png asset out of Sanity. Only 48% of that square is
  // artwork -- the rest is dead black padding -- so it is cropped to the mark
  // itself and then sized. Without the crop, a 160px box would show a 77px
  // logo; with it, the mark really is 160px wide.
  //
  // The rect is measured from THIS revision of the asset. If EmailLogo.png is
  // ever replaced, re-measure it (or drop the rect if the new one is already
  // tightly cropped) -- a stale rect would crop the wrong region.
  logo: 'https://cdn.sanity.io/images/lwbwahym/production/d3b36041ed3eb60d6ef9e6a6353c30ab79363be4-440x440.png',
  logoRect: '116,130,211,186',
  logoWidth: 160,
  logoHeight: 141,
  yellow: '#FFF200',
  pink: '#EC008C',
  cyan: '#00AEEF',
  dark: '#111111',
  // The header bar alone is pure black. EmailLogo.png has no alpha channel and
  // a black background, so on #111111 it showed as a darker square around the
  // logo; matching the bar to the logo makes the seam disappear. Sanity's ?bg=
  // only fills transparency, so it cannot be fixed at request time. Everything
  // else -- footers, rules, borders -- stays on `dark`.
  headerBar: '#000000',
  site: 'https://comicstripcanvas.co.uk',
  sans: "Arial, Helvetica, sans-serif",

  /* Readable shades of the brand colours, for TEXT (WCAG 4.5:1). The colours
     above stay for rules, borders and large type. Worked out from the brand
     values, so changing one moves its shades with it. */
  pinkText: readableShade(BASE.pink, PANEL),     // links, order numbers on white
  pinkOnDark: readableShade(BASE.pink, BASE.dark), // links in the dark footer
  pinkBanner: readableShade(BASE.pink, '#FFFFFF'), // a pink panel white text sits on
  cyanText: readableShade(BASE.cyan, PANEL),
  cyanBanner: readableShade(BASE.cyan, '#FFFFFF'),
  greenText: readableShade(BASE.green, PANEL),   // FREE UK P&P, discounts, "Action Required"
  goldText: readableShade(BASE.gold, '#FFF9E6'),
  muted: '#666666',                              // small print on white (was #777/#888/#aaa)
  mutedOnDark: '#A3A3A3',                        // small print in the dark footer (was #555/#666)
};

// Cropped region is 211px wide natively, comfortably above the 160px it is
// displayed at, so it stays crisp without upscaling.
const LOGO_SRC = `${EMAIL_BRAND.logo}?rect=${EMAIL_BRAND.logoRect}`;

/**
 * Charcoal bar, logo, tagline, then a 4px comic-pink rule. Sits directly on
 * top of a white body.
 */
export const emailHeader = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
    <tr>
      <td align="center" bgcolor="${EMAIL_BRAND.headerBar}" style="background: ${EMAIL_BRAND.headerBar}; padding: 28px 24px 24px;">
        <img src="${LOGO_SRC}" alt="Comic Strip Canvas"
             width="${EMAIL_BRAND.logoWidth}" height="${EMAIL_BRAND.logoHeight}"
             style="display: block; margin: 0 auto; width: ${EMAIL_BRAND.logoWidth}px; height: ${EMAIL_BRAND.logoHeight}px; border: 0; outline: none; text-decoration: none;" />
        <p style="margin: 14px 0 0; font-family: ${EMAIL_BRAND.sans}; font-size: 13px; letter-spacing: 1px; color: #777777; text-align: center;">BOLD POP CULTURE WALL ART</p>
      </td>
    </tr>
    <tr>
      <td height="4" bgcolor="${EMAIL_BRAND.pink}" style="background: ${EMAIL_BRAND.pink}; height: 4px; line-height: 4px; font-size: 0;">&nbsp;</td>
    </tr>
  </table>`;

/**
 * The team's version: the same logo on the same black bar, half the size and
 * without the tagline, so an alert's subject line in the body is still the
 * first thing read. For internal notices (new order, shipping, returns) --
 * customers get emailHeader.
 */
const TEAM_LOGO_WIDTH = 80;
const TEAM_LOGO_HEIGHT = Math.round(TEAM_LOGO_WIDTH * EMAIL_BRAND.logoHeight / EMAIL_BRAND.logoWidth);
export const teamEmailHeader = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse;">
    <tr>
      <td align="center" bgcolor="${EMAIL_BRAND.headerBar}" style="background: ${EMAIL_BRAND.headerBar}; padding: 14px 16px;">
        <img src="${LOGO_SRC}" alt="Comic Strip Canvas"
             width="${TEAM_LOGO_WIDTH}" height="${TEAM_LOGO_HEIGHT}"
             style="display: block; margin: 0 auto; width: ${TEAM_LOGO_WIDTH}px; height: ${TEAM_LOGO_HEIGHT}px; border: 0; outline: none; text-decoration: none;" />
      </td>
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
