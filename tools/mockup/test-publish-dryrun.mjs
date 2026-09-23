#!/usr/bin/env node
/**
 * A dry run must make reads and nothing else.
 *
 *   node tools/mockup/test-publish-dryrun.mjs
 *
 * This exists because the previous version did not. Its dry run POSTed the
 * batch to the actions endpoint with dryRun: true, to check that the endpoint,
 * the API version and the action shape were right -- a real check, and one the
 * rest of the tool cannot do offline. But it meant a dry run sent a request to
 * the write endpoint whose only difference from a publish was one boolean in
 * the body, and the safety of the whole thing rested on Sanity honouring it.
 *
 * So the rule is now structural rather than behavioural: in a dry run, no
 * request goes anywhere except /data/query/. Structural rules need a test that
 * knows the difference, which means watching the traffic rather than reading
 * the output, because "dry run: nothing published" is printed either way.
 *
 * The client is stubbed: every request is recorded, GROQ reads are answered
 * from a fixture, and anything else fails the test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, setFetch } from './publish.mjs';

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

const LISTING = { _type: 'image', _key: 'listing', asset: { _ref: 'image-art' } };
const POSTER = { _type: 'image', _key: 'mockup-poster', asset: { _ref: 'image-p1' }, alt: 'x lifestyle mockup — Comic Strip Canvas' };

const PUBLISHED = [
  { _id: 'p1', _type: 'product', title: 'One', slug: { current: 'one' }, category: 'comic-book-icons', images: [LISTING] },
  { _id: 'p2', _type: 'product', title: 'Two', slug: { current: 'two' }, category: 'comic-book-icons', images: [LISTING] },
];
const DRAFTS = [
  // p1 gained a poster and nothing else: publishable.
  { _id: 'drafts.p1', _type: 'product', title: 'One', slug: { current: 'one' }, category: 'comic-book-icons', images: [LISTING, POSTER] },
  // p2 gained a poster AND a retitle: held.
  { _id: 'drafts.p2', _type: 'product', title: 'Two (edited)', slug: { current: 'two' }, category: 'comic-book-icons', images: [LISTING, POSTER] },
];

/** Records every request; answers reads; never answers a write. */
function stub() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), body: init.body });
    const u = String(url);
    if (u.includes('/data/query/')) {
      const q = decodeURIComponent(u.split('query=')[1].split('&')[0]);
      const result = /path\("drafts\.\*\*"\)\s*&&/.test(q) || q.includes('_id in path("drafts.**") && _type')
        ? DRAFTS
        : PUBLISHED;
      return { json: async () => ({ result }) };
    }
    // Anything that is not a read: answer it so the tool carries on, and let
    // the assertions below decide what it means. Failing here would hide WHICH
    // request was made behind a stack trace.
    return { json: async () => ({ transactionId: 'stubbed' }) };
  };
  return { calls, fetchImpl };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csc-publish-'));
const quiet = () => { const o = console.log; console.log = () => {}; return () => { console.log = o; }; };

const isRead = (c) => c.url.includes('/data/query/');
const isWrite = (c) => c.url.includes('/data/actions/') || c.url.includes('/data/mutate/') || c.method !== 'GET';

// 1. A dry run makes reads and nothing else.
{
  const { calls, fetchImpl } = stub();
  setFetch(fetchImpl);
  const restore = quiet();
  await main({ dry: true, category: 'comic-book-icons', slugs: [], backupDir: tmp });
  restore();

  const writes = calls.filter(isWrite);
  check('a dry run makes at least one read', calls.filter(isRead).length > 0, `${calls.length} request(s)`);
  check('a dry run makes NO write or actions request', writes.length === 0,
    writes.length ? writes.map((w) => `${w.method} ${w.url}`).join(' | ') : 'none');
  check('every request was a GROQ read',
    calls.every(isRead), [...new Set(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`))].join(' | '));
  check('nothing was sent to the actions endpoint',
    !calls.some((c) => c.url.includes('/data/actions/')));
  check('no request carried an actionType in its body',
    !calls.some((c) => typeof c.body === 'string' && c.body.includes('actionType')));
  check('no request mentioned dryRun either — the flag is gone, not merely set',
    !calls.some((c) => typeof c.body === 'string' && c.body.includes('dryRun')));
}

// 2. The negative control. Without it, test 1 passes on a tool that does
//    nothing at all, and that is the failure mode worth guarding: a check
//    that cannot fail is not a check.
{
  const { calls, fetchImpl } = stub();
  setFetch(fetchImpl);
  const restore = quiet();
  await main({ dry: false, category: 'comic-book-icons', slugs: [], backupDir: tmp });
  restore();

  const actions = calls.filter((c) => c.url.includes('/data/actions/'));
  check('a REAL run does contact the actions endpoint', actions.length === 1, `${actions.length} call(s)`);
  check('so the dry-run assertion above could have failed', actions.length > 0);
  const body = JSON.parse(actions[0]?.body || '{}');
  check('and it sends exactly one publish action for the publishable product',
    body.actions?.length === 1 && body.actions[0].actionType === 'sanity.action.document.publish'
    && body.actions[0].publishedId === 'p1',
    JSON.stringify(body.actions));
  check('the held product is not among them',
    !JSON.stringify(body.actions).includes('p2'));
  check('no dryRun field is sent on a real run either', !('dryRun' in body));
}

// 3. The plan a dry run computes is the plan a real run acts on.
{
  const { calls: dryCalls, fetchImpl: f1 } = stub();
  setFetch(f1);
  let out = '';
  const orig = console.log;
  console.log = (...a) => { out += a.join(' ') + '\n'; };
  await main({ dry: true, category: 'comic-book-icons', slugs: [], backupDir: tmp });
  console.log = orig;

  check('the dry run reports one publishable', /publishable\s+1/.test(out), out.match(/publishable.*/)?.[0] || '');
  check('the dry run reports one held', /held for review\s+1/.test(out), out.match(/held for review.*/)?.[0] || '');
  check('the dry run names the held field', /HELD.*title/.test(out), out.match(/.*HELD.*/)?.[0] || '');
  check('the dry run says no write endpoint was contacted',
    /no write endpoint contacted/.test(out));
  check('and it still made only reads', dryCalls.every(isRead));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log(fails.length ? `  FAILED: ${fails.join(', ')}` : '  all dry-run checks passed');
process.exit(fails.length ? 1 : 0);
