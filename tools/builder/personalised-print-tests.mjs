/**
 * The rules for handing out a personalised build's print file.
 *
 *   node tools/builder/personalised-print-tests.mjs
 *
 * Offline: _shared/personalised-print.mjs only, which the edge route, the
 * renderer, the admin page and both Studio panels all decide by. The route
 * itself is exercised end to end by personalised-print-loop.mjs under
 * netlify dev.
 */
import {
  DOWNLOAD_STATUSES, AWAITING_APPROVAL, printFingerprint, downloadAllowed, printStaleness,
  printDownloadName, describePrint, printPanelState, buildForLine, printKey,
} from '../../netlify/functions/_shared/personalised-print.mjs';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

const recipe = JSON.stringify({ template: 'cover', output: { format: 'standard', sizeKey: 'large', faceInches: [16, 24] } });
const base = {
  _id: 'pendingPersonalisation.pp-1759a345912886940b06c86e1ada03fe',
  status: 'in_production', orderNumber: 'CSC-1006', templateId: 'cover', outputFormat: 'standard',
  printSize: '16 × 24 in', recipe, sceneSvg: '<svg>the approved design</svg>',
};

say('\n1. WHAT THE PRINT WAS MADE FROM\n');
{
  const a = await printFingerprint(base);
  ok(/^[0-9a-f]{24}$/.test(a), 'a fingerprint is 24 hex characters', a);
  ok(a === await printFingerprint({ ...base }), '  the same design gives the same one');
  ok(a !== await printFingerprint({ ...base, sceneSvg: '<svg>edited</svg>' }), '  an edited scene changes it');
  ok(a !== await printFingerprint({ ...base, recipe: recipe.replace('large', 'medium') }), '  so does a recipe change');
  ok(printKey('pp-1') === 'renders/pp-1/print.png', 'the print lives where the renderer writes it');
}

say('\n2. ONLY ONCE THE CUSTOMER HAS APPROVED\n');
{
  ok(JSON.stringify(DOWNLOAD_STATUSES) === '["in_production","dispatched"]', 'in_production and dispatched', DOWNLOAD_STATUSES.join(', '));
  for (const status of ['in_production', 'dispatched']) ok(downloadAllowed({ status }).ok, `  ${status}: allowed`);
  for (const status of ['draft', 'paid', 'preparing', 'rendered', 'approved', 'on_hold', undefined]) {
    const r = downloadAllowed({ status });
    ok(!r.ok && r.code === 409 && r.why.startsWith(AWAITING_APPROVAL), `  ${status ?? 'no status'}: refused`, r.why);
  }
  ok(AWAITING_APPROVAL === 'Available once the customer approves', 'in the words asked for');
}

say('\n3. NEVER A PRINT OF AN EARLIER DESIGN\n');
{
  const fp = await printFingerprint(base);
  const fresh = { fingerprint: fp, renderedAt: '2026-10-05T12:00:00Z' };
  ok(!(await printStaleness({ doc: base, rendered: fresh })).stale, 'a print of the current design is current');

  const edited = { ...base, sceneSvg: '<svg>edited after</svg>', editedAt: '2026-10-05T11:00:00Z', editCount: 1 };
  const s1 = await printStaleness({ doc: edited, rendered: fresh });
  ok(s1.stale && /changed since/.test(s1.why), 'a design changed since the render is stale', s1.why);

  const s2 = await printStaleness({
    doc: { ...base, editedAt: '2026-10-05T13:00:00Z', editCount: 2 },
    rendered: fresh,                                     // fingerprint still matches
  });
  ok(s2.stale && /before the design was last edited/.test(s2.why),
    'rendered before the last edit is stale even when the fingerprint matches', s2.why);

  const legacyUnedited = await printStaleness({ doc: base, rendered: { width: 4800, height: 7200 } });
  ok(!legacyUnedited.stale, 'a print from before fingerprints, on a never-edited design, is fine');
  const legacyEdited = await printStaleness({ doc: { ...base, editCount: 1, editedAt: '2026-10-01T00:00:00Z' }, rendered: {} });
  ok(legacyEdited.stale && /nothing proves/.test(legacyEdited.why),
    '  but on an edited design it is refused — nothing proves it post-dates the edit');

  const none = await printStaleness({ doc: base, rendered: null });
  ok(none.stale && none.missing, 'no print at all is reported as missing');
}

say('\n4. WHAT IT IS CALLED, AND HOW BIG\n');
{
  ok(printDownloadName(base) === 'CSC-1006-cover-large-standard.png', 'CSC-1006-cover-large-standard.png', printDownloadName(base));
  ok(printDownloadName({ ...base, templateId: 'cover-fullbleed', outputFormat: 'gallery' })
    === 'CSC-1006-cover-fullbleed-large-gallery.png', '  template ids keep their hyphen');
  ok(printDownloadName({ ...base, orderNumber: 'CSC 1/006"' }) === 'CSC-1-006-cover-large-standard.png',
    '  nothing unsafe reaches the header', printDownloadName({ ...base, orderNumber: 'CSC 1/006"' }));
  ok(describePrint({ width: 4800, height: 7200, dpi: 300, fileInches: [16, 24] }, base)
    === '4800 × 7200 px · 16 × 24 in at 300 dpi', 'pixel size and print size', describePrint({ width: 4800, height: 7200, dpi: 300, fileInches: [16, 24] }, base));
  ok(describePrint({ width: 4800, height: 7200 }, base) === '4800 × 7200 px · 16 × 24 in', '  falling back to the build\'s print size');
}

say('\n5. WHAT EACH BUTTON SAYS\n');
{
  const fp = await printFingerprint(base);
  const pf = { width: 4800, height: 7200, dpi: 300, fileInches: [16, 24], fingerprint: fp, renderedAt: '2026-10-05T12:00:00Z' };
  ok((await printPanelState({ ...base, status: 'rendered', printFile: pf })).state === 'awaiting', 'before approval: awaiting');
  const ready = await printPanelState({ ...base, printFile: pf });
  ok(ready.state === 'ready' && ready.size.includes('4800 × 7200 px'), 'approved and current: ready, with its size', ready.size);
  ok((await printPanelState({ ...base, sceneSvg: '<svg>x</svg>', printFile: pf })).state === 'stale', 'approved but changed: stale');
  const unrec = await printPanelState({ ...base });
  ok(unrec.state === 'unrecorded' && unrec.size === '16 × 24 in',
    'no recorded print, never edited: offered, and the route decides', unrec.why);
  const legacy = await printPanelState({ ...base, editCount: 1, editedAt: '2026-10-01T00:00:00Z' });
  ok(legacy.state === 'stale', '  no recorded print, edited: stale straight away');
}

say('\n6. WHICH BUILD A LINE IS\n');
{
  const b = (id, extra) => ({ _id: `pendingPersonalisation.${id}`, templateId: 'cover', outputFormat: 'standard', recipe, ...extra });
  const one = b('pp-a');
  ok(buildForLine({ personalisationId: 'pp-a' }, [b('pp-z'), one]).build === one, 'a stamped line names its build');
  ok(/not found/.test(buildForLine({ personalisationId: 'pp-q' }, [one]).why || ''), '  and a missing one says so');
  const line = { buildKind: 'personalised', productSlug: 'personalised-book-covers', formatKey: 'canvas-standard', sizeKey: 'large' };
  ok(buildForLine(line, [one]).build === one, 'an unstamped line matches the one build that fits');
  const strip = b('pp-s', { templateId: 'strip' });
  const gallery = b('pp-g', { outputFormat: 'gallery' });
  ok(buildForLine(line, [strip, gallery, one]).build === one, '  by template family, finish and size');
  const twin = b('pp-t');
  const amb = buildForLine(line, [one, twin]);
  ok(!amb.build && /2 builds/.test(amb.why), 'two builds that look alike: no guess', amb.why);
  ok(!buildForLine(line, []).build, 'no builds: nothing offered');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
