/**
 * Tests for the spend guards, and in particular for the two daily budgets.
 *
 *   node tools/builder/guard-tests.mjs
 *
 * Nothing here touches Netlify, Sanity or the network: the blob store is an
 * in-memory stub that implements the parts spend-guard actually uses, etags
 * included, so the compare-and-swap path is exercised rather than skipped.
 *
 * The question these exist to answer is the one that is easy to get wrong and
 * impossible to see: that internal work and customer traffic really are drawing
 * from different pots, and that neither can spend the other's.
 */
import {
  CUSTOMER, STUDIO, ORIGINS, originOr, requestOrigin,
  DEFAULT_STYLE_DAILY_MAX, DEFAULT_STUDIO_STYLE_DAILY_MAX,
  styleDailyMax, studioStyleDailyMax,
  BUSY_MESSAGE, STUDIO_BUSY_MESSAGE, busyMessageFor,
  DEFAULT_NEW_DESIGNS_PER_HOUR, newDesignsPerHourLimit,
  COVERS, ICONS, STRIPS, TEMPLATE_FAMILIES, familyForTemplate, styleLimitFor,
  DEFAULT_STYLE_LIMITS, isStyleLimit, readVisitorAll,
  STYLE_LIMIT_MESSAGE, STYLE_LIMIT_KEEPS, STYLE_LIMIT_CTA_LABEL,
  styleLimitCta, styleLimitNotice, claimStyleLimitNotice,
  readGlobal, bumpGlobal, claimBreakerNotice,
  readVisitor, checkVisitor, bumpVisitor, visitorHasStyleBudget,
  hourBucket, dayBucket, sweepGuardCounters,
} from '../../netlify/functions/_shared/spend-guard.mjs';
import { notifyStyleLimit } from '../../netlify/functions/_shared/limit-email.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/** The parts of a Netlify Blobs store spend-guard uses, with working etags. */
function memStore() {
  const data = new Map();
  let seq = 0;
  return {
    data,
    async get(key, { type } = {}) {
      const e = data.get(key);
      if (!e) return null;
      return type === 'json' ? JSON.parse(e.json) : e.json;
    },
    async getWithMetadata(key, { type } = {}) {
      const e = data.get(key);
      if (!e) return null;
      return { data: type === 'json' ? JSON.parse(e.json) : e.json, etag: e.etag };
    },
    async setJSON(key, value, cond = {}) {
      const e = data.get(key);
      if (cond.onlyIfNew && e) return { modified: false };
      if (cond.onlyIfMatch && (!e || e.etag !== cond.onlyIfMatch)) return { modified: false };
      data.set(key, { json: JSON.stringify(value), etag: `etag-${++seq}` });
      return { modified: true };
    },
    async list({ prefix } = {}) {
      return {
        blobs: [...data.keys()]
          .filter((k) => !prefix || k.startsWith(prefix))
          .map((key) => ({ key })),
      };
    },
    async delete(key) { data.delete(key); },
  };
}

const NOW = new Date('2026-09-15T14:30:00Z');
const req = (headers = {}) => ({ headers: { get: (n) => headers[n.toLowerCase()] ?? null } });

/* ------------------------------------------------------------- 1. origins */

say('\n1. WHICH BUDGET A CALL SPENDS FROM\n');
{
  ok(ORIGINS.join(',') === 'customer,studio', 'two origins', ORIGINS.join(','));

  for (const v of [undefined, null, '', 'Studio', 'STUDIO', 'admin', 0, {}, 'customer']) {
    ok(originOr(v) === CUSTOMER, `${JSON.stringify(v)} reads as customer`, originOr(v));
  }
  ok(originOr(STUDIO) === STUDIO, 'only the exact value is studio');

  /* The claim on its own is worth nothing. If it were, a customer could post
     origin=studio and spend the internal budget instead of their own. */
  delete process.env.PERSONALISATION_ACTION_SECRET;
  ok(requestOrigin(req(), {}) === CUSTOMER, 'a request that says nothing is a customer');
  ok(requestOrigin(req(), { claimed: 'studio' }) === CUSTOMER,
    'a bare claim of studio is refused when no secret is configured');

  process.env.PERSONALISATION_ACTION_SECRET = 'the-studio-secret';
  ok(requestOrigin(req(), { claimed: 'studio' }) === CUSTOMER,
    'and refused when the request carries no secret at all');
  ok(requestOrigin(req({ 'x-csc-action-secret': 'wrong' }), { claimed: 'studio' }) === CUSTOMER,
    'and refused on a wrong secret');
  ok(requestOrigin(req({ 'x-csc-action-secret': 'the-studio-secreT' }), { claimed: 'studio' }) === CUSTOMER,
    'and on one that differs by a single character');
  ok(requestOrigin(req({ 'x-csc-action-secret': 'the-studio-secret' }), { claimed: 'studio' }) === STUDIO,
    'the right secret AND the claim together are what make it studio');
  ok(requestOrigin(req({ 'x-csc-action-secret': 'the-studio-secret' }), {}) === CUSTOMER,
    'the secret alone does not — nothing is studio unless it says so');
  delete process.env.PERSONALISATION_ACTION_SECRET;
}

/* ------------------------------------------------------------ 2. ceilings */

say('\n2. TWO CEILINGS\n');
{
  delete process.env.STYLE_DAILY_MAX;
  delete process.env.STUDIO_STYLE_DAILY_MAX;
  ok(styleDailyMax() === DEFAULT_STYLE_DAILY_MAX, `customer defaults to ${DEFAULT_STYLE_DAILY_MAX}`);
  ok(studioStyleDailyMax() === DEFAULT_STUDIO_STYLE_DAILY_MAX,
    `studio defaults to ${DEFAULT_STUDIO_STYLE_DAILY_MAX}`);
  ok(DEFAULT_STUDIO_STYLE_DAILY_MAX < DEFAULT_STYLE_DAILY_MAX,
    'and the studio default is the conservative one',
    `${DEFAULT_STUDIO_STYLE_DAILY_MAX} < ${DEFAULT_STYLE_DAILY_MAX}`);

  process.env.STUDIO_STYLE_DAILY_MAX = '7';
  ok(studioStyleDailyMax() === 7, 'the studio ceiling is env-configurable', String(studioStyleDailyMax()));
  ok(styleDailyMax() === DEFAULT_STYLE_DAILY_MAX, 'and setting it leaves the customer one alone');

  process.env.STYLE_DAILY_MAX = '11';
  ok(styleDailyMax() === 11 && studioStyleDailyMax() === 7, 'both are set independently',
    `${styleDailyMax()} / ${studioStyleDailyMax()}`);

  for (const bad of ['0', '-5', 'lots', '', '  ']) {
    process.env.STUDIO_STYLE_DAILY_MAX = bad;
    ok(studioStyleDailyMax() === DEFAULT_STUDIO_STYLE_DAILY_MAX,
      `"${bad}" is not a ceiling and falls back to the default`, String(studioStyleDailyMax()));
  }
  delete process.env.STYLE_DAILY_MAX;
  delete process.env.STUDIO_STYLE_DAILY_MAX;
}

/* -------------------------------------------- 3. neither draws the other down */

say('\n3. NEITHER BUDGET CAN SPEND THE OTHER\n');
{
  process.env.STYLE_DAILY_MAX = '5';
  process.env.STUDIO_STYLE_DAILY_MAX = '3';
  const store = memStore();

  await bumpGlobal(store, 1, NOW, STUDIO);
  await bumpGlobal(store, 1, NOW, STUDIO);

  const afterStudio = await readGlobal(store, NOW, STUDIO);
  const customerNow = await readGlobal(store, NOW, CUSTOMER);
  ok(afterStudio.calls === 2, 'two studio calls counted', String(afterStudio.calls));
  ok(customerNow.calls === 0, 'and the customer counter has not moved', String(customerNow.calls));
  ok(customerNow.remaining === 5, 'the customer still has its whole budget',
    String(customerNow.remaining));

  await bumpGlobal(store, 1, NOW, CUSTOMER);
  ok((await readGlobal(store, NOW, STUDIO)).calls === 2,
    'a customer call does not move the studio counter');
  ok((await readGlobal(store, NOW, CUSTOMER)).calls === 1, 'it moves its own');

  /* Separate keys, not two fields in one document: two writers that never
     contend cannot lose each other's increments. */
  const keys = [...store.data.keys()].sort();
  ok(keys.includes(`global/${dayBucket(NOW)}.json`), 'the customer counter keeps its original key',
    keys.join(', '));
  ok(keys.includes(`global-studio/${dayBucket(NOW)}.json`), 'the studio counter has its own');

  /* A default-origin call is a customer call, which is what makes every
     existing caller keep the meaning it had. Called with no `now` either, the
     way the live code calls it.

     ITS OWN STORE, and that is not tidiness. The first cut of this shared the
     store above and asserted the count was 1 — which held only while NOW's day
     and the real today were different days, and stopped holding the morning the
     date rolled over onto NOW's. A test that passes because of what day it is
     is a test that will fail on a day nobody is looking. */
  const fresh = memStore();
  await bumpGlobal(fresh, 1);
  const defaulted = await readGlobal(fresh);
  const defaultedStudio = await readGlobal(fresh, new Date(), STUDIO);
  ok(defaulted.origin === CUSTOMER && defaulted.calls === 1,
    'bumpGlobal with no origin is a customer call', `${defaulted.origin} ${defaulted.calls}`);
  ok(defaultedStudio.calls === 0, 'and lands nowhere near the studio counter',
    String(defaultedStudio.calls));

  delete process.env.STYLE_DAILY_MAX;
  delete process.env.STUDIO_STYLE_DAILY_MAX;
}

/* ------------------------------------------------ 4. each refuses at its own */

say('\n4. EACH BUDGET REFUSES AT ITS OWN CEILING\n');
{
  process.env.STYLE_DAILY_MAX = '4';
  process.env.STUDIO_STYLE_DAILY_MAX = '2';
  const store = memStore();

  const studioFirst = await bumpGlobal(store, 1, NOW, STUDIO);
  ok(studioFirst.tripped === false && studioFirst.crossed === false,
    'one of two studio calls is not the ceiling');
  const studioSecond = await bumpGlobal(store, 1, NOW, STUDIO);
  ok(studioSecond.tripped === true, 'the second reaches it', `${studioSecond.calls}/${studioSecond.max}`);
  ok(studioSecond.crossed === true, 'and is the one call worth emailing about');

  const cust = await readGlobal(store, NOW, CUSTOMER);
  ok(cust.tripped === false, 'the customer breaker is NOT tripped by a full studio budget',
    `${cust.calls}/${cust.max}`);
  ok(cust.remaining === 4, 'the live builder still has everything it started with',
    String(cust.remaining));

  /* And the other way round, which is the direction that was actually hurting:
     customer traffic must not shut the studio out either. */
  for (let i = 0; i < 4; i++) await bumpGlobal(store, 1, NOW, CUSTOMER);
  const bothFull = {
    customer: await readGlobal(store, NOW, CUSTOMER),
    studio: await readGlobal(store, NOW, STUDIO),
  };
  ok(bothFull.customer.tripped === true, 'a spent customer budget trips its own breaker',
    `${bothFull.customer.calls}/${bothFull.customer.max}`);
  ok(bothFull.studio.max === 2 && bothFull.studio.calls === 2,
    'and the studio budget is where it was, refusing on its own terms',
    `${bothFull.studio.calls}/${bothFull.studio.max}`);

  /* Lowering a ceiling by hand trips the breaker with no call crossing it --
     which is why the refusal paths re-read rather than trusting `crossed`. */
  process.env.STUDIO_STYLE_DAILY_MAX = '1';
  ok((await readGlobal(store, NOW, STUDIO)).tripped === true,
    'a ceiling lowered below the count trips immediately');
  process.env.STUDIO_STYLE_DAILY_MAX = '99';
  const reopened = await readGlobal(store, NOW, STUDIO);
  ok(reopened.tripped === false && reopened.remaining === 97,
    'and raising it reopens without resetting anything',
    `${reopened.calls}/${reopened.max}`);

  /* There is no way to zero a counter: the only lever is the ceiling, and the
     count itself only ever moves by a call being made or refunded. */
  ok((await readGlobal(store, NOW, STUDIO)).calls === 2,
    'the count itself is untouched by any of that', String(reopened.calls));

  delete process.env.STYLE_DAILY_MAX;
  delete process.env.STUDIO_STYLE_DAILY_MAX;
}

/* ---------------------------------------------------------- 5. the refund */

say('\n5. A REFUND GOES BACK TO THE BUDGET THAT PAID\n');
{
  process.env.STUDIO_STYLE_DAILY_MAX = '10';
  const store = memStore();
  await bumpGlobal(store, 1, NOW, STUDIO);
  await bumpGlobal(store, 1, NOW, CUSTOMER);
  await bumpGlobal(store, -1, NOW, STUDIO);
  ok((await readGlobal(store, NOW, STUDIO)).calls === 0, 'the studio call was refunded');
  ok((await readGlobal(store, NOW, CUSTOMER)).calls === 1, 'the customer one was not touched');
  await bumpGlobal(store, -1, NOW, STUDIO);
  ok((await readGlobal(store, NOW, STUDIO)).calls === 0, 'and a counter never goes negative');
  delete process.env.STUDIO_STYLE_DAILY_MAX;
}

/* ---------------------------------------------------- 6. when they reset */

say('\n6. RESETS\n');
{
  const store = memStore();
  const beforeMidnight = new Date('2026-09-15T23:59:59Z');
  const afterMidnight = new Date('2026-09-16T00:00:01Z');

  for (const o of ORIGINS) await bumpGlobal(store, 1, beforeMidnight, o);
  for (const o of ORIGINS) {
    ok((await readGlobal(store, beforeMidnight, o)).calls === 1, `${o} counted before midnight`);
    ok((await readGlobal(store, afterMidnight, o)).calls === 0,
      `${o} is back to zero one second after midnight UTC`);
  }
  ok(dayBucket(beforeMidnight) !== dayBucket(afterMidnight),
    'because both are keyed on the UTC day and nothing else',
    `${dayBucket(beforeMidnight)} -> ${dayBucket(afterMidnight)}`);

  /* The per-visitor counters are deliberately NOT on the same schedule, and
     that is worth pinning down rather than leaving to be rediscovered. */
  const vstore = memStore();
  await bumpVisitor(vstore, 'vtest', 'style', 1, new Date('2026-09-15T14:00:00Z'));
  const eightHoursOn = new Date('2026-09-15T22:00:00Z');
  const twentyFiveHoursOn = new Date('2026-09-16T15:00:00Z');
  const at = (now) => readVisitor(vstore, 'vtest', { family: COVERS, now });
  ok((await at(eightHoursOn)).styleCalls24h === 1,
    'a visitor style call is still counted eight hours later');
  ok((await at(new Date('2026-09-16T13:00:00Z'))).styleCalls24h === 1,
    'and across midnight UTC — it is a rolling 24 hours, not a calendar day');
  ok((await at(twentyFiveHoursOn)).styleCalls24h === 0,
    'and gone once 24 hours have passed');

  await bumpVisitor(vstore, 'vtest', 'designs', 1, new Date('2026-09-15T14:59:00Z'));
  ok((await at(new Date('2026-09-15T14:59:59Z'))).designsThisHour === 1,
    'a new design is counted within its UTC hour');
  ok((await at(new Date('2026-09-15T15:00:01Z'))).designsThisHour === 0,
    'and the hour bucket turns over on the hour, not 60 minutes later',
    hourBucket(new Date('2026-09-15T15:00:01Z')));
}

/* ------------------------------------------- 7. the per-IP guards are unchanged */

say('\n7. THE PER-VISITOR GUARDS, UNTOUCHED\n');
{
  const store = memStore();
  const key = 'vabc123';

  ok(DEFAULT_NEW_DESIGNS_PER_HOUR === 4, 'still four new designs an hour by default',
    String(DEFAULT_NEW_DESIGNS_PER_HOUR));
  ok(newDesignsPerHourLimit() === 4, 'and four in force with nothing set',
    String(newDesignsPerHourLimit()));

  const designs = newDesignsPerHourLimit();
  for (let i = 0; i < designs; i++) {
    ok((await checkVisitor(store, key, { newDesign: true, now: NOW })).ok,
      `new design ${i + 1} of ${designs} allowed`);
    await bumpVisitor(store, key, 'designs', 1, NOW);
  }
  const fifth = await checkVisitor(store, key, { newDesign: true, now: NOW });
  ok(!fifth.ok && fifth.reason === 'visitor-designs-per-hour',
    'the fifth in the hour is refused', fifth.reason);
  ok((await checkVisitor(store, key, { newDesign: false, now: NOW })).ok,
    'but another photo on an existing design is still allowed');

  const busy = 'vbusy';
  for (let i = 0; i < styleLimitFor(COVERS); i++) {
    await bumpVisitor(store, busy, COVERS, 1, NOW);
  }
  const spent = await checkVisitor(store, busy, { templateId: 'cover', now: NOW });
  ok(!spent.ok && spent.reason === 'visitor-style-limit-covers',
    'a visitor out of cover attempts is stopped', spent.reason);
  ok(isStyleLimit(spent.reason), 'and it is recognised as an allowance, not a refusal');
  ok((await visitorHasStyleBudget(store, busy, NOW, 'cover')) === false,
    'and the resume path agrees');

  /* The two axes are independent: the site-wide budget having room does not
     buy a visitor past their own limit, which is the whole point of having
     both. Nothing about the origins changed this. */
  process.env.STUDIO_STYLE_DAILY_MAX = '1000';
  process.env.STYLE_DAILY_MAX = '1000';
  ok(!(await checkVisitor(store, busy, { templateId: 'cover', now: NOW })).ok,
    'a wide-open site budget does not lift a per-visitor refusal');
  delete process.env.STUDIO_STYLE_DAILY_MAX;
  delete process.env.STYLE_DAILY_MAX;

  /* Failing open is deliberate: a blob store having a bad minute must not take
     the builder down. */
  const broken = { async get() { throw new Error('store is down'); } };
  const verdict = await checkVisitor(broken, key, { newDesign: true, templateId: 'cover', now: NOW });
  ok(verdict.ok === true, 'an unreadable counter store allows the upload', verdict.reason || 'ok');
}

/* -------------------------------------------------- 8. one email per budget */

say('\n8. THE BREAKER EMAIL IS CLAIMED PER BUDGET\n');
{
  const store = memStore();
  ok((await claimBreakerNotice(store, NOW, CUSTOMER)) === true, 'the first customer caller claims it');
  ok((await claimBreakerNotice(store, NOW, CUSTOMER)) === false, 'the second does not');
  ok((await claimBreakerNotice(store, NOW, STUDIO)) === true,
    'and the studio budget still gets its own — they are different money');
  ok((await claimBreakerNotice(store, NOW, STUDIO)) === false, 'once each');
  ok((await claimBreakerNotice(store, new Date('2026-09-16T09:00:00Z'), CUSTOMER)) === true,
    'and again the next UTC day');
}

/* ------------------------------------------------------- 9. what is said */

say('\n9. WHAT A PAUSED PANEL SAYS\n');
{
  ok(/unusually busy/.test(BUSY_MESSAGE) && /shortly/.test(BUSY_MESSAGE),
    'a customer is told it is coming, not that something failed', BUSY_MESSAGE);
  ok(busyMessageFor(CUSTOMER) === BUSY_MESSAGE, 'which is the default');
  ok(busyMessageFor(undefined) === BUSY_MESSAGE, 'including for a document with no origin');
  ok(busyMessageFor(STUDIO) === STUDIO_BUSY_MESSAGE, 'the studio is told which budget ran out');
  ok(/STUDIO_STYLE_DAILY_MAX/.test(STUDIO_BUSY_MESSAGE), 'and which variable raises it',
    STUDIO_BUSY_MESSAGE);
  ok(!/fail/i.test(BUSY_MESSAGE) && !/error/i.test(BUSY_MESSAGE),
    'neither message calls it a failure');
}

/* ------------------------------------------------------- 10. the sweeper */

say('\n10. BOTH SETS OF COUNTERS ARE COLLECTED\n');
{
  const store = memStore();
  const old = new Date('2026-08-01T12:00:00Z');
  for (const o of ORIGINS) await bumpGlobal(store, 1, old, o);
  for (const o of ORIGINS) await bumpGlobal(store, 1, NOW, o);
  await bumpVisitor(store, 'vold', COVERS, 1, old);

  const before = [...store.data.keys()].length;
  const report = await sweepGuardCounters({ now: NOW, store });
  ok(report.days === 2, 'both of the old day counters were collected, not just the customer one',
    String(report.days));
  ok(report.visitors === 1, 'and the stale visitor document', String(report.visitors));
  const left = [...store.data.keys()].sort();
  ok(left.includes(`global/${dayBucket(NOW)}.json`) && left.includes(`global-studio/${dayBucket(NOW)}.json`),
    "today's counters are both still there", left.join(', '));
  ok(!report.errors.length, 'and nothing errored', report.errors.join('; '));
  ok(before > left.length, 'something was actually deleted', `${before} -> ${left.length}`);
}

/* ---------------------------------------- 11. an allowance per kind of design */

say('\n11. AN ALLOWANCE PER KIND OF DESIGN\n');
{
  /* A cover is one panel and a strip is twelve, so one flat number was
     generous for one and barely a single build of the other. These are the
     three allowances, and the point of them is that they are separate. */
  ok(TEMPLATE_FAMILIES.join(',') === 'covers,icons,strips', 'three families',
    TEMPLATE_FAMILIES.join(','));

  const map = [
    ['cover', COVERS], ['cover-fullbleed', COVERS],
    ['icon-portrait', ICONS], ['icon-landscape', ICONS],
    ['strip', STRIPS],
  ];
  for (const [templateId, family] of map) {
    ok(familyForTemplate(templateId) === family, `${templateId} spends from ${family}`,
      familyForTemplate(templateId));
  }
  for (const unknown of [null, undefined, '', 'poster', 'cover-v2']) {
    ok(familyForTemplate(unknown) === COVERS,
      `${JSON.stringify(unknown)} falls back to the tightest allowance`, familyForTemplate(unknown));
  }

  ok(DEFAULT_STYLE_LIMITS[COVERS] === 5 && DEFAULT_STYLE_LIMITS[ICONS] === 5
    && DEFAULT_STYLE_LIMITS[STRIPS] === 30, 'the defaults are 5 / 5 / 30',
    JSON.stringify(DEFAULT_STYLE_LIMITS));

  /* One complete build, per template, against its own allowance. This is the
     assertion that would catch a limit set below what a build actually costs. */
  const PANELS = { cover: 1, 'cover-fullbleed': 1, 'icon-portrait': 1, 'icon-landscape': 1, strip: 12 };
  for (const [templateId, panels] of Object.entries(PANELS)) {
    const limit = styleLimitFor(familyForTemplate(templateId));
    ok(limit >= panels, `${templateId}: ${limit} attempts covers a complete ${panels}-panel build`,
      `${panels} needed`);
  }

  for (const [envVar, family] of [
    ['STYLE_LIMIT_COVERS', COVERS], ['STYLE_LIMIT_ICONS', ICONS], ['STYLE_LIMIT_STRIPS', STRIPS],
  ]) {
    process.env[envVar] = '3';
    ok(styleLimitFor(family) === 3, `${envVar} is read per request`, String(styleLimitFor(family)));
    process.env[envVar] = 'nonsense';
    ok(styleLimitFor(family) === DEFAULT_STYLE_LIMITS[family],
      'and nonsense falls back to the default', String(styleLimitFor(family)));
    delete process.env[envVar];
  }

  /* THE ONE THAT MATTERS: spending a strip allowance must leave the covers
     alone. This is the bug the old flat counter had by construction. */
  process.env.STYLE_LIMIT_COVERS = '5';
  process.env.STYLE_LIMIT_ICONS = '5';
  process.env.STYLE_LIMIT_STRIPS = '30';
  const store = memStore();
  const key = 'vmixed';

  for (let i = 0; i < 12; i++) await bumpVisitor(store, key, STRIPS, 1, NOW);
  const all = await readVisitorAll(store, key, NOW);
  ok(all[STRIPS].styleCalls24h === 12, 'a twelve-panel strip spent twelve strip attempts',
    String(all[STRIPS].styleCalls24h));
  ok(all[COVERS].styleCalls24h === 0 && all[ICONS].styleCalls24h === 0,
    'and nothing at all from covers or icons',
    `${all[COVERS].styleCalls24h} / ${all[ICONS].styleCalls24h}`);
  ok((await checkVisitor(store, key, { templateId: 'cover', now: NOW })).ok,
    'so a cover is still allowed after a whole strip');
  ok(all[COVERS].remaining === 5, 'with the full cover allowance intact',
    String(all[COVERS].remaining));

  /* Each boundary, on its own counter. */
  for (const [templateId, family] of [['cover', COVERS], ['icon-portrait', ICONS], ['strip', STRIPS]]) {
    const k = `vlim-${family}`;
    const limit = styleLimitFor(family);
    for (let i = 0; i < limit - 1; i++) await bumpVisitor(store, k, family, 1, NOW);
    ok((await checkVisitor(store, k, { templateId, now: NOW })).ok,
      `${family}: the last attempt inside the limit is allowed`, `${limit - 1} of ${limit}`);
    await bumpVisitor(store, k, family, 1, NOW);
    const over = await checkVisitor(store, k, { templateId, now: NOW });
    ok(!over.ok && over.reason === `visitor-style-limit-${family}`,
      `${family}: the one past it is stopped`, over.reason);
    ok(over.remaining === 0, 'with nothing left', String(over.remaining));

    /* And the other two are untouched by it. */
    const others = TEMPLATE_FAMILIES.filter((f) => f !== family);
    const counts = await readVisitorAll(store, k, NOW);
    ok(others.every((f) => counts[f].styleCalls24h === 0),
      `${family}: ${others.join(' and ')} never moved`,
      others.map((f) => `${f} ${counts[f].styleCalls24h}`).join(', '));
  }

  /* A refund goes back to the family that paid. */
  const rk = 'vrefund';
  await bumpVisitor(store, rk, STRIPS, 1, NOW);
  await bumpVisitor(store, rk, STRIPS, -1, NOW);
  const refunded = await readVisitorAll(store, rk, NOW);
  ok(refunded[STRIPS].styleCalls24h === 0, 'a refunded strip call is given back');
  ok(refunded[COVERS].styleCalls24h === 0, 'and no other counter was touched');

  /* The rolling window is per family too, not a shared clock. */
  const wk = 'vwindow';
  await bumpVisitor(store, wk, COVERS, 1, new Date('2026-09-15T02:00:00Z'));
  ok((await readVisitor(store, wk, { family: COVERS, now: new Date('2026-09-16T01:00:00Z') })).styleCalls24h === 1,
    'a cover attempt is still spent 23 hours later');
  ok((await readVisitor(store, wk, { family: COVERS, now: new Date('2026-09-16T03:00:00Z') })).styleCalls24h === 0,
    'and back 25 hours later — rolling, not midnight');

  delete process.env.STYLE_LIMIT_COVERS;
  delete process.env.STYLE_LIMIT_ICONS;
  delete process.env.STYLE_LIMIT_STRIPS;
}

/* ------------------------------------------- 12. what the customer is told */

say('\n12. THE WAY OUT\n');
{
  ok(STYLE_LIMIT_MESSAGE === "You've reached the maximum number of style attempts for today. "
    + "Send your photo to our artwork team and we'll put a proof together for you.",
    'the shop\u2019s wording, unchanged', STYLE_LIMIT_MESSAGE);
  ok(!/fail/i.test(STYLE_LIMIT_MESSAGE) && !/error/i.test(STYLE_LIMIT_MESSAGE)
    && !/sorry/i.test(STYLE_LIMIT_MESSAGE), 'it does not read as a failure');
  ok(/saved/i.test(STYLE_LIMIT_KEEPS) && /tomorrow/i.test(STYLE_LIMIT_KEEPS),
    'and the line under it answers "is my work gone?" and "when can I come back?"',
    STYLE_LIMIT_KEEPS);

  const notice = styleLimitNotice('pp-0123456789abcdef', STRIPS);
  ok(notice.text === STYLE_LIMIT_MESSAGE, 'the notice carries the wording');
  ok(notice.ctaLabel === STYLE_LIMIT_CTA_LABEL && /artwork team/i.test(notice.ctaLabel),
    'and a label that says what pressing it does', notice.ctaLabel);
  ok(notice.ctaHref.startsWith('/contact?'), 'the call to action is the contact form',
    notice.ctaHref);
  ok(/[?&]ref=pp-0123456789abcdef(&|$)/.test(notice.ctaHref),
    'with the build reference, so the team can find the photos already uploaded',
    notice.ctaHref);
  ok(/[?&]topic=artwork-proof(&|$)/.test(notice.ctaHref), 'and the topic the page prefills from');
  ok(/[?&]subject=Custom\+Order(&|$)/.test(notice.ctaHref),
    'and a subject the form actually offers', notice.ctaHref);
  ok(notice.family === STRIPS, 'it knows which allowance ran out', notice.family);

  /* Nothing personal is ever in that URL -- a build id and two fixed words. */
  const params = [...new URL(`https://x${notice.ctaHref}`).searchParams.keys()].sort();
  ok(params.join(',') === 'ref,subject,topic', 'and nothing else is in the link',
    params.join(','));

  /* It has to work for a build that has no id yet. */
  const bare = styleLimitNotice(null, null);
  ok(bare.ctaHref.startsWith('/contact?') && !/ref=/.test(bare.ctaHref),
    'a notice with no build still has a working link', bare.ctaHref);
  ok(bare.family === null, 'and says nothing it does not know');

  ok(styleLimitCta('pp-x') !== styleLimitCta('pp-y'), 'two builds get two links');
}

/* ------------------------------------- 13. telling somebody a customer is stuck */

say('\n13. ONE EMAIL PER VISITOR PER DAY\n');
{
  /* No RESEND_API_KEY here on purpose. notifyStyleLimit claims the right to
     send BEFORE it sends -- so a provider outage costs one notification rather
     than one per refusal -- which means the claim is observable without any
     network at all: the first call reports that it had nothing to send WITH,
     and every call after it reports that it had nothing to send ABOUT. Those
     two answers are the whole contract. */
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;

  const store = memStore();
  const key = 'vstuck';

  const first = await notifyStyleLimit({
    store, key, buildId: 'pp-aaa', templateId: 'cover', calls: 5, now: NOW,
  });
  ok(first.sent === false && first.reason === 'no RESEND_API_KEY',
    'the first hit claims the day and tries to send', first.reason);

  /* Eight more, the way a customer tapping Replace produces them. */
  const repeats = [];
  for (let i = 0; i < 8; i++) {
    repeats.push(await notifyStyleLimit({
      store, key, buildId: 'pp-aaa', templateId: 'cover', calls: 5 + i, now: NOW,
    }));
  }
  ok(repeats.every((r) => r.reason === 'already notified about this visitor today'),
    'and the next eight are silent — one email, not nine',
    [...new Set(repeats.map((r) => r.reason))].join(' | '));
  ok(repeats.every((r) => r.sent === false), 'none of them sent anything');

  /* The three places that can notice this all go through the same claim, so a
     retry endpoint and a background styler cannot each send their own. */
  ok((await claimStyleLimitNotice(store, key, NOW)) === false,
    'a second caller on the same visitor and day is refused the claim');

  /* A different customer is a different person and gets their own. */
  const second = await notifyStyleLimit({
    store, key: 'vother', buildId: 'pp-bbb', templateId: 'strip', calls: 30, now: NOW,
  });
  ok(second.reason === 'no RESEND_API_KEY', 'another visitor claims their own day', second.reason);

  /* And tomorrow reopens it, because tomorrow they are stuck again. */
  const tomorrow = new Date('2026-09-16T09:00:00Z');
  ok((await notifyStyleLimit({
    store, key, buildId: 'pp-aaa', templateId: 'cover', calls: 5, now: tomorrow,
  })).reason === 'no RESEND_API_KEY', 'the next UTC day is a new claim');

  /* Every family can raise one -- the email is about a person being stuck, and
     all three ways of being stuck are worth hearing about. */
  for (const [templateId, family] of [
    ['cover', 'covers'], ['icon-portrait', 'icons'], ['strip', 'strips'],
  ]) {
    const fresh = `vfam-${family}`;
    const r = await notifyStyleLimit({
      store, key: fresh, buildId: `pp-${family}`, templateId, calls: 1, now: NOW,
    });
    ok(r.reason === 'no RESEND_API_KEY', `a ${family} customer triggers it`, r.reason);
    const again = await notifyStyleLimit({
      store, key: fresh, buildId: `pp-${family}`, templateId, calls: 2, now: NOW,
    });
    ok(again.reason === 'already notified about this visitor today',
      `and a ${family} customer only triggers it once`, again.reason);
    /* The claim records what it was about, so the stored row says something on
       its own -- and nothing in it identifies anybody. */
    const doc = await store.get(`visitor/${fresh}/notified.json`, { type: 'json' });
    ok(doc.days[dayBucket(NOW)].family === family, `the claim records the ${family} family`,
      doc.days[dayBucket(NOW)].family);
    ok(doc.days[dayBucket(NOW)].buildId === `pp-${family}`, 'and the build to look at');
    ok(!JSON.stringify(doc).includes('@') && !/\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(doc)),
      'and holds no address of any kind');
  }

  /* Nothing to claim against is not an error, it is a no-op. */
  const nokey = await notifyStyleLimit({ store, key: null, buildId: 'pp-ccc', now: NOW });
  ok(nokey.sent === false && /no visitor/.test(nokey.reason),
    'a build with no visitor key notifies nobody rather than throwing', nokey.reason);

  /* THE INDEPENDENCE THAT MATTERS. The site-wide breaker email and this one are
     different facts about different things -- the shop has stopped styling for
     everyone, versus one customer has used their own allowance while the shop
     carried on. They are claimed on different records, so neither can silence
     the other on a day when both happen. */
  const shared = memStore();
  const vkey = 'vboth';
  ok((await claimStyleLimitNotice(shared, vkey, NOW)) === true,
    'a customer runs out and the claim is taken');
  ok((await claimBreakerNotice(shared, NOW, CUSTOMER)) === true,
    'the site-wide breaker still claims its own email the same day');
  ok((await claimStyleLimitNotice(shared, vkey, NOW)) === false,
    'the customer one stays claimed');
  ok((await claimBreakerNotice(shared, NOW, CUSTOMER)) === false,
    'and so does the breaker one');
  ok((await claimBreakerNotice(shared, NOW, STUDIO)) === true,
    'and the studio budget is a third, independent of both');

  /* The other order, in case one of them ever starts writing where the other
     reads. */
  const reverse = memStore();
  ok((await claimBreakerNotice(reverse, NOW, CUSTOMER)) === true, 'breaker first');
  ok((await claimStyleLimitNotice(reverse, 'vrev', NOW)) === true,
    'then a customer — still both');

  /* The claim document must not grow for ever. */
  const growing = memStore();
  for (let d = 1; d <= 6; d++) {
    await claimStyleLimitNotice(growing, 'vlong', new Date(`2026-09-0${d}T10:00:00Z`));
  }
  const kept = Object.keys(
    (await growing.get('visitor/vlong/notified.json', { type: 'json' })).days
  );
  ok(kept.length <= 2, 'six days of claims keep at most two rows', kept.join(', '));

  if (savedKey) process.env.RESEND_API_KEY = savedKey;
}

/* --------------------------------- 14. the designs guard is tunable as well */

say('\n14. HOW MANY DESIGNS AN HOUR, WITHOUT A DEPLOY\n');
{
  /* Every style allowance beside it became tunable and this one did not, so it
     quietly became the ceiling that actually bound: raising STYLE_LIMIT_STRIPS
     to allow five strips does nothing if the visitor cannot create more than
     four designs in the hour it takes to try them. */
  delete process.env.STYLE_LIMIT_DESIGNS_PER_HOUR;
  ok(newDesignsPerHourLimit() === DEFAULT_NEW_DESIGNS_PER_HOUR,
    'unset is the default', String(newDesignsPerHourLimit()));

  process.env.STYLE_LIMIT_DESIGNS_PER_HOUR = '12';
  ok(newDesignsPerHourLimit() === 12, 'a value in the environment is honoured',
    String(newDesignsPerHourLimit()));
  process.env.STYLE_LIMIT_DESIGNS_PER_HOUR = ' 7 ';
  ok(newDesignsPerHourLimit() === 7, 'and trimmed', String(newDesignsPerHourLimit()));
  process.env.STYLE_LIMIT_DESIGNS_PER_HOUR = '1';
  ok(newDesignsPerHourLimit() === 1, 'it can be tightened as well as loosened',
    String(newDesignsPerHourLimit()));

  /* A guard that switches itself off over a typo is worse than one that
     ignores it, so every unusable value falls back rather than being
     interpreted -- exactly as the three style limits do. */
  for (const bad of ['0', '-3', 'lots', '', '  ', 'null', 'Infinity', 'NaN']) {
    process.env.STYLE_LIMIT_DESIGNS_PER_HOUR = bad;
    ok(newDesignsPerHourLimit() === DEFAULT_NEW_DESIGNS_PER_HOUR,
      `${JSON.stringify(bad)} falls back to ${DEFAULT_NEW_DESIGNS_PER_HOUR}`,
      String(newDesignsPerHourLimit()));
  }

  /* PER REQUEST, not at import. A constant captured when the module loaded is
     exactly what needed a deploy to change, so this is the assertion that says
     the fix is a fix: the same module instance, read twice, answers
     differently. */
  delete process.env.STYLE_LIMIT_DESIGNS_PER_HOUR;
  const before = newDesignsPerHourLimit();
  process.env.STYLE_LIMIT_DESIGNS_PER_HOUR = '9';
  const after = newDesignsPerHourLimit();
  delete process.env.STYLE_LIMIT_DESIGNS_PER_HOUR;
  const restored = newDesignsPerHourLimit();
  ok(before === 4 && after === 9 && restored === 4,
    'the same module answers 4, then 9, then 4 again — read per request',
    `${before} -> ${after} -> ${restored}`);

  /* And the guard actually enforces the tuned number, not the default. */
  process.env.STYLE_LIMIT_DESIGNS_PER_HOUR = '2';
  const store = memStore();
  const key = 'vtunable';
  ok((await checkVisitor(store, key, { newDesign: true, now: NOW })).ok, 'design 1 of 2 allowed');
  await bumpVisitor(store, key, 'designs', 1, NOW);
  ok((await checkVisitor(store, key, { newDesign: true, now: NOW })).ok, 'design 2 of 2 allowed');
  await bumpVisitor(store, key, 'designs', 1, NOW);
  const third = await checkVisitor(store, key, { newDesign: true, now: NOW });
  ok(!third.ok && third.reason === 'visitor-designs-per-hour',
    'and the third is refused at the TUNED limit, not at four', third.reason);
  ok(third.designsLimit === 2, 'the verdict carries the limit it hit',
    String(third.designsLimit));
  ok(third.designsThisHour === 2, 'and the count', String(third.designsThisHour));

  /* Raised mid-hour, the visitor who was refused a moment ago is allowed --
     which is the whole point of reading it per request. */
  process.env.STYLE_LIMIT_DESIGNS_PER_HOUR = '5';
  const afterRaise = await checkVisitor(store, key, { newDesign: true, now: NOW });
  ok(afterRaise.ok, 'raising it unblocks them on their very next upload');
  ok(afterRaise.designsLimit === 5, 'against the new number', String(afterRaise.designsLimit));

  /* Tightening it below what they have already spent refuses immediately. */
  process.env.STYLE_LIMIT_DESIGNS_PER_HOUR = '1';
  ok(!(await checkVisitor(store, key, { newDesign: true, now: NOW })).ok,
    'and tightening it below their count refuses at once');

  /* It bounds NEW designs only. A visitor at the designs ceiling can still add
     photographs to the design they are already working on -- otherwise the
     guard would strand a half-built strip. */
  ok((await checkVisitor(store, key, { newDesign: false, now: NOW })).ok,
    'but another photo on an existing design is still allowed');

  delete process.env.STYLE_LIMIT_DESIGNS_PER_HOUR;
}

say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
