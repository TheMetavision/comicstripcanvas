/**
 * Manual line breaks in a caption — the rules, tested.
 *
 *   node tools/builder/text-lines-tests.mjs
 *
 * Imports src/scripts/text-lines.js and src/scripts/box-link.js, which is the
 * code the builder runs. No DOM and no bundle, for the reason box-link-tests
 * gives: these are strings in, strings out, and a browser between the test and
 * the answer is three more things that can fail.
 *
 * The assertion this file exists for is the LAST section: a value with no break
 * in it has to come out of every one of these functions exactly as it went in,
 * because that is what makes an existing design render to the same pixels.
 */
import {
  MAX_TEXT_LINES, LINE_HEIGHT, splitLines, explicitLines, linesFor,
  wantedGrowth, clampGrowth,
} from '../../src/scripts/text-lines.js';
import { boxTransform, grownInner } from '../../src/scripts/box-link.js';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* A greedy wrapper with the same shape as the builder's, measuring one unit per
   character so the sums in here are readable. The real one measures glyphs. */
const wrapAt = (n) => (text) => {
  const words = String(text).split(/\s+/), out = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && t.length > n) { out.push(cur); cur = w; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
};

/* ------------------------------------------------------ 1. splitting */

say('\n1. WHERE THE LINES COME FROM\n');
{
  ok(String(splitLines('one\ntwo')) === 'one,two', 'a break makes two lines', String(splitLines('one\ntwo')));
  ok(splitLines('a\nb\nc').length === 3, 'three breaks, three lines');
  ok(splitLines('a\nb\nc\nd').length === MAX_TEXT_LINES,
    `a fourth line is cut at the cap of ${MAX_TEXT_LINES}`, String(splitLines('a\nb\nc\nd')));
  ok(String(splitLines('a\nb\nc\nd')) === 'a,b,c', 'and it is the LAST one that goes, not the first');

  /* Windows line endings arrive from a paste, not from the textarea itself. */
  ok(String(splitLines('one\r\ntwo')) === 'one,two', 'a pasted CRLF is one break, not two');
  ok(String(splitLines('one\rtwo')) === 'one,two', 'and so is a lone CR');

  /* A blank line is a deliberate act -- somebody pushing a word down. */
  ok(splitLines('a\n\nb').length === 3 && splitLines('a\n\nb')[1] === '',
    'a blank line survives as a blank line');

  ok(String(splitLines('')) === '', 'an empty value is still one line');
  ok(splitLines(null).length === 1 && splitLines(null)[0] === '', 'and so is nothing at all');

  ok(explicitLines('a\nb') === 2, 'explicitLines counts the breaks');
  ok(explicitLines('no breaks here') === 1, 'and says one when there are none');
}

/* ------------------------------------------- 2. breaks, wrapping, and both */

say('\n2. BREAKS FIRST, WRAPPING AROUND THEM\n');
{
  const w10 = wrapAt(10);

  /* wrap:false — the five cover fields that never auto-wrapped. A manual break
     is a decision, and a decision is honoured whether the field wraps or not. */
  const nowrap = linesFor(splitLines('THE AMAZING\nSPIDER'), false, w10);
  ok(String(nowrap) === 'THE AMAZING,SPIDER', 'a non-wrapping field still breaks where it was told',
    String(nowrap));
  ok(linesFor(splitLines('one long unbroken title'), false, w10).length === 1,
    'and is still one line when it has no break in it');

  /* wrap:true — the break wins, the wrap fills in underneath. */
  const both = linesFor(splitLines('aaa bbb ccc\nddd'), true, w10);
  ok(both[both.length - 1] === 'ddd', 'the author\'s break is still a break after wrapping',
    String(both));
  ok(both.length <= MAX_TEXT_LINES, 'and the total is capped', String(both.length));

  /* The cap applies to the TOTAL, which is the interesting case: two explicit
     lines whose first half also wraps is three lines, not four. */
  const over = linesFor(splitLines('aaaa bbbb cccc dddd\neee'), true, wrapAt(9));
  ok(over.length === MAX_TEXT_LINES, 'wrapping cannot push the total past the cap', String(over.length));

  const blank = linesFor(splitLines('a\n\nb'), true, w10);
  ok(blank.length === 3 && blank[1] === '', 'a blank line is not swallowed by the wrapper',
    JSON.stringify(blank));
}

/* -------------------------------------------------- 3. how far a box grows */

say('\n3. HOW FAR THE BOX GROWS\n');
{
  const f = (value, fontSize, sizeScale) => ({ value, fontSize, sizeScale });

  ok(wantedGrowth([f('one line', 100, 1)]) === 0, 'a single-line caption asks for nothing');
  ok(wantedGrowth([]) === 0, 'and neither does an empty box');

  const two = wantedGrowth([f('one\ntwo', 100, 1)]);
  ok(two === 100 * LINE_HEIGHT, 'two lines ask for one line of leading', String(two));
  const three = wantedGrowth([f('a\nb\nc', 100, 1)]);
  ok(three === 2 * 100 * LINE_HEIGHT, 'three lines ask for two', String(three));

  /* The size slider scales the ask, or the box would stop matching the text. */
  ok(wantedGrowth([f('a\nb', 100, 2)]) === 200 * LINE_HEIGHT, 'the size slider scales the ask');

  /* Two fields in one box: the box has to suit the greediest. */
  const pair = wantedGrowth([f('a\nb\nc', 100, 1), f('x\ny', 100, 1)]);
  ok(pair === 2 * 100 * LINE_HEIGHT, 'a box with two captions grows for the taller', String(pair));

  /* --- the clamp --- */
  ok(clampGrowth(0, 500, 100) === 0, 'no ask, no growth');
  ok(clampGrowth(200, 500, 100) === 200, 'plenty of headroom, the full ask is granted');
  ok(clampGrowth(600, 500, 100) === 400, 'a short margin grants only what is there', String(clampGrowth(600, 500, 100)));
  ok(clampGrowth(600, 100, 100) === 0, 'a box already on the margin cannot grow at all');
  ok(clampGrowth(600, 50, 100) === 0, 'and one past it does not grow backwards',
    String(clampGrowth(600, 50, 100)));
}

/* ------------------------------------------- 4. the box, grown, as geometry */

say('\n4. THE BOX GROWS UPWARD AND ONLY UPWARD\n');
{
  const box = () => ({ id: 'q', x: 100, y: 200, dx: 0, dy: 0, scale: 2, height: 400, inner: { x: 10, y: 20, w: 300, h: 340 } });

  const plain = box();
  const grown = { ...box(), grow: 100 };

  /* The bottom edge is where the tail is. It must not move. */
  const bottomOf = (b) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)(?:,([\d.]+))?\)/.exec(boxTransform(b));
    const ty = Number(m[2]), sy = Number(m[4] ?? m[3]);
    return ty + (b.height / (b.scale || 1)) * sy;
  };
  ok(Math.abs(bottomOf(plain) - bottomOf(grown)) < 1e-9,
    'the bottom edge lands in the same place grown or not',
    `${bottomOf(plain)} vs ${bottomOf(grown)}`);

  const topOf = (b) => Number(/translate\(([-\d.]+),([-\d.]+)\)/.exec(boxTransform(b))[2]);
  ok(topOf(grown) === topOf(plain) - 100, 'and the top rises by exactly the growth',
    `${topOf(plain)} -> ${topOf(grown)}`);

  /* The inner area the text is measured against grows with it. */
  const gi = grownInner(grown), pi = grownInner(plain);
  ok(gi.height > pi.height, 'the inner area gets taller', `${pi.height} -> ${gi.height.toFixed(1)}`);
  ok(gi.top < pi.top, 'and its top moves up, not its bottom', `${pi.top} -> ${gi.top.toFixed(1)}`);
  /* The scale is uniform about the box's bottom edge, so the padding BELOW the
     inner rect scales with everything else and the inner bottom rises a little.
     That is the right answer, not a rounding slip: the alternative -- pinning
     the inner bottom while the outline stretches -- would grow the gap between
     the words and the bottom of the bubble every time a line was added.
     What must not move is the OUTLINE's bottom, and that is asserted above. */
  const innerBottom = (i) => i.top + i.height;
  const boxBottom = grown.y + grown.dy + grown.height;
  const padPlain = boxBottom - innerBottom(pi);
  const padGrown = boxBottom - innerBottom(gi);
  const sy = (grown.height + grown.grow) / grown.height;
  ok(Math.abs(padGrown - padPlain * sy) < 1e-9,
    'the padding under the words scales with the box, it is not left behind',
    `${padPlain} -> ${padGrown.toFixed(1)} (x${sy})`);
  ok(innerBottom(gi) < boxBottom, 'and the words still end above the bottom of the bubble');
}

/* ------------------------------------------------ 5. THE COMPATIBILITY RULE */

say('\n5. A DESIGN WITH NO BREAKS IS UNTOUCHED\n');
{
  /* This is the section that matters. Every one of these is the exact value or
     string the builder produced before manual breaks existed, and prove.mjs
     checks the same claim in pixels. */
  const v = 'THE AMAZING SPIDER-MAN';
  const segs = splitLines(v);
  ok(segs.length === 1 && segs[0] === v, 'splitLines hands a break-free value straight back');
  ok(segs[0] === v, 'the same string, not a copy of it with something done to it');

  const w = wrapAt(10);
  const viaLinesFor = linesFor(segs, true, w);
  ok(JSON.stringify(viaLinesFor) === JSON.stringify(w(v)),
    'linesFor on one segment is exactly what the old wrap() returned');
  const noWrap = linesFor(segs, false, w);
  ok(noWrap.length === 1 && noWrap[0] === v, 'and with wrap off it is exactly [value]');

  ok(wantedGrowth([{ value: v, fontSize: 150, sizeScale: 1 }]) === 0,
    'a break-free caption asks for no growth, so no box moves');

  /* The transform string, character for character. scale(2) and scale(2,2)
     raster identically and are different files. */
  const b = { id: 'q', x: 627, y: 4686, dx: 0, dy: 0, scale: 2, height: 464, inner: { x: 73, y: 27, w: 1694, h: 397 } };
  ok(boxTransform(b) === 'translate(627,4686) scale(2)',
    'boxTransform is byte-for-byte what it always was', boxTransform(b));
  ok(boxTransform({ ...b, grow: 0 }) === 'translate(627,4686) scale(2)',
    'an explicit zero growth is the same string too');
  ok(boxTransform({ ...b, grow: undefined }) === 'translate(627,4686) scale(2)',
    'and so is an absent one');

  const gi = grownInner(b);
  ok(gi.top === 4686 + 27 && gi.height === 397,
    'grownInner hands back the inner rect untouched', `${gi.top}, ${gi.height}`);

  ok(LINE_HEIGHT === 1.16, 'leading is still 1.16 — the number the old code used', String(LINE_HEIGHT));
}

/* ------------------------------------------------ 6. when the clamp bites */

say('\n6. WHEN THE CLAMP BITES, THE SHRINK LOOP TAKES OVER\n');
{
  /* The builder's fit loop, reproduced exactly: same forty passes, same 0.94,
     same two tests, measuring one unit per character. The point is to show what
     happens when the box was NOT allowed to grow as far as the text asked. */
  function fitLoop(value, wrapOn, areaW, areaH, fontSize) {
    let size = fontSize, lines = [value];
    const measure = (t, s) => t.length * s;
    const segs = splitLines(value, MAX_TEXT_LINES);
    for (let pass = 0; pass < 40; pass++) {
      lines = linesFor(segs, wrapOn, (t) => {
        const words = t.split(/\s+/), out = []; let cur = '';
        for (const w of words) {
          const c = cur ? cur + ' ' + w : w;
          if (cur && measure(c, size) > areaW * 0.90) { out.push(cur); cur = w; } else cur = c;
        }
        if (cur) out.push(cur);
        return out;
      }, MAX_TEXT_LINES);
      const tall = lines.length * size * LINE_HEIGHT > areaH;
      const wide = lines.some((l) => measure(l, size) > areaW * 0.92);
      if (!tall && !wide) return { size, lines, fits: true, passes: pass };
      size *= 0.94;
    }
    const tall = lines.length * size * LINE_HEIGHT > areaH;
    return { size, lines, fits: !tall, passes: 40 };
  }

  const INNER_H = 340, INNER_W = 900, FONT = 100;

  /* A box with room: it grows the full amount and the text keeps its size. */
  const roomy = clampGrowth(wantedGrowth([{ value: 'a\nb\nc', fontSize: FONT, sizeScale: 1 }]), 900, 40);
  const withRoom = fitLoop('one\ntwo\nthree', false, INNER_W, INNER_H + roomy, FONT);
  ok(roomy > 0, 'a box with headroom grows', roomy.toFixed(0));
  ok(withRoom.lines.length === 3, 'three lines stay three lines', String(withRoom.lines.length));
  ok(withRoom.passes === 0, 'and the text never had to shrink at all', `${withRoom.passes} passes`);

  /* The same caption in a box pinned against the safe margin. */
  const pinched = clampGrowth(wantedGrowth([{ value: 'a\nb\nc', fontSize: FONT, sizeScale: 1 }]), 44, 40);
  const clamped = fitLoop('one\ntwo\nthree', false, INNER_W, INNER_H + pinched, FONT);
  ok(pinched === 4, 'a box on the margin grows by only what is left', String(pinched));
  ok(clamped.lines.length === 3, 'it is still three lines — nothing is dropped', String(clamped.lines.length));
  ok(clamped.passes > 0, 'but the shrink loop had to work', `${clamped.passes} passes`);
  ok(clamped.size < FONT, 'so the text came out smaller', `${clamped.size.toFixed(1)} vs ${FONT}`);

  /* The assertion the whole feature rests on. */
  ok(clamped.fits, 'and it FITS — a clamped box does not overflow, it shrinks');
  ok(clamped.lines.length * clamped.size * LINE_HEIGHT <= INNER_H + pinched,
    'measured against the box it actually has, not the one it wanted',
    `${(clamped.lines.length * clamped.size * LINE_HEIGHT).toFixed(1)} <= ${(INNER_H + pinched).toFixed(1)}`);

  /* A box with no headroom at all: growth is zero and the loop carries it. */
  const none = clampGrowth(wantedGrowth([{ value: 'a\nb\nc', fontSize: FONT, sizeScale: 1 }]), 40, 40);
  const noGrow = fitLoop('one\ntwo\nthree', false, INNER_W, INNER_H + none, FONT);
  ok(none === 0, 'a box flush against the margin does not grow one unit', String(none));
  ok(noGrow.fits && noGrow.lines.length === 3,
    'and three lines still fit inside the unchanged box, smaller',
    `${noGrow.size.toFixed(1)} after ${noGrow.passes} passes`);
}

say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
