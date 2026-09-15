/**
 * Moving speech boxes, as data.
 *
 * The icon templates have two boxes -- the quote and the attribution -- and
 * until now nothing tied them together, so repositioning the pair meant
 * dragging each one and judging the gap by eye. "Link boxes" makes them move as
 * one; this is the arithmetic behind it.
 *
 * WHY THIS IS ITS OWN FILE, when the handler tests deliberately stubbed at the
 * npm boundary rather than carving seams into shipped code: there was no seam
 * here at all. Every one of these rules lives inside a 4,700-line closure that
 * only exists once a browser has mounted a component, so the only way to check
 * that a linked drag preserves a gap was to build a DOM, run the bundle and
 * synthesise pointer events -- which tests the arithmetic through four layers
 * that can each fail for their own reasons. The rules are pure: offsets in,
 * offsets out, no DOM. Pulling them out is the same move as _shared/photo-input:
 * the policy goes where it can be read and checked, the drawing stays with the
 * thing that can draw.
 *
 * Nothing here touches the SVG. The caller redraws.
 */

/** Where a box's group sits, given its home and its accumulated offset. */
export const boxTransform = (b) =>
  `translate(${b.x + b.dx},${b.y + b.dy}) scale(${b.scale || 1})`;

/**
 * Move one box by (sx, sy), taking its own text along if that text asked to go.
 *
 * "Move with box" is a per-field choice and stays one: linking the boxes says
 * nothing about whether the words inside them are pinned to them. A field with
 * no position yet is left alone rather than given one -- it has not been laid
 * out, and inventing a position here would put it somewhere the layout never
 * chose.
 *
 * Mutates, because the builder's boxes and fields ARE the live model; returning
 * copies would mean reconciling them back and that is where drift starts.
 */
export function moveBox(box, texts, sx, sy) {
  if (!sx && !sy) return box;
  box.dx += sx;
  box.dy += sy;
  for (const f of texts || []) {
    if (f.boxRef === box.id && f.linked && f.pos) { f.pos.x += sx; f.pos.y += sy; }
  }
  return box;
}

/**
 * One drag step.
 *
 * `sx, sy` is a DELTA, not a destination, and that is the whole reason a linked
 * drag preserves the gap: the boxes do not start level, so copying the dragged
 * box's offset onto the others would snap them together the instant the drag
 * began. Every box moves by the same amount instead, so whatever arrangement
 * the design already had survives exactly.
 *
 * @returns {object[]} the boxes that moved, for the caller to redraw
 */
export function dragBoxes(boxes, texts, dragged, sx, sy, linked) {
  const moving = linked ? boxes : [dragged];
  for (const b of moving) moveBox(b, texts, sx, sy);
  return moving;
}

/**
 * Where each box should go when the customer asks for them back.
 *
 * Unlinked, each box goes home to where the template puts it.
 *
 * Linked, the PAIR goes home: the first box lands on its own origin and every
 * other box moves by the same amount, so the gap the customer set up survives
 * the recentre instead of being quietly replaced by the template's. Recentring
 * a linked pair into a different arrangement from the one on screen is the one
 * thing that would make the link untrustworthy -- it would mean the boxes were
 * only linked while being dragged, which is not what the toggle says.
 *
 * @returns {{box: object, sx: number, sy: number}[]} what to move, and by how much
 */
export function planRecentre(boxes, linked) {
  if (!boxes || !boxes.length) return [];
  if (!linked) {
    return boxes
      .filter((b) => b.dx || b.dy)
      .map((b) => ({ box: b, sx: -b.dx, sy: -b.dy }));
  }
  const anchor = boxes[0];
  const sx = -anchor.dx, sy = -anchor.dy;
  if (!sx && !sy) return [];
  return boxes.map((b) => ({ box: b, sx, sy }));
}

/** Apply a plan from planRecentre. */
export function applyRecentre(plan, texts) {
  for (const { box, sx, sy } of plan) moveBox(box, texts, sx, sy);
  return plan.map((p) => p.box);
}

/**
 * The gap between two boxes, which is the thing a linked drag must never
 * change. Exported because it is what a test should assert on, and what a
 * future control that shows the gap would read.
 */
export const offsetBetween = (a, b) => ({ x: (b.x + b.dx) - (a.x + a.dx), y: (b.y + b.dy) - (a.y + a.dy) });

/** Is there anything to link? One box cannot be linked to itself. */
export const canLinkBoxes = (boxes) => Array.isArray(boxes) && boxes.length > 1;

/* ------------------------------------------------------ through the scene */

/*
 * Linking is an EDITING mode, not a drawing instruction: the renderer prints
 * the offsets, which are already resolved by the time a scene is written, and
 * never reads any of this. It is recorded so that a design reopened by Replace
 * artwork or by Customise comes back in the mode it was drawn in -- otherwise
 * the first drag after a reload would break a gap the customer had set, which
 * is exactly the complaint this feature exists to answer.
 */

/** What to write for a scene. `undefined` on a template with nothing to link. */
export const sceneLinkFlag = (boxes, linked) => (canLinkBoxes(boxes) ? !!linked : undefined);

/**
 * What to restore from one. Absent -- every design drawn before this existed --
 * reads as unlinked, which is the behaviour those designs were made with.
 */
export const linkFromScene = (boxes, recipe) =>
  canLinkBoxes(boxes) && recipe?.boxesLinked === true;

/**
 * "Move with box", per field.
 *
 * This was never recorded and so was lost on every reopen. It has to survive
 * now: linked boxes that carried their words while being drawn, and then came
 * back not carrying them, would look like the link itself was broken.
 */
export const fieldMovesWithBox = (f) => (f && f.boxRef ? !!f.linked : undefined);

/** Restore it, ignoring anything that is not an explicit true or false. */
export function applyFieldMovesWithBox(f, saved) {
  if (f && f.boxRef && typeof saved === 'boolean') f.linked = saved;
  return f;
}
