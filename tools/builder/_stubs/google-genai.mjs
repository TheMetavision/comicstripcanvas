/**
 * Enough of @google/genai to run the styling path.
 *
 * Only the SDK is replaced, so _shared/style.mjs itself -- the prompt assembly,
 * the reference images, the part ordering, the StyleError it raises and the
 * retry rule it applies -- is the REAL code under test. Stubbing styleImage
 * instead would have tested nothing but the stub.
 *
 * `next` decides what the model does. Anything it does not understand throws,
 * so a test that forgets to say what the model should do fails loudly rather
 * than silently exercising a default.
 */

export const calls = [];
export const state = { next: null, image: null };

export function reset() {
  calls.length = 0;
  state.next = null;
  state.image = null;
}

/** The PNG bytes a successful generation hands back. Set once by the test. */
export function setImage(png) { state.image = png; }

/** What the model does on the next call, until changed. */
export function willReturnImage() { state.next = { kind: 'image' }; }
export function willRefuse(detail = {}) { state.next = { kind: 'refuse', detail }; }
export function willReturnNothing() { state.next = { kind: 'empty' }; }
export function willThrow(status, message = 'stub: upstream said no') {
  state.next = { kind: 'throw', status, message };
}

export const Modality = { IMAGE: 'IMAGE', TEXT: 'TEXT' };

export class GoogleGenAI {
  constructor(opts) { this.opts = opts; }

  get models() {
    return {
      generateContent: async (params) => {
        calls.push(params);
        const next = state.next;
        if (!next) throw new Error('stub: the test did not say what the model should do');

        if (next.kind === 'throw') {
          const err = new Error(next.message);
          err.status = next.status;
          throw err;
        }
        if (next.kind === 'refuse') {
          /* A refusal is a well-formed response with no image in it -- which is
             exactly why "the model returned no image" was so hard to act on,
             and why the detail below matters. */
          return {
            candidates: [{
              finishReason: next.detail.finishReason ?? null,
              finishMessage: next.detail.finishMessage ?? null,
              safetyRatings: next.detail.safetyRatings ?? null,
              content: { parts: next.detail.modelText ? [{ text: next.detail.modelText }] : [] },
            }],
            promptFeedback: {
              blockReason: next.detail.blockReason ?? null,
              safetyRatings: next.detail.promptSafetyRatings ?? null,
            },
          };
        }
        if (next.kind === 'empty') {
          return { candidates: [], promptFeedback: {} };
        }
        if (!state.image) throw new Error('stub: no image was set for a successful generation');
        return {
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [{ inlineData: { mimeType: 'image/png', data: state.image.toString('base64') } }],
            },
          }],
          promptFeedback: {},
        };
      },
    };
  }
}

export default { GoogleGenAI, Modality };
