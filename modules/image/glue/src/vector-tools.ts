// The VECTOR TOOLS inside the image (image ADR 476, WP5.11): the Pen, the
// Freeform Pen, Path Selection, Direct Selection and the five shape
// tools. Thin gestures over draw's machines — `PenMachine`,
// `DirectSelectMachine` and `PencilMachine` from `@paged-media/draw-tools`,
// imported, not copied (the Phase 11 rule) — fed through the same frame
// fit as every image tool.
//
// COORDINATE SPACES, as the machines name them: the POINTER space is the
// page (pt), where tolerances and the 45° constraints are measured; the
// INNER space is the image (px), where the geometry lives. The fit is
// the affine between them (`fitAffine`), handed to the machines as the
// path's transform, so a plan comes back in image px.
//
// What a tool edits is the session's vector TARGET (a path, or a layer's
// vector mask; `vector-session.ts`). Every commit is ONE undo step: a
// geometry replaced, a work path or shape layer made, a fill.

import {
  applyAffine,
  closestTOnCubic,
  evalCubic,
  inverseApplyAffine,
  pointInAnchorPath,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
} from "@paged-media/draw-geometry";
import {
  applyPathOps,
  DirectSelectMachine,
  PencilMachine,
  PenMachine,
  penPreview,
  type DirectSelectHit,
  type DirectSelectKey,
  type PenHit,
  type PenSnapshot,
} from "@paged-media/draw-tools";
import type {
  BundleHost,
  CanvasPointerEvent,
  ElementId,
  GestureHandler,
  ToolPreviewShape,
} from "@paged-media/plugin-api";

import { resolveFrameFit, type FitTransform } from "./frame-fit";
import type { ImageSession } from "./session";
import {
  CONTINUE_OP,
  geometryOf,
  opsOf,
  tableOf,
  type Geometry,
} from "./vector-engine";
import { shapeGeometry, type ShapeKind } from "./vector-shapes";

/** Hit radius around an anchor or handle dot, page pt. */
export const HIT_PT = 5;
/** Half the side of an anchor dot in the overlay, page pt. */
const DOT_PT = 2;
/** The Pen's close radius, page pt. */
const CLOSE_PT = 6;
/** The stand-in id the machines carry for the image's one target path:
 *  the document is never addressed, so it only has to be stable. */
const TARGET_ID = { kind: "polygon", id: "image-vector-target" } as ElementId;

/** The image→page affine of a fit (identity without one: headless, or
 *  a frame that is not on a page, where page points are image px). */
export function fitAffine(fit: FitTransform | null): Affine {
  return fit
    ? [fit.scale, 0, 0, fit.scale, fit.originX, fit.originY]
    : [1, 0, 0, 1, 0, 0];
}

function toInner(m: Affine, p: Vec2): [number, number] {
  const q = inverseApplyAffine(m, p[0], p[1]);
  return q ? [q[0], q[1]] : [p[0], p[1]];
}

function mapTable(
  t: AnchorTable,
  f: (p: Vec2) => [number, number],
): AnchorTable {
  return {
    anchors: t.anchors.map((a) => ({
      anchor: f(a.anchor),
      left: f(a.left),
      right: f(a.right),
    })),
    subpathStarts: [...t.subpathStarts],
    subpathOpen: [...(t.subpathOpen ?? [])],
  };
}

function contourRanges(t: AnchorTable): [number, number][] {
  const n = t.anchors.length;
  const s = t.subpathStarts.length ? t.subpathStarts : n ? [0] : [];
  return s.map((from, i) => [from, i + 1 < s.length ? s[i + 1] : n]);
}

/** The overlay for a table in POINTER space: each contour solid, its
 *  anchors as small squares (the `selected` ones also inside a larger
 *  square), and the handles of `withHandles` anchors as lines. */
export function tableOverlay(
  t: AnchorTable,
  pageId: string,
  opts: { selected?: readonly number[]; withHandles?: readonly number[] } = {},
): ToolPreviewShape[] {
  const out: ToolPreviewShape[] = [];
  contourRanges(t).forEach(([from, to], i) => {
    if (to - from < 2) return;
    out.push({
      pageId,
      anchors: t.anchors.slice(from, to).map((a) => ({
        anchor: [a.anchor[0], a.anchor[1]],
        left: [a.left[0], a.left[1]],
        right: [a.right[0], a.right[1]],
      })),
      close: !(t.subpathOpen?.[i] ?? false),
    });
  });
  const sel = new Set(opts.selected ?? []);
  t.anchors.forEach((a, i) => {
    const [x, y] = a.anchor;
    const r = sel.has(i) ? DOT_PT * 1.75 : DOT_PT;
    out.push({ pageId, rect: [y - r, x - r, y + r, x + r] });
  });
  for (const i of opts.withHandles ?? []) {
    const a = t.anchors[i];
    if (!a) continue;
    for (const h of [a.left, a.right]) {
      if (h[0] === a.anchor[0] && h[1] === a.anchor[1]) continue;
      out.push({
        pageId,
        points: [
          [a.anchor[0], a.anchor[1]],
          [h[0], h[1]],
        ],
      });
      out.push({
        pageId,
        rect: [h[1] - DOT_PT, h[0] - DOT_PT, h[1] + DOT_PT, h[0] + DOT_PT],
      });
    }
  }
  return out;
}

/** The segment nearest `p` (POINTER space) within `tol`, as the machines
 *  name it: the flat index of its start anchor and the cubic parameter. */
export function segmentHit(
  t: AnchorTable,
  p: Vec2,
  tol: number,
): { index: number; t: number } | null {
  let best = { index: -1, t: 0, d: Infinity };
  const ranges = contourRanges(t);
  for (let ci = 0; ci < ranges.length; ci++) {
    const [from, to] = ranges[ci];
    const closed = !(t.subpathOpen?.[ci] ?? false);
    const last = closed ? to : to - 1;
    for (let i = from; i < last; i++) {
      const a = t.anchors[i];
      const b = t.anchors[i + 1 < to ? i + 1 : from];
      const tt = closestTOnCubic(a.anchor, a.right, b.left, b.anchor, p);
      const q = evalCubic(a.anchor, a.right, b.left, b.anchor, tt);
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= tol && d < best.d) best = { index: i, t: tt, d };
    }
  }
  return best.index >= 0 ? { index: best.index, t: best.t } : null;
}

/** The anchor whose dot is under `p` (POINTER space), or −1. */
export function anchorHit(t: AnchorTable, p: Vec2, tol: number): number {
  let best = -1;
  let bd = Infinity;
  t.anchors.forEach((a, i) => {
    const d = Math.hypot(a.anchor[0] - p[0], a.anchor[1] - p[1]);
    if (d <= tol && d < bd) {
      best = i;
      bd = d;
    }
  });
  return best;
}

/** The subpath under `p` (POINTER space): inside its filled area or on
 *  its outline. −1 for none. The topmost (last) wins. */
export function subpathHit(t: AnchorTable, p: Vec2, tol: number): number {
  const ranges = contourRanges(t);
  for (let ci = ranges.length - 1; ci >= 0; ci--) {
    const [from, to] = ranges[ci];
    const one: AnchorTable = {
      anchors: t.anchors.slice(from, to),
      subpathStarts: [0],
      subpathOpen: [t.subpathOpen?.[ci] ?? false],
    };
    if (pointInAnchorPath(p, one.anchors, [0])) return ci;
    if (segmentHit(one, p, tol)) return ci;
  }
  return -1;
}

/** Shared head of the vector gestures: the frame fit, the target's table
 *  in both spaces, the overlay. */
function vectorBase(host: BundleHost, session: ImageSession, label: string) {
  let fit: FitTransform | null = null;
  const m = () => fitAffine(fit);
  const pageId = () => fit?.pageId ?? "";
  const target = () => session.vectors().activeTarget();
  /** The target's geometry, its inner table and its pointer table. */
  const read = () => {
    const tg = target();
    const g = tg ? session.vectors().geometry(tg) : null;
    if (!tg || !g) return null;
    const inner = tableOf(g);
    const outer = mapTable(inner, (p) => applyAffine(m(), p[0], p[1]));
    return { target: tg, geometry: g, inner, outer };
  };
  return {
    activate() {
      void resolveFrameFit(host, session.state().source, label).then((f) => {
        fit = f;
      });
    },
    deactivate() {
      host.overlay.setToolPreviews(null);
      fit = null;
    },
    m,
    pageId,
    read,
    /** Pointer → image px. */
    inner: (p: Vec2) => toInner(m(), p),
    show(shapes: ToolPreviewShape[]) {
      host.overlay.setToolPreviews(shapes.length ? shapes : null);
    },
  };
}

/** `table` (inner) as geometry, each contour keeping its operation. */
function rebuild(g: Geometry, table: AnchorTable): Geometry {
  const ops = opsOf(g);
  const n = Math.max(1, table.subpathStarts.length);
  while (ops.length < n) ops.push({ op: 1, rule: 1 });
  return geometryOf(table, ops.slice(0, n));
}

/** THE PEN: click corners, drag smooth anchors, close on the first
 *  anchor (or Enter for an open path); over the target path a press adds
 *  or deletes an anchor, or continues an open end. Draws per the mode
 *  (`vector-session.ts`): a shape layer, a path, never pixels. */
export function makePenGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  const base = vectorBase(host, session, "pen");
  let machine = new PenMachine({ closeTolerance: CLOSE_PT });
  let ctx: ReturnType<typeof base.read> = null;

  const hits = (p: Vec2): PenHit[] => {
    if (!ctx) return [];
    const path = {
      id: TARGET_ID,
      table: ctx.inner,
      transform: base.m(),
      selected: true,
    };
    const a = anchorHit(ctx.outer, p, HIT_PT);
    if (a >= 0) return [{ kind: "anchor", path, index: a }];
    const s = segmentHit(ctx.outer, p, HIT_PT);
    return s ? [{ kind: "segment", path, index: s.index, t: s.t }] : [];
  };

  const render = (snap: PenSnapshot | null) => {
    const shapes: ToolPreviewShape[] = ctx
      ? tableOverlay(ctx.outer, base.pageId())
      : [];
    const run = snap && penPreview(snap, base.pageId(), { dashed: true });
    if (run) shapes.push(run);
    base.show(shapes);
  };

  const finish = async (snap: PenSnapshot) => {
    const plan = snap.plan;
    if (!plan) return;
    machine = new PenMachine({ closeTolerance: CLOSE_PT });
    const mode = session.vectors().state().mode;
    if (plan.kind === "insertPath") {
      const anchors = plan.anchors.map((a) => ({
        anchor: base.inner(a.anchor),
        left: base.inner(a.left),
        right: base.inner(a.right),
      }));
      const g = geometryOf({
        anchors,
        subpathStarts: [0],
        subpathOpen: [plan.open],
      });
      await session.vectors().addShape(g, mode === "pixels" ? "path" : mode);
    } else if (ctx) {
      let table: AnchorTable;
      try {
        table = applyPathOps(ctx.inner, plan.ops);
      } catch (err) {
        host.log.debug("pen: the plan does not apply to one path", err);
        return;
      }
      await session
        .vectors()
        .setGeometry(ctx.target, rebuild(ctx.geometry, table));
    }
    ctx = base.read();
    render(null);
  };

  const feed = (snap: PenSnapshot) => {
    render(snap);
    if (snap.plan) void finish(snap);
  };

  return {
    onActivate() {
      base.activate();
      ctx = base.read();
    },
    onDeactivate() {
      machine = new PenMachine({ closeTolerance: CLOSE_PT });
      base.deactivate();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      ctx = base.read();
      feed(
        machine.handle({
          type: "down",
          point: e.pagePoint,
          modifiers: { shift: e.modifiers.shift, alt: e.modifiers.alt },
          hits: hits(e.pagePoint),
        }),
      );
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      feed(
        machine.handle({
          type: "move",
          point: e.pagePoint,
          modifiers: { shift: e.modifiers.shift, alt: e.modifiers.alt },
          hits: hits(e.pagePoint),
        }),
      );
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      feed(
        machine.handle({
          type: "up",
          point: e.pagePoint,
          modifiers: { shift: e.modifiers.shift, alt: e.modifiers.alt },
        }),
      );
    },
    onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      feed(machine.handle({ type: "key", key: e.key }));
    },
  };
}

/** THE FREEFORM PEN: drag a freehand path (the Pencil's machine:
 *  simplified, smooth anchors), closed when released near its start. */
export function makeFreeformPenGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  const base = vectorBase(host, session, "freeform pen");
  let machine: PencilMachine | null = null;
  const fresh = () =>
    new PencilMachine({
      tolerance: 1.5,
      smooth: true,
      closeTolerance: CLOSE_PT,
    });

  return {
    onActivate() {
      base.activate();
    },
    onDeactivate() {
      machine = null;
      base.deactivate();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      machine = fresh();
      machine.handle({ type: "down", point: e.pagePoint });
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint) return;
      const snap = machine.handle({ type: "move", point: e.pagePoint });
      if (snap.points.length > 1)
        base.show([
          {
            pageId: base.pageId(),
            points: snap.points.map((p) => [p[0], p[1]] as [number, number]),
          },
        ]);
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint) return;
      const snap = machine.handle({ type: "up", point: e.pagePoint });
      machine = null;
      base.show([]);
      const c = snap.commit;
      if (!c || c.anchors.length < 2) return;
      const anchors: AnchorTriple[] = c.anchors.map((a) => ({
        anchor: base.inner(a.anchor),
        left: base.inner(a.left),
        right: base.inner(a.right),
      }));
      const g = geometryOf({
        anchors,
        subpathStarts: [0],
        subpathOpen: [c.open],
      });
      const mode = session.vectors().state().mode;
      void session.vectors().addShape(g, mode === "pixels" ? "path" : mode);
    },
    onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || !machine) return;
      machine.handle({ type: "key", key: "Escape" });
      machine = null;
      base.show([]);
    },
  };
}

/** DIRECT SELECTION: drag anchors, handles and segments of the target
 *  path; marquee; arrows nudge; Delete removes anchors. Draw's machine
 *  plans the edit, `applyPathOps` applies it to the image's table. */
export function makeDirectSelectGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  const base = vectorBase(host, session, "direct selection");
  let ctx: ReturnType<typeof base.read> = null;
  let machine: DirectSelectMachine | null = null;
  let selection: number[] = [];

  const build = () => {
    ctx = base.read();
    machine = ctx
      ? new DirectSelectMachine({
          table: ctx.inner,
          transform: base.m(),
          slop: 1,
          nudgeStep: base.m()[0],
          selection,
        })
      : null;
  };

  const show = (table: AnchorTable | null, selected: readonly number[]) => {
    if (!table) {
      base.show([]);
      return;
    }
    base.show(
      tableOverlay(table, base.pageId(), {
        selected,
        withHandles: selected,
      }),
    );
  };

  const hitAt = (p: Vec2): DirectSelectHit => {
    if (!ctx) return { kind: "empty" };
    for (const i of selection) {
      const a = ctx.outer.anchors[i];
      if (!a) continue;
      for (const side of ["left", "right"] as const) {
        const h = a[side];
        if (h[0] === a.anchor[0] && h[1] === a.anchor[1]) continue;
        if (Math.hypot(h[0] - p[0], h[1] - p[1]) <= HIT_PT)
          return { kind: "handle", index: i, side };
      }
    }
    const a = anchorHit(ctx.outer, p, HIT_PT);
    if (a >= 0) return { kind: "anchor", index: a };
    const s = segmentHit(ctx.outer, p, HIT_PT);
    return s ? { kind: "segment", index: s.index, t: s.t } : { kind: "empty" };
  };

  const settle = async (snap: ReturnType<DirectSelectMachine["handle"]>) => {
    selection = [...snap.selected];
    if (snap.commit && ctx) {
      const table = applyPathOps(ctx.inner, snap.commit.ops);
      await session
        .vectors()
        .setGeometry(ctx.target, rebuild(ctx.geometry, table));
      build();
      show(ctx?.outer ?? null, selection);
      return;
    }
    show(snap.table, snap.selected);
  };

  return {
    onActivate() {
      base.activate();
      selection = [];
      build();
      show(ctx?.outer ?? null, selection);
    },
    onDeactivate() {
      machine = null;
      base.deactivate();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      build();
      if (!machine) return;
      void settle(
        machine.handle({
          type: "down",
          point: e.pagePoint,
          hit: hitAt(e.pagePoint),
          modifiers: { shift: e.modifiers.shift, alt: e.modifiers.alt },
        }),
      );
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint) return;
      void settle(
        machine.handle({
          type: "move",
          point: e.pagePoint,
          modifiers: { shift: e.modifiers.shift, alt: e.modifiers.alt },
        }),
      );
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint) return;
      void settle(
        machine.handle({
          type: "up",
          point: e.pagePoint,
          modifiers: { shift: e.modifiers.shift, alt: e.modifiers.alt },
        }),
      );
    },
    onKey(e: KeyboardEvent) {
      const keys: string[] = [
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Delete",
        "Backspace",
        "Escape",
      ];
      if (!keys.includes(e.key)) return;
      build();
      if (!machine) return;
      e.preventDefault();
      void settle(
        machine.handle({
          type: "key",
          key: e.key as DirectSelectKey,
          modifiers: { shift: e.shiftKey, alt: e.altKey },
        }),
      );
    },
  };
}

/** PATH SELECTION: pick whole subpaths (Shift adds), drag them (Alt drags
 *  a copy), arrows nudge, Delete removes them. One step per gesture. */
export function makePathSelectGesture(
  host: BundleHost,
  session: ImageSession,
): GestureHandler {
  const base = vectorBase(host, session, "path selection");
  let ctx: ReturnType<typeof base.read> = null;
  let picked: number[] = [];
  let drag: { from: Vec2; copy: boolean; moved: boolean } | null = null;
  let offset: Vec2 = [0, 0];

  const anchorsOf = (t: AnchorTable, contours: readonly number[]) => {
    const r = contourRanges(t);
    return contours.flatMap((ci) => {
      const [from, to] = r[ci] ?? [0, 0];
      return Array.from({ length: to - from }, (_, k) => from + k);
    });
  };

  const show = () => {
    if (!ctx) {
      base.show([]);
      return;
    }
    const shapes = tableOverlay(ctx.outer, base.pageId(), {
      selected: anchorsOf(ctx.outer, picked),
    });
    if (drag?.moved) {
      const moved = mapTable(ctx.outer, (p) => [
        p[0] + offset[0],
        p[1] + offset[1],
      ]);
      const r = contourRanges(moved);
      for (const ci of picked) {
        const [from, to] = r[ci];
        shapes.push({
          pageId: base.pageId(),
          anchors: moved.anchors.slice(from, to).map((a) => ({
            anchor: [a.anchor[0], a.anchor[1]],
            left: [a.left[0], a.left[1]],
            right: [a.right[0], a.right[1]],
          })),
          close: !(moved.subpathOpen?.[ci] ?? false),
          dashed: true,
        });
      }
    }
    base.show(shapes);
  };

  /** Move (or copy) the picked subpaths by `d` image px. */
  const commitMove = async (d: Vec2, copy: boolean) => {
    if (!ctx || picked.length === 0) return;
    const g = ctx.geometry;
    const shift = (s: Geometry["subpaths"][number]) => ({
      ...s,
      anchors: s.anchors.map((v, i) => v + (i % 2 === 0 ? d[0] : d[1])),
    });
    const next: Geometry = copy
      ? {
          subpaths: [
            ...g.subpaths,
            ...picked.map((ci) => {
              const s = shift(g.subpaths[ci]);
              return s.op === CONTINUE_OP ? { ...s, op: 1, rule: 1 } : s;
            }),
          ],
        }
      : {
          subpaths: g.subpaths.map((s, ci) =>
            picked.includes(ci) ? shift(s) : s,
          ),
        };
    const before = g.subpaths.length;
    if (await session.vectors().setGeometry(ctx.target, next)) {
      if (copy) picked = picked.map((_, k) => before + k);
    }
    ctx = base.read();
  };

  return {
    onActivate() {
      base.activate();
      ctx = base.read();
      picked = [];
      show();
    },
    onDeactivate() {
      drag = null;
      base.deactivate();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      ctx = base.read();
      if (!ctx) return;
      const ci = subpathHit(ctx.outer, e.pagePoint, HIT_PT);
      if (ci < 0) {
        if (!e.modifiers.shift) picked = [];
      } else if (e.modifiers.shift) {
        picked = picked.includes(ci)
          ? picked.filter((c) => c !== ci)
          : [...picked, ci];
      } else if (!picked.includes(ci)) picked = [ci];
      drag =
        ci >= 0 && picked.includes(ci)
          ? { from: e.pagePoint, copy: e.modifiers.alt, moved: false }
          : null;
      offset = [0, 0];
      show();
    },
    onPointerMove(e: CanvasPointerEvent) {
      if (!drag || !e.pagePoint) return;
      offset = [e.pagePoint[0] - drag.from[0], e.pagePoint[1] - drag.from[1]];
      if (Math.hypot(offset[0], offset[1]) > 0.5) drag.moved = true;
      show();
    },
    onPointerUp(e: CanvasPointerEvent) {
      const d = drag;
      drag = null;
      if (!d || !d.moved || !e.pagePoint) {
        show();
        return;
      }
      const a = base.inner(d.from);
      const b = base.inner(e.pagePoint);
      void commitMove([b[0] - a[0], b[1] - a[1]], d.copy).then(show);
    },
    onKey(e: KeyboardEvent) {
      if (!ctx || picked.length === 0) return;
      const step = e.shiftKey ? 10 : 1;
      const nudge: Record<string, Vec2> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (nudge[e.key]) {
        e.preventDefault();
        void commitMove(nudge[e.key], false).then(show);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const g = ctx.geometry;
        const kept = g.subpaths.filter((_, ci) => !picked.includes(ci));
        // A continuation whose head went becomes a head itself.
        if (kept[0]?.op === CONTINUE_OP)
          kept[0] = { ...kept[0], op: 1, rule: 1 };
        picked = [];
        const tg = ctx.target;
        void (
          kept.length
            ? session.vectors().setGeometry(tg, { subpaths: kept })
            : Promise.resolve(false)
        ).then(() => {
          ctx = base.read();
          show();
        });
      }
    },
  };
}

/** A SHAPE TOOL: drag the shape (Shift: square / circle / 45°, Alt: from
 *  the centre) and release to make it per the mode. */
export function makeShapeGesture(
  host: BundleHost,
  session: ImageSession,
  kind: ShapeKind,
): GestureHandler {
  const base = vectorBase(host, session, `${kind} tool`);
  let from: [number, number] | null = null;
  const geometryAt = (e: CanvasPointerEvent): Geometry | null => {
    if (!from || !e.pagePoint) return null;
    const v = session.vectors().state();
    return shapeGeometry(
      kind,
      from,
      base.inner(e.pagePoint),
      { shift: e.modifiers.shift, alt: e.modifiers.alt },
      v.shape,
      v.op,
    );
  };
  return {
    onActivate() {
      base.activate();
    },
    onDeactivate() {
      from = null;
      base.deactivate();
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!e.pagePoint) return;
      from = base.inner(e.pagePoint);
    },
    onPointerMove(e: CanvasPointerEvent) {
      const g = geometryAt(e);
      if (!g) return;
      const t = mapTable(tableOf(g), (p) => applyAffine(base.m(), p[0], p[1]));
      base.show(tableOverlay(t, base.pageId()).filter((s) => "anchors" in s));
    },
    onPointerUp(e: CanvasPointerEvent) {
      const g = geometryAt(e);
      from = null;
      base.show([]);
      if (g) void session.vectors().addShape(g);
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && from) {
        from = null;
        base.show([]);
      }
    },
  };
}
