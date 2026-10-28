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

// An animated slide drawn with Canvas2D (slide ADR 714): the fallback where
// the device has no WebGPU, and the canvas preview's. The same layers and
// draw states as the WebGPU compositor (effects/layer.wgsl); a filter is a
// clip path of the same geometry (`filterClip`, pure), a colour effect is
// not drawn here.

import type { Box } from "../anim/model.js";
import type { DrawState, MaskState } from "./scene.js";
import type { SlideScene } from "./scene-source.js";

/** A filter's visible area at its progress, in page pt: polygons (null:
 *  no clip), whether they are the area or its complement (an exit takes
 *  the area away), a factor on the layer's opacity and a shift of its
 *  content (`slide`). */
export interface FilterClip {
  polys: [number, number][][] | null;
  complement: boolean;
  alpha: number;
  shift: [number, number];
}

const rect = (b: Box, x0: number, y0: number, x1: number, y1: number) =>
  [
    [b.x + x0 * b.w, b.y + y0 * b.h],
    [b.x + x1 * b.w, b.y + y0 * b.h],
    [b.x + x1 * b.w, b.y + y1 * b.h],
    [b.x + x0 * b.w, b.y + y1 * b.h],
  ] as [number, number][];

/** Pseudo-random 0..1 for cell `i` (the same cells every frame). */
const cellHash = (i: number, seed: number) => {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** A polygon of an ellipse inscribed in the box, scaled by `r` about its
 *  centre. */
const ellipse = (b: Box, r: number, n = 48): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [
      b.x + b.w / 2 + (Math.cos(a) * r * b.w) / 2,
      b.y + b.h / 2 + (Math.sin(a) * r * b.h) / 2,
    ] as [number, number];
  });

/** A pie from twelve o'clock, clockwise, `from`..`to` radians. */
const pie = (b: Box, from: number, to: number): [number, number][] => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const R = Math.hypot(b.w, b.h);
  const pts: [number, number][] = [[cx, cy]];
  const n = Math.max(2, Math.ceil(((to - from) / Math.PI) * 24));
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    pts.push([cx + Math.sin(a) * R, cy - Math.cos(a) * R]);
  }
  return pts;
};

export function filterClip(m: MaskState, seed = 1): FilterClip {
  const p = Math.max(0, Math.min(1, m.progress));
  const b = m.box;
  const sub = m.sub ?? "";
  const none: FilterClip = {
    polys: null,
    complement: false,
    alpha: 1,
    shift: [0, 0],
  };
  const area = (polys: [number, number][][]): FilterClip => ({
    polys,
    complement: m.out,
    alpha: 1,
    shift: [0, 0],
  });
  switch (m.filter.toLowerCase()) {
    case "wipe":
      if (sub === "right") return area([rect(b, 1 - p, 0, 1, 1)]);
      if (sub === "up") return area([rect(b, 0, 0, 1, p)]);
      if (sub === "down") return area([rect(b, 0, 1 - p, 1, 1)]);
      return area([rect(b, 0, 0, p, 1)]);
    case "barn": {
      const vertical = sub.endsWith("Vertical") || sub === "";
      const out = sub.startsWith("out");
      const h = p / 2;
      if (out)
        return area([
          vertical ? rect(b, 0.5 - h, 0, 0.5 + h, 1) : rect(b, 0, 0.5 - h, 1, 0.5 + h),
        ]);
      return area(
        vertical
          ? [rect(b, 0, 0, h, 1), rect(b, 1 - h, 0, 1, 1)]
          : [rect(b, 0, 0, 1, h), rect(b, 0, 1 - h, 1, 1)],
      );
    }
    case "blinds":
    case "randombar":
    case "checkerboard": {
      const polys: [number, number][][] = [];
      const name = m.filter.toLowerCase();
      if (name === "blinds") {
        for (let i = 0; i < 6; i++)
          polys.push(
            sub === "vertical"
              ? rect(b, i / 6, 0, i / 6 + p / 6, 1)
              : rect(b, 0, i / 6, 1, i / 6 + p / 6),
          );
      } else if (name === "randombar") {
        const vertical = sub === "vertical";
        const n = Math.max(1, Math.floor((vertical ? b.w : b.h) / 1.5));
        for (let i = 0; i < n; i++)
          if (cellHash(i, seed) < p)
            polys.push(
              vertical
                ? rect(b, i / n, 0, (i + 1) / n, 1)
                : rect(b, 0, i / n, 1, (i + 1) / n),
            );
      } else {
        const down = sub === "down";
        for (let r = 0; r < 8; r++)
          for (let c = -1; c < 8; c += 2) {
            const off = r % 2 === 1 ? 1 : 0;
            const s = (c + off) / 8;
            const e = s + (2 / 8) * p;
            const [x0, x1] = [Math.max(0, s), Math.min(1, e)];
            if (x1 <= x0) continue;
            polys.push(
              down
                ? rect(b, r / 8, x0, (r + 1) / 8, x1)
                : rect(b, x0, r / 8, x1, (r + 1) / 8),
            );
          }
      }
      return area(polys);
    }
    case "box":
      if (sub === "in") {
        // Revealed from the edges in: all but a shrinking centre square.
        const k = (1 - p) / 2;
        return {
          polys: [rect(b, 0.5 - k, 0.5 - k, 0.5 + k, 0.5 + k)],
          complement: !m.out,
          alpha: 1,
          shift: [0, 0],
        };
      }
      return area([rect(b, 0.5 - p / 2, 0.5 - p / 2, 0.5 + p / 2, 0.5 + p / 2)]);
    case "circle":
      if (sub === "in")
        return {
          polys: [ellipse(b, Math.SQRT2 * (1 - p))],
          complement: !m.out,
          alpha: 1,
          shift: [0, 0],
        };
      return area([ellipse(b, Math.SQRT2 * p)]);
    case "diamond": {
      const d = (k: number): [number, number][] => [
        [b.x + b.w / 2, b.y + b.h / 2 - k * b.h],
        [b.x + b.w / 2 + k * b.w, b.y + b.h / 2],
        [b.x + b.w / 2, b.y + b.h / 2 + k * b.h],
        [b.x + b.w / 2 - k * b.w, b.y + b.h / 2],
      ];
      if (sub === "in")
        return { polys: [d(1 - p)], complement: !m.out, alpha: 1, shift: [0, 0] };
      return area([d(p)]);
    }
    case "plus": {
      const k = (sub === "in" ? 1 - p : p) / 2;
      const cross = [rect(b, 0.5 - k, 0, 0.5 + k, 1), rect(b, 0, 0.5 - k, 1, 0.5 + k)];
      if (sub === "in") return { polys: cross, complement: !m.out, alpha: 1, shift: [0, 0] };
      return area(cross);
    }
    case "dissolve": {
      const nx = Math.max(1, Math.round(b.w / 4));
      const ny = Math.max(1, Math.round(b.h / 4));
      const polys: [number, number][][] = [];
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++)
          if (cellHash(y * nx + x, seed) < p)
            polys.push(rect(b, x / nx, y / ny, (x + 1) / nx, (y + 1) / ny));
      return area(polys);
    }
    case "strips": {
      // The edge x + y = 2p (in box units) from the named corner.
      const k = 2 * p;
      const tri = (pts: [number, number][]) =>
        pts.map(([u, v]) => [b.x + u * b.w, b.y + v * b.h] as [number, number]);
      const from: Record<string, [number, number]> = {
        downLeft: [1, 0],
        upLeft: [1, 1],
        downRight: [0, 0],
        upRight: [0, 1],
      };
      const [cx, cy] = from[sub] ?? [0, 0];
      const sx = cx === 0 ? 1 : -1;
      const sy = cy === 0 ? 1 : -1;
      return area([
        tri([
          [cx, cy],
          [cx + sx * k, cy],
          [cx, cy + sy * k],
        ]),
      ]);
    }
    case "wedge":
      return area([pie(b, -Math.PI * p, Math.PI * p)]);
    case "wheel": {
      const n = Math.max(1, Number(sub) || 1);
      const polys: [number, number][][] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        polys.push(pie(b, a, a + (p * Math.PI * 2) / n));
      }
      return area(polys);
    }
    case "slide": {
      const away = m.out ? p : 1 - p;
      const dir: Record<string, [number, number]> = {
        fromTop: [0, -1],
        fromBottom: [0, 1],
        fromLeft: [-1, 0],
        fromRight: [1, 0],
      };
      const [dx, dy] = dir[sub] ?? [0, -1];
      return {
        polys: [rect(b, 0, 0, 1, 1)],
        complement: false,
        alpha: 1,
        shift: [dx * away * b.w, dy * away * b.h],
      };
    }
    case "fade":
    default:
      return { ...none, alpha: m.out ? 1 - p : p };
  }
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function clipTo(g: Ctx, c: FilterClip): void {
  if (!c.polys) return;
  const path = new Path2D();
  if (c.complement) path.rect(-1e5, -1e5, 2e5, 2e5);
  for (const poly of c.polys) {
    poly.forEach(([x, y], i) => (i === 0 ? path.moveTo(x, y) : path.lineTo(x, y)));
    path.closePath();
  }
  g.clip(path, c.complement ? "evenodd" : "nonzero");
}

/** Draw `scene` with `states` (one per layer) into `g`, whose transform
 *  maps page pt to its pixels already. */
export function drawScene2d(
  g: Ctx,
  scene: SlideScene,
  states: readonly DrawState[],
): void {
  const [w, h] = scene.sizePt;
  g.drawImage(scene.background, 0, 0, w, h);
  scene.layers.forEach((l, i) => {
    const s = states[i];
    if (!s || !s.visible || s.opacity <= 0) return;
    g.save();
    let alpha = s.opacity;
    let shift: [number, number] = [0, 0];
    // Filters are laid out on the page before the layer moves.
    const [a, b, c, d, e, f] = s.matrix;
    g.transform(a, b, c, d, e, f);
    for (const m of s.masks) {
      const clip = filterClip(m, i + 1);
      alpha *= clip.alpha;
      if (clip.shift[0] || clip.shift[1]) shift = clip.shift;
      clipTo(g, clip);
    }
    g.globalAlpha *= Math.max(0, Math.min(1, alpha));
    g.drawImage(
      l.image,
      l.region.x + shift[0],
      l.region.y + shift[1],
      l.region.width,
      l.region.height,
    );
    g.restore();
  });
}
