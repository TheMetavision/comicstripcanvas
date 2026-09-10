/**
 * The parts of a scene that do not need a renderer: how big the print file is,
 * and how a file's bytes become an href.
 *
 * A leaf module on purpose. render.mjs imports @resvg/resvg-js at the top, and
 * anything wanting only the arithmetic used to drag a native binary into its
 * bundle to get it -- studio-save needs the print width for its reply and
 * rasterises nothing at all. Same reasoning as _shared/cutout.mjs.
 *
 * render.mjs re-exports all of it, so nothing that already imports these from
 * there has to change.
 */

import path from 'node:path';

export const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.heic': 'image/heic', '.heif': 'image/heif',
};

export const dataUri = (buf, name) =>
  `data:${MIME[path.extname(name).toLowerCase()] || 'image/png'};base64,${Buffer.from(buf).toString('base64')}`;

export const DPI = 300;

/**
 * The finished file's size from the builder's recipe.
 *
 * faceInches is the visible art; wrapInches is the gallery wrap that folds
 * round the stretcher bars, added on all four sides. fileInches wins outright
 * when the recipe carries it -- the builder computed it, and recomputing it
 * here is exactly the drift the token scheme exists to prevent.
 */
export function printGeometry(recipe) {
  const out = (recipe && recipe.output) || {};
  const canvas = (recipe && recipe.canvas) || {};
  const face = out.faceInches || [(canvas.width || 3000) / DPI, (canvas.height || 3000) / DPI];
  const wrap = out.wrapInches || 0;
  const fileInches = out.fileInches || [face[0] + 2 * wrap, face[1] + 2 * wrap];
  return { fileInches, printWidth: Math.round(fileInches[0] * DPI) };
}
