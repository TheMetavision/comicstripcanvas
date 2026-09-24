/**
 * The file that gets printed for ONE order line.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A product carries one print master, made at whatever size the design was
 * built at. An order is for a particular size AND finish, and a canvas needs
 * inches of artwork beyond the face to fold round the stretcher bars. Adapting
 * the one to the other was being done by hand, per order, in an image editor --
 * which is slow, unrecorded, and the kind of job where a 1.5 in wrap becomes a
 * 2.5 in wrap at four in the afternoon.
 *
 * Two routes in, because there are two kinds of product:
 *
 *   a scene   The design is still in the studio blob store as the SVG the
 *             builder saved, with its artwork beside it. That is re-projected
 *             onto the ordered face and rasterised, so a gallery-wrap cover
 *             carries on into the wrap exactly as the builder showed it. 246
 *             products are like this -- every one that can be fulfilled today.
 *
 *   a master  A flat PNG and nothing else. It is fitted inside the face and,
 *             for a canvas, given a wrap. No stock product is in this state
 *             right now: the 65 without a scene are the 62 with no print file
 *             at all plus the 3 personalised. It is the route a master attached
 *             by hand will take.
 *
 * Every file leaves here with a pHYs chunk saying 300 dpi. A print file whose
 * own resolution is a matter of opinion gets printed at whatever the press
 * assumes, which is how a 24 in canvas comes back 18 in.
 */
import sharp from 'sharp';
import { DPI, geom, printPixels, reprojectScene, wrapInchesFor, FIT } from './print-geometry.mjs';
import { sizeWH } from './sizes.mjs';

/** The face a line was bought at, in inches, the way up the artwork is. */
export function faceFor(sizeKey, orientation) {
  const wh = sizeWH(sizeKey, orientation);
  if (!wh) throw new Error(`faceFor: "${sizeKey}" is not a size`);
  return { w: wh[0], h: wh[1] };
}

/**
 * Stamp the resolution into the file.
 *
 * sharp writes a pHYs chunk when a density is set; verified by reading the
 * chunk back rather than assumed, because a missing pHYs is invisible until
 * something downstream guesses 72.
 */
export const stampDpi = (png, dpi = DPI) =>
  sharp(png).withMetadata({ density: dpi }).png().toBuffer();

/** What pHYs actually says, for checking a finished file. */
export function readDpi(png) {
  let i = 8;
  while (i < png.length - 8) {
    const len = png.readUInt32BE(i);
    if (png.toString('ascii', i + 4, i + 8) === 'pHYs') {
      const ppuX = png.readUInt32BE(i + 8);
      return png[i + 16] === 1 ? Math.round(ppuX * 0.0254) : null;
    }
    i += 12 + len;
  }
  return null;
}

/**
 * A flat master, fitted to a face and given its wrap.
 *
 * NEVER crops. The master is fitted whole inside the face and any leftover is
 * padded, because a master is all there is -- there is no scene to go back to,
 * so anything trimmed off is gone. With every size now 3:2 and every master
 * 2:3 or 3:2, the pad should be nothing at all; `padded` in the result says
 * whether it fired, and the caller logs it, because if it ever does fire it
 * means a master is not the shape the shop sells.
 *
 * The wrap is mirrored by default: a canvas edge made of the picture's own
 * pixels reads as the picture continuing round the corner, where a band of
 * flat colour reads as a mistake. Solid is offered for artwork with a definite
 * border, where a mirrored edge doubles it.
 */
export async function fitFlatMaster({
  master, face, wrapInches = 0, edgeColour = null, wrapMode = 'mirror',
}) {
  const faceW = Math.round(face.w * DPI), faceH = Math.round(face.h * DPI);
  const meta = await sharp(master).metadata();
  const pad = edgeColour || '#FFFFFF';

  const masterAspect = meta.width / meta.height;
  const faceAspect = faceW / faceH;
  const padded = Math.abs(masterAspect - faceAspect) > 0.002;

  let img = sharp(master).resize(faceW, faceH, {
    fit: 'contain',
    background: pad,
    kernel: 'lanczos3',
  });

  const wrapPx = Math.round((Number(wrapInches) || 0) * DPI);
  if (wrapPx > 0) {
    const extend = { top: wrapPx, bottom: wrapPx, left: wrapPx, right: wrapPx };
    /* A mirrored extend needs the face as real pixels first: extendWith works
       on the pipeline's current image, and chaining it onto a resize that has
       not been executed mirrors the source, not the fitted face. */
    const faceBuf = await img.png().toBuffer();
    img = wrapMode === 'solid'
      ? sharp(faceBuf).extend({ ...extend, background: pad })
      : sharp(faceBuf).extend({ ...extend, extendWith: 'mirror' });
  }

  const png = await img.png().toBuffer();
  const out = await stampDpi(png);
  return {
    png: out,
    padded,
    masterAspect,
    faceAspect,
    width: faceW + 2 * wrapPx,
    height: faceH + 2 * wrapPx,
  };
}

/**
 * A saved scene, re-projected onto the ordered face and rasterised.
 *
 * `prepare` is _shared/render.mjs's prepareScene, passed in rather than
 * imported: it pulls in resvg, and the callers that only want the arithmetic
 * (studio-save, and the tests) must not drag a native binary into their bundle.
 * Same reason scene.mjs exists apart from render.mjs.
 */
export async function renderFromScene({
  sceneSvg, recipe, template, face, finish, prepare, rasterise, origin, imageFor,
}) {
  const canvas = recipe?.canvas;
  if (!canvas) throw new Error('renderFromScene: the recipe has no canvas');
  const fit = FIT[template];
  if (!fit) throw new Error(`renderFromScene: no fit rule for template "${template}"`);

  const savedFace = recipe?.output?.faceInches;
  if (!Array.isArray(savedFace) || savedFace.length !== 2) {
    throw new Error('renderFromScene: the recipe does not say what face it was saved at');
  }
  const from = geom(canvas, { w: savedFace[0], h: savedFace[1] }, fit,
    recipe.output.wrapInches || 0);
  const wrapInches = wrapInchesFor(finish);
  const to = geom(canvas, face, fit, wrapInches);

  const { svg: moved, changed } = reprojectScene(sceneSvg, canvas, from, to);

  /* The recipe travels with the scene and carries the geometry the renderer
     reads, so it has to describe the face being printed rather than the one it
     was saved at -- otherwise printGeometry() would size the raster for the
     wrong sheet. */
  const forPrint = {
    ...recipe,
    output: {
      ...recipe.output,
      faceInches: [face.w, face.h],
      wrapInches,
      fileInches: to.fileInches,
    },
  };

  const prepared = await prepare({ sceneSvg: moved, recipe: forPrint, origin, imageFor });
  try {
    const px = printPixels(to);
    const raster = rasterise(prepared.svg, prepared.fontFiles, px.width);
    let png = raster.asPng();

    /* resvg is given a width and works the height out from the viewBox, and a
       viewBox whose aspect is a recurring decimal can land a pixel short: a
       16x24 in cover rasterises 4800x7199. The existing print masters in Sanity
       are 4800x7199 for exactly this reason.

       The sheet size is the contract -- 24 in at 300 dpi is 7200 px, and a file
       that says 7199 is a file the press has to decide about. So it is made
       exact. A pixel or two is rounding; more than that means the geometry
       disagrees with the raster and is a fault rather than a rounding, so it
       throws instead of quietly stretching the artwork to fit. */
    const meta = await sharp(png).metadata();
    if (meta.width !== px.width || meta.height !== px.height) {
      const off = Math.max(Math.abs(meta.width - px.width), Math.abs(meta.height - px.height));
      if (off > 2) {
        throw new Error(
          `renderFromScene: rasterised ${meta.width}x${meta.height} but the sheet is `
          + `${px.width}x${px.height} — that is ${off}px out, not rounding`
        );
      }
      png = await sharp(png).resize(px.width, px.height, { fit: 'fill' }).png().toBuffer();
    }

    png = await stampDpi(png);
    return { png, width: px.width, height: px.height, changed, fileInches: to.fileInches };
  } finally {
    if (prepared.cleanup) await prepared.cleanup();
  }
}

/**
 * What a finished file for this line should measure, before making it.
 * Used by the cache key and by the page that reports progress.
 */
export function expectedPixels(face, finish) {
  const wrapInches = wrapInchesFor(finish);
  return printPixels({ fileInches: [face.w + 2 * wrapInches, face.h + 2 * wrapInches] });
}
