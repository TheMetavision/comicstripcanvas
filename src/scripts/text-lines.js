/**
 * Where a caption's lines come from, as data.
 *
 * Same move as box-link.js, for the same reason: these are pure rules about
 * text, and they lived inside a 4,800-line closure that only exists once a
 * browser has mounted a component. Pulling them out is what makes "a manual
 * break renders as its own line" something a test can assert in a millisecond
 * instead of something you check by eye on a rendered poster.
 *
 * Nothing here touches the DOM, measures a glyph, or draws. The builder does
 * all three; this decides only WHICH strings are lines.
 *
 * ── The rule that matters most ──────────────────────────────────────────────
 *
 * A value with no newline in it must come out of here as the single element it
 * went in as, untouched and unmeasured, so that the SVG a design produced
 * before this feature existed is the SVG it produces after. Every function
 * below has that as its first branch, and cli-tests pins it.
 */

/**
 * The most lines a caption may have.
 *
 * Three. The cover's caption box has an inner area of 1694 x 397 reference
 * units, so at 1.16 leading three lines land near 114 units each -- still
 * comfortably legible on the smallest print the shop sells. A fourth would push
 * the auto-fit below the point where it reads as a deliberate choice rather
 * than a mistake, and the shrink loop would spend the difference making every
 * line smaller.
 */
export const MAX_TEXT_LINES = 3;

/**
 * Leading, as a multiple of the font size.
 *
 * 1.16 is not a new number: it is what the builder has always used for wrapped
 * text, in both the fit test and the baseline placement. Keeping it is what
 * lets a design that wrapped to two lines before this change render to the same
 * pixels after it.
 */
export const LINE_HEIGHT = 1.16;

/**
 * A caption's explicit lines.
 *
 * Splits on the author's own breaks and nothing else -- no wrapping, no
 * measuring, no trimming of the text itself. Blank segments survive: somebody
 * who typed a break to push a word onto the third line meant it.
 *
 * @param {string} value
 * @param {number} max
 * @returns {string[]} always at least one element
 */
export function splitLines(value, max = MAX_TEXT_LINES) {
  const s = value == null ? '' : String(value);
  /* The fast path is also the compatibility path: no break means the value is
     handed back as it arrived, having been neither normalised nor copied into
     anything that could change it. */
  if (s.indexOf('\n') === -1 && s.indexOf('\r') === -1) return [s];
  const parts = s.replace(/\r\n?/g, '\n').split('\n');
  return parts.slice(0, Math.max(1, max));
}

/** How many lines a value asks for by its breaks alone, ignoring wrapping. */
export const explicitLines = (value, max = MAX_TEXT_LINES) => splitLines(value, max).length;

/**
 * The finished list of lines for one field.
 *
 * Explicit breaks first, then wrapping inside each of them when the field wraps
 * at all. The order is the point: a manual break is a decision and a wrap is a
 * consequence, so the break is honoured and the wrap fills in around it.
 *
 * The cap applies to the total, which is why a two-line caption whose first
 * half also wraps comes out at three lines rather than four.
 *
 * @param {string[]} segments  from splitLines
 * @param {boolean}  doWrap    the field's own wrap flag
 * @param {(text: string) => string[]} wrapOne  wraps one segment at the current size
 * @param {number}   max
 */
export function linesFor(segments, doWrap, wrapOne, max = MAX_TEXT_LINES) {
  /* One segment and no break: exactly what the builder did before there were
     breaks at all -- wrap it, or don't, and hand back the result unsliced. */
  if (segments.length === 1) return doWrap ? wrapOne(segments[0]) : [segments[0]];

  const out = [];
  for (const seg of segments) {
    if (!doWrap) { out.push(seg); continue; }
    /* An empty segment has nothing to wrap and a greedy wrapper would drop it,
       taking the author's blank line with it. */
    const wrapped = seg === '' ? [''] : wrapOne(seg);
    for (const line of wrapped) out.push(line);
  }
  return out.slice(0, Math.max(1, max));
}

/**
 * How much taller a box wants to be, in the box's own units.
 *
 * Derived from the EXPLICIT breaks only, never from the wrapped result. That is
 * deliberate and it is what keeps the layout from chasing its own tail: the box
 * height decides how much room the text has, and if it were derived from the
 * wrap -- which depends on the room -- the two would feed each other. Breaks
 * are known before anything is measured, so they can safely decide the box.
 *
 * A field that has no break asks for nothing, so a design full of single-line
 * captions leaves every box at exactly the size it has always been.
 *
 * @param {Array<{value: string, fontSize: number, sizeScale?: number}>} fields
 * @returns {number} extra height wanted, 0 when nothing has a break
 */
export function wantedGrowth(fields, max = MAX_TEXT_LINES) {
  let want = 0;
  for (const f of fields || []) {
    const extra = explicitLines(f.value, max) - 1;
    if (extra <= 0) continue;
    want = Math.max(want, extra * (f.fontSize || 0) * (f.sizeScale || 1) * LINE_HEIGHT);
  }
  return want;
}

/**
 * What the box actually gets, once the artwork's safe margin has its say.
 *
 * The box grows UPWARDS -- its bottom stays where it is, because that is where
 * a speech box's tail points and moving it would break the thing that makes the
 * box read as belonging to the picture. So the room available is whatever sits
 * between the box's top and the safe margin, and no more.
 *
 * When that is less than the text wanted, this returns the smaller number and
 * says nothing. It does not need to: the builder's shrink loop measures against
 * the box it ACTUALLY has, so a clamped box simply means slightly smaller text,
 * arrived at by the same forty passes that have always been there. Text cannot
 * overflow a clamped box, because the clamp never enters the fit test.
 *
 * @param {number} want     from wantedGrowth
 * @param {number} boxTop   the box's top edge, in canvas units
 * @param {number} safeTop  the highest the box's top may go
 * @returns {number} 0 or more, never more than `want`
 */
export function clampGrowth(want, boxTop, safeTop) {
  if (!(want > 0)) return 0;
  const headroom = boxTop - safeTop;
  if (!(headroom > 0)) return 0;
  return Math.min(want, headroom);
}
