// THE PIXEL WARPS ON THE CANVAS (WP5.6, image ADR 483): what the open
// Warp, Puppet Warp and Liquify dialogs draw over the image (one retained
// overlay layer) and what a drag there does. Pure functions over the
// dialog's values and an `env` the session fills from the engine (the
// style mesh, the bent puppet mesh, a pin's rest point), so a test drives
// them without a canvas — `blur-gallery-pins.ts`'s pattern.
//
//   · WARP: the bent grid (the patch's isolines at thirds) and its sixteen
//     control points; dragging one makes the warp CUSTOM;
//   · PUPPET WARP: the bent mesh and the pins; a click on the image adds a
//     pin where the bent content is (its rest point), a drag moves a pin,
//     Alt-click removes one;
//   · LIQUIFY: every press is a stroke of the dialog's tool and brush; the
//     brush ring follows the drag and frozen strokes are outlined.

import type { ToolPreviewShape } from "@paged-media/plugin-api";

import type { FilterValue, FilterValues } from "./filters-schema";
import { STYLE_CUSTOM } from "./filters-warp";
import { imageToPage, type FitTransform } from "./frame-fit";

type Pt = [number, number];
type Patch = Record<string, FilterValue>;

/** What the canvas needs beyond the values (the session answers from the
 *  engine). */
export interface WarpCanvasEnv {
  /** The image's size, px. */
  width: number;
  height: number;
  /** The Warp's sixteen control points, px (flat x/y). */
  mesh(): readonly number[];
  /** The bent Puppet Warp mesh's edges, px (flat x0, y0, x1, y1 …). */
  edges(): readonly number[];
  /** Where `at` on the bent layer rests in the unbent one. */
  restPoint(at: Pt): Pt;
  /** The last pointer position of a Liquify drag (px), or null. */
  brushAt: Pt | null;
}

/** One drag on the canvas: each pointer position → the values it sets. */
export interface WarpDrag {
  move(at: Pt): Patch | null;
}

const n = (v: FilterValues, k: string, d = 0): number => {
  const x = v[k];
  return typeof x === "number" ? x : d;
};
const list = (v: FilterValues, k: string): number[] => {
  const x = v[k];
  return Array.isArray(x) ? [...(x as readonly number[])] : [];
};
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The grab radius in image px: about 1.5 % of the longer side, at
 *  least 4 px (a tenth of a tiny image's side). */
export const grabRadius = (w: number, h: number) => {
  const span = Math.max(w, h);
  return Math.max(Math.min(4, span * 0.1), span * 0.015);
};

function bern(t: number): [number, number, number, number] {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

/** A point of the bicubic Bézier patch `m` (paged-warp's envelope, drawn
 *  here only; the warp itself is the engine's). */
export function patchPoint(m: readonly number[], u: number, v: number): Pt {
  const bu = bern(u);
  const bv = bern(v);
  let x = 0;
  let y = 0;
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      const w = bv[r]! * bu[c]!;
      x += w * m[2 * (r * 4 + c)]!;
      y += w * m[2 * (r * 4 + c) + 1]!;
    }
  return [x, y];
}

/** The shapes the open dialog `id` draws, in page coordinates. */
export function warpCanvasShapes(
  id: string,
  v: FilterValues,
  env: WarpCanvasEnv,
  fit: FitTransform,
): ToolPreviewShape[] {
  const out: ToolPreviewShape[] = [];
  const page = (p: Pt) => imageToPage(fit, p);
  const poly = (pts: Pt[], close = false) =>
    out.push({ pageId: fit.pageId, points: pts.map(page), close });
  const handle = (p: Pt, shape: "square" | "round", active = false) => {
    const [x, y] = page(p);
    out.push({ kind: "handle", pageId: fit.pageId, x, y, shape, active });
  };
  if (id === "warp") {
    const m = env.mesh();
    if (m.length !== 32) return out;
    const steps = 16;
    for (let k = 0; k <= 3; k++) {
      const a: Pt[] = [];
      const b: Pt[] = [];
      for (let i = 0; i <= steps; i++) {
        a.push(patchPoint(m, k / 3, i / steps));
        b.push(patchPoint(m, i / steps, k / 3));
      }
      poly(a);
      poly(b);
    }
    for (let i = 0; i < 16; i++) {
      const corner = i === 0 || i === 3 || i === 12 || i === 15;
      handle([m[2 * i]!, m[2 * i + 1]!], corner ? "square" : "round");
    }
  } else if (id === "puppetWarp") {
    if (v.showMesh !== false) {
      const e = env.edges();
      for (let i = 0; i + 3 < e.length; i += 4)
        poly([
          [e[i]!, e[i + 1]!],
          [e[i + 2]!, e[i + 3]!],
        ]);
    }
    const p = list(v, "pins");
    for (let i = 0; i + 3 < p.length; i += 4)
      handle([p[i + 2]! * env.width, p[i + 3]! * env.height], "round");
  } else if (id === "liquify") {
    const s = list(v, "strokes");
    let i = 0;
    while (i + 6 <= s.length) {
      const count = s[i + 5]!;
      // Freeze (8) and thaw (9) strokes stay visible: the mask.
      if (s[i] === 8 && count > 0) {
        const pts: Pt[] = [];
        for (let k = 0; k < count; k++)
          pts.push([
            s[i + 6 + 2 * k]! * env.width,
            s[i + 7 + 2 * k]! * env.height,
          ]);
        poly(pts.length === 1 ? [pts[0]!, pts[0]!] : pts);
      }
      i += 6 + 2 * count;
    }
    if (env.brushAt) {
      const r = n(v, "size", 100) / 2;
      const ring: Pt[] = [];
      for (let k = 0; k < 40; k++) {
        const a = (k / 40) * Math.PI * 2;
        ring.push([
          env.brushAt[0] + r * Math.cos(a),
          env.brushAt[1] + r * Math.sin(a),
        ]);
      }
      poly(ring, true);
    }
  }
  return out;
}

/** What a press at `at` (image px) grabs in the open dialog `id`, or null
 *  when it grabs nothing (the tool then has the event). */
export function warpCanvasHit(
  id: string,
  v: FilterValues,
  env: WarpCanvasEnv,
  at: Pt,
  alt: boolean,
): WarpDrag | null {
  const { width: w, height: h } = env;
  const tol = grabRadius(w, h);
  if (id === "warp") {
    const m = env.mesh();
    if (m.length !== 32) return null;
    let best = -1;
    let bestD = tol;
    for (let i = 0; i < 16; i++) {
      const d = dist(at, [m[2 * i]!, m[2 * i + 1]!]);
      if (d <= bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best < 0) return null;
    // From here the mesh is CUSTOM: the current points, normalised.
    const base = m.map((x, i) => x / (i % 2 === 0 ? w : h));
    return {
      move(p) {
        const next = [...base];
        next[2 * best] = p[0] / w;
        next[2 * best + 1] = p[1] / h;
        return { style: STYLE_CUSTOM, mesh: next };
      },
    };
  }
  if (id === "puppetWarp") {
    const pins = list(v, "pins");
    for (let i = 0; i + 3 < pins.length; i += 4) {
      if (dist(at, [pins[i + 2]! * w, pins[i + 3]! * h]) > tol) continue;
      if (alt) {
        let done = false;
        return {
          move() {
            if (done) return null;
            done = true;
            const next = [...pins];
            next.splice(i, 4);
            return { pins: next };
          },
        };
      }
      return {
        move(p) {
          const next = list(v, "pins");
          next[i + 2] = p[0] / w;
          next[i + 3] = p[1] / h;
          return { pins: next };
        },
      };
    }
    if (alt) return null;
    // A new pin where the bent content is: it holds its rest point.
    const rest = env.restPoint(at);
    const added = [...pins, rest[0] / w, rest[1] / h, at[0] / w, at[1] / h];
    const k = pins.length;
    let first = true;
    return {
      move(p) {
        if (first) {
          first = false;
          return { pins: added };
        }
        const next = [...added];
        next[k + 2] = p[0] / w;
        next[k + 3] = p[1] / h;
        return { pins: next };
      },
    };
  }
  if (id === "liquify") {
    const span = Math.max(w, h);
    const head = [
      n(v, "tool"),
      n(v, "size", 100) / span,
      n(v, "pressure", 100) / 100,
      n(v, "density", 50) / 100,
      n(v, "rate", 80) / 100,
      0,
    ];
    const strokes = list(v, "strokes");
    const at0 = strokes.length;
    const points: number[] = [];
    let last: Pt | null = null;
    return {
      move(p) {
        if (last && dist(p, last) < 0.5) return null;
        last = p;
        points.push(p[0] / w, p[1] / h);
        const stroke = [...head];
        stroke[5] = points.length / 2;
        return { strokes: [...strokes.slice(0, at0), ...stroke, ...points] };
      },
    };
  }
  return null;
}
