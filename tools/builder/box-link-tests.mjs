/**
 * "Link boxes" — the arithmetic, tested.
 *
 *   node tools/builder/box-link-tests.mjs
 *
 * Imports src/scripts/box-link.js, which is the code the builder runs. No DOM
 * and no bundle: these rules are offsets in, offsets out, and putting a browser
 * between the test and the sum would only add three more things that can fail.
 */
import {
  boxTransform, moveBox, dragBoxes, planRecentre, applyRecentre,
  offsetBetween, canLinkBoxes,
  sceneLinkFlag, linkFromScene, fieldMovesWithBox, applyFieldMovesWithBox,
} from '../../src/scripts/box-link.js';

let pass = 0, fail = 0;
const ok = (c, l, e = '') => {
  if (c) { pass++; console.log(`  PASS  ${l}${e ? ' — ' + e : ''}`); }
  else { fail++; console.log(`  FAIL  ${l}${e ? ' — ' + e : ''}`); }
};
const say = console.log.bind(console);

/* The icon template as the builder builds it: two boxes that do NOT start
   level, which is the whole point -- a rule that copied one offset onto the
   other would look correct on a symmetrical fixture. */
const icon = () => ({
  boxes: [
    { id: 'quote', x: 100, y: 200, dx: 0, dy: 0, scale: 1 },
    { id: 'attribution', x: 140, y: 620, dx: 0, dy: 0, scale: 1 },
  ],
  texts: [
    { id: 'quote', boxRef: 'quote', linked: true, pos: { x: 300, y: 260 } },
    { id: 'attribution', boxRef: 'attribution', linked: true, pos: { x: 320, y: 660 } },
  ],
});

/* A cover: one caption box, so nothing to link. */
const cover = () => ({
  boxes: [{ id: 'caption', x: 50, y: 50, dx: 0, dy: 0, scale: 1 }],
  texts: [{ id: 'issue', boxRef: 'caption', linked: true, pos: { x: 60, y: 60 } }],
});

const at = (b) => `${b.x + b.dx},${b.y + b.dy}`;

/* --------------------------------------------------- 1. what can be linked */

say('\n1. WHAT CAN BE LINKED\n');
{
  ok(canLinkBoxes(icon().boxes) === true, 'two boxes can be linked');
  ok(canLinkBoxes(cover().boxes) === false,
    'a cover has one caption box, so the control never appears there');
  ok(canLinkBoxes([]) === false, 'a strip has none');
  ok(canLinkBoxes(undefined) === false, 'and nothing is not a pair');
}

/* ------------------------------------------ 2. the gap survives a linked drag */

say('\n2. THE GAP SURVIVES A LINKED DRAG\n');
{
  const t = icon();
  const [quote, attribution] = t.boxes;
  const before = offsetBetween(quote, attribution);
  ok(before.x === 40 && before.y === 420, 'the boxes start 40 across and 420 down apart',
    JSON.stringify(before));

  /* A drag arrives as many small steps, not one big one, so it is tested that
     way -- an error that accumulates per step would hide in a single move. */
  for (let i = 0; i < 25; i++) dragBoxes(t.boxes, t.texts, quote, 3, -7, true);

  const after = offsetBetween(quote, attribution);
  ok(after.x === before.x && after.y === before.y,
    'after 25 steps of a linked drag the gap is EXACTLY what it was',
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  ok(quote.dx === 75 && quote.dy === -175, 'the dragged box has moved', at(quote));
  ok(attribution.dx === 75 && attribution.dy === -175, 'and so has the other, by the same',
    at(attribution));

  /* Dragging the OTHER one is the same deal -- either box leads. */
  for (let i = 0; i < 10; i++) dragBoxes(t.boxes, t.texts, attribution, -2, 5, true);
  const afterSecond = offsetBetween(quote, attribution);
  ok(afterSecond.x === before.x && afterSecond.y === before.y,
    'and dragging the attribution box instead keeps it too', JSON.stringify(afterSecond));
  ok(quote.dx === 55 && attribution.dx === 55, 'both moved together', `${quote.dx} / ${attribution.dx}`);
}

/* ----------------------------------------- 3. unlinked, they move alone */

say('\n3. UNLINKED, ONLY THE ONE YOU DRAG MOVES\n');
{
  const t = icon();
  const [quote, attribution] = t.boxes;
  dragBoxes(t.boxes, t.texts, quote, 30, 40, false);
  ok(quote.dx === 30 && quote.dy === 40, 'the dragged box moved', at(quote));
  ok(attribution.dx === 0 && attribution.dy === 0, 'the other did not', at(attribution));
  ok(offsetBetween(quote, attribution).x === 10,
    'so the gap changed, which is what unlinked means',
    String(offsetBetween(quote, attribution).x));
}

/* ------------------------------------------- 4. unlinking leaves them be */

say('\n4. UNLINKING LEAVES BOTH WHERE THEY ARE\n');
{
  const t = icon();
  const [quote, attribution] = t.boxes;
  dragBoxes(t.boxes, t.texts, quote, 60, 90, true);
  const snapshot = [at(quote), at(attribution), JSON.stringify(t.texts.map((f) => f.pos))];

  /* Unlinking is a flag the caller flips; nothing in here runs. The assertion
     is that there is no cleanup to run -- no snap-back, no reconciliation --
     because the offsets are already the truth. */
  const stillThere = [at(quote), at(attribution), JSON.stringify(t.texts.map((f) => f.pos))];
  ok(snapshot.join('|') === stillThere.join('|'),
    'nothing moves when the link comes off', stillThere.join(' | '));

  /* And the next drag moves only one, immediately. */
  dragBoxes(t.boxes, t.texts, quote, 5, 5, false);
  ok(quote.dx === 65 && attribution.dx === 60,
    'the very next drag is independent', `${quote.dx} / ${attribution.dx}`);
}

/* --------------------------------------------- 5. recentre, as a pair */

say('\n5. RECENTRE\n');
{
  /* Linked: the pair goes home together, gap intact. */
  const t = icon();
  const [quote, attribution] = t.boxes;
  const gap = offsetBetween(quote, attribution);
  dragBoxes(t.boxes, t.texts, quote, 120, -60, true);
  applyRecentre(planRecentre(t.boxes, true), t.texts);
  ok(quote.dx === 0 && quote.dy === 0, 'the first box lands on its own origin', at(quote));
  ok(offsetBetween(quote, attribution).x === gap.x
    && offsetBetween(quote, attribution).y === gap.y,
    'and the gap is the one the customer had, not the template default',
    JSON.stringify(offsetBetween(quote, attribution)));

  /* The case that proves it is the CUSTOMER'S gap: drag them apart unlinked
     first, then link, then recentre. A recentre that reset both would quietly
     throw that arrangement away. */
  const u = icon();
  dragBoxes(u.boxes, u.texts, u.boxes[1], 200, 15, false);   // move only the attribution
  const custom = offsetBetween(u.boxes[0], u.boxes[1]);
  dragBoxes(u.boxes, u.texts, u.boxes[0], 40, 40, true);     // now linked, move the pair
  applyRecentre(planRecentre(u.boxes, true), u.texts);
  ok(u.boxes[0].dx === 0 && u.boxes[0].dy === 0, 'the anchor is home', at(u.boxes[0]));
  ok(offsetBetween(u.boxes[0], u.boxes[1]).x === custom.x
    && offsetBetween(u.boxes[0], u.boxes[1]).y === custom.y,
    'and the arrangement they set up by hand survived the recentre',
    `${JSON.stringify(custom)} -> ${JSON.stringify(offsetBetween(u.boxes[0], u.boxes[1]))}`);
  ok(u.boxes[1].dx === 200, 'the second box keeps its own offset', String(u.boxes[1].dx));

  /* Unlinked: each goes to its own home, which IS the template arrangement. */
  const v = icon();
  dragBoxes(v.boxes, v.texts, v.boxes[0], 70, 70, false);
  dragBoxes(v.boxes, v.texts, v.boxes[1], -30, 10, false);
  applyRecentre(planRecentre(v.boxes, false), v.texts);
  ok(v.boxes.every((b) => b.dx === 0 && b.dy === 0),
    'unlinked, every box goes back to the template', v.boxes.map(at).join(' | '));

  /* Already home is a no-op rather than a redraw of everything. */
  ok(planRecentre(icon().boxes, true).length === 0, 'a pair already home plans no moves');
  ok(planRecentre(icon().boxes, false).length === 0, 'and so does an unlinked one');
  ok(planRecentre([], true).length === 0, 'and no boxes at all is not an error');
}

/* ---------------------------------------- 6. the words, and whose choice */

say('\n6. "MOVE WITH BOX" STAYS A PER-FIELD CHOICE\n');
{
  const t = icon();
  t.texts[1].linked = false;          // the attribution text is NOT pinned
  const quotePos = { ...t.texts[0].pos };
  const attrPos = { ...t.texts[1].pos };

  dragBoxes(t.boxes, t.texts, t.boxes[0], 25, 35, true);

  ok(t.texts[0].pos.x === quotePos.x + 25 && t.texts[0].pos.y === quotePos.y + 35,
    'a pinned field travels with its box', JSON.stringify(t.texts[0].pos));
  ok(t.texts[1].pos.x === attrPos.x && t.texts[1].pos.y === attrPos.y,
    'an unpinned one stays exactly where it was, even though the boxes are linked',
    JSON.stringify(t.texts[1].pos));

  /* A field with no position has not been laid out yet; giving it one here
     would put it somewhere the layout never chose. */
  const u = icon();
  u.texts[0].pos = null;
  dragBoxes(u.boxes, u.texts, u.boxes[0], 10, 10, true);
  ok(u.texts[0].pos === null, 'a field with no position yet is left alone, not invented');

  /* Only its OWN box's text moves, never the other box's. */
  const w = icon();
  const otherBefore = { ...w.texts[1].pos };
  moveBox(w.boxes[0], w.texts, 12, 12);
  ok(w.texts[1].pos.x === otherBefore.x,
    "moving one box never drags the other box's words", JSON.stringify(w.texts[1].pos));
}

/* ------------------------------------------------- 7. position only */

say('\n7. POSITION ONLY — NOTHING ELSE IS SHARED\n');
{
  const t = icon();
  t.boxes[0].scale = 1.4;
  t.boxes[1].scale = 0.8;
  t.boxes[0].rot = 5;
  t.boxes[1].fillColour = '#ff0000';

  dragBoxes(t.boxes, t.texts, t.boxes[0], 50, 50, true);
  applyRecentre(planRecentre(t.boxes, true), t.texts);

  ok(t.boxes[0].scale === 1.4 && t.boxes[1].scale === 0.8,
    'size is per box and untouched', `${t.boxes[0].scale} / ${t.boxes[1].scale}`);
  ok(t.boxes[0].rot === 5, 'angle too', String(t.boxes[0].rot));
  ok(t.boxes[1].fillColour === '#ff0000', 'and the key line and colours', t.boxes[1].fillColour);

  ok(boxTransform(t.boxes[0]) === 'translate(100,200) scale(1.4)',
    'the transform carries the box’s own scale', boxTransform(t.boxes[0]));
  ok(boxTransform({ id: 'x', x: 1, y: 2, dx: 3, dy: 4 }) === 'translate(4,6) scale(1)',
    'and defaults the scale when a box has none', boxTransform({ id: 'x', x: 1, y: 2, dx: 3, dy: 4 }));
}

/* ------------------------------------- 8. a drag of nothing changes nothing */

say('\n8. A ZERO MOVE IS A NO-OP\n');
{
  const t = icon();
  const before = t.boxes.map(at).join('|');
  dragBoxes(t.boxes, t.texts, t.boxes[0], 0, 0, true);
  ok(t.boxes.map(at).join('|') === before, 'a zero-delta drag moves nothing');
  ok(t.texts[0].pos.x === 300, 'and touches no text', String(t.texts[0].pos.x));
}

/* ------------------------------------------- 9. through the scene and back */

say('\n9. THE LINKED STATE SURVIVES A SAVE AND A RELOAD\n');
{
  /* The point of persisting it: a design reopened by Replace artwork or by
     Customise has to come back in the mode it was drawn in, or the first drag
     after the reload breaks the gap the customer set. */
  const drawn = icon();
  dragBoxes(drawn.boxes, drawn.texts, drawn.boxes[0], 90, -40, true);
  const gapWhenDrawn = offsetBetween(drawn.boxes[0], drawn.boxes[1]);

  /* What the builder writes into the scene. */
  const scene = {
    boxesLinked: sceneLinkFlag(drawn.boxes, true),
    boxes: drawn.boxes.map((b) => ({
      id: b.id, offset: { x: Math.round(b.dx), y: Math.round(b.dy) },
    })),
    text: drawn.texts.map((f) => ({
      id: f.id,
      pos: f.pos ? { x: Math.round(f.pos.x), y: Math.round(f.pos.y) } : null,
      movesWithBox: fieldMovesWithBox(f),
    })),
  };
  ok(scene.boxesLinked === true, 'the scene records that the boxes were linked',
    String(scene.boxesLinked));
  ok(scene.text.every((t) => t.movesWithBox === true),
    'and that each field was moving with its box',
    JSON.stringify(scene.text.map((t) => t.movesWithBox)));

  /* Through JSON, because that is what happens to it in the blob store. */
  const reloaded = JSON.parse(JSON.stringify(scene));

  /* What the builder restores. */
  const fresh = icon();
  for (const b of reloaded.boxes) {
    const box = fresh.boxes.find((x) => x.id === b.id);
    box.dx = b.offset.x; box.dy = b.offset.y;
  }
  for (const t of reloaded.text) {
    const f = fresh.texts.find((x) => x.id === t.id);
    if (t.pos) f.pos = { ...t.pos };
    applyFieldMovesWithBox(f, t.movesWithBox);
  }
  const linkedAgain = linkFromScene(fresh.boxes, reloaded);

  ok(linkedAgain === true, 'it comes back linked', String(linkedAgain));
  ok(fresh.texts.every((f) => f.linked === true), 'with the fields still pinned');
  const gapAfter = offsetBetween(fresh.boxes[0], fresh.boxes[1]);
  ok(gapAfter.x === gapWhenDrawn.x && gapAfter.y === gapWhenDrawn.y,
    'and the gap is the one it was drawn with',
    `${JSON.stringify(gapWhenDrawn)} -> ${JSON.stringify(gapAfter)}`);

  /* And the next drag still moves the pair, which is the thing that was broken
     before the flag was recorded. */
  dragBoxes(fresh.boxes, fresh.texts, fresh.boxes[0], 15, 15, linkedAgain);
  const gapAfterDrag = offsetBetween(fresh.boxes[0], fresh.boxes[1]);
  ok(gapAfterDrag.x === gapWhenDrawn.x && gapAfterDrag.y === gapWhenDrawn.y,
    'the first drag after a reload keeps it too', JSON.stringify(gapAfterDrag));

  /* Unlinked round-trips as unlinked. */
  const plain = icon();
  const plainScene = JSON.parse(JSON.stringify({ boxesLinked: sceneLinkFlag(plain.boxes, false) }));
  ok(plainScene.boxesLinked === false, 'an unlinked design says so', String(plainScene.boxesLinked));
  ok(linkFromScene(plain.boxes, plainScene) === false, 'and comes back unlinked');

  /* A design drawn before any of this existed has no flag at all. */
  ok(linkFromScene(icon().boxes, {}) === false,
    'a scene with no flag reads as unlinked — which is how those designs were made');
  ok(linkFromScene(icon().boxes, { boxesLinked: 'yes' }) === false,
    'and only an explicit true counts');
  ok(linkFromScene(icon().boxes, null) === false, 'a missing scene is not an error');

  /* A cover writes nothing, so nothing can come back wrong on one. */
  ok(sceneLinkFlag(cover().boxes, true) === undefined,
    'a one-box template records no flag at all', String(sceneLinkFlag(cover().boxes, true)));
  ok(linkFromScene(cover().boxes, { boxesLinked: true }) === false,
    'and would refuse one even if a scene carried it');

  /* "Move with box" on a field that has no box is not a thing. */
  ok(fieldMovesWithBox({ id: 'free', linked: true }) === undefined,
    'a field with no box records nothing');
  const free = { id: 'free', linked: false };
  applyFieldMovesWithBox(free, true);
  ok(free.linked === false, 'and cannot be given the setting on the way back in');
  const pinned = { id: 'q', boxRef: 'quote', linked: true };
  applyFieldMovesWithBox(pinned, undefined);
  ok(pinned.linked === true, 'an absent value leaves the field as the template made it');
}

say(`\n${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
