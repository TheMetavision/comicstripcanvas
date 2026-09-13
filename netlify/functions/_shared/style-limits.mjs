/**
 * The per-design cap, on its own with no dependencies.
 *
 * It lives here rather than in style.mjs because style.mjs imports the Gemini
 * SDK at the top, and the readers of this number are not all styling anything:
 * personalisation-status polls every three seconds and wants one integer, not a
 * model client in its bundle. style.mjs re-exports it, so nothing that already
 * imported it from there had to change.
 */

/** How many model calls one personalisation may ever make. */
export const MAX_STYLE_CALLS = 16;
