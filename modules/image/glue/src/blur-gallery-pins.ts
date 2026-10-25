// THE BLUR GALLERY ON THE CANVAS (WP5.2): what the workspace draws over
// the image (host.overlay, one retained layer) and what a drag there
// moves. Pure functions over the dialog's values, so the session owns no
// geometry of its own and a test can drive them without a canvas.
//
// Every blur that is on draws its handles: Field Blur its pins (a ring and
// the blur amount), Iris Blur its ellipse, the sharp core inside it, the
// centre and a handle on each axis, Tilt-Shift its centre line, the sharp
// band and the transition lines, the centre and an angle handle, Path Blur
// its polyline and points, Spin Blur its ellipse, centre and axis handles.
//
// A press near a handle drags it; a press elsewhere with Field Blur on
// places a new pin (Photoshop's click-to-add); Alt on a pin removes it.

import type { ToolPreviewShape } from "@paged-media/plugin-api";

import type { FilterValue, FilterValues } from "./filters-schema";
import { imageToPage, type FitTransform } from "./frame-fit";

type Pt = [number, number];
type Patch = Record<string, FilterValue>;

/** One drag on the canvas: each pointer position → the values it sets. */
export interface BlurDrag {
  move(at: Pt, width: number, height: number): Patch | null;
}

const n = (v: FilterValues, k: string, d = 0): number => {
  const x = v[k];
  return typeof x === "number" ? x : d;
};
const on = (v: FilterValues, k: string): boolean => v[k] === true;
const list = (v: FilterValues, k: string): number[] => {
  const x = v[k];
  return Array.isArray(x) ? [...(x as readonly number[])] : [];
};
const rad = (deg: number) => (deg * Math.PI) / 180;

/** An ellipse about `c` (image px), radii `rx`/`ry`, rotated `rot`°. */
function ellipse(c: Pt, rx: number, ry: number, rot: number, k = 48): Pt[] {
  const [cs, sn] = [Math.cos(rad(rot)), Math.sin(rad(rot))];
  const out: Pt[] = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    const [x, y] = [rx * Math.cos(a), ry * Math.sin(a)];
    out.push([c[0] + x * cs - y * sn, c[1] + x * sn + y * cs]);
  }
  return out;
}

/** A pin: a ring of `r` image px about `c`. */
const ring = (c: Pt, r: number) => ellipse(c, r, r, 0, 16);

/** The handle size in image px (about 1 % of the longer side). */
const handle = (w: number, h: number) => Math.max(3, Math.max(w, h) * 0.012);

/** The shapes the open Blur Gallery draws, in page coordinates. */
export function blurGalleryShapes(
  v: FilterValues,
  w: number,
  h: number,
  fit: FitTransform,
): ToolPreviewShape[] {
  const out: ToolPreviewShape[] = [];
  const page = (p: Pt) => imageToPage(fit, p);
  const poly = (pts: Pt[], close: boolean) =>
    out.push({ pageId: fit.pageId, points: pts.map(page), close });
  const label = (p: Pt, text: string) => {
    const [x, y] = page(p);
    out.push({
      kind: "text",
      pageId: fit.pageId,
      x,
      y,
      text,
      anchor: "middle",
      background: true,
    });
  };
  const r = handle(w, h);
  const span = Math.max(w, h);
  if (on(v, "field")) {
    const pins = list(v, "fieldPins");
    for (let i = 0; i + 2 < pins.length; i += 3) {
      const c: Pt = [pins[i]! * w, pins[i + 1]! * h];
      poly(ring(c, r), true);
      label([c[0], c[1] - 2 * r], `${Math.round(pins[i + 2]!)} px`);
    }
  }
  if (on(v, "iris")) {
    const c: Pt = [n(v, "irisX", 0.5) * w, n(v, "irisY", 0.5) * h];
    const [rx, ry] = [n(v, "irisRx") * span, n(v, "irisRy") * span];
    const rot = n(v, "irisRot");
    const f = n(v, "irisFeather", 0.5);
    poly(ellipse(c, rx, ry, rot), true);
    poly(ellipse(c, rx * f, ry * f, rot), true);
    poly(ring(c, r), true);
    for (const p of irisHandles(c, rx, ry, rot)) poly(ring(p, r * 0.7), true);
  }
  if (on(v, "tilt")) {
    const c: Pt = [n(v, "tiltX", 0.5) * w, n(v, "tiltY", 0.5) * h];
    const a = rad(n(v, "tiltAngle"));
    const d: Pt = [Math.cos(a), -Math.sin(a)];
    const nrm: Pt = [-d[1], d[0]];
    const line = (off: number) => {
      const o: Pt = [c[0] + nrm[0] * off, c[1] + nrm[1] * off];
      poly(
        [
          [o[0] - d[0] * span, o[1] - d[1] * span],
          [o[0] + d[0] * span, o[1] + d[1] * span],
        ],
        false,
      );
    };
    const sharp = n(v, "tiltSharp");
    const far = sharp + n(v, "tiltFeather");
    line(0);
    for (const s of [-1, 1]) {
      line(s * sharp);
      line(s * far);
    }
    poly(ring(c, r), true);
    poly(ring(tiltAngleHandle(c, a, span), r * 0.7), true);
  }
  if (on(v, "path")) {
    const pts = list(v, "pathPoints");
    const path: Pt[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2)
      path.push([pts[i]! * w, pts[i + 1]! * h]);
    if (path.length >= 2) poly(path, false);
    for (const p of path) poly(ring(p, r * 0.8), true);
  }
  if (on(v, "spin")) {
    const c: Pt = [n(v, "spinX", 0.5) * w, n(v, "spinY", 0.5) * h];
    const [rx, ry] = [n(v, "spinRx") * span, n(v, "spinRy") * span];
    const rot = n(v, "spinRot");
    poly(ellipse(c, rx, ry, rot), true);
    poly(ring(c, r), true);
    for (const p of irisHandles(c, rx, ry, rot)) poly(ring(p, r * 0.7), true);
    label([c[0], c[1] - 2 * r], `${Math.round(n(v, "spinAngle"))}°`);
  }
  return out;
}

/** The two axis handles of an ellipse: the end of its x and y radius. */
function irisHandles(c: Pt, rx: number, ry: number, rot: number): [Pt, Pt] {
  const [cs, sn] = [Math.cos(rad(rot)), Math.sin(rad(rot))];
  return [
    [c[0] + rx * cs, c[1] + rx * sn],
    [c[0] - ry * sn, c[1] + ry * cs],
  ];
}

/** Tilt-Shift's angle handle: on the centre line, a quarter span out. */
function tiltAngleHandle(c: Pt, a: number, span: number): Pt {
  return [c[0] + Math.cos(a) * span * 0.25, c[1] - Math.sin(a) * span * 0.25];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** A drag that moves the point at `xKey`/`yKey` (normalised). */
const moveCentre =
  (xKey: string, yKey: string): BlurDrag["move"] =>
  (at, w, h) => ({ [xKey]: clamp01(at[0] / w), [yKey]: clamp01(at[1] / h) });

/** What a press at `at` (image px) grabs, or null when it grabs nothing
 *  (the tool then has the event). `alt` removes a field pin instead. */
export function blurGalleryHit(
  v: FilterValues,
  w: number,
  h: number,
  at: Pt,
  alt: boolean,
): BlurDrag | null {
  const tol = handle(w, h) * 1.8;
  const span = Math.max(w, h);
  // Path points first (they sit on top of everything they cross).
  if (on(v, "path")) {
    const pts = list(v, "pathPoints");
    for (let i = 0; i + 1 < pts.length; i += 2) {
      if (dist(at, [pts[i]! * w, pts[i + 1]! * h]) > tol) continue;
      return {
        move(p, pw, ph) {
          const next = list(v, "pathPoints");
          next[i] = clamp01(p[0] / pw);
          next[i + 1] = clamp01(p[1] / ph);
          return { pathPoints: next };
        },
      };
    }
  }
  if (on(v, "field")) {
    const pins = list(v, "fieldPins");
    for (let i = 0; i + 2 < pins.length; i += 3) {
      if (dist(at, [pins[i]! * w, pins[i + 1]! * h]) > tol) continue;
      if (alt) {
        // Photoshop keeps at least one pin; so does the gallery.
        if (pins.length <= 3) return { move: () => null };
        let done = false;
        return {
          move() {
            if (done) return null;
            done = true;
            const next = list(v, "fieldPins");
            next.splice(i, 3);
            return { fieldPins: next };
          },
        };
      }
      return {
        move(p, pw, ph) {
          const next = list(v, "fieldPins");
          next[i] = clamp01(p[0] / pw);
          next[i + 1] = clamp01(p[1] / ph);
          return { fieldPins: next };
        },
      };
    }
  }
  for (const kind of ["iris", "spin"] as const) {
    if (!on(v, kind)) continue;
    const c: Pt = [n(v, `${kind}X`, 0.5) * w, n(v, `${kind}Y`, 0.5) * h];
    const [rx, ry] = [n(v, `${kind}Rx`) * span, n(v, `${kind}Ry`) * span];
    const rot = n(v, `${kind}Rot`);
    if (dist(at, c) <= tol) return { move: moveCentre(`${kind}X`, `${kind}Y`) };
    const [hx, hy] = irisHandles(c, rx, ry, rot);
    for (const [hp, key, axis] of [
      [hx, `${kind}Rx`, 0],
      [hy, `${kind}Ry`, 1],
    ] as const) {
      if (dist(at, hp) > tol) continue;
      return {
        move(p, pw, ph) {
          const s = Math.max(pw, ph);
          const [cs, sn] = [Math.cos(rad(rot)), Math.sin(rad(rot))];
          const d: Pt = [p[0] - c[0], p[1] - c[1]];
          const local =
            axis === 0 ? d[0] * cs + d[1] * sn : -d[0] * sn + d[1] * cs;
          return { [key]: Math.min(1, Math.max(0.02, Math.abs(local) / s)) };
        },
      };
    }
  }
  if (on(v, "tilt")) {
    const c: Pt = [n(v, "tiltX", 0.5) * w, n(v, "tiltY", 0.5) * h];
    if (dist(at, c) <= tol) return { move: moveCentre("tiltX", "tiltY") };
    const a = rad(n(v, "tiltAngle"));
    if (dist(at, tiltAngleHandle(c, a, span)) <= tol)
      return {
        move(p) {
          const deg = (Math.atan2(c[1] - p[1], p[0] - c[0]) * 180) / Math.PI;
          return { tiltAngle: Math.round(deg) };
        },
      };
  }
  if (on(v, "field") && !alt) {
    // A press on open canvas places a pin there (and drags it).
    const pins = list(v, "fieldPins");
    const blur = pins.length >= 3 ? pins[pins.length - 1]! : 15;
    const i = pins.length;
    let placed = false;
    return {
      move(p, pw, ph) {
        const next = list(v, "fieldPins");
        if (!placed) {
          next.push(clamp01(at[0] / w), clamp01(at[1] / h), blur);
          placed = true;
        } else if (next.length < i + 3) {
          next.push(0, 0, blur);
        }
        next[i] = clamp01(p[0] / pw);
        next[i + 1] = clamp01(p[1] / ph);
        next[i + 2] = blur;
        v = { ...v, fieldPins: next };
        return { fieldPins: next };
      },
    };
  }
  return null;
}
