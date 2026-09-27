/**
 * Is a customise design's artwork a CUT-OUT, and where does it stop?
 *
 * THE BUG THIS ANSWERS
 * --------------------
 * variantOf() decides whether a panel holds a cut-out by asking whether the
 * server has a cut-out of the CUSTOMER'S OWN photograph:
 *
 *     (s.cutoutUrl && s.variant !== 'styled') ? 'cutout' : 'styled'
 *
 * That is the right question for a personalised build, where the panel holds
 * two pictures -- the styled photograph and the PNG our service cut out of it
 * -- and the variant says which to draw.
 *
 * It is the wrong question on "Customise this design". There the artwork is
 * the SHOP'S, already cut out, delivered by /api/customise-scene as one
 * finished image. There is no cutoutUrl because there is nothing to cut out,
 * so bleeds() came back false and the preview clipped the figure to the inner
 * art window -- while the print used the clip stored in the scene. On Bruce
 * Lee those disagreed by a quarter to a third of the sheet depending on
 * finish. The print and the listing image were right; the preview was wrong,
 * which is the worst way round: the customer approves one picture and is sent
 * another.
 *
 * So a customise design says what it is, rather than being guessed at from
 * files that only a personalised build has.
 *
 * Pure and dependency-free so the rule can be tested without a browser.
 */

/** A rect's worth of numbers, or null if any of them is missing. */
const rectOf = (tag) => {
  if (!tag) return null;
  const at = (a) => {
    const m = new RegExp(`\\b${a}\\s*=\\s*"([^"]*)"`).exec(tag);
    return m ? Number(m[1]) : NaN;
  };
  const r = { x: at('x'), y: at('y'), width: at('width'), height: at('height') };
  return Object.values(r).every(Number.isFinite) ? r : null;
};

/** The rect the stored scene clips its artwork to, exactly as saved. */
export function storedClipRect(sceneSvg) {
  if (typeof sceneSvg !== 'string') return null;
  const m = /<clipPath id="clip-art">\s*(<rect[^>]*>)/.exec(sceneSvg);
  return rectOf(m && m[1]);
}

/** Two rects the same to within half a pixel — the scale these are written at. */
export const sameRect = (a, b) => !!a && !!b
  && ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 0.5);

const VARIANTS = new Set(['cutout', 'styled']);

/**
 * What the customise builder should draw, and where it should stop.
 *
 * @param {object}  scene           the /api/customise-scene payload
 * @param {object?} panelRect       the template's art window, when known
 * @returns {{ variant: 'cutout'|'styled', rect: object|null, why: string }}
 *
 * `rect` is set only when the scene has no cutoutClip to recompute from: the
 * clip as SAVED, to be used unchanged. That is deliberately the same promise
 * the print path makes -- an absent cutoutClip means "leave the stored clip
 * rect exactly as it is" -- so a scene that predates the field previews at
 * every finish exactly as it prints.
 */
export function customiseCutout(scene, panelRect = null) {
  const recipe = (scene && scene.recipe) || {};
  const svg = (scene && scene.sceneSvg) || recipe.svg || '';
  const stored = storedClipRect(svg);
  const hasClip = !!(recipe.cutoutClip && typeof recipe.cutoutClip === 'object');

  /* What the studio recorded when it saved. The field came in after these
     three covers were drawn, so its absence says nothing either way. */
  const declared = VARIANTS.has(recipe.imageVariant) ? recipe.imageVariant : null;
  if (declared === 'styled') return { variant: 'styled', rect: null, why: 'the scene says full picture' };
  if (declared === 'cutout') {
    return hasClip
      ? { variant: 'cutout', rect: null, why: 'the scene says cut-out and carries a cutoutClip' }
      : { variant: 'cutout', rect: stored, why: 'the scene says cut-out; using the clip it was saved with' };
  }

  /* No declaration. The clip itself is the evidence: a full picture is clipped
     to the art window, and anything else was clipped to the page because the
     operator was letting a figure run off it. Comparing the two is what the
     scene can actually tell us. */
  if (hasClip) return { variant: 'cutout', rect: null, why: 'no imageVariant, but a cutoutClip was set' };
  if (stored && panelRect && !sameRect(stored, panelRect)) {
    return { variant: 'cutout', rect: stored, why: 'no imageVariant; its clip is not the art window' };
  }
  if (stored && !panelRect) {
    return { variant: 'cutout', rect: stored, why: 'no imageVariant and no art window to compare' };
  }
  return { variant: 'styled', rect: null, why: 'no imageVariant; its clip is the art window' };
}
