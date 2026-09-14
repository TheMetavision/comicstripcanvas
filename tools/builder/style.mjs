/**
 * Batch comic styling, for catalogue production.
 *
 * The shop's own artwork used to go through the customer builder to get styled,
 * which meant catalogue work counted against the spend guards written to stop a
 * stranger running up a bill, and a batch of twenty photographs had to be
 * dropped into a browser one at a time. This does the same job from a command
 * prompt, in batches, with resume.
 *
 * IDENTICAL OUTPUT TO THE SITE, and that is the point of the file rather than a
 * nice-to-have. It imports styleImage from netlify/functions/_shared/style.mjs
 * -- the same module the deployed function calls -- so the prompt, the three
 * style references, the aspect-ratio choice, the model, the timeout, the single
 * internal retry and the pinned API base URL are not copies that can drift.
 * They are the same code. meta.json records the prompt hash and the reference
 * filenames so a picture made here can be proved to have been made the same way
 * as one made by the site.
 *
 * That was true of everything EXCEPT the input, which is where it bit: the
 * shop's photographs never reach the model at their original size, because the
 * browser re-encodes each upload to 4000px on the longest side first, and this
 * was posting the file as it sat on disk. A 5302 x 2758 JPEG the builder styles
 * happily came back here as "The model returned no image". Those rules now live
 * in _shared/photo-input.mjs and both paths read them from there.
 *
 * Nothing here touches Sanity, Netlify, Stripe or the live site.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import {
  STYLE_PROMPT, styleImage as realStyleImage, loadStyleRefs, imageSize, nearestRatio,
} from '../../netlify/functions/_shared/style.mjs';
import sharp from 'sharp';
import { normaliseWithSharp } from '../../netlify/functions/_shared/photo-input.mjs';
import {
  parseArgs, listImages, filterOnly, slugFor, MIME_BY_EXT, pool, withRetry, classifyFailure,
  alreadyDone, concurrencyFrom, MAX_CONCURRENCY, DEFAULT_CONCURRENCY, sha256, humanMs,
  styledName, STYLED_SIZES,
  writeRunLog, readRunTotals, printSummary, requireEnv, sleep as realSleep,
} from './_cli.mjs';

const SPEC = {
  in: 'string', out: 'string', '4k': 'boolean', only: 'string',
  concurrency: 'number', 'dry-run': 'boolean', force: 'boolean', help: 'boolean',
};

export const HELP = `
  node tools/builder/style.mjs --in <folder> --out <folder> [options]

  Styles every photograph in a folder through the same model, prompt and style
  references the live site uses, and writes one folder per picture.

    --in <folder>       where the photographs are (jpg, jpeg, png, webp)
    --out <folder>      where to write <slug>/styled-2k.png and <slug>/meta.json
    --4k                style at 4K instead of 2K. Slower and dearer (~52s a
                        picture against ~36s); worth it for cover winners, not
                        for a first pass
    --only <a,b,c>      just these slugs, comma separated
    --concurrency <n>   how many at once. Default ${DEFAULT_CONCURRENCY}, hard cap ${MAX_CONCURRENCY}: the API is rate
                        limited, and past four in flight the extra requests come
                        back as 429s and retries, which costs wall time rather
                        than saving it
    --dry-run           list what would be generated and how many calls that is.
                        Makes no API calls at all
    --force             re-style slugs that already have output at this size.
                        Without it they are skipped, so an interrupted batch can
                        simply be run again
    --help              this

  The slug is the filename without its extension, lowercased, with anything
  that is not a letter or a digit collapsed to a hyphen. The one exception is a
  picture already called styled-2k.png or styled-4k.png: those names say the
  size rather than the subject, so the slug comes from the folder holding it,
  or from the slug recorded in the meta.json beside it.

  Every photograph is prepared before it is sent exactly as the shop prepares a
  customer's: EXIF rotation applied, 4000px on the longest side, never upscaled,
  re-encoded to JPEG under 4 MiB (PNG if it is a cut-out). The rules come from
  _shared/photo-input.mjs, which the builder reads too. meta.json records both
  the original size and the size actually sent.

  Needs GOOGLE_AI_API_KEY in the environment or in .env at the repo root -- the
  same variable the deployed functions read. Its value is never printed.

  Example — a folder of twenty photographs at 2K, then the three winners at 4K:

    node tools/builder/style.mjs --in .\\photos\\batch-7 --out .\\artwork\\batch-7
    node tools/builder/style.mjs --in .\\photos\\batch-7 --out .\\artwork\\batch-7 \`
      --only bruce-lee,tupac,gizmo --4k

  Review them all on one page afterwards:

    start .\\artwork\\batch-7\\_contact-sheet.html
`;

/** The contact sheet: every result in one page, slug underneath. */
export function contactSheet(rows, { title = 'Styled batch' } = {}) {
  const cells = rows.map((r) => `
    <figure>
      <img src="${r.href}" alt="${r.slug}" loading="lazy">
      <figcaption>${r.slug}${r.note ? ` <span class="note">${r.note}</span>` : ''}</figcaption>
    </figure>`).join('');
  return `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { margin: 0; padding: 24px; background: #16161a; color: #eee;
         font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 18px; }
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
  figure { margin: 0; }
  img { display: block; width: 100%; height: auto; background: #000; border: 1px solid #333; }
  figcaption { margin-top: 6px; font-size: 13px; word-break: break-all; }
  .note { color: #e66; }
  .empty { color: #888; }
</style>
<h1>${title} — ${rows.length} image${rows.length === 1 ? '' : 's'}</h1>
${rows.length ? `<div class="grid">${cells}\n</div>` : '<p class="empty">Nothing styled yet.</p>'}
`;
}

/**
 * Everything Google said about why there is no picture.
 *
 * "The model returned no image" is true and useless: it covers a safety
 * refusal, an empty candidate, a malformed request and a model that answered
 * in words. styleImage already collects the fields that tell those apart --
 * they were simply being thrown away here. The run log gets all of it; the
 * summary line gets the short form, which is enough to know whether to try a
 * different photograph or a different request.
 *
 * Only the ratings that actually tripped are kept: the API returns a rating for
 * every category on every call, and four NEGLIGIBLEs in a log file are noise
 * standing exactly where the one that mattered should be.
 */
export function refusalDetail(err) {
  const blocking = (ratings) => (Array.isArray(ratings) ? ratings : [])
    .filter((r) => r && (r.blocked || !/^(NEGLIGIBLE|LOW)$/i.test(String(r.probability || ''))))
    .map((r) => `${r.category}: ${r.probability}${r.blocked ? ' (blocked)' : ''}`);

  const detail = {
    message: String(err?.message || err || '').slice(0, 500) || null,
    finishReason: err?.finishReason ?? null,
    finishMessage: err?.finishMessage ?? null,
    blockReason: err?.blockReason ?? null,
    safety: blocking(err?.safetyRatings),
    promptSafety: blocking(err?.promptSafetyRatings),
    /* What the model said instead of drawing. Often the most useful line in
       the whole record -- it is where "I can't create images of real people"
       turns up. */
    modelText: err?.modelText ? String(err.modelText).slice(0, 500) : null,
    status: typeof err?.status === 'number' ? err.status : null,
    attempts: err?.attempts ?? null,
  };
  const bits = [];
  if (detail.finishReason) bits.push(`finish=${detail.finishReason}`);
  if (detail.blockReason) bits.push(`blocked=${detail.blockReason}`);
  if (detail.status) bits.push(`http ${detail.status}`);
  if (detail.safety.length) bits.push(detail.safety.join(', '));
  if (detail.promptSafety.length) bits.push(`prompt ${detail.promptSafety.join(', ')}`);
  if (detail.modelText) bits.push(`said "${detail.modelText.slice(0, 80)}"`);
  /* Nothing at all is itself worth saying out loud: a response with no image,
     no finishReason and no text is a different bug from a refusal, and the two
     used to print the same line. */
  detail.short = bits.join('; ') || 'no finishReason, no safety rating, no text — an empty response';
  return detail;
}

/**
 * @param {string[]} argv
 * @param {object} deps  injectable for the tests: styleImage, sleep, log, now
 */
export async function run(argv, deps = {}) {
  const {
    styleImage = realStyleImage, sleep = realSleep, log = console.log,
    error = console.error, now = Date.now,
    normalise = (buffer) => normaliseWithSharp(buffer, { sharp, mode: 'customer' }),
  } = deps;

  const { opts, errors } = parseArgs(argv, SPEC);
  if (opts.help || argv.length === 0) { log(HELP); return 0; }
  if (errors.length) { errors.forEach((e) => error(`  ${e}`)); log(HELP); return 1; }
  if (!opts.in || !opts.out) { error('  --in and --out are both required.'); log(HELP); return 1; }

  const size = opts['4k'] ? '4K' : '2K';
  /* The name comes from _cli.mjs, which is also where cutout.mjs learns to
     recognise it -- one definition, so a batch cannot be written under a name
     the other tool does not know is artwork. */
  const outName = styledName(size);
  const dryRun = !!opts['dry-run'];
  const concurrency = concurrencyFrom(opts.concurrency);

  let all;
  try { all = listImages(opts.in); } catch (e) { error(`  ${e.message}`); return 1; }
  const { items, missing } = filterOnly(all, opts.only);
  if (missing.length) error(`  --only named nothing in --in: ${missing.join(', ')}`);
  if (!items.length) { error(`  No images to style in ${opts.in}`); return 1; }

  const outDir = path.resolve(opts.out);
  const planned = items.map((it) => ({
    ...it,
    outFile: path.join(outDir, it.slug, outName),
    skip: alreadyDone(path.join(outDir, it.slug, outName), opts.force),
  }));
  const todo = planned.filter((p) => !p.skip);

  if (dryRun) {
    log(`\n  DRY RUN — nothing is generated and no call is made.\n`);
    log(`  ${items.length} image(s) in ${path.resolve(opts.in)}, at ${size}, ${concurrency} at a time`);
    for (const p of planned) {
      log(`    ${p.skip ? 'skip    ' : 'generate'}  ${p.slug.padEnd(28)} ${path.basename(p.file)}`);
    }
    log(`\n  ${todo.length} call(s) would be made, ${planned.length - todo.length} skipped `
      + `(already styled at ${size}).\n`);
    return 0;
  }

  /* The key is read before anything is written, so a batch cannot get half way
     and then discover it was never going to work. Its value is not printed
     here or anywhere else. */
  try {
    requireEnv('GOOGLE_AI_API_KEY', 'Put it in .env at the repo root, or set it for this session.');
  } catch (e) { error(`\n  ${e.message}\n`); return 1; }

  /* Fail now if the references are not where they should be, rather than on
     the first call -- loadStyleRefs throws with the list of places it looked. */
  let refs;
  try { refs = loadStyleRefs(); } catch (e) { error(`\n  ${e.message}\n`); return 1; }

  const promptHash = sha256(STYLE_PROMPT);
  const refNames = refs.map((r) => r.name);
  log(`\n  ${todo.length} to style at ${size}, ${planned.length - todo.length} already done, `
    + `${concurrency} at a time`);
  log(`  prompt ${promptHash.slice(0, 12)}…  refs ${refNames.join(', ')}  (${refs.dir})\n`);

  /* Before anything is styled, not as a side effect of the first success.
     A batch where every image failed used to leave this folder uncreated, and
     then the contact sheet read it: ENOENT, thrown out of the summary step,
     out of run(), and caught by a top-level handler that printed the message
     and exited -- while the pool's timers were still live, which is what turned
     a missing folder into a libuv assertion. The run log went the same way, so
     the one record of what went wrong was the thing the failure destroyed. */
  fs.mkdirSync(outDir, { recursive: true });

  const started = now();
  let calls = 0;
  const rows = [];

  await pool(todo, concurrency, async (item) => {
    const row = { slug: item.slug, result: 'failed', ms: null, detail: '' };
    const t0 = now();
    try {
      const original = fs.readFileSync(item.file);
      const ext = path.extname(item.file).toLowerCase();
      if (!MIME_BY_EXT[ext]) throw new Error(`unsupported extension ${ext}`);
      const src = imageSize(original);

      /* The photograph is prepared exactly as the shop prepares a customer's
         before it reaches the same function. Sending the original bytes is
         what made a 5302 x 2758 JPEG come back with no image at all while the
         same picture styled fine through the builder. */
      const prepared = await normalise(original);
      const buffer = prepared.buffer;
      const mimeType = prepared.mimeType;
      /* From the prepared size, not the original: style-photo-background reads
         the dimensions off the bytes it is about to send, and this is the same
         moment in the same pipeline. (In practice the two agree -- the resize
         holds the aspect ratio -- but agreeing by accident is not the same as
         being read from the same place.) */
      const ratio = nearestRatio(prepared.width, prepared.height);

      const styled = await withRetry(async () => {
        calls++;
        return styleImage({ buffer, mimeType, aspectRatio: ratio, imageSize: size });
      }, {
        sleepFn: sleep,
        onRetry: ({ attempt, wait, reason }) =>
          log(`    ${item.slug}: attempt ${attempt} failed (${reason}), retrying in ${humanMs(wait)}`),
      });

      const dir = path.join(outDir, item.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, outName), styled.buffer);
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        slug: item.slug,
        source: item.file,
        /* Two sizes, because they are two different facts: what was on disk,
           and what the model was actually shown. Reading the second off the
           first is exactly the mistake this whole change is about. */
        sourcePx: [src.width, src.height],
        sentPx: [prepared.width, prepared.height],
        sentMimeType: prepared.mimeType,
        sentBytes: prepared.buffer.length,
        sentQuality: prepared.quality,
        normalised: prepared.note,
        aspectRatio: ratio,
        resolution: size,
        model: styled.model,
        /* The two things that decide what the picture looks like, recorded so a
           batch can be proved to match the site rather than assumed to. */
        promptSha256: promptHash,
        refs: refNames,
        refsDir: refs.dir,
        outputPx: [styled.width ?? null, styled.height ?? null],
        bytes: styled.buffer.length,
        durationMs: styled.ms,
        at: new Date().toISOString(),
        tool: 'tools/builder/style.mjs',
      }, null, 1));

      row.result = 'styled';
      row.ms = now() - t0;
      row.sent = `${prepared.width}x${prepared.height}`;
      row.detail = `${src.width ?? '?'}x${src.height ?? '?'} → sent ${row.sent} → `
        + `${styled.width ?? '?'}x${styled.height ?? '?'} ${Math.round(styled.buffer.length / 1024)} KB`;
      log(`    ${item.slug}: ${humanMs(row.ms)}  ${row.detail}`);
    } catch (err) {
      const { kind, reason } = classifyFailure(err);
      row.result = kind === 'refused' ? 'refused' : 'failed';
      row.ms = now() - t0;
      /* The whole of it in the run log, the short form in the table. Both, not
         either: the table has one line to say it in and the log has no such
         limit, and the answer to "why did this batch produce nothing" is
         usually in the half that does not fit. */
      row.error = refusalDetail(err);
      /* Not both when they are the same sentence: an http 404 classified as
         "http 404" does not need saying twice across one column. */
      row.detail = (row.error.short === reason ? reason : `${reason} — ${row.error.short}`).slice(0, 300);
      log(`    ${item.slug}: ${row.result.toUpperCase()} — ${reason}`);
      if (row.error.short !== reason) log(`      ${row.error.short}`);
    }
    rows.push(row);
    return row;
  });

  for (const p of planned.filter((x) => x.skip)) {
    rows.push({ slug: p.slug, result: 'skipped', ms: null, detail: `already ${size}` });
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  const summary = {
    succeeded: rows.filter((r) => r.result === 'styled').length,
    skipped: rows.filter((r) => r.result === 'skipped').length,
    refused: rows.filter((r) => r.result === 'refused').length,
    failed: rows.filter((r) => r.result === 'failed').length,
    calls,
    wallMs: now() - started,
  };

  /* The sheet lists everything in the OUT folder, not just this run: the point
     of it is to look at a batch, and a batch is usually more than one run. */
  const sheetRows = fs.readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => {
      for (const res of STYLED_SIZES) {
        const rel = `${d.name}/${styledName(res)}`;
        if (fs.existsSync(path.join(outDir, rel))) {
          return { slug: d.name, href: rel, note: res === '4k' ? '4K' : '' };
        }
      }
      return null;
    })
    .filter(Boolean);
  const sheetPath = path.join(outDir, '_contact-sheet.html');
  fs.writeFileSync(sheetPath, contactSheet(sheetRows, { title: `Styled — ${path.basename(outDir)}` }));

  const runFile = writeRunLog(outDir, {
    tool: 'style', at: new Date().toISOString(), size, concurrency,
    in: path.resolve(opts.in), out: outDir,
    promptSha256: promptHash, refs: refNames, summary, rows,
  });

  printSummary({
    label: 'Styling', rows, summary, runFile, outDir,
    totals: readRunTotals(outDir), log,
  });
  log(`  contact sheet: ${sheetPath}\n`);
  return summary.failed ? 1 : 0;
}

/* Run only when this file IS the command, so the tests can import it. */
/* pathToFileURL rather than comparing paths: on Windows the two spellings of
   the same file differ by drive-letter case and slash direction, and the
   canonical comparison is the URL. */
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  /* process.exitCode, not process.exit(). The tools hold live handles when they
     finish -- undici's keep-alive sockets from the API call, sharp's worker
     threads -- and killing the loop out from under a handle that is already
     closing is what produced

       Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c

     after a perfectly good summary had already printed. Setting the code and
     letting the loop drain says the same thing to the shell without racing
     anything. unref'd handles do not hold it open, so it still exits promptly.

     The catch still exits hard: something has already gone wrong enough to
     reach here, and getting the non-zero code out matters more than a tidy
     shutdown. */
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => { console.error('\n  style.mjs failed:', err.message, '\n'); process.exit(1); });
}
