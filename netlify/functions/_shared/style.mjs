import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality } from '@google/genai';

/**
 * Comic styling, applied by Gemini's image model.
 *
 * The customer's photograph is the only source of content. Three of our own
 * generations go in as style references, the photograph goes in last, and the
 * model is asked to redraw the photograph in that style and nothing else.
 *
 * Field names here were read off the installed @google/genai typings rather
 * than remembered: GenerateContentConfig.responseModalities (string[]) and
 * GenerateContentConfig.imageConfig.{aspectRatio,imageSize}. Note the package
 * also carries a DEPRECATED snake_case ImageConfig (aspect_ratio / image_size)
 * for a different API surface -- that one is not what generateContent takes.
 *
 * Nothing in here writes anything or knows about the builder. It takes bytes
 * and gives bytes back.
 */

/* The brief, held as a constant so it can be iterated on in one place. Every
   sentence past the first is there to stop the model treating the photograph
   as inspiration rather than as the subject. */
export const STYLE_PROMPT =
  'Redraw this photograph as a comic-book illustration in exactly the art style of the reference images. ' +
  'The photograph is the only source of content: keep every person, face, expression, pose, body shape, ' +
  'hairstyle, clothing, glasses, object, pet and the background composition exactly as they are — same number ' +
  'of people, same positions, same framing, same crop. Do not add, remove, replace or move anything. Do not ' +
  "change anyone's identity, age, gender or ethnicity. Apply only the linework, colouring, shading and texture " +
  'of the reference style. No text, captions, speech bubbles, borders, panels, watermarks or signatures. ' +
  'Output one finished image at the same aspect ratio as the photograph. ' +
  'Preserve hair colour and skin tone. Reproduce any printed text on clothing exactly, letter for letter.';

const REF_DIR = fileURLToPath(new URL('./style-refs/', import.meta.url));
const REF_FILES = ['ref-1.jpg', 'ref-2.jpg', 'ref-3.jpg'];

const TIMEOUT_MS = 90000;
/** Aspect ratios the image config accepts; see ImageConfig in the typings. */
export const SUPPORTED_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/**
 * Everything the caller needs to tell a refusal from a fault. A model that
 * declines leaves its reason in finishReason / promptFeedback and often says
 * why in a text part; losing that turns "the photo tripped a safety filter"
 * into an indistinguishable 500.
 */
export class StyleError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'StyleError';
    this.finishReason = detail.finishReason ?? null;
    this.finishMessage = detail.finishMessage ?? null;
    this.blockReason = detail.blockReason ?? null;
    this.safetyRatings = detail.safetyRatings ?? null;
    this.promptSafetyRatings = detail.promptSafetyRatings ?? null;
    this.modelText = detail.modelText ?? null;
    this.status = detail.status ?? null;
  }
}

/* Same invariant as the fonts in render.mjs: a missing reference must stop the
   job, not quietly produce work in some other style. Read once at module load
   so a broken deploy fails on the first call rather than the hundredth. */
let refCache = null;
export function loadStyleRefs() {
  if (refCache) return refCache;
  const missing = [];
  const refs = REF_FILES.map((name) => {
    const file = path.join(REF_DIR, name);
    if (!fs.existsSync(file)) { missing.push(name); return null; }
    const data = fs.readFileSync(file);
    if (!data.length) { missing.push(`${name} (empty)`); return null; }
    return { name, data, mimeType: 'image/jpeg' };
  });
  if (missing.length) {
    throw new Error(
      `Style reference missing — refusing to style in an unknown style. Absent: ` +
      `${missing.join(', ')}. Expected in ${REF_DIR}. If this is a deploy, check the ` +
      `included_files entry for the function in netlify.toml.`
    );
  }
  refCache = refs;
  return refCache;
}

/* Image dimensions straight from the header. sharp is a devDependency for the
   test harness only -- a deployed function should not carry a native binary
   just to read two integers. Returns nulls for a format not covered here
   rather than throwing: the bytes are still good. */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return { width: null, height: null };
  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the segments to the start-of-frame, which carries the size
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // standalone markers carry no length
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { width: null, height: null };
  }
  // WebP: RIFF container, three possible chunk layouts
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  return { width: null, height: null };
}

/** 429 and 5xx are the platform having a moment; a 4xx is a decision. */
const worthRetrying = (err) => {
  const status = typeof err?.status === 'number' ? err.status : null;
  if (status === 429) return true;
  return status !== null && status >= 500 && status < 600;
};

const firstInlineImage = (parts) =>
  (parts || []).find((p) => p.inlineData?.data && (p.inlineData.mimeType || '').startsWith('image/'));

const collectText = (parts) =>
  (parts || []).map((p) => p.text).filter(Boolean).join('\n').trim() || null;

/**
 * Redraw one photograph in the reference style.
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer       the customer's photograph
 * @param {string} opts.mimeType     its mime type
 * @param {string} opts.aspectRatio  one of SUPPORTED_RATIOS
 * @param {string} [opts.imageSize]  '1K' | '2K' | '4K'
 * @param {string} [opts.model]
 * @returns {Promise<{buffer: Buffer, mimeType: string, width: number|null, height: number|null, model: string, ms: number}>}
 */
export async function styleImage({
  buffer,
  mimeType,
  aspectRatio,
  imageSize: size = '2K',
  model = process.env.STYLE_MODEL || 'gemini-3-pro-image-preview',
}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new StyleError('No photograph given to style');
  if (!mimeType || !mimeType.startsWith('image/')) throw new StyleError(`Not an image mime type: ${mimeType}`);

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) throw new StyleError('GOOGLE_AI_API_KEY is not set');

  const refs = loadStyleRefs();
  const ai = new GoogleGenAI({ apiKey });

  /* Interleaved, and the order is load-bearing: the references are labelled and
     shown first so "the reference images" in the prompt has a referent, the
     photograph goes last so "this photograph" is unambiguous, and the brief
     comes after everything it talks about. */
  const parts = [
    { text: 'Style references:' },
    ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data.toString('base64') } })),
    { text: 'Photograph to redraw:' },
    { inlineData: { mimeType, data: buffer.toString('base64') } },
    { text: STYLE_PROMPT },
  ];
  const contents = [{ role: 'user', parts }];

  const attempt = async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await ai.models.generateContent({
        model,
        contents,
        config: {
          // image-only output: no commentary to strip out afterwards
          responseModalities: [Modality.IMAGE],
          imageConfig: { aspectRatio, imageSize: size },
          abortSignal: ac.signal,
        },
      });
      const ms = Date.now() - started;
      const candidate = res?.candidates?.[0];
      const image = firstInlineImage(candidate?.content?.parts);
      if (!image) {
        throw new StyleError('The model returned no image', {
          finishReason: candidate?.finishReason ?? null,
          finishMessage: candidate?.finishMessage ?? null,
          blockReason: res?.promptFeedback?.blockReason ?? null,
          safetyRatings: candidate?.safetyRatings ?? null,
          promptSafetyRatings: res?.promptFeedback?.safetyRatings ?? null,
          modelText: collectText(candidate?.content?.parts),
        });
      }
      const out = Buffer.from(image.inlineData.data, 'base64');
      const { width, height } = imageSize(out);
      return { buffer: out, mimeType: image.inlineData.mimeType || 'image/png', width, height, model, ms };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch (err) {
    // A StyleError is the model's answer, not a fault -- retrying gets the same
    // answer and bills twice for it. Only retry transport-level trouble.
    if (err instanceof StyleError || !worthRetrying(err)) {
      if (err instanceof StyleError) throw err;
      throw new StyleError(err?.message || 'Styling failed', { status: err?.status ?? null });
    }
    try {
      return await attempt();
    } catch (retryErr) {
      if (retryErr instanceof StyleError) throw retryErr;
      throw new StyleError(retryErr?.message || 'Styling failed after one retry', {
        status: retryErr?.status ?? null,
      });
    }
  }
}
