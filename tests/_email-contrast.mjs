/**
 * WCAG contrast check for email HTML, with no dependencies (identical in every
 * Metavision brand repo: tests/_email-contrast.mjs).
 *
 * Emails use inline styles, so this follows them the way a browser would: text
 * colour is inherited (links default to #0000EE), the background is the
 * nearest ancestor's background / background-color / bgcolor (semi-transparent
 * colours are blended), and font size and weight decide "large" text.
 * Every visible text node must reach 4.5:1, or 3:1 when large (24px+, or
 * 18.66px+ bold). Hidden text (display:none, preheaders) is skipped.
 *
 *   import { contrastIssues, assertReadable } from './_email-contrast.mjs';
 *   assertReadable(html, 'order confirmation');   // throws, listing every failure
 */

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080',
  maroon: '#800000', teal: '#008080', magenta: '#ff00ff', fuchsia: '#ff00ff', cyan: '#00ffff', aqua: '#00ffff',
  lime: '#00ff00', olive: '#808000', pink: '#ffc0cb', gold: '#ffd700', darkgray: '#a9a9a9', lightgray: '#d3d3d3',
  whitesmoke: '#f5f5f5', crimson: '#dc143c', darkred: '#8b0000', darkgreen: '#006400',
};
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BOLD_TAGS = new Set(['b', 'strong', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TAG_SIZE = { h1: 2, h2: 1.5, h3: 1.17, h4: 1, h5: 0.83, h6: 0.67, small: 0.83 };

/** '#abc' | '#aabbcc' | '#aabbccdd' | rgb()/rgba() | named -> {r,g,b,a}, or null (transparent/unknown). */
export function parseColor(value) {
  if (!value) return null;
  let v = String(value).trim().toLowerCase().replace(/\s*!important$/, '');
  if (NAMED[v]) v = NAMED[v];
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const n = (x) => (x.endsWith('%') ? (parseFloat(x) / 100) * 255 : parseFloat(x));
    return { r: n(p[0]), g: n(p[1]), b: n(p[2]), a: p[3] === undefined ? 1 : (p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3])) };
  }
  return null;
}

const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
const lum = ({ r, g, b }) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const toHex = ({ r, g, b }) => '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

/** Contrast ratio of two colours (any form parseColor accepts). */
export function contrast(a, b) {
  const x = typeof a === 'string' ? parseColor(a) : a;
  const y = typeof b === 'string' ? parseColor(b) : b;
  const [l1, l2] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (l1 + 0.05) / (l2 + 0.05);
}

function styleMap(attrs) {
  const out = {};
  const m = attrs.match(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (!m) return out;
  const css = (m[2] ?? m[3]).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim().replace(/\s*!important$/i, '');
  }
  return out;
}
const attr = (attrs, name) => { const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[2] ?? m[3] ?? m[4]) : null; };
/** The first colour in a `background` value (gradients: its first stop). */
function firstColor(value) {
  if (!value) return undefined;
  if (/^\s*(transparent|none|inherit|initial)\s*$/i.test(value)) return 'transparent';
  const m = value.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b/gi) || [];
  for (const t of m) if (parseColor(t)) return t;
  return undefined;
}
function fontSize(value, parent) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const n = parseFloat(v);
  if (Number.isNaN(n)) return null;
  if (v.endsWith('px')) return n;
  if (v.endsWith('pt')) return n * (4 / 3);
  if (v.endsWith('em') && !v.endsWith('rem')) return n * parent;
  if (v.endsWith('rem')) return n * 16;
  if (v.endsWith('%')) return (n / 100) * parent;
  return null;
}
const decode = (s) => s.replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, '·');

/**
 * Every visible text node below its threshold:
 * [{ text, fg, bg, ratio, need, size, bold }]
 */
export function contrastIssues(html, { normal = 4.5, large = 3 } = {}) {
  const src = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '');
  const root = { tag: '#root', color: parseColor('#000000'), bg: parseColor('#ffffff'), size: 16, bold: false, hidden: false };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const popTo = (names, stopAt = []) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stopAt.includes(stack[i].tag)) return;
      if (names.includes(stack[i].tag)) { stack.length = i; return; }
    }
  };
  const issues = [];
  const re = /<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[3] !== undefined) {
      const t = top();
      const text = decode(m[3]).replace(/\s+/g, ' ').trim();
      if (!text || t.hidden) continue;
      const fg = blend(t.color, t.bg);
      const ratio = contrast(fg, t.bg);
      const isLarge = t.size >= 24 || (t.bold && t.size >= 18.66);
      const need = isLarge ? large : normal;
      if (ratio + 0.005 < need) issues.push({ text: text.slice(0, 70), fg: toHex(fg), bg: toHex(t.bg), ratio: Math.round(ratio * 100) / 100, need, size: Math.round(t.size * 10) / 10, bold: t.bold });
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    if (m[0].startsWith('</')) { popTo([tag]); continue; }
    if (['td', 'th'].includes(tag)) popTo(['td', 'th'], ['tr', 'table']);
    if (tag === 'tr') popTo(['tr'], ['table', 'tbody', 'thead', 'tfoot']);
    if (tag === 'li') popTo(['li'], ['ul', 'ol']);
    if (tag === 'p') popTo(['p'], ['div', 'td', 'th', 'li', 'table', 'body', 'blockquote']);
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    const parent = top();
    const st = styleMap(attrs);
    const node = { tag, color: parent.color, bg: parent.bg, size: parent.size, bold: parent.bold, hidden: parent.hidden };
    if (tag === 'a') node.color = parseColor('#0000ee');
    const c = parseColor(st.color || attr(attrs, 'color'));
    if (c) node.color = c;
    const bgVal = st['background-color'] ?? firstColor(st.background) ?? attr(attrs, 'bgcolor');
    const bg = parseColor(bgVal);
    if (bg && bg.a > 0) node.bg = blend(bg, parent.bg);
    if (TAG_SIZE[tag]) node.size = parent.size * TAG_SIZE[tag];
    const fs = fontSize(st['font-size'], parent.size);
    if (fs !== null) node.size = fs;
    if (BOLD_TAGS.has(tag)) node.bold = true;
    const fw = st['font-weight'];
    if (fw) node.bold = /bold|bolder/.test(fw) || parseInt(fw, 10) >= 700;
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0
      || (/^0(px)?$/.test(st['max-height'] || '') && /hidden/.test(st.overflow || '')) || (fs !== null && fs <= 1)
      || attr(attrs, 'hidden') !== null && /\shidden(\s|=|$)/i.test(' ' + attrs)) node.hidden = true;
    stack.push(node);
  }
  return issues;
}

/** Throws an AssertionError-style Error listing every text node below threshold. */
export function assertReadable(html, label = 'email', opts) {
  const issues = contrastIssues(html, opts);
  if (issues.length) {
    const lines = issues.map((i) => `  ${i.ratio}:1 (needs ${i.need}) ${i.fg} on ${i.bg}, ${i.size}px${i.bold ? ' bold' : ''}: "${i.text}"`);
    throw new Error(`${label}: ${issues.length} text element(s) below WCAG contrast\n${lines.join('\n')}`);
  }
}
