/**
 * The publisher stamp on a "Customise this design" save.
 *
 * In customise mode only the wording, dates and colours are the customer's.
 * The artwork and the publisher stamp belong to the product, so a saved
 * customise scene must carry the stamp exactly as the product's own stored
 * scene has it, whatever the browser sent. The builder hides the logo controls
 * in this mode; this is the lock, because a browser is not where locks live.
 *
 * The stamp in a scene is three pieces the builder draws together:
 *   <rect .../>                              the plate, immediately before
 *   <image data-role="logo" href="{{LOGO}}"/> the logo itself
 *   <clipPath id="logoClip">...</clipPath>   the plate's clip, in <defs>
 * The renderer only ever puts the shop's own logo file in for {{LOGO}}, so the
 * picture cannot be swapped by a recipe -- but its size, position, plate fill
 * and clip can, and an extra <image> pointing anywhere else could pose as one.
 *
 * lockStamp() returns the customer's scene with the stamp replaced by the
 * product's, and recipe.logo replaced by the product's, or a refusal.
 * Pure: no I/O, so it is unit-tested directly (tests/customise-stamp.test.mjs).
 */

const LOGO_IMAGE = /<image\b[^>]*\bdata-role\s*=\s*["']logo["'][^>]*?(?:\/>|>\s*<\/image>)/gi;
/* The plate is the <rect> written immediately before the logo image. */
const PLATE_AND_LOGO = /<rect\b[^>]*?(?:\/>|>\s*<\/rect>)\s*<image\b[^>]*\bdata-role\s*=\s*["']logo["'][^>]*?(?:\/>|>\s*<\/image>)/i;
const LOGO_CLIP = /<clipPath\b[^>]*\bid\s*=\s*["']logoClip["'][^>]*>[\s\S]*?<\/clipPath>/gi;
const ANY_IMAGE = /<image\b[^>]*?>/gi;
const HREF = /\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi;
/* Every image in an exported scene is a token the renderer resolves itself. */
const TOKEN = /^\{\{(?:IMAGE:[A-Za-z0-9._-]{1,64}|OVERLAY|BACKGROUND|LOGO)\}\}$/;

const count = (re, s) => (s.match(re) || []).length;
/* Written the way the builder writes them (unrounded), so a rebuilt stamp matches. */
const num = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : '0');
const attr = (v) => String(v).replace(/[^#A-Za-z0-9.()%-]/g, '');

/**
 * The product's stamp as SVG, rebuilt from its recipe.logo the way the builder
 * draws it. Used only when the stored scene carries no SVG of its own.
 */
export function stampFromRecipeLogo(logo) {
  if (!logo || !Array.isArray(logo.slot) || logo.slot.length !== 4) return null;
  const [sx, sy, sw, sh] = logo.slot.map(num);
  const fitted = Array.isArray(logo.fitted) && logo.fitted.length === 4 ? logo.fitted.map(num) : [sx, sy, sw, sh];
  const [fx, fy, fw, fh] = fitted;
  const plated = !!logo.fillPlate && typeof logo.plateColour === 'string' && /^#[0-9a-f]{3,8}$/i.test(logo.plateColour);
  const plateFill = plated ? attr(logo.plateColour) : 'none';
  return {
    plateAndLogo:
      `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="14" ry="14" fill="${plateFill}"/>` +
      `<image href="{{LOGO}}" x="${fx}" y="${fy}" width="${fw}" height="${fh}" data-role="logo" ` +
      `preserveAspectRatio="none" clip-path="${plated ? 'url(#logoClip)' : 'none'}"/>`,
    clip: `<clipPath id="logoClip"><rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="14" ry="14"/></clipPath>`,
  };
}

/** The product's stamp: exactly as its stored SVG has it, else rebuilt from its recipe. */
function productStamp(source) {
  const svg = typeof source?.svg === 'string' ? source.svg : '';
  if (svg && count(LOGO_IMAGE, svg) === 1) {
    const pl = svg.match(PLATE_AND_LOGO);
    const clips = svg.match(LOGO_CLIP) || [];
    if (pl && clips.length <= 1) return { plateAndLogo: pl[0], clip: clips[0] || null };
  }
  if (svg && count(LOGO_IMAGE, svg) === 0 && !source?.recipe?.logo) return { none: true };
  if (!svg && !source?.recipe?.logo) return { none: true };
  return stampFromRecipeLogo(source?.recipe?.logo);
}

/**
 * @param {string} customerSvg  the scene the browser exported
 * @param {object} recipeRest   the browser's recipe without its svg
 * @param {object} source       the product's stored scene ({ svg, recipe })
 * @returns {{ ok: true, svg: string, recipe: object, changed: string[] } | { ok: false, error: string }}
 */
export function lockStamp(customerSvg, recipeRest, source) {
  if (typeof customerSvg !== 'string') return { ok: false, error: 'The recipe carries no scene' };

  /* Only the design's own artwork, by token. Anything else -- a URL, a path --
     is a picture the product does not have, and the place a fake stamp would go. */
  for (const tag of customerSvg.match(ANY_IMAGE) || []) {
    // An <image> with no href draws nothing (an unfilled panel is exported so).
    const hrefs = [...tag.matchAll(HREF)].map((m) => m[2].trim());
    if (hrefs.some((h) => !TOKEN.test(h))) {
      return { ok: false, error: 'This design can only use its own artwork and publisher stamp' };
    }
  }

  const stamp = productStamp(source);
  const logos = count(LOGO_IMAGE, customerSvg);
  const changed = [];
  let svg = customerSvg;

  if (stamp && stamp.none) {
    if (logos > 0) return { ok: false, error: 'This design has no publisher stamp to change' };
  } else {
    if (!stamp) return { ok: false, error: 'This design is not ready to customise yet' };
    if (logos !== 1) return { ok: false, error: 'The publisher stamp cannot be changed on this design' };
    const pl = svg.match(PLATE_AND_LOGO);
    if (!pl) return { ok: false, error: 'The publisher stamp cannot be changed on this design' };
    if (pl[0] !== stamp.plateAndLogo) changed.push('stamp');
    svg = svg.replace(pl[0], () => stamp.plateAndLogo);

    const clips = svg.match(LOGO_CLIP) || [];
    if (clips.length > 1) return { ok: false, error: 'The publisher stamp cannot be changed on this design' };
    if (stamp.clip) {
      if (clips.length === 1) {
        if (clips[0] !== stamp.clip) changed.push('stamp clip');
        svg = svg.replace(clips[0], () => stamp.clip);
      } else {
        // The plate refers to #logoClip; put the product's back where defs live.
        const at = svg.search(/<defs\b[^>]*>/i);
        if (at < 0) return { ok: false, error: 'The publisher stamp cannot be changed on this design' };
        const end = svg.indexOf('>', at) + 1;
        svg = svg.slice(0, end) + stamp.clip + svg.slice(end);
        changed.push('stamp clip');
      }
    }
  }

  const productLogo = source?.recipe?.logo ?? null;
  if (JSON.stringify(recipeRest?.logo ?? null) !== JSON.stringify(productLogo)) changed.push('recipe.logo');
  return { ok: true, svg, recipe: { ...recipeRest, logo: productLogo }, changed };
}
