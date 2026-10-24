/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
 *
 * paged is free software: you may redistribute it and/or modify it under the
 * terms of the GNU Affero General Public License, version 3, as published by
 * the Free Software Foundation, OR under the Paged Media Enterprise License
 * (PMEL), a commercial license available from And The Next GmbH. Full
 * copyright and license information is available in LICENSE.md, distributed
 * with this source code.
 *
 * paged is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the licenses for details.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    AGPL-3.0-only OR Paged Media Enterprise License (PMEL)
 */

// Canvas operations on a stored layer stack (PGIL), headless: rotate by a
// quarter turn, flip, crop and Canvas Size, over every layer, mask and
// group mask at once — what the editor's Image ▸ Rotate / Flip / Canvas
// Size do to the interactive stack (image-js `transform_canvas`).
//
// These move pixels; they compute none. Every output pixel is one input
// pixel (or transparent, where Canvas Size adds area), so there is no
// kernel here and no GPU is needed. The COMPOSITE of the new stack is
// still the object model's business: the identity bakes on the CPU, any
// other stack is stored pending (image-objects.ts).
//
// A smart object is refused: its preserved source does not follow a canvas
// transform here (its re-render at the new orientation is a GPU resample).

import type { PgilLayer, PgilStack } from "./pgil";

export const QUARTER_OPS = [
  "rotateCw",
  "rotateCcw",
  "rotate180",
  "flipHorizontal",
  "flipVertical",
] as const;
export type QuarterOp = (typeof QUARTER_OPS)[number];

/** The nine-point anchor of Canvas Size: where the old canvas sits. */
export const ANCHORS = [
  "topLeft",
  "top",
  "topRight",
  "left",
  "center",
  "right",
  "bottomLeft",
  "bottom",
  "bottomRight",
] as const;
export type Anchor = (typeof ANCHORS)[number];

export type CanvasOp =
  | { kind: QuarterOp }
  /** Keep the `width × height` region at (`x`, `y`). */
  | { kind: "crop"; x: number; y: number; width: number; height: number }
  /** Resize the canvas, the old one placed at `anchor`. */
  | { kind: "canvas"; width: number; height: number; anchor: Anchor };

/** Why `op` cannot apply to `stack`, or null. */
export function canvasOpProblem(stack: PgilStack, op: CanvasOp): string | null {
  if (stack.layers.some((l) => l.kind === "smart"))
    return "a stack with a smart object is rotated, flipped or resized in the editor (its source re-renders on the GPU)";
  if (op.kind === "crop") {
    const { x, y, width, height } = op;
    if (![x, y, width, height].every(Number.isInteger))
      return "a crop is whole pixels";
    if (width < 1 || height < 1) return "a crop keeps at least one pixel";
    if (x < 0 || y < 0 || x + width > stack.width || y + height > stack.height)
      return `the crop must lie inside the ${stack.width}×${stack.height} canvas`;
  }
  if (op.kind === "canvas") {
    if (!Number.isInteger(op.width) || !Number.isInteger(op.height))
      return "a canvas size is whole pixels";
    if (op.width < 1 || op.height < 1)
      return "a canvas is at least one pixel each way";
    if (op.width > 30000 || op.height > 30000)
      return "a canvas is at most 30000 pixels each way";
  }
  return null;
}

/** Old pixel `(sx, sy)` for new pixel `(x, y)`, or null (new area). */
type PixelMap = (x: number, y: number) => [number, number] | null;

function plan(
  W: number,
  H: number,
  op: CanvasOp,
): { width: number; height: number; at: PixelMap } {
  switch (op.kind) {
    case "rotateCw":
      return { width: H, height: W, at: (x, y) => [y, H - 1 - x] };
    case "rotateCcw":
      return { width: H, height: W, at: (x, y) => [W - 1 - y, x] };
    case "rotate180":
      return { width: W, height: H, at: (x, y) => [W - 1 - x, H - 1 - y] };
    case "flipHorizontal":
      return { width: W, height: H, at: (x, y) => [W - 1 - x, y] };
    case "flipVertical":
      return { width: W, height: H, at: (x, y) => [x, H - 1 - y] };
    case "crop":
      return {
        width: op.width,
        height: op.height,
        at: (x, y) => [x + op.x, y + op.y],
      };
    case "canvas": {
      const col = ANCHORS.indexOf(op.anchor) % 3;
      const row = Math.floor(ANCHORS.indexOf(op.anchor) / 3);
      const dx = Math.floor(((op.width - W) * col) / 2);
      const dy = Math.floor(((op.height - H) * row) / 2);
      return {
        width: op.width,
        height: op.height,
        at: (x, y) => {
          const sx = x - dx;
          const sy = y - dy;
          return sx >= 0 && sy >= 0 && sx < W && sy < H ? [sx, sy] : null;
        },
      };
    }
  }
}

function remap(
  src: Uint8Array,
  bpp: number,
  W: number,
  width: number,
  height: number,
  at: PixelMap,
  fill: number,
): Uint8Array {
  const out = new Uint8Array(width * height * bpp).fill(fill);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const s = at(x, y);
      if (!s) continue;
      const from = (s[1] * W + s[0]) * bpp;
      out.set(src.subarray(from, from + bpp), (y * width + x) * bpp);
    }
  return out;
}

/** A bounded layer's pixels on the whole canvas. */
function canvasPixels(l: PgilLayer, W: number, H: number, bpp: number) {
  if (!l.rect) return l.pixels;
  const out = new Uint8Array(W * H * bpp);
  const r = l.rect;
  for (let y = 0; y < r.h; y++)
    out.set(
      l.pixels.subarray(y * r.w * bpp, (y + 1) * r.w * bpp),
      ((r.y + y) * W + r.x) * bpp,
    );
  return out;
}

function canvasMask(l: PgilLayer, W: number, H: number) {
  const r = l.maskRect;
  if (!r) return l.mask!;
  const out = new Uint8Array(W * H).fill(r.outside);
  for (let y = 0; y < r.h; y++)
    out.set(l.mask!.subarray(y * r.w, (y + 1) * r.w), (r.y + y) * W + r.x);
  return out;
}

/** Apply `op` to `stack` in place (call `canvasOpProblem` first). */
export function applyCanvasOp(stack: PgilStack, op: CanvasOp): void {
  const { width: W, height: H } = stack;
  const { width, height, at } = plan(W, H, op);
  for (const l of stack.layers) {
    const bpp = l.depth === 16 ? 8 : 4;
    l.pixels = remap(canvasPixels(l, W, H, bpp), bpp, W, width, height, at, 0);
    l.rect = null;
    if (l.mask) {
      const fill = l.maskRect ? l.maskRect.outside : 255;
      l.mask = remap(canvasMask(l, W, H), 1, W, width, height, at, fill);
      l.maskRect = null;
    }
  }
  for (const g of stack.groups)
    if (g.mask) g.mask = remap(g.mask, 1, W, width, height, at, 255);
  stack.width = width;
  stack.height = height;
}

/** A selection's coverage (one byte per pixel) after `op`, as the
 *  editor's own canvas operations carry its live selection: a quarter turn
 *  or a flip moves it with the pixels, exactly; a crop or a canvas resize
 *  drops it (null), as a crop does in the editor. */
export function coverageAfterCanvasOp(
  sel: { width: number; height: number; coverage: Uint8Array },
  op: CanvasOp,
): { width: number; height: number; coverage: Uint8Array } | null {
  if (op.kind === "crop" || op.kind === "canvas") return null;
  const { width, height, at } = plan(sel.width, sel.height, op);
  return {
    width,
    height,
    coverage: remap(sel.coverage, 1, sel.width, width, height, at, 0),
  };
}
