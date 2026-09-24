import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

/**
 * Spend guards for the styling pipeline.
 *
 * Every comic style call costs money, and nothing upstream of this module has
 * any idea how much has been spent today. The counters, all in Netlify Blobs:
 *
 *   per visitor   new personalisations per hour, and style calls per rolling 24h
 *                 -- counted PER TEMPLATE FAMILY, see below. Every one of them
 *                 is read from the environment per request, so the shop can be
 *                 tuned without a deploy and no single hardcoded number can
 *                 quietly become the one that binds.
 *   site-wide     style calls per UTC day, with a circuit breaker above it --
 *                 one counter per ORIGIN, so internal work and customer traffic
 *                 cannot exhaust each other
 *
 * TWO BUDGETS, NOT ONE POOL. Catalogue generation and customer traffic used to
 * share a single daily ceiling, which meant a batch of internal work could shut
 * the live builder for the rest of the day. They now have a counter each --
 * STYLE_DAILY_MAX for customers, STUDIO_STYLE_DAILY_MAX for studio work -- and
 * neither can draw the other down. Both are real limits: running out of studio
 * budget pauses studio work exactly as running out of customer budget pauses a
 * customer's, and there is deliberately no bypass, no unlimited mode and no way
 * to reset either counter from a request.
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

/* ---------------------------------------------------------------- origins */

/**
 * Which budget a style call spends from.
 *
 * A document carries its origin from the moment it is created, so every later
 * caller -- the styler, the retry endpoint, the resume sweep -- bills and
 * checks the same counter without having to work it out again from whatever
 * request happens to be in flight.
 */
export const CUSTOMER = 'customer';
export const STUDIO = 'studio';
export const ORIGINS = [CUSTOMER, STUDIO];

/**
 * An origin, or the customer one.
 *
 * Anything unrecognised -- absent, misspelt, a value from a document written
 * before this field existed -- reads as `customer`. That direction is the safe
 * one: an unknown origin spends the budget that is watched most closely and
 * refills on the same schedule, rather than quietly finding its way onto the
 * internal one.
 */
export const originOr = (value) => (value === STUDIO ? STUDIO : CUSTOMER);

/**
 * New pendingPersonalisation documents one visitor may create in an hour.
 *
 * A CONSTANT no longer, and the reason is worth keeping: every style allowance
 * around it became tunable from the environment and this one did not, so it
 * quietly became the ceiling that actually bound. Raising STYLE_LIMIT_STRIPS to
 * let somebody make five strips does nothing at all if they cannot create more
 * than four designs in the hour it takes them to try -- and nothing in the logs
 * says that is what happened, because the refusal names the designs guard and
 * not the allowance it is standing in front of.
 *
 * Exported as the DEFAULT, not as the limit. Read newDesignsPerHourLimit() for
 * the number in force: a constant captured at import time cannot be changed
 * without a deploy, which is the whole thing being fixed.
 */
export const DEFAULT_NEW_DESIGNS_PER_HOUR = 4;

/* ------------------------------------------------------- template families */

/**
 * What a build costs depends entirely on what it is.
 *
 * A cover and an icon are ONE panel: a complete build is one style call, and
 * everything after that is the customer trying again. A strip is TWELVE: a
 * complete build is twelve calls before anyone has changed their mind about
 * anything. One flat allowance across all three -- which is what was here --
 * therefore means the same number is generous for a cover and barely a single
 * attempt at a strip, and a customer who made a strip in the morning had spent
 * most of the day's covers by lunchtime.
 *
 * So: a counter per family, and a limit that reflects what the family costs.
 * A customer's strip usage cannot touch their cover allowance, or the reverse.
 */
export const COVERS = 'covers';
export const ICONS = 'icons';
export const STRIPS = 'strips';
export const TEMPLATE_FAMILIES = [COVERS, ICONS, STRIPS];

const FAMILY_BY_TEMPLATE = {
  cover: COVERS,
  'cover-fullbleed': COVERS,
  'icon-portrait': ICONS,
  'icon-landscape': ICONS,
  strip: STRIPS,
};

/**
 * Which allowance a template spends from.
 *
 * An unrecognised template -- absent, misspelt, a template added later and not
 * listed here -- counts as a cover. That is the tightest of the three, so a
 * gap in this table costs a customer some attempts rather than handing out a
 * strip's worth of calls to anything that turns up with no name.
 */
export const familyForTemplate = (templateId) => FAMILY_BY_TEMPLATE[templateId] || COVERS;

/**
 * Billed style calls one visitor may make per family, per rolling 24 hours.
 *
 * Measured against what a build actually costs as the code stands:
 *
 *   covers   1 call a build (one panel)  -> 5 is one build and four re-tries
 *   icons    1 call a build (one panel)  -> 5 is one build and four re-tries
 *   strips  12 calls a build (12 panels) -> 30 is two complete strips and six
 *
 * The per-design cap (MAX_STYLE_CALLS, 16) sits underneath all of them and is
 * unchanged: no single design may ever spend more than sixteen calls, however
 * much daily allowance is left.
 */
export const DEFAULT_STYLE_LIMITS = {
  [COVERS]: 5,
  [ICONS]: 5,
  [STRIPS]: 30,
};

const LIMIT_ENV = {
  [COVERS]: 'STYLE_LIMIT_COVERS',
  [ICONS]: 'STYLE_LIMIT_ICONS',
  [STRIPS]: 'STYLE_LIMIT_STRIPS',
};

/* The designs guard rides with them. It limits documents rather than style
   calls, so it is not a member of the family above -- but it is the same kind
   of dial, it is tuned in the same conversation, and sharing the prefix is what
   puts it next to them in a list of environment variables instead of somewhere
   else alphabetically. */
const DESIGNS_ENV = 'STYLE_LIMIT_DESIGNS_PER_HOUR';

/** One family's daily allowance, overridable in the Netlify UI without a deploy. */
export function styleLimitFor(family) {
  const fam = TEMPLATE_FAMILIES.includes(family) ? family : COVERS;
  const n = Number.parseInt(String(process.env[LIMIT_ENV[fam]] ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STYLE_LIMITS[fam];
}

/** The blob field a family's counter lives in. */
const styleField = (family) => `style-${TEMPLATE_FAMILIES.includes(family) ? family : COVERS}`;
/** Site-wide style calls per UTC day, unless STYLE_DAILY_MAX says otherwise. */
export const DEFAULT_STYLE_DAILY_MAX = 300;
/* Studio work per UTC day, unless STUDIO_STYLE_DAILY_MAX says otherwise.
   Deliberately small. A catalogue batch is twenty photographs and a handful of
   retries, and the number this defaults to is the one that applies on a deploy
   where nobody has thought about it -- so it should be enough to do a day's
   work and not enough to run up a bill nobody noticed. Raising it is one
   environment variable and no deploy. */
export const DEFAULT_STUDIO_STYLE_DAILY_MAX = 40;
/** How long a visitor's counters are kept after their last write. */
export const VISITOR_RETENTION_HOURS = 48;
/** How long a day's site-wide counter is kept, for reading back after the fact. */
export const GLOBAL_RETENTION_DAYS = 7;

/* Hour granularity for the rolling window: 24 buckets covers between 23 and 24
   hours of history, which is the accuracy this is worth. Storing a timestamp
   per call would be exact and would also grow a document by a row per call. */
const WINDOW_HOURS = 24;

const SALT_FALLBACK = 'csc-style-guard-v1';

/** Shown to the customer when the designs-per-hour guard refuses an upload. */
export const LIMIT_MESSAGE =
  "You've reached today's limit for new designs — please try again later, " +
  'or contact us if you\'re working on something big.';

/* ------------------------------------------- out of style attempts for today */

/**
 * The end of a customer's daily allowance, which is not a failure and must not
 * read like one.
 *
 * They have done nothing wrong, their photographs are safe, and there is
 * something we can actually do for them -- so the message says all three and
 * hands them a way to ask. The first two sentences are the shop's words,
 * unchanged; the third is the part the builder needs in order to be honest
 * about what happens next.
 */
export const STYLE_LIMIT_MESSAGE =
  "You've reached the maximum number of style attempts for today. Send your photo "
  + "to our artwork team and we'll put a proof together for you.";

/** Said underneath it, because "is my work gone?" is the next question. */
export const STYLE_LIMIT_KEEPS =
  'Your photos and everything you have built are saved. You can carry on tomorrow, '
  + 'or send them over now and we will take it from here.';

export const STYLE_LIMIT_CTA_LABEL = 'Send your photo to our artwork team';

/**
 * Where that button goes.
 *
 * The contact form rather than a mailto: a mailto opens nothing at all for
 * anyone on webmail, which is most people, and a dead button at the exact
 * moment somebody is already frustrated is worse than no button. The form is
 * already built, already has Turnstile and the honeypot in front of it, and
 * already reaches the team.
 *
 * `ref` is the build id, so whoever answers can find the photographs that are
 * already uploaded instead of asking for them again. It is an opaque id and
 * grants no access to anything -- the proof and thumbnail endpoints carry their
 * own unguessable tokens -- and no name, address or email ever goes in the URL.
 */
export function styleLimitCta(buildId) {
  const params = new URLSearchParams({ subject: 'Custom Order', topic: 'artwork-proof' });
  if (buildId) params.set('ref', String(buildId));
  return `/contact?${params.toString()}`;
}

/**
 * Everything the builder needs to render the state, from the server.
 *
 * The wording lives here for the same reason the paused wording does: the
 * panel, the Studio row and anything else that has to describe this should not
 * be able to disagree about it.
 */
export const styleLimitNotice = (buildId, family) => ({
  text: STYLE_LIMIT_MESSAGE,
  keeps: STYLE_LIMIT_KEEPS,
  ctaLabel: STYLE_LIMIT_CTA_LABEL,
  ctaHref: styleLimitCta(buildId),
  family: TEMPLATE_FAMILIES.includes(family) ? family : null,
  resetsOn: 'a rolling 24 hours from each call',
});

/** Shown on a panel whose styling is waiting for the breaker to reset. */
export const BUSY_MESSAGE = "We're unusually busy — your comic style will be applied shortly";

/* The same state, said to whoever is actually looking at it. A customer is told
   the shop is busy, because from where they are standing that is the whole
   truth and the wait is the only part that concerns them. Someone working in
   the Studio needs the other half: which budget ran out, and what to change. */
export const STUDIO_BUSY_MESSAGE =
  "The studio's daily styling budget is spent — this artwork will be styled when "
  + 'the budget resets at midnight UTC, or sooner if STUDIO_STYLE_DAILY_MAX is raised.';

/** The message for a paused panel, given which budget paused it. */
export const busyMessageFor = (origin) =>
  (originOr(origin) === STUDIO ? STUDIO_BUSY_MESSAGE : BUSY_MESSAGE);

/**
 * A site-wide ceiling, overridable in the Netlify UI without a deploy.
 *
 * Defaults to the customer ceiling when asked without an origin, so every
 * existing caller keeps the meaning it had.
 */
export function styleDailyMax(origin = CUSTOMER) {
  const studio = originOr(origin) === STUDIO;
  const raw = studio ? process.env.STUDIO_STYLE_DAILY_MAX : process.env.STYLE_DAILY_MAX;
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(n) && n > 0) return n;
  return studio ? DEFAULT_STUDIO_STYLE_DAILY_MAX : DEFAULT_STYLE_DAILY_MAX;
}

/**
 * How many new designs one visitor may start in an hour, right now.
 *
 * Read per request, like every limit beside it, so the number can be changed in
 * the Netlify UI and the next upload sees it. Nonsense -- absent, zero,
 * negative, fractional, a word -- falls back to the default rather than being
 * interpreted, because a guard that switches itself off over a typo is worse
 * than one that ignores it.
 */
export function newDesignsPerHourLimit() {
  const n = Number.parseInt(String(process.env[DESIGNS_ENV] ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NEW_DESIGNS_PER_HOUR;
}

/** The studio ceiling, named rather than passed as an argument. */
export const studioStyleDailyMax = () => styleDailyMax(STUDIO);

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

/**
 * Which budget this request may spend from.
 *
 * NEVER taken on trust. `claimed` is whatever the request said about itself,
 * and by itself it means nothing at all: a customer who posts origin=studio
 * would otherwise be spending the internal budget and walking past their own.
 * So a claim of `studio` is only honoured when the request also carries the
 * studio's shared secret -- the same one studio-save requires, and the only
 * studio proof that exists at the API layer. /admin/* Basic Auth guards the
 * page and never sees a function call, so it cannot be the thing that decides
 * this.
 *
 * Everything else, including every request that says nothing, is a customer.
 */
export function requestOrigin(req, { claimed = null } = {}) {
  if (originOr(claimed) !== STUDIO) return CUSTOMER;
  const expected = process.env.CSC_INTERNAL_SECRET;
  if (!expected) {
    console.warn('spend-guard: a request claimed the studio origin but no secret is configured');
    return CUSTOMER;
  }
  const given = req?.headers?.get ? req.headers.get('x-csc-internal-secret') : null;
  if (!sameSecret(given, expected)) {
    console.warn('spend-guard: a request claimed the studio origin with a bad or missing secret');
    return CUSTOMER;
  }
  return STUDIO;
}

/* Constant-time, and length-safe: a mismatched length returns before the loop,
   which leaks the length of the expected value and nothing else. studio-save
   carries its own identical copy; they are six lines each and merging them is
   a refactor for another branch, not something to do while changing what the
   counters mean. */
function sameSecret(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
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
/* A prefix per origin rather than a field inside one document, for the same
   reason the visitor's two counters are separate keys: the two are written by
   unrelated callers and must not contend, and a studio batch must not be able
   to lose a customer's increment to a compare-and-swap it won. The customer
   path keeps the key it has always had, so today's counters keep counting and
   nothing needs migrating. */
const globalPath = (day, origin = CUSTOMER) =>
  (originOr(origin) === STUDIO ? `global-studio/${day}.json` : `global/${day}.json`);
/** Every prefix a day counter can live under, for the sweeper. */
const GLOBAL_PREFIXES = ORIGINS.map((o) => globalPath('', o).replace('.json', ''));

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
 * `styleCalls24h` is the family's own count, not a total across all three: the
 * whole point of the split is that they are separate allowances, and a number
 * that added them up would be the flat limit again wearing a different name.
 *
 * @returns {{ designsThisHour, styleCalls24h, family, limit, remaining, hour }}
 */
export async function readVisitor(store, key, { templateId = null, family = null, now = new Date() } = {}) {
  const fam = family || familyForTemplate(templateId);
  const [designs, style] = await Promise.all([
    readJson(store, visitorPath(key, 'designs')),
    readJson(store, visitorPath(key, styleField(fam))),
  ]);
  const hour = hourBucket(now);
  const calls = sumWindow(style?.hours, windowHours(now));
  const limit = styleLimitFor(fam);
  return {
    designsThisHour: Number(designs?.hours?.[hour]) || 0,
    styleCalls24h: calls,
    family: fam,
    limit,
    remaining: Math.max(0, limit - calls),
    hour,
  };
}

/** Every family's count at once, for a log line or a report. */
export async function readVisitorAll(store, key, now = new Date()) {
  const out = {};
  for (const fam of TEMPLATE_FAMILIES) {
    out[fam] = await readVisitor(store, key, { family: fam, now });
  }
  return out;
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
 * @returns {{ ok, reason, designsThisHour, designsLimit, styleCalls24h, family, limit }}
 */
export async function checkVisitor(store, key, { newDesign = false, templateId = null, now = new Date() } = {}) {
  let counts;
  try {
    counts = await readVisitor(store, key, { templateId, now });
  } catch (err) {
    console.warn(`spend-guard: ${key} could not be read, allowing: ${err.message}`);
    return {
      ok: true, reason: null, designsThisHour: 0, styleCalls24h: 0,
      designsLimit: newDesignsPerHourLimit(),
      family: familyForTemplate(templateId), limit: styleLimitFor(familyForTemplate(templateId)),
      remaining: null,
    };
  }

  /* Both numbers travel with the verdict, so a caller can say which ceiling it
     hit and what that ceiling was without importing either. The log line for
     this refusal used to name the count and not the limit, which made a tuned
     deploy and an untuned one read identically. */
  const designsLimit = newDesignsPerHourLimit();
  if (newDesign && counts.designsThisHour >= designsLimit) {
    return { ...counts, designsLimit, ok: false, reason: 'visitor-designs-per-hour' };
  }
  /* Out of attempts for this family is NOT a refusal of the upload any more.
     The caller stores the photograph, marks the panel `limited` and shows the
     customer the way to the artwork team -- see STYLE_LIMIT_MESSAGE. The
     reason names the family so a log line says which allowance ran out. */
  if (counts.styleCalls24h >= counts.limit) {
    return { ...counts, designsLimit, ok: false, reason: `visitor-style-limit-${counts.family}` };
  }
  return { ...counts, designsLimit, ok: true, reason: null };
}

/** Did this verdict run out of style attempts, rather than designs per hour? */
export const isStyleLimit = (reason) => /^visitor-style-limit-/.test(String(reason || ''));

/**
 * True while this visitor still has room for another billed style call on this
 * family. The family matters: a customer with no cover attempts left may still
 * have twenty-eight strip calls in hand, and a resume that asked the wrong one
 * would either stall good work or spend an allowance that is gone.
 */
export async function visitorHasStyleBudget(store, key, now = new Date(), templateId = null) {
  const { styleCalls24h, limit } = await readVisitor(store, key, { templateId, now });
  return styleCalls24h < limit;
}

/**
 * Move one of a visitor's counters. `delta` is normally +1, or -1 for a refund.
 *
 * Pruning happens here rather than on a schedule: every write already has the
 * whole document in hand, and a document that is never written again is
 * collected by retention rather than growing.
 */
export async function bumpVisitor(store, key, field, delta, now = new Date()) {
  /* 'designs', or a family -- 'covers' / 'icons' / 'strips', which is stored as
     style-<family>. Anything else would silently open a counter nobody reads,
     so it is named here rather than accepted. */
  const path = field === 'designs' ? 'designs' : styleField(field);
  const hour = hourBucket(now);
  /* Prune what has EXPIRED, not everything outside the window. ISO hour labels
     sort chronologically as strings, so this is a comparison and not a set
     membership test -- and the difference matters: a set of the last 24 hours
     also excludes the hours ahead of now, so a write whose clock ran a moment
     behind another one would delete that other one's bucket. */
  const oldest = windowHours(now)[WINDOW_HOURS - 1];
  return update(store, visitorPath(key, path), (doc) => {
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
export async function readGlobal(store, now = new Date(), origin = CUSTOMER) {
  const which = originOr(origin);
  const day = dayBucket(now);
  const doc = await readJson(store, globalPath(day, which));
  const max = styleDailyMax(which);
  const calls = Number(doc?.calls) || 0;
  return {
    origin: which,
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
export async function bumpGlobal(store, delta, now = new Date(), origin = CUSTOMER) {
  const which = originOr(origin);
  const max = styleDailyMax(which);
  let before = 0;
  const doc = await update(store, globalPath(dayBucket(now), which), (existing) => {
    const next = existing
      || { day: dayBucket(now), origin: which, calls: 0, createdAt: now.toISOString() };
    before = Number(next.calls) || 0;
    next.calls = Math.max(0, before + delta);
    next.max = max;
    next.origin = which;
    if (next.calls >= max && !next.trippedAt) next.trippedAt = now.toISOString();
    next.updatedAt = now.toISOString();
    return next;
  });
  const calls = Number(doc?.calls) || 0;
  return {
    origin: which, calls, max,
    tripped: calls >= max,
    crossed: before < max && calls >= max,
  };
}

/**
 * Claim the right to send today's breaker email.
 *
 * Exactly one caller gets true per UTC day, whichever asks first; everyone else
 * gets false and stays quiet. Claimed BEFORE the send rather than after, so a
 * Resend outage costs one missing email rather than one per refused upload.
 */
export async function claimBreakerNotice(store, now = new Date(), origin = CUSTOMER) {
  /* A nonce rather than a timestamp comparison. Two callers a second apart
     would both find a fresh-looking notifiedAt and both send; only the one
     whose own mark survived the compare-and-swap may claim it. */
  const which = originOr(origin);
  const nonce = crypto.randomUUID();
  /* Per origin, so a studio budget running out still gets its own email even
     though a customer one already sent today's. They are different facts about
     different money. */
  await update(store, globalPath(dayBucket(now), which), (existing) => {
    const next = existing
      || { day: dayBucket(now), origin: which, calls: 0, createdAt: now.toISOString() };
    if (next.notifiedAt) return null;            // someone already has it
    next.notifiedAt = now.toISOString();
    next.notifyNonce = nonce;
    next.trippedAt = next.trippedAt || now.toISOString();
    return next;
  });
  const after = await readJson(store, globalPath(dayBucket(now), which));
  return after?.notifyNonce === nonce;
}

/* ------------------------------------- telling somebody a customer is stuck */

/* Two days kept, not one. A claim made at 23:59 and a second attempt at 00:01
   are different days, and the older row has to survive long enough for that
   boundary to be visible rather than silently reopening the claim. Anything
   older than that is noise, and retention collects the whole document once the
   visitor has been quiet for VISITOR_RETENTION_HOURS. */
const NOTICE_DAYS_KEPT = 2;

/**
 * Claim the right to tell the team that this visitor has run out of attempts.
 *
 * Exactly one caller gets true per visitor per UTC day, whichever asks first.
 * Everyone else gets false and stays quiet, so a customer who taps Replace
 * eight times produces one email rather than eight -- and all three of the
 * places that can notice this (the upload, the retry endpoint and the styler
 * itself) go through the same claim, so they cannot each send their own.
 *
 * The same shape as claimBreakerNotice, and for the same reason: a nonce
 * written through a compare-and-swap, not a timestamp compared afterwards. Two
 * callers a second apart would both find a fresh-looking mark and both send;
 * only the one whose own nonce survived the write may claim it.
 *
 * Claimed BEFORE the send, so an email provider having a bad minute costs one
 * missing notification rather than one per refusal.
 */
export async function claimStyleLimitNotice(store, key, now = new Date(), detail = {}) {
  const day = dayBucket(now);
  const nonce = crypto.randomUUID();
  await update(store, visitorPath(key, 'notified'), (doc) => {
    const next = doc || { days: {}, createdAt: now.toISOString() };
    next.days = next.days || {};
    if (next.days[day]) return null;            // somebody already has today
    for (const d of Object.keys(next.days)) {
      if (d < dayBucket(new Date(now.getTime() - (NOTICE_DAYS_KEPT - 1) * 86400_000))) {
        delete next.days[d];
      }
    }
    next.days[day] = {
      at: now.toISOString(),
      nonce,
      /* What it was about, so the record says something on its own. None of
         this identifies anybody: the key is already a salted hash and the
         build id is opaque. */
      family: detail.family || null,
      buildId: detail.buildId || null,
    };
    next.updatedAt = now.toISOString();
    return next;
  });
  const after = await readJson(store, visitorPath(key, 'notified'));
  return after?.days?.[day]?.nonce === nonce;
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

  /* Both prefixes, from ORIGINS rather than a literal list: adding a third
     budget must not silently leave its counters uncollected. */
  for (const prefix of GLOBAL_PREFIXES) {
    try {
      const { blobs } = await s.list({ prefix });
      for (const b of blobs) {
        const day = Date.parse((b.key.split('/').pop() || '').replace('.json', ''));
        if (!Number.isFinite(day) || day > dayCutoff) { report.kept++; continue; }
        if (!dryRun) await s.delete(b.key);
        report.days++;
      }
    } catch (err) {
      report.errors.push(`days (${prefix}): ${err.message}`);
    }
  }

  const label = dryRun ? 'spend-guard sweep (DRY RUN)' : 'spend-guard sweep';
  console.log(
    `${label}: ${report.visitors} visitor counter(s) and ${report.days} day counter(s) ` +
    `past their window, ${report.kept} kept.`
  );
  return report;
}
