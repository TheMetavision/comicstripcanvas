// The "Confirm your subscription" email: CSC's own header and button
// (_shared/email.mjs) in the same email-safe shell as the brands' contact
// emails -- table layout, inline styles, 600px max, bgcolor attributes for
// Outlook, colour-scheme meta, and a preheader in real characters.
//
// No visitor input appears in it except the link we generate, and it says
// plainly that ignoring it means nothing happens: whoever receives one they
// did not ask for is not signed up.
import { EMAIL_BRAND, emailHeader, button } from './email.mjs';

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function confirmationEmail({ confirmUrl }) {
  const subject = 'Confirm your subscription — Comic Strip Canvas';
  const preheader = 'One click and you’re in. Didn’t sign up? Ignore this and nothing happens.';
  const href = escAttr(confirmUrl);
  const sans = EMAIL_BRAND.sans;
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Confirm your subscription</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f3f5;" bgcolor="#f2f3f5">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#f2f3f5;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f3f5" style="background-color:#f2f3f5;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
      <tr><td>${emailHeader}</td></tr>
      <tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:32px 28px;font-family:${sans};color:#1f2125;">
        <h1 style="margin:0 0 16px;font-size:24px;line-height:1.3;color:${EMAIL_BRAND.dark};">Confirm your subscription</h1>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#1f2125;">Thanks for joining the Comic Strip Canvas crew! Click below to confirm this is your address and we’ll start sending you new releases, deals and behind-the-scenes art.</p>
        <div style="margin:26px 0;">${button(href, 'Confirm my subscription')}</div>
        <p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#5f6670;">The link works once and expires in 48 hours. If the button doesn’t work, paste this into your browser:<br><a href="${href}" style="color:#5f6670;word-break:break-all;">${href}</a></p>
        <p style="margin:0;font-size:13px;line-height:1.6;color:#5f6670;"><strong>Didn’t sign up?</strong> Someone may have entered your address by mistake. Ignore this email and you won’t be added to anything.</p>
      </td></tr>
      <tr><td bgcolor="${EMAIL_BRAND.dark}" style="background-color:${EMAIL_BRAND.dark};padding:20px 28px;font-family:${sans};font-size:12px;line-height:1.6;color:#b8bcc4;">
        <strong style="color:#ffffff;">Comic Strip Canvas</strong> &middot; <a href="${EMAIL_BRAND.site}" style="color:${EMAIL_BRAND.yellow};text-decoration:none;">comicstripcanvas.co.uk</a><br>
        Bold pop culture wall art.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
  const text =
    'Confirm your subscription to Comic Strip Canvas\n\n' +
    'Thanks for joining the crew! Open this link to confirm this is your address:\n\n' +
    `${confirmUrl}\n\n` +
    'The link works once and expires in 48 hours.\n\n' +
    'Didn’t sign up? Someone may have entered your address by mistake. Ignore this email and you won’t be added to anything.\n\n' +
    `Comic Strip Canvas — ${EMAIL_BRAND.site}`;
  return { subject, preheader, html, text };
}
