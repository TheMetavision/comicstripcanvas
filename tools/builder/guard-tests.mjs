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
  MAX_NEW_DESIGNS_PER_HOUR, MAX_VISITOR_STYLE_CALLS_PER_DAY,
  readGlobal, bumpGlobal, claimBreakerNotice,
  readVisitor, checkVisitor, bumpVisitor, visitorHasStyleBudget,
  hourBucket, dayBucket, sweepGuardCounters,
} from '../../netlify/functions/_shared/spend-guard.mjs';

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
     way the live code calls it — so this lands on today's real day key rather
     than on NOW's, and both sides of the assertion have to agree about that. */
  await bumpGlobal(store, 1);
  const defaulted = await readGlobal(store);
  const defaultedStudio = await readGlobal(store, new Date(), STUDIO);
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
  ok((await readVisitor(vstore, 'vtest', eightHoursOn)).styleCalls24h === 1,
    'a visitor style call is still counted eight hours later');
  ok((await readVisitor(vstore, 'vtest', eightHoursOn)).styleCalls24h === 1,
    'and across midnight UTC — it is a rolling 24 hours, not a calendar day');
  ok((await readVisitor(vstore, 'vtest', twentyFiveHoursOn)).styleCalls24h === 0,
    'and gone once 24 hours have passed');

  await bumpVisitor(vstore, 'vtest', 'designs', 1, new Date('2026-09-15T14:59:00Z'));
  ok((await readVisitor(vstore, 'vtest', new Date('2026-09-15T14:59:59Z'))).designsThisHour === 1,
    'a new design is counted within its UTC hour');
  ok((await readVisitor(vstore, 'vtest', new Date('2026-09-15T15:00:01Z'))).designsThisHour === 0,
    'and the hour bucket turns over on the hour, not 60 minutes later',
    hourBucket(new Date('2026-09-15T15:00:01Z')));
}

/* ------------------------------------------- 7. the per-IP guards are unchanged */

say('\n7. THE PER-VISITOR GUARDS, UNTOUCHED\n');
{
  const store = memStore();
  const key = 'vabc123';

  ok(MAX_NEW_DESIGNS_PER_HOUR === 4, 'still four new designs an hour',
    String(MAX_NEW_DESIGNS_PER_HOUR));
  ok(MAX_VISITOR_STYLE_CALLS_PER_DAY === 40, 'still forty style calls in a rolling 24h',
    String(MAX_VISITOR_STYLE_CALLS_PER_DAY));

  for (let i = 0; i < MAX_NEW_DESIGNS_PER_HOUR; i++) {
    ok((await checkVisitor(store, key, { newDesign: true, now: NOW })).ok,
      `new design ${i + 1} of ${MAX_NEW_DESIGNS_PER_HOUR} allowed`);
    await bumpVisitor(store, key, 'designs', 1, NOW);
  }
  const fifth = await checkVisitor(store, key, { newDesign: true, now: NOW });
  ok(!fifth.ok && fifth.reason === 'visitor-designs-per-hour',
    'the fifth in the hour is refused', fifth.reason);
  ok((await checkVisitor(store, key, { newDesign: false, now: NOW })).ok,
    'but another photo on an existing design is still allowed');

  const busy = 'vbusy';
  for (let i = 0; i < MAX_VISITOR_STYLE_CALLS_PER_DAY; i++) {
    await bumpVisitor(store, busy, 'style', 1, NOW);
  }
  const spent = await checkVisitor(store, busy, { now: NOW });
  ok(!spent.ok && spent.reason === 'visitor-style-calls-24h',
    'a visitor out of style calls is refused', spent.reason);
  ok((await visitorHasStyleBudget(store, busy, NOW)) === false, 'and the resume path agrees');

  /* The two axes are independent: the site-wide budget having room does not
     buy a visitor past their own limit, which is the whole point of having
     both. Nothing about the origins changed this. */
  process.env.STUDIO_STYLE_DAILY_MAX = '1000';
  process.env.STYLE_DAILY_MAX = '1000';
  ok(!(await checkVisitor(store, busy, { now: NOW })).ok,
    'a wide-open site budget does not lift a per-visitor refusal');
  delete process.env.STUDIO_STYLE_DAILY_MAX;
  delete process.env.STYLE_DAILY_MAX;

  /* Failing open is deliberate: a blob store having a bad minute must not take
     the builder down. */
  const broken = { async get() { throw new Error('store is down'); } };
  const verdict = await checkVisitor(broken, key, { newDesign: true, now: NOW });
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
  await bumpVisitor(store, 'vold', 'style', 1, old);

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

say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
