/**
 * How a source photograph is prepared before it is styled.
 *
 * The shop and the catalogue CLI were doing different things here, and the
 * difference was invisible until it wasn't: a 5302 x 2758 JPEG that the
 * customer builder styles happily came back from tools/builder/style.mjs as
 * "The model returned no image". The customer's photograph never reaches the
 * model at its original size -- the browser re-encodes it first, to 4000px on
 * the longest side and under 4 MiB -- and the CLI was posting the original
 * bytes.
 *
 * So the rules live here now, once, and both paths read them from this file.
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The POLICY: which sizes, which quality, which format, in which order. It
 * imports nothing at all, so the browser bundle can take it and so can a
 * Netlify function and so can a Node CLI.
 *
 * The PIXELS are somebody else's job, because the two hosts have different
 * tools for it and neither can use the other's: the browser has a canvas, Node
 * has sharp. normaliseWithSharp() below is the Node half, and it takes sharp
 * as an argument rather than importing it -- that is what keeps this file safe
 * to bundle into a browser.
 *
 * WHAT IS DELIBERATELY NOT IDENTICAL
 * ----------------------------------
 * The resampler. Canvas drawImage downscales with an implementation-defined
 * filter (bilinear-ish, and not the same one in every browser); sharp uses
 * Lanczos 3. The output DIMENSIONS, format, quality and byte ceilings match
 * exactly, and those are what decide whether the model accepts the request.
 * The individual pixels differ slightly, and no amount of care would make two
 * different resamplers agree. Anything downstream that needs byte-identical
 * output has to go through one host, not both.
 *
 * The browser's blank-canvas ladder (BLANK_FALLBACK_SIDES) is an iOS Safari
 * workaround: past its canvas area cap drawImage silently draws nothing, and a
 * white JPEG is worse than a soft one. sharp has no such cap, so the Node path
 * does not carry that fallback. It is exported anyway, because it is part of
 * the browser's behaviour and this file is meant to describe all of it.
 */

/* -------------------------------------------------------------- the ladder */

/**
 * Longest side and JPEG quality, in the order they are tried.
 *
 * Pixels are cheaper to lose than quality: below about 0.75 JPEG artefacts
 * start to show, and the comic styling applied afterwards amplifies them. So
 * resolution goes first and quality is only traded once the pixel steps run
 * out.
 *
 * It used to start at 5000px, which is where iPhone uploads were dying.
 */
export const ENCODE_LADDER = [[4000, 0.9], [4000, 0.82], [3000, 0.82]];

/* Aim under 4 MiB. personalise-save hard-rejects above 5.5 MiB, and the gap is
   the margin for a multipart envelope and for the ladder being approximate. */
export const UPLOAD_TARGET_BYTES = 4 * 1024 * 1024;

/* Studio artwork has no request to fit inside -- it goes up in chunks -- so its
   ceiling is the file itself. Applying a 4000px transport limit to the shop's
   own prepared artwork would quietly throw away resolution nobody asked it to
   lose: the studio's source IS the print. */
export const STUDIO_MAX_BYTES = 60 * 1024 * 1024;

/* Already in a format the renderer reads, so a canvas round trip could only add
   a re-compression the shop did not ask for. */
export const STUDIO_SENDS_AS_IS = /^image\/(png|jpeg)$/;

export const QUALITY_FLOOR = 0.6;      // last resort, visibly soft
export const QUALITY_STEP = 0.06;

/** Browser only: rungs to fall back to when a canvas draw comes back blank. */
export const BLANK_FALLBACK_SIDES = [2400, 1600, 1000];

/* The alpha probe. A cut-out photograph must not become a JPEG: JPEG has no
   alpha, so every transparent pixel encodes as BLACK, and on a cover -- where
   the cutout bleeds across the whole page -- that paints the burst out
   entirely. Sampled small because it is a yes/no question. */
export const ALPHA_PROBE_SIDE = 320;
export const ALPHA_PROBE_ALPHA = 250;      // below this counts as "not opaque"
export const ALPHA_PROBE_FRACTION = 0.01;  // >1% of pixels => treat as a cutout

/* -------------------------------------------------------------- the maths */

/**
 * The box a picture is drawn into, at a given longest side.
 *
 * Never upscales: a 280 x 362 photograph comes out 280 x 362. Each side is
 * rounded independently, which is what the browser does, so the aspect ratio
 * can shift by a fraction of a pixel -- and must, or the two paths would
 * disagree about the dimensions by one pixel on some inputs.
 */
export function fitWithin(width, height, maxSide) {
  const w0 = Number(width) || 0, h0 = Number(height) || 0;
  if (!w0 || !h0) return { width: w0, height: h0, scale: 1 };
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  return {
    width: Math.max(1, Math.round(w0 * scale)),
    height: Math.max(1, Math.round(h0 * scale)),
    scale,
  };
}

/**
 * The rungs for this mode.
 *
 * Studio starts at the source's own size and falls through the customer rungs
 * below it; customer mode starts at the transport ceiling.
 */
export function ladderFor(mode, width, height) {
  if (mode === 'studio') return [[Math.max(Number(width) || 0, Number(height) || 0), 0.95], ...ENCODE_LADDER];
  return [...ENCODE_LADDER];
}

/** How small the encoded file has to get before the ladder stops. */
export const targetBytesFor = (mode) => (mode === 'studio' ? STUDIO_MAX_BYTES : UPLOAD_TARGET_BYTES);

/**
 * One quality step down, clamped to the floor.
 *
 * Clamped rather than compared: from 0.82 a plain 0.06 step goes 0.76, 0.70,
 * 0.64, 0.58 -- it never lands on 0.60, so an unclamped loop runs one step
 * BELOW the floor it names.
 */
export const stepQuality = (q) => Math.max(QUALITY_FLOOR, Math.round((q - QUALITY_STEP) * 100) / 100);

/**
 * What a photograph of this size will be reduced to, without touching it.
 *
 * Byte-size decisions cannot be predicted without encoding, so this reports the
 * FIRST rung only -- which is the one that is used for all but the largest
 * files. Enough to tell a customer, or a dry run, what is about to happen.
 */
export function plannedSize(width, height, mode = 'customer') {
  const [side] = ladderFor(mode, width, height)[0];
  return fitWithin(width, height, side);
}

/* ------------------------------------------------------------- the node half */

/** JPEG quality as sharp wants it: a whole number of percent. */
const pct = (q) => Math.max(1, Math.min(100, Math.round(q * 100)));

/**
 * Does this picture have enough transparency to be treated as a cutout?
 *
 * The browser draws it into a <=320px box and counts pixels whose alpha is
 * under 250. This does the same through sharp. A format with no alpha channel
 * at all is answered without decoding anything.
 */
export async function looksCutOut(buffer, { sharp }) {
  const meta = await sharp(buffer).metadata();
  if (!meta.hasAlpha) return false;
  const { data, info } = await sharp(buffer)
    .resize(ALPHA_PROBE_SIDE, ALPHA_PROBE_SIDE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let clear = 0;
  for (let i = info.channels - 1; i < data.length; i += info.channels) {
    if (data[i] < ALPHA_PROBE_ALPHA) clear++;
  }
  return clear / (info.width * info.height) > ALPHA_PROBE_FRACTION;
}

/**
 * Prepare a photograph for styling, the way the browser does.
 *
 * @param {Buffer} buffer          the file as it is on disk
 * @param {object} opts
 * @param {Function} opts.sharp    the sharp module -- injected, see the header
 * @param {'customer'|'studio'} [opts.mode]
 * @returns {Promise<{
 *   buffer: Buffer, mimeType: string, width: number, height: number,
 *   originalWidth: number, originalHeight: number, quality: number|null,
 *   resized: boolean, reencoded: boolean, hasAlpha: boolean, note: string,
 * }>}
 */
export async function normaliseWithSharp(buffer, { sharp, mode = 'customer' } = {}) {
  if (!sharp) throw new Error('normaliseWithSharp needs sharp passed in');

  /* autoOrient first, and for the same reason the browser gets it free: an
     <img> decodes with the EXIF rotation already applied, so naturalWidth is
     the upright width. Reading metadata off the un-rotated image would have a
     portrait phone photo come out landscape here and not there. */
  const upright = sharp(buffer).autoOrient();
  const meta = await upright.metadata();
  const w0 = meta.autoOrient?.width || meta.width || 0;
  const h0 = meta.autoOrient?.height || meta.height || 0;
  if (!w0 || !h0) throw new Error('Could not read the image dimensions');

  const keepAlpha = await looksCutOut(buffer, { sharp });
  const mimeType = keepAlpha ? 'image/png' : 'image/jpeg';
  const targetBytes = targetBytesFor(mode);

  /* Studio sends a PNG or a JPEG that is already small enough exactly as it is,
     byte for byte. Nothing a re-encode could add. */
  if (mode === 'studio' && STUDIO_SENDS_AS_IS.test(meta.format === 'png' ? 'image/png' : `image/${meta.format}`)
    && buffer.length <= STUDIO_MAX_BYTES) {
    return {
      buffer, mimeType: meta.format === 'png' ? 'image/png' : 'image/jpeg',
      width: w0, height: h0, originalWidth: w0, originalHeight: h0,
      quality: null, resized: false, reencoded: false, hasAlpha: !!meta.hasAlpha,
      note: 'sent as it is (studio)',
    };
  }

  /** Draw at this longest side, at this quality, and see what it weighs. */
  const encodeAt = async (maxSide, quality) => {
    const box = fitWithin(w0, h0, maxSide);
    let pipe = sharp(buffer).autoOrient().resize(box.width, box.height, { fit: 'fill' });
    /* Black, not white: a canvas encoded to a format with no alpha composites
       onto solid black per the HTML spec, and this has to match. Only reached
       when the alpha probe said this is not a cutout, so it is at most a
       handful of stray pixels either way. */
    pipe = keepAlpha ? pipe.png() : pipe.flatten({ background: '#000000' }).jpeg({ quality: pct(quality) });
    const out = await pipe.toBuffer();
    return { ...box, buffer: out, quality };
  };

  let best = null, side = 0;
  for (const [rungSide, quality] of ladderFor(mode, w0, h0)) {
    side = rungSide;
    best = await encodeAt(side, quality);
    if (best.buffer.length <= targetBytes) break;
  }

  /* Pixel steps exhausted; only quality is left to give. PNG ignores quality
     entirely, so a transparent source gives up resolution and nothing else --
     which is why this loop is skipped for one. */
  let q = best.quality;
  while (!keepAlpha && best.buffer.length > targetBytes && q > QUALITY_FLOOR) {
    q = stepQuality(q);
    best = await encodeAt(side, q);
  }

  return {
    buffer: best.buffer,
    mimeType,
    width: best.width,
    height: best.height,
    originalWidth: w0,
    originalHeight: h0,
    quality: keepAlpha ? null : best.quality,
    resized: best.width !== w0 || best.height !== h0,
    reencoded: true,
    hasAlpha: keepAlpha,
    note: `${w0}x${h0} -> ${best.width}x${best.height} `
      + `${keepAlpha ? 'png' : `jpeg q${pct(best.quality)}`} `
      + `${Math.round(best.buffer.length / 1024)} KB`,
  };
}
