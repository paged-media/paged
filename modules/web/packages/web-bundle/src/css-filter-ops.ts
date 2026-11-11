/*
 * This file is part of paged (https://paged.media).
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

// CSS `filter:` colour functions and `blur()` as the engine's image filter
// stack (engine ADR 1037, amendment 2026-11-11): the web module's reader of
// the CSS encoding. A web picture's filter is then the same engine operation
// a Photoshop adjustment layer or a Word picture correction is, drawn in
// every output and editable in the Picture panel.
//
// Filter Effects 1 defines every colour function as a linear map of the
// straight sRGB colour (`feColorMatrix` / `feComponentTransfer`, clamped
// after each function), so each is one channel-mixer op exactly; `blur()`'s
// standard deviation, in points, becomes a blur in the picture's own pixels.

import type { RasterOp } from "@paged-media/plugin-api";

type Row = [number, number, number, number];

const mixer = (red: Row, green: Row, blue: Row): RasterOp => ({
  op: "channelMixer",
  red,
  green,
  blue,
});

/** The channel mixer's own range (`RasterOp::is_valid`): coefficients
 *  −2..2, constants −1..1. */
function inRange(op: RasterOp): boolean {
  if (op.op !== "channelMixer") return true;
  return [op.red, op.green, op.blue].every(
    (row) =>
      row.slice(0, 3).every((v) => v >= -2 && v <= 2) &&
      row[3] >= -1 &&
      row[3] <= 1,
  );
}

/** The matrix of one CSS colour function (`amount` as CSS resolves it: a
 *  fraction, `hue-rotate` in degrees); `null` for a function the spec does
 *  not define as one. */
export function cssColorFilterOp(fn: string, amount: number): RasterOp | null {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  switch (fn) {
    case "grayscale": {
      const k = 1 - clamp01(amount);
      return mixer(
        [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0],
        [0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0],
        [0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k, 0],
      );
    }
    case "sepia": {
      const k = 1 - clamp01(amount);
      return mixer(
        [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0],
        [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0],
        [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k, 0],
      );
    }
    case "saturate": {
      const s = Math.max(0, amount);
      return mixer(
        [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0],
        [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0],
        [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0],
      );
    }
    case "hue-rotate": {
      const a = (amount * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return mixer(
        [
          0.213 + c * 0.787 - s * 0.213,
          0.715 - c * 0.715 - s * 0.715,
          0.072 - c * 0.072 + s * 0.928,
          0,
        ],
        [
          0.213 - c * 0.213 + s * 0.143,
          0.715 + c * 0.285 + s * 0.14,
          0.072 - c * 0.072 - s * 0.283,
          0,
        ],
        [
          0.213 - c * 0.213 - s * 0.787,
          0.715 - c * 0.715 + s * 0.715,
          0.072 + c * 0.928 + s * 0.072,
          0,
        ],
      );
    }
    case "brightness": {
      const a = Math.max(0, amount);
      return mixer([a, 0, 0, 0], [0, a, 0, 0], [0, 0, a, 0]);
    }
    case "contrast": {
      const a = Math.max(0, amount);
      const c = 0.5 - 0.5 * a;
      return mixer([a, 0, 0, c], [0, a, 0, c], [0, 0, a, c]);
    }
    case "invert": {
      const a = clamp01(amount);
      const d = 1 - 2 * a;
      return mixer([d, 0, 0, a], [0, d, 0, a], [0, 0, d, a]);
    }
    default:
      return null;
  }
}

/** The ops a CSS filter list's colour functions and blurs make on a picture
 *  of `pxPerPt` pixels per point, in list order, and the loss keys of what
 *  does not map (a function out of the op's range, an unknown one). The
 *  caller handles `opacity()`, `drop-shadow()` and `url()`. */
export function cssFilterOps(
  filters: readonly (
    | { kind: "blur"; radius: number }
    | { kind: "color"; function: string; amount: number }
  )[],
  pxPerPt: number,
): { ops: RasterOp[]; losses: string[] } {
  const ops: RasterOp[] = [];
  const losses: string[] = [];
  for (const f of filters) {
    if (f.kind === "blur") {
      // σ in the picture's own pixels; the stack takes at most 64.
      const radius = f.radius * pxPerPt;
      if (!(radius >= 0)) losses.push("filter.blur");
      else {
        if (radius > 64) losses.push("filter.blur.wide");
        ops.push({ op: "blur", radius: Math.min(64, radius) });
      }
      continue;
    }
    const op = cssColorFilterOp(f.function, f.amount);
    if (op && inRange(op)) ops.push(op);
    else losses.push(`filter.${f.function}`);
  }
  return { ops, losses };
}
