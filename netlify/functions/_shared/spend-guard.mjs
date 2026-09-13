import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

/**
 * Spend guards for the styling pipeline.
 *
 * Every comic style call costs money, and nothing upstream of this module has
 * any idea how much has been spent today. Three counters, all in Netlify Blobs:
 *
 *   per visitor   new personalisations per hour, and style calls per rolling 24h
 *   site-wide     style calls per UTC day, with a circuit breaker above it
 *
 * A visitor is a salted hash of the client IP and nothing else. The raw address
 * is never written anywhere -- not to a blob, not to Sanity, not to a log line.
 * The salt comes from STYLE_GUARD_SALT; the fallback below keeps the guard
 * working on a deploy where nobody set it, at the cost of the hash being
 * guessable by anyone who has read this file. That trade is deliberate: a guard
 * that silently switches itself off because an env var is missing is worse than
 * one whose key space is known, because nothing about the key is a secret to
 * begin with -- it identifies a bucket, it does not authorise anything.
 *
 * WHAT COUNTS. Only a call that will actually be billed. A dedupe hit reuses a
 * styled photograph and never reaches the model, and a refusal that never
 * reached the model is refunded -- so the increment lives at the one point in
 * the pipeline where a generation is genuinely about to happen, in
 * style-photo-background, beside the per-design styleCalls increment, and the
 * refund path decrements both. The checks at the entry points read those
 * counters; they never write them.
 *
 * EXPIRY. Blobs carry no TTL, so the counters expire by being keyed on the
 * window they belong to: an hour bucket inside a per-visitor document, a day
 * for the site-wide one. Buckets outside the window are pruned on every write,
 * so a visitor document cannot grow without bound, and retention.mjs deletes
 * documents nobody has touched for VISITOR_RETENTION_HOURS.
 *
 * CONCURRENCY. Blobs have no atomic increment, so every write is a
 * compare-and-swap against the entry's etag with a bounded retry. Two style
 * calls finishing in the same instant therefore cost two, not one.
 */

export const GUARD_STORE = 'spend-guard';

/** New pendingPersonalisation documents one visitor may create in an hour. */
export const MAX_NEW_DESIGNS_PER_HOUR = 4;
/** Billed style calls one visitor may make in a rolling 24 hours. */
export const MAX_VISITOR_STYLE_CALLS_PER_DAY = 40;
/** Site-wide style calls per UTC day, unless STYLE_DAILY_MAX says otherwise. */
export const DEFAULT_STYLE_DAILY_MAX = 300;
/** How long a visitor's counters are kept after their last write. */
export const VISITOR_RETENTION_HOURS = 48;
/** How long a day's site-wide counter is kept, for reading back after the fact. */
export const GLOBAL_RETENTION_DAYS = 7;

/* Hour granularity for the rolling window: 24 buckets covers between 23 and 24
   hours of history, which is the accuracy this is worth. Storing a timestamp
   per call would be exact and would also grow a document by a row per call. */
const WINDOW_HOURS = 24;

const SALT_FALLBACK = 'csc-style-guard-v1';

/** Shown to the customer when a per-visitor limit refuses an upload. */
export const LIMIT_MESSAGE =
  "You've reached today's limit for new designs — please try again later, " +
  'or contact us if you\'re working on something big.';

/** Shown on a panel whose styling is waiting for the breaker to reset. */
export const BUSY_MESSAGE = "We're unusually busy — your comic style will be applied shortly";

/** The site-wide ceiling, overridable in the Netlify UI without a deploy. */
export function styleDailyMax() {
  const raw = process.env.STYLE_DAILY_MAX;
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STYLE_DAILY_MAX;
}

export const guardStore = () => getStore(GUARD_STORE);

/* ---------------------------------------------------------------- the key */

/**
 * The client's address, as Netlify reports it.
 *
 * context.ip is the platform's own answer and is not client-settable.
 * x-nf-client-connection-ip is the same value as a header, kept for the
 * scheduled and background paths where no context is passed. x-forwarded-for
 * is last and only its first entry is used -- everything after it is whatever
 * the client wanted to claim.
 */
export function clientIp(req, context) {
  const fromContext = context && typeof context.ip === 'string' ? context.ip.trim() : '';
  if (fromContext) return fromContext;
  const h = (name) => (req?.headers?.get ? (req.headers.get(name) || '').trim() : '');
  const nf = h('x-nf-client-connection-ip');
  if (nf) return nf;
  const fwd = h('x-forwarded-for').split(',')[0].trim();
  if (fwd) return fwd;
  return h('client-ip') || '';
}

/**
 * A visitor's counter key: a salted hash of their address, never the address.
 *
 * Short on purpose. 16 hex characters is 64 bits, which is far more than enough
 * to keep the handful of visitors in any one window apart, and it is what ends
 * up in the logs -- long enough to correlate two refusals, short enough to read.
 */
export function visitorKey(req, context) {
  const ip = clientIp(req, context);
  const salt = process.env.STYLE_GUARD_SALT || SALT_FALLBACK;
  const digest = crypto.createHash('sha256').update(`${salt}|${ip || 'unknown'}`).digest('hex');
  return `v${digest.slice(0, 16)}`;
}

/* ------------------------------------------------------------- the buckets */

/** '2026-09-13T04' — UTC, so the day the counters reset on is not local. */
export const hourBucket = (now = new Date()) => now.toISOString().slice(0, 13);
/** '2026-09-13' — UTC. */
export const dayBucket = (now = new Date()) => now.toISOString().slice(0, 10);

/** The WINDOW_HOURS hour labels ending at `now`, newest first. */
export function windowHours(now = new Date()) {
  const out = [];
  for (let i = 0; i < WINDOW_HOURS; i++) {
    out.push(hourBucket(new Date(now.getTime() - i * 3600_000)));
  }
  return out;
}

/* A key per counter, not a document holding both.

   The two are written by different functions at unrelated moments -- a new
   design is counted by the upload endpoint, a style call by the background
   styler -- and one blob holding both means those two writes contend for the
   same entry for no reason at all. Splitting them removes that contention
   entirely rather than relying on the compare-and-swap to sort it out, which
   matters wherever conditional writes are weaker than the production store's:
   a local dev run loses one of the two writes and the count quietly runs
   short. Two writers of the SAME counter still go through the CAS below. */
const visitorPath = (key, field) => `visitor/${key}/${field}.json`;
const globalPath = (day) => `global/${day}.json`;

const sumWindow = (buckets, hours) =>
  hours.reduce((n, h) => n + (Number(buckets?.[h]) || 0), 0);

/* ------------------------------------------------------- compare-and-swap */

/**
 * Read a JSON entry, hand it to `mutate`, and write the result back only if
 * nothing else changed it in between.
 *
 * `mutate` receives null when the key does not exist yet and may return null to
 * mean "leave it alone". A store that does not implement conditional writes --
 * the local dev emulation is not guaranteed to -- reports no `modified` flag,
 * and that is taken as success rather than looping until the attempts run out.
 */
let warnedAboutEtags = false;

async function update(store, key, mutate, { attempts = 12 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    /* Backoff with jitter from the second attempt on. Without it a strip
       finishing twelve panels at once livelocks: every writer reads the same
       etag, one wins, the other eleven retry in lockstep and collide again.
       The jitter is what breaks the lockstep, and a few tens of milliseconds
       is nothing against a call that took thirty-six seconds. */
    if (i) await new Promise((r) => setTimeout(r, 10 * i + Math.floor(Math.random() * 30)));
    let existing = null;
    try {
      existing = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    } catch (err) {
      lastError = err;
      existing = null;
    }
    const next = mutate(existing?.data ? JSON.parse(JSON.stringify(existing.data)) : null);
    if (next === null || next === undefined) return existing?.data ?? null;

    /* No etag means the store cannot do a conditional write, and the guard
       degrades to last-write-wins. Worth a line in the log rather than being
       silent about it: it is the difference between a counter that is exact
       and one that can run short under concurrency. */
    if (existing && !existing.etag && !warnedAboutEtags) {
      warnedAboutEtags = true;
      console.warn('spend-guard: this blob store returns no etag — counters cannot be compare-and-swapped');
    }
    const conditions = existing
      ? (existing.etag ? { onlyIfMatch: existing.etag } : {})
      : { onlyIfNew: true };
    try {
      const res = await store.setJSON(key, next, conditions);
      if (!res || res.modified !== false) return next;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `spend-guard: could not write ${key} after ${attempts} attempts` +
    (lastError ? ` (${lastError.message})` : ' (contention)')
  );
}

async function readJson(store, key) {
  try {
    return (await store.get(key, { type: 'json', consistency: 'strong' })) || null;
  } catch (err) {
    console.warn(`spend-guard: could not read ${key}: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------ per-visitor counts */

/**
 * What this visitor has spent.
 *
 * @returns {{ designsThisHour: number, styleCalls24h: number, hour: string }}
 */
export async function readVisitor(store, key, now = new Date()) {
  const [designs, style] = await Promise.all([
    readJson(store, visitorPath(key, 'designs')),
    readJson(store, visitorPath(key, 'style')),
  ]);
  const hour = hourBucket(now);
  return {
    designsThisHour: Number(designs?.hours?.[hour]) || 0,
    styleCalls24h: sumWindow(style?.hours, windowHours(now)),
    hour,
  };
}

/**
 * May this visitor do the thing they are asking for?
 *
 * `newDesign` is true for the upload that creates a personalisation. Both
 * limits are checked on every upload, not just the first: the 24-hour style
 * budget belongs to the visitor, so a second photo on an existing design is
 * just as much of a spend as the first one on a new design.
 *
 * Fails OPEN. If the counter store cannot be read the answer is yes -- a blob
 * store having a bad minute must not take the shop's builder down with it.
 *
 * @returns {{ ok: boolean, reason: string|null, designsThisHour, styleCalls24h }}
 */
export async function checkVisitor(store, key, { newDesign = false, now = new Date() } = {}) {
  let counts;
  try {
    counts = await readVisitor(store, key, now);
  } catch (err) {
    console.warn(`spend-guard: ${key} could not be read, allowing: ${err.message}`);
    return { ok: true, reason: null, designsThisHour: 0, styleCalls24h: 0 };
  }

  if (newDesign && counts.designsThisHour >= MAX_NEW_DESIGNS_PER_HOUR) {
    return { ...counts, ok: false, reason: 'visitor-designs-per-hour' };
  }
  if (counts.styleCalls24h >= MAX_VISITOR_STYLE_CALLS_PER_DAY) {
    return { ...counts, ok: false, reason: 'visitor-style-calls-24h' };
  }
  return { ...counts, ok: true, reason: null };
}

/** True while this visitor still has room for another billed style call. */
export async function visitorHasStyleBudget(store, key, now = new Date()) {
  const { styleCalls24h } = await readVisitor(store, key, now);
  return styleCalls24h < MAX_VISITOR_STYLE_CALLS_PER_DAY;
}

/**
 * Move one of a visitor's counters. `delta` is normally +1, or -1 for a refund.
 *
 * Pruning happens here rather than on a schedule: every write already has the
 * whole document in hand, and a document that is never written again is
 * collected by retention rather than growing.
 */
export async function bumpVisitor(store, key, field, delta, now = new Date()) {
  const hour = hourBucket(now);
  /* Prune what has EXPIRED, not everything outside the window. ISO hour labels
     sort chronologically as strings, so this is a comparison and not a set
     membership test -- and the difference matters: a set of the last 24 hours
     also excludes the hours ahead of now, so a write whose clock ran a moment
     behind another one would delete that other one's bucket. */
  const oldest = windowHours(now)[WINDOW_HOURS - 1];
  return update(store, visitorPath(key, field === 'designs' ? 'designs' : 'style'), (doc) => {
    const next = doc || { hours: {}, createdAt: now.toISOString() };
    next.hours = next.hours || {};
    for (const h of Object.keys(next.hours)) if (h < oldest) delete next.hours[h];
    next.hours[hour] = Math.max(0, (Number(next.hours[hour]) || 0) + delta);
    if (!next.hours[hour]) delete next.hours[hour];
    next.updatedAt = now.toISOString();
    return next;
  });
}

/* ------------------------------------------------------ the circuit breaker */

/**
 * Today's site-wide count and whether the breaker is open.
 *
 * Fails CLOSED-ish on a read error: `tripped` comes back false, so an
 * unreadable counter does not pause the whole shop. The per-design cap and the
 * per-visitor limits are still in force underneath it.
 */
export async function readGlobal(store, now = new Date()) {
  const day = dayBucket(now);
  const doc = await readJson(store, globalPath(day));
  const max = styleDailyMax();
  const calls = Number(doc?.calls) || 0;
  return {
    day,
    calls,
    max,
    remaining: Math.max(0, max - calls),
    tripped: calls >= max,
    trippedAt: doc?.trippedAt || null,
    notifiedAt: doc?.notifiedAt || null,
  };
}

/**
 * Move today's site-wide counter.
 *
 * @returns {{ calls, max, tripped, crossed }} — `crossed` is true only for the
 *          single increment that took the count from below the threshold to at
 *          or above it, which is the moment worth emailing about.
 */
export async function bumpGlobal(store, delta, now = new Date()) {
  const max = styleDailyMax();
  let before = 0;
  const doc = await update(store, globalPath(dayBucket(now)), (existing) => {
    const next = existing || { day: dayBucket(now), calls: 0, createdAt: now.toISOString() };
    before = Number(next.calls) || 0;
    next.calls = Math.max(0, before + delta);
    next.max = max;
    if (next.calls >= max && !next.trippedAt) next.trippedAt = now.toISOString();
    next.updatedAt = now.toISOString();
    return next;
  });
  const calls = Number(doc?.calls) || 0;
  return { calls, max, tripped: calls >= max, crossed: before < max && calls >= max };
}

/**
 * Claim the right to send today's breaker email.
 *
 * Exactly one caller gets true per UTC day, whichever asks first; everyone else
 * gets false and stays quiet. Claimed BEFORE the send rather than after, so a
 * Resend outage costs one missing email rather than one per refused upload.
 */
export async function claimBreakerNotice(store, now = new Date()) {
  /* A nonce rather than a timestamp comparison. Two callers a second apart
     would both find a fresh-looking notifiedAt and both send; only the one
     whose own mark survived the compare-and-swap may claim it. */
  const nonce = crypto.randomUUID();
  await update(store, globalPath(dayBucket(now)), (existing) => {
    const next = existing || { day: dayBucket(now), calls: 0, createdAt: now.toISOString() };
    if (next.notifiedAt) return null;            // someone already has it
    next.notifiedAt = now.toISOString();
    next.notifyNonce = nonce;
    next.trippedAt = next.trippedAt || now.toISOString();
    return next;
  });
  const after = await readJson(store, globalPath(dayBucket(now)));
  return after?.notifyNonce === nonce;
}

/* ------------------------------------------------------------- the sweeper */

/**
 * Delete counters whose window has passed. Called by retention.mjs.
 *
 * Visitor documents go by their last write, day counters by the date in their
 * key, so neither depends on a blob timestamp the store does not keep.
 */
export async function sweepGuardCounters({ dryRun = false, now = new Date(), store } = {}) {
  const s = store || guardStore();
  const report = { visitors: 0, days: 0, kept: 0, errors: [] };

  const visitorCutoff = now.getTime() - VISITOR_RETENTION_HOURS * 3600_000;
  const dayCutoff = now.getTime() - GLOBAL_RETENTION_DAYS * 86400_000;

  try {
    const { blobs } = await s.list({ prefix: 'visitor/' });
    for (const b of blobs) {
      const doc = await readJson(s, b.key);
      const touched = Date.parse(doc?.updatedAt || doc?.createdAt || '');
      if (!Number.isFinite(touched) || touched > visitorCutoff) { report.kept++; continue; }
      if (!dryRun) await s.delete(b.key);
      report.visitors++;
    }
  } catch (err) {
    report.errors.push(`visitors: ${err.message}`);
  }

  try {
    const { blobs } = await s.list({ prefix: 'global/' });
    for (const b of blobs) {
      const day = Date.parse((b.key.split('/').pop() || '').replace('.json', ''));
      if (!Number.isFinite(day) || day > dayCutoff) { report.kept++; continue; }
      if (!dryRun) await s.delete(b.key);
      report.days++;
    }
  } catch (err) {
    report.errors.push(`days: ${err.message}`);
  }

  const label = dryRun ? 'spend-guard sweep (DRY RUN)' : 'spend-guard sweep';
  console.log(
    `${label}: ${report.visitors} visitor counter(s) and ${report.days} day counter(s) ` +
    `past their window, ${report.kept} kept.`
  );
  return report;
}
