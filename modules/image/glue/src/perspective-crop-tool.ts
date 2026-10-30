// THE PERSPECTIVE CROP TOOL (WP5.6, image ADR 483) — in the crop tool's
// flyout, no key of its own, as Photoshop has it. A drag draws the crop
// as a rectangle; each corner then drags on its own (the quadrilateral
// follows the perspective of the photograph: a façade, a document shot at
// an angle), a drag inside moves it whole, a drag outside starts again.
// The overlay draws the quadrilateral, its four corner handles and the
// perspective grid through it (the homography from the unit square onto
// the quad, the SDK's `homographyFromQuads`). Enter, or Image ▸ Apply
// perspective crop, commits — the whole stack drawn upright onto a canvas
// sized from the quad's sides (`layers_perspective_crop`,
// `geom.warp_projective`), ONE undo step; Escape clears.

import type {
  BundleHost,
  CanvasPointerEvent,
  Disposable,
  GestureHandler,
  PagedEditor,
  ToolPreviewShape,
} from "@paged-media/plugin-api";
import { applyMatrix3, homographyFromQuads } from "@paged-media/plugin-sdk";

import {
  imageToPage,
  pageToImage,
  resolveFrameFit,
  type FitTransform,
} from "./frame-fit";
import type { ImageSession } from "./session";

type Pt = [number, number];
/** NW, NE, SE, SW, image px. */
export type CropQuad = [Pt, Pt, Pt, Pt];

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The size the quad is drawn upright at: the mean of its opposite sides,
 *  as Photoshop sizes a perspective crop by default. */
export function perspectiveCropSize(q: CropQuad): {
  width: number;
  height: number;
} {
  const width = Math.round((dist(q[0], q[1]) + dist(q[3], q[2])) / 2);
  const height = Math.round((dist(q[0], q[3]) + dist(q[1], q[2])) / 2);
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/** Is `p` inside the (convex or not) quad? Even-odd. */
function inside(q: CropQuad, p: Pt): boolean {
  let c = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const [xi, yi] = q[i]!;
    const [xj, yj] = q[j]!;
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      c = !c;
  }
  return c;
}

/** The tool's geometry, without a canvas. */
export interface PerspectiveCropMachine {
  quad(): CropQuad | null;
  down(p: Pt, tol: number): void;
  move(p: Pt): void;
  up(): void;
  clear(): void;
  /** The grid lines through the quad (thirds), image px. */
  grid(): Pt[][];
}

export function createPerspectiveCropMachine(): PerspectiveCropMachine {
  let quad: CropQuad | null = null;
  let drag:
    | { kind: "rect"; from: Pt }
    | { kind: "corner"; i: number }
    | { kind: "move"; from: Pt; start: CropQuad }
    | null = null;
  return {
    quad: () => quad,
    down(p, tol) {
      if (quad) {
        let best = -1;
        let bestD = tol;
        quad.forEach((c, i) => {
          const d = dist(c, p);
          if (d <= bestD) {
            best = i;
            bestD = d;
          }
        });
        if (best >= 0) {
          drag = { kind: "corner", i: best };
          return;
        }
        if (inside(quad, p)) {
          drag = { kind: "move", from: p, start: quad };
          return;
        }
      }
      quad = null;
      drag = { kind: "rect", from: p };
    },
    move(p) {
      if (!drag) return;
      if (drag.kind === "rect") {
        const [x0, y0] = drag.from;
        quad = [
          [Math.min(x0, p[0]), Math.min(y0, p[1])],
          [Math.max(x0, p[0]), Math.min(y0, p[1])],
          [Math.max(x0, p[0]), Math.max(y0, p[1])],
          [Math.min(x0, p[0]), Math.max(y0, p[1])],
        ];
      } else if (drag.kind === "corner" && quad) {
        const next = [...quad] as CropQuad;
        next[drag.i] = p;
        quad = next;
      } else if (drag.kind === "move") {
        const dx = p[0] - drag.from[0];
        const dy = p[1] - drag.from[1];
        quad = drag.start.map(([x, y]) => [x + dx, y + dy]) as CropQuad;
      }
    },
    up() {
      // A click without a drag leaves no (empty) quad behind.
      if (quad && perspectiveCropSize(quad).width <= 1 && drag?.kind === "rect")
        quad = null;
      drag = null;
    },
    clear() {
      quad = null;
      drag = null;
    },
    grid() {
      if (!quad) return [];
      const h = homographyFromQuads(
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        quad,
      );
      if (!h) return [];
      const out: Pt[][] = [];
      for (const t of [1 / 3, 2 / 3]) {
        out.push([applyMatrix3(h, [t, 0]), applyMatrix3(h, [t, 1])]);
        out.push([applyMatrix3(h, [0, t]), applyMatrix3(h, [1, t])]);
      }
      return out;
    },
  };
}

/** Commit the machine's quad (Enter, or Image ▸ Apply perspective crop:
 *  the command and the tool share one machine). False without a quad. */
export async function commitPerspectiveCropOf(
  machine: PerspectiveCropMachine,
  session: ImageSession,
): Promise<boolean> {
  const q = machine.quad();
  if (!q) return false;
  const { width, height } = perspectiveCropSize(q);
  machine.clear();
  return session.commitPerspectiveCrop(q, width, height);
}

/** The tool's gesture over the composited frame, over `machine` (shared
 *  with the Apply command). */
export function makePerspectiveCropGesture(
  host: BundleHost,
  session: ImageSession,
  machine: PerspectiveCropMachine,
): GestureHandler {
  let fit: FitTransform | null = null;
  let layer:
    (Disposable & { set(s: ToolPreviewShape[]): void; clear(): void }) | null =
    null;
  const render = () => {
    if (!fit) return;
    layer ??= host.overlay.layer("perspective-crop");
    const q = machine.quad();
    if (!q) {
      layer.clear();
      return;
    }
    const f = fit;
    const page = (p: Pt) => imageToPage(f, p);
    const shapes: ToolPreviewShape[] = [
      { pageId: f.pageId, points: q.map(page), close: true },
      ...machine.grid().map((l) => ({ pageId: f.pageId, points: l.map(page) })),
      ...q.map((c): ToolPreviewShape => {
        const [x, y] = page(c);
        return { kind: "handle", pageId: f.pageId, x, y, shape: "square" };
      }),
    ];
    layer.set(shapes);
  };
  const at = (e: CanvasPointerEvent): Pt | null =>
    fit && e.pagePoint ? pageToImage(fit, e.pagePoint) : null;
  return {
    onActivate(_paged: PagedEditor) {
      void resolveFrameFit(
        host,
        session.state().source,
        "perspective crop",
      ).then((f) => {
        fit = f;
        render();
      });
    },
    onDeactivate() {
      machine.clear();
      layer?.clear();
      fit = null;
    },
    onPointerDown(e) {
      const p = at(e);
      if (!p || !fit) return;
      // Six page pt of grab, in image px.
      machine.down(p, 6 / fit.scale);
      render();
    },
    onPointerMove(e) {
      const p = at(e);
      if (!p) return;
      machine.move(p);
      render();
    },
    onPointerUp() {
      machine.up();
      render();
    },
    onKey(e) {
      if (e.key === "Escape") {
        machine.clear();
        render();
      } else if (e.key === "Enter") {
        void commitPerspectiveCropOf(machine, session).then(render);
      }
    },
  };
}
