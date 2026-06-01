/**
 * netlify/functions/contact.mts
 *
 * Contact form intake for Wyrmfuel. Persists the submission as a Sanity
 * `contactSubmission` document, then sends a notification email via Resend.
 * Replaces the previous email-only handler.
 *
 * Flow:
 *   1. Validate request (POST, JSON body, required fields)
 *   2. Honeypot check (`botcheck` must be empty)
 *   3. Rate-limit by hashed IP (3 submissions per 10 minutes per IP)
 *   4. Write a Sanity doc (status: 'new', generated refCode)
 *   5. Send notification email via Resend (best-effort)
 *   6. Return { success: true, refCode }
 *
 * Sanity write happens BEFORE email send: if email fails, the submission
 * is still persisted and recoverable. The IP is never stored in plaintext —
 * only a salted SHA-256 hash for rate-limit deduplication.
 *
 * Env vars (Netlify):
 *   SANITY_PROJECT_ID, SANITY_DATASET, SANITY_API_TOKEN
 *   RESEND_API_KEY, NOTIFICATION_FROM, NOTIFICATION_TO
 *   BRAND_NAME, SITE_URL
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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Notification email HTML ──────────────────────────────────────────────
function buildNotificationHtml({ brandName, refCode, name, email, phone, subject, message, pageUri }) {
  return `
<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a2e;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <tr><td style="padding:20px 28px;background:#0e0e14;color:#fff;">
      <p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:0.6;">${escapeHtml(brandName)}</p>
      <h1 style="margin:4px 0 0;font-size:18px;font-weight:700;">New contact-form submission</h1>
    </td></tr>
    <tr><td style="padding:28px;">
      <table cellpadding="0" cellspacing="0" style="width:100%;font-size:14px;line-height:1.6;">
        <tr><td style="color:#6b7280;width:110px;padding:4px 0;">Reference</td><td style="font-weight:700;">${escapeHtml(refCode)}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 0;">From</td><td>${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</td></tr>
        ${phone ? `<tr><td style="color:#6b7280;padding:4px 0;">Phone</td><td>${escapeHtml(phone)}</td></tr>` : ''}
        <tr><td style="color:#6b7280;padding:4px 0;">Subject</td><td>${escapeHtml(subject)}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 0;vertical-align:top;">Submitted from</td><td style="word-break:break-all;">${escapeHtml(pageUri)}</td></tr>
      </table>
      <hr style="margin:20px 0;border:0;border-top:1px solid #e5e7eb;" />
      <div style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:#1a1a2e;">${escapeHtml(message)}</div>
    </td></tr>
  </table>
</body></html>`;
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

  if (!SANITY_PROJECT_ID || !SANITY_TOKEN || !RESEND_API_KEY || !NOTIFICATION_TO) {
    console.error('contact endpoint misconfigured: missing required env vars');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: 'Server configuration error.' }),
    };
  }

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

  // ── Email notification (best-effort — submission already saved) ─
  try {
    await resend.emails.send({
      from: NOTIFICATION_FROM || `${BRAND_NAME} <no-reply@example.com>`,
      to: NOTIFICATION_TO,
      replyTo: email,
      subject: `[${BRAND_NAME}] ${subject} \u2014 ${refCode}`,
      html: buildNotificationHtml({ brandName: BRAND_NAME, refCode, name, email, phone, subject, message, pageUri }),
    });
  } catch (err) {
    console.error('notification email failed (submission still saved):', err && err.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, refCode }),
  };
};
