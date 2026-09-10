/**
 * The parts of a render job that do not need a renderer: how big the print file
 * is, how a file's bytes become an href, and what the container has to work
 * with.
 *
 * A leaf module on purpose. render.mjs imports @resvg/resvg-js at the top, and
 * anything wanting only the arithmetic used to drag a native binary into its
 * bundle to get it -- studio-save needs the print width for its reply and
 * rasterises nothing at all, and style-photo-background wants memoryNote
 * without resvg anywhere near a bundle that does not list it as external. Same
 * reasoning as _shared/cutout.mjs.
 *
 * render.mjs re-exports all of it, so nothing that already imports these from
 * there has to change.
 */

import fs from 'node:fs';
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

/**
 * What this container has, and how much of it is already gone.
 *
 * Logged on the first line of all three jobs that hold big pictures in memory
 * -- both renderers and the styling call. A studio render was killed
 * mid-rasterise because netlify.toml asked for memory it never actually got --
 * the function ran at the 1024 MB default, and the only trace was an empty log
 * and a missing print file. There is no exception to catch when a container is
 * killed for allocating, so the size has to be written down BEFORE the work
 * starts or it cannot be read afterwards.
 *
 * cgroup v2 first, then v1. Absent or unreadable outside a container (a
 * developer's machine), and "max" on a cgroup with no limit set, so both are
 * reported as an unknown limit rather than guessed at.
 */
export function memoryNote() {
  const { rss, heapUsed, external } = process.memoryUsage();
  let limit = null;
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw === 'max') break;                     // a cgroup with no limit
      const n = Number(raw);
      // v1 reports a nonsense-large sentinel when unlimited.
      if (Number.isFinite(n) && n > 0 && n < 2 ** 53) { limit = n; break; }
    } catch { /* not in a container, or no permission */ }
  }
  const mb = (n) => `${Math.round(n / 1048576)} MB`;
  return `rss ${mb(rss)}, heap ${mb(heapUsed)}, external ${mb(external)}, ` +
    `container limit ${limit ? mb(limit) : 'unknown'}`;
}
