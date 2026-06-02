/**
 * netlify/functions/contact.mts
 *
 * Contact form intake (brand-agnostic — configured entirely via env vars,
 * so the same file deploys to every brand site). Persists the submission as a
 * Sanity `contactSubmission` document, sends a notification email to the team,
 * and sends a branded acknowledgement back to the customer.
 *
 * Flow:
 *   1. Validate request (POST, JSON body, required fields)
 *   2. Honeypot check (`botcheck` must be empty)
 *   3. Rate-limit by hashed IP (3 submissions per 10 minutes per IP)
 *   4. Write a Sanity doc (status: 'new', generated refCode)
 *   5. Send notification email to the team via Resend (best-effort)
 *   6. Send acknowledgement email to the customer via Resend (best-effort)
 *   7. Return { success: true, refCode }
 *
 * Sanity write happens BEFORE either email: if email fails, the submission
 * is still persisted and recoverable. Both sends are best-effort and never
 * change the success response. The IP is never stored in plaintext — only a
 * salted SHA-256 hash for rate-limit deduplication.
 *
 * Env vars (Netlify):
 *   SANITY_PROJECT_ID, SANITY_DATASET, SANITY_API_TOKEN
 *   RESEND_API_KEY, NOTIFICATION_FROM, NOTIFICATION_TO
 *   BRAND_NAME, SITE_URL
 *   LOGO_URL          absolute https URL of the logo for the email header
 *   EMAIL_HEADER_BG   header background (default #0e0e14; use #000000 for a
 *                     logo that sits on a black background, to avoid a seam)
 *   BRAND_ACCENT      hex for the thin accent rule under the header
 */

import { createClient } from '@sanity/client';
import { Resend } from 'resend';
import crypto from 'node:crypto';

// ── CORS — restrict to the live origin + localhost for dev ───────────────
const ALLOWED_ORIGINS = [
  'https://comicstripcanvas.co.uk',
  'https://www.comicstripcanvas.co.uk',
  'http://localhost:4321',
  'http://localhost:3000',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin || '') ? origin : 'https://comicstripcanvas.co.uk';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────
function generateRefCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return `MSG-${code}`;
}

function hashIp(ip) {
  // Daily salt — prevents long-term tracking while keeping 10-minute dedup
  // (within a UTC day the same IP hashes consistently).
  const dayKey = new Date().toISOString().slice(0, 10);
  return crypto.createHash('sha256').update(`${ip}|${dayKey}`).digest('hex').slice(0, 32);
}

function extractIp(event) {
  // Netlify sets x-nf-client-connection-ip; fall back to x-forwarded-for.
  const h = event.headers || {};
  const xfwd = h['x-forwarded-for'] || h['X-Forwarded-For'];
  return (
    h['x-nf-client-connection-ip'] ||
    h['X-Nf-Client-Connection-Ip'] ||
    (xfwd ? String(xfwd).split(',')[0].trim() : '') ||
    'unknown'
  );
}

function sanitiseString(v, max = 500) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function firstNameOf(name) {
  return String(name).trim().split(/\s+/)[0] || 'there';
}

// ── Shared branded email shell ───────────────────────────────────────────
// Logo header if LOGO_URL is set, otherwise a text wordmark fallback so any
// brand that hasn't set a logo still renders cleanly.
function renderEmailShell({ brandName, logoUrl, headerBg, accent, siteUrl, preheader, innerHtml }) {
  const year = new Date().getFullYear();
  const bg = headerBg || '#0e0e14';
  const rule = accent || bg;
  const header = logoUrl
    ? `<img src="${logoUrl}" alt="${escapeHtml(brandName)}" width="200" style="display:block;width:200px;max-width:64%;height:auto;border:0;margin:0 auto;" />`
    : `<span style="font-size:20px;font-weight:800;letter-spacing:1px;color:#ffffff;">${escapeHtml(brandName)}</span>`;
  const host = siteUrl ? siteUrl.replace(/^https?:\/\//, '') : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>:root{color-scheme:light dark;supported-color-schemes:light dark;}</style>
</head>
<body style="margin:0;padding:24px;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a2e;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || '')}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <tr><td align="center" bgcolor="${bg}" style="padding:24px 28px;background:${bg};">${header}</td></tr>
    <tr><td style="height:3px;background:${rule};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding:28px;">${innerHtml}</td></tr>
    <tr><td style="padding:18px 28px;border-top:1px solid #eee;font-size:12px;line-height:1.6;color:#9aa0aa;">
      ${escapeHtml(brandName)}${host ? ` &middot; <a href="${siteUrl}" style="color:${rule};text-decoration:none;">${escapeHtml(host)}</a>` : ''}<br />&copy; ${year} ${escapeHtml(brandName)}
    </td></tr>
  </table>
</body></html>`;
}

// ── Notification email (to the team) ─────────────────────────────────────
function buildNotificationHtml(brand, { refCode, name, email, phone, subject, message, pageUri }) {
  const inner = `
    <h1 style="margin:0 0 16px;font-size:18px;font-weight:700;color:#1a1a2e;">New contact-form submission</h1>
    <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;line-height:1.6;">
      <tr><td style="color:#6b7280;width:110px;padding:4px 0;">Reference</td><td style="font-weight:700;">${escapeHtml(refCode)}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0;">From</td><td>${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</td></tr>
      ${phone ? `<tr><td style="color:#6b7280;padding:4px 0;">Phone</td><td>${escapeHtml(phone)}</td></tr>` : ''}
      <tr><td style="color:#6b7280;padding:4px 0;">Subject</td><td>${escapeHtml(subject)}</td></tr>
      <tr><td style="color:#6b7280;padding:4px 0;vertical-align:top;">Submitted from</td><td style="word-break:break-all;">${escapeHtml(pageUri)}</td></tr>
    </table>
    <hr style="margin:20px 0;border:0;border-top:1px solid #e5e7eb;" />
    <div style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:#1a1a2e;">${escapeHtml(message)}</div>`;
  return renderEmailShell({ ...brand, preheader: `New enquiry from ${name} (${refCode})`, innerHtml: inner });
}

// ── Acknowledgement email (to the customer) ──────────────────────────────
function buildAckHtml(brand, { firstName, refCode, subject, message }) {
  const inner = `
    <h1 style="margin:0 0 14px;font-size:18px;font-weight:700;color:#1a1a2e;">Thanks &mdash; we&rsquo;ve got your message</h1>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">Hi ${escapeHtml(firstName)}, thanks for getting in touch with ${escapeHtml(brand.brandName)}. We&rsquo;ve received your message and will get back to you as soon as we can. Here&rsquo;s a copy for your records:</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;background:#f9fafb;border:1px solid #eee;border-radius:8px;">
      <tr><td style="padding:12px 16px;">
        <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;line-height:1.6;">
          <tr><td style="color:#6b7280;width:90px;padding:4px 0;vertical-align:top;">Reference</td><td style="font-weight:700;">${escapeHtml(refCode)}</td></tr>
          <tr><td style="color:#6b7280;padding:4px 0;vertical-align:top;">Subject</td><td>${escapeHtml(subject)}</td></tr>
          <tr><td style="color:#6b7280;padding:4px 0;vertical-align:top;">Message</td><td style="white-space:pre-wrap;">${escapeHtml(message)}</td></tr>
        </table>
      </td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">No need to reply to this email &mdash; it&rsquo;s just confirmation we&rsquo;ve received your enquiry. Quote <strong>${escapeHtml(refCode)}</strong> if you contact us about it.</p>`;
  return renderEmailShell({ ...brand, preheader: `We&rsquo;ve received your message — ${brand.brandName}`, innerHtml: inner });
}

// ── Handler ──────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  // ── Env-var sanity check ────────────────────────────────────────
  const SANITY_PROJECT_ID = process.env.SANITY_PROJECT_ID || '';
  const SANITY_DATASET = process.env.SANITY_DATASET || 'production';
  const SANITY_TOKEN = process.env.SANITY_API_TOKEN || process.env.SANITY_TOKEN || '';
  const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
  const NOTIFICATION_FROM = process.env.NOTIFICATION_FROM || '';
  const NOTIFICATION_TO = process.env.NOTIFICATION_TO || '';
  const BRAND_NAME = process.env.BRAND_NAME || 'Website';
  const SITE_URL = process.env.SITE_URL || '';
  const LOGO_URL = process.env.LOGO_URL || '';
  const EMAIL_HEADER_BG = process.env.EMAIL_HEADER_BG || '#0e0e14';
  const BRAND_ACCENT = process.env.BRAND_ACCENT || EMAIL_HEADER_BG;

  if (!SANITY_PROJECT_ID || !SANITY_TOKEN || !RESEND_API_KEY || !NOTIFICATION_TO) {
    console.error('contact endpoint misconfigured: missing required env vars');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: 'Server configuration error.' }),
    };
  }

  const brand = {
    brandName: BRAND_NAME,
    logoUrl: LOGO_URL,
    headerBg: EMAIL_HEADER_BG,
    accent: BRAND_ACCENT,
    siteUrl: SITE_URL,
  };

  // ── Parse + validate ────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Invalid request body.' }) };
  }

  // Honeypot — silently 200 so bots think they succeeded
  if (typeof payload.botcheck === 'string' && payload.botcheck.length > 0) {
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, refCode: 'MSG-IGNORED' }) };
  }

  const name = sanitiseString(payload.name, 120);
  const email = sanitiseString(payload.email, 200);
  const phone = sanitiseString(payload.phone, 80);
  const subject = sanitiseString(payload.subject, 200) || 'General Enquiry';
  const message = sanitiseString(payload.message, 5000);
  const pageUri = sanitiseString(payload.pageUri, 500);

  if (!name || !email || !message) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, error: 'Name, email, and message are required.' }),
    };
  }
  if (!isValidEmail(email)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, error: 'Please provide a valid email address.' }),
    };
  }

  // ── Clients (constructed per request so env vars are read at runtime,
  //    never captured at module init — same pattern as Metavision) ───
  const sanity = createClient({
    projectId: SANITY_PROJECT_ID,
    dataset: SANITY_DATASET,
    apiVersion: '2024-12-01',
    token: SANITY_TOKEN,
    useCdn: false,
  });
  const resend = new Resend(RESEND_API_KEY);

  // ── Rate-limit: 3 submissions per IP per rolling 10 minutes ─────
  const ip = extractIp(event);
  const submitterIp = hashIp(ip);
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recentCount = await sanity.fetch(
      `count(*[_type == "contactSubmission" && submitterIp == $h && submittedAt > $since])`,
      { h: submitterIp, since: tenMinAgo }
    );
    if (recentCount >= 3) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ success: false, error: 'Too many submissions \u2014 please try again shortly.' }),
      };
    }
  } catch (err) {
    // A failed rate-limit check shouldn't block legitimate submissions.
    console.warn('rate-limit check failed (continuing):', err && err.message);
  }

  // ── Write to Sanity ─────────────────────────────────────────────
  const refCode = generateRefCode();
  const submittedAt = new Date().toISOString();
  const userAgent = sanitiseString(
    (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '',
    500
  );

  try {
    const doc: Record<string, unknown> = {
      _type: 'contactSubmission',
      refCode,
      status: 'new',
      name,
      email,
      subject,
      message,
      submittedAt,
      pageUri,
      userAgent,
      submitterIp,
    };
    if (phone) doc.phone = phone;
    await sanity.create(doc as any);
  } catch (err) {
    console.error('Sanity write failed:', err && err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: 'Could not save your message. Please try again or email us directly.' }),
    };
  }

  const firstName = firstNameOf(name);
  const fromAddress = NOTIFICATION_FROM || `${BRAND_NAME} <no-reply@example.com>`;

  // ── Team notification (best-effort — submission already saved) ──
  try {
    await resend.emails.send({
      from: fromAddress,
      to: NOTIFICATION_TO,
      replyTo: email,
      subject: `[${BRAND_NAME}] ${subject} \u2014 ${refCode}`,
      html: buildNotificationHtml(brand, { refCode, name, email, phone, subject, message, pageUri }),
      text:
        `New contact-form submission\n\n` +
        `Reference: ${refCode}\n` +
        `From: ${name} <${email}>\n` +
        (phone ? `Phone: ${phone}\n` : '') +
        `Subject: ${subject}\n` +
        `Submitted from: ${pageUri}\n\n` +
        `${message}`,
    });
  } catch (err) {
    console.error('notification email failed (submission still saved):', err && err.message);
  }

  // ── Customer acknowledgement (best-effort — submission already saved) ──
  try {
    await resend.emails.send({
      from: fromAddress,
      to: email,
      replyTo: NOTIFICATION_TO,
      subject: `We\u2019ve received your message \u2014 ${BRAND_NAME} (${refCode})`,
      html: buildAckHtml(brand, { firstName, refCode, subject, message }),
      text:
        `Hi ${firstName},\n\n` +
        `Thanks for getting in touch with ${BRAND_NAME}. We've received your message and will get back to you as soon as we can.\n\n` +
        `Reference: ${refCode}\n` +
        `Subject: ${subject}\n\n` +
        `Your message:\n${message}\n\n` +
        `No need to reply — this is just confirmation. Quote ${refCode} if you contact us about it.\n\n` +
        `${BRAND_NAME}${SITE_URL ? `\n${SITE_URL}` : ''}`,
    });
  } catch (err) {
    console.error('acknowledgement email failed (submission still saved):', err && err.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, refCode }),
  };
};
