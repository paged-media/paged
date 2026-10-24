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

// FREE TRANSFORM (editor ADR 293) — one handle box that moves, scales,
// rotates, shears and distorts the selection, as Illustrator's and
// Photoshop's do.
//
// The box is the selection chrome's own box (one item's turned box, the
// union box of several) and it is hit-tested here, from geometry, with the
// chrome's screen metrics (`hitTestBox` in plugin-sdk, the same code the
// `host.transformBox` door runs for a bundle):
//
//   drag inside                 move                 (Shift: one axis)
//   drag a handle               scale from the opposite handle
//                               (Shift proportional, Alt from the centre,
//                               the Constrain mode always proportional)
//   drag just outside a corner  rotate about the reference point
//                               (Shift: 15° steps)
//   Cmd/Ctrl + side handle      shear, the opposite side holding
//                               (Shift: 15° slants)
//   Cmd/Ctrl + corner           free distort         (or the Free Distort mode)
//   Cmd/Ctrl+Alt+Shift + corner perspective          (or the Perspective mode)
//   drag the reference point    move it              (a click on the 9-grid
//                                                     in the Control bar
//                                                     picks one)
//
// Move, scale, rotate and shear are ONE ENGINE GESTURE each: the same
// translate / scale / rotate / shear arms the selection chrome, the Rotate,
// Scale and Shear tools and the Transform panel drive, through the same
// begin / buffer / flush driver (`runWorkerGesture`). A side handle of a
// box that stands upright shears along x, one that lies on its side along
// y (the anchor's `shearAxis`).
//
// Free Distort and Perspective have no engine arm: until the engine has an
// envelope effect (WP3.2) they are applied DESTRUCTIVELY — the box's new
// quad maps every anchor and handle of each target's path (bilinear for
// Free Distort, projective for Perspective), written as one `framePath`
// per target in ONE batch, so one undo step. Text frames, placed images
// and groups have no path of their own to rewrite and are refused, with
// the reason shown on the canvas.

import type {
  ElementGeometryItem,
  ElementId,
  GestureAnchor,
  Mutation,
  PathAnchorsResult,
} from "@paged-media/client";
import type {
  CanvasPointerEvent,
  CursorSpec,
  GestureHandler,
  PagedEditor,
  ToolPreviewShape,
} from "@paged-media/shell";
import { layoutPageRects } from "@paged-media/shell";
import {
  BOX_OPPOSITE,
  ROTATE_CURSOR,
  affineToMatrix3,
  applyMatrix3,
  invert3,
  dragBox,
  handleCursor,
  handlePoint,
  hitTestBox,
  isUsableQuad,
  operationFor,
  quadCentre,
  quadMap,
  unitToQuad,
  type BoxDragStart,
  type BoxHandle,
  type BoxMode,
  type BoxOperation,
  type BoxPoint,
  type BoxQuad,
} from "@paged-media/plugin-sdk";

import { CLICK_DRAG_THRESHOLD_PX } from "./shared";
import { runWorkerGesture, type WorkerGestureRun } from "./transform-tools";

export const FREE_TRANSFORM_TOOL_ID = "paged.tool.freeTransform";

/** The nine reference points of the Control bar's grid. */
export type ReferenceKey =
  "nw" | "n" | "ne" | "w" | "c" | "e" | "sw" | "s" | "se";

export const REFERENCE_KEYS: readonly ReferenceKey[] = [
  "nw",
  "n",
  "ne",
  "w",
  "c",
  "e",
  "sw",
  "s",
  "se",
];

/** Each reference point in the box's unit square. */
export const REFERENCE_UV: Readonly<Record<ReferenceKey, BoxPoint>> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  w: [0, 0.5],
  c: [0.5, 0.5],
  e: [1, 0.5],
  sw: [0, 1],
  s: [0.5, 1],
  se: [1, 1],
};

export const BOX_MODES: readonly BoxMode[] = [
  "freeTransform",
  "constrain",
  "freeDistort",
  "perspective",
];

/** The box the tool works on: its page, its corners (page-local pt) and
 *  the items it stands for. */
export interface FreeTransformBox {
  pageId: string;
  quad: BoxQuad;
  targets: ElementId[];
  geometry: ElementGeometryItem[];
}

/** An item transform `[a, b, c, d, tx, ty]` applied to a point. */
const apply = (
  t: readonly number[] | null | undefined,
  x: number,
  y: number,
): BoxPoint => (t ? applyMatrix3(affineToMatrix3(t), [x, y]) : [x, y]);

/**
 * The box of a selection's geometry, as the selection chrome draws it: one
 * item's own (turned) box; several items' union box on the page the first
 * of them is on. Null when nothing has a page.
 */
export function freeTransformBoxOf(
  geometry: readonly ElementGeometryItem[],
): FreeTransformBox | null {
  const placed = geometry.filter((g) => g?.pageId);
  if (placed.length === 0) return null;
  const pageId = placed[0]!.pageId!;
  if (placed.length === 1) {
    const g = placed[0]!;
    const [top, left, bottom, right] = g.bounds;
    const t = g.itemTransform;
    return {
      pageId,
      quad: [
        apply(t, left, top),
        apply(t, right, top),
        apply(t, right, bottom),
        apply(t, left, bottom),
      ],
      targets: [g.id],
      geometry: [g],
    };
  }
  const onPage = placed.filter((g) => g.pageId === pageId);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of onPage) {
    const [top, left, bottom, right] = g.bounds;
    for (const [x, y] of [
      apply(g.itemTransform, left, top),
      apply(g.itemTransform, right, top),
      apply(g.itemTransform, right, bottom),
      apply(g.itemTransform, left, bottom),
    ]) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    pageId,
    quad: [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ],
    // Every selected item moves, wherever its box is drawn.
    targets: placed.map((g) => g.id),
    geometry: placed,
  };
}

/** A reference key's point on the box. */
export function referencePointOf(quad: BoxQuad, key: ReferenceKey): BoxPoint {
  const h = unitToQuad(quad);
  return h ? applyMatrix3(h, REFERENCE_UV[key]) : quadCentre(quad);
}

/** Why an item cannot be distorted destructively, or null when it can
 *  (it draws from a path of its own the map can rewrite). */
export function distortRefusal(g: ElementGeometryItem): string | null {
  const kind = (g.id as { kind: string }).kind;
  if (kind === "textFrame") return "a text frame";
  if (kind === "group") return "a group";
  if (kind === "rectangle" && g.hasImage) return "a placed image";
  if (
    kind !== "rectangle" &&
    kind !== "oval" &&
    kind !== "polygon" &&
    kind !== "graphicLine"
  )
    return `a ${kind}`;
  return null;
}

/**
 * The batch that writes a distorted box onto paths: each target's anchors
 * and handles mapped page → `map` → back into the item's own space, one
 * `framePath` per target. `map` takes page-local pt to page-local pt.
 */
export function distortBatchFor(
  paths: readonly PathAnchorsResult[],
  map: (p: BoxPoint) => BoxPoint,
): Mutation | null {
  const ops: Mutation[] = [];
  for (const r of paths) {
    const t = r.itemTransform ?? [1, 0, 0, 1, 0, 0];
    const inv = invert3(affineToMatrix3(t));
    if (!inv) return null;
    const toInner = (p: BoxPoint): [number, number] => applyMatrix3(inv, p);
    const through = (p: readonly [number, number]): [number, number] =>
      toInner(map(apply(t, p[0], p[1])));
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: r.id,
        path: "framePath",
        value: {
          type: "framePath",
          value: {
            anchors: r.anchors.map((x) => ({
              anchor: through(x.anchor),
              left: through(x.left),
              right: through(x.right),
            })),
            subpathStarts: [...r.subpathStarts],
          },
        },
      },
    } as Mutation);
  }
  if (ops.length === 0) return null;
  return ops.length === 1
    ? ops[0]!
    : ({ op: "batch", args: { ops } } as Mutation);
}

/** The gesture doors a numeric shear drives. */
export interface ShearClient {
  beginGesture(
    nodes: ElementId[],
    gesture: { kind: "shear" },
    anchor: GestureAnchor,
  ): Promise<number>;
  updateGesture(
    handle: number,
    delta: [number, number],
    modifiers: { shift: boolean; alt: boolean },
  ): Promise<unknown>;
  commitGesture(handle: number): Promise<unknown>;
  cancelGesture(handle: number): Promise<unknown>;
}

/**
 * A NUMERIC shear of the box's items by `degrees` along x about `pivot`
 * (the Control bar's field): the engine's shear arm driven once — begin,
 * one update, commit — so one undo step. The anchor sits one lever above
 * the pivot; the delta is `tan(angle)` times that lever.
 */
export async function shearSelectionBy(
  client: ShearClient,
  box: FreeTransformBox,
  pivot: BoxPoint,
  degrees: number,
): Promise<void> {
  const k = Math.tan((degrees * Math.PI) / 180);
  if (!Number.isFinite(k) || Math.abs(k) < 1e-9) return;
  const lever = -100;
  const h = await client.beginGesture(
    box.targets,
    { kind: "shear" },
    {
      pageId: box.pageId,
      pointInPage: [pivot[0], pivot[1] + lever],
      pivotInPage: pivot,
      shearAxis: "x",
    },
  );
  try {
    await client.updateGesture(h, [k * lever, 0], { shift: false, alt: false });
    await client.commitGesture(h);
  } catch (err) {
    await client.cancelGesture(h).catch(() => {});
    throw err;
  }
}

const selectionKeyOf = (ids: readonly { kind: string; id: unknown }[]) =>
  ids.map((id) => `${id.kind}:${String(id.id)}`).join("|");

/** One press, from the hit to its release. */
interface Press {
  box: FreeTransformBox;
  start: BoxDragStart;
  startDoc: [number, number];
  op: BoxOperation;
  /** The engine gesture (move / scale / rotate / shear). */
  run: WorkerGestureRun | null;
  /** The live quad of a client-side arm (distort / perspective). */
  quad: BoxQuad | null;
  refused: string | null;
}

export function createFreeTransformHandler(): GestureHandler {
  let paged: PagedEditor | null = null;
  let press: Press | null = null;
  /** A reference point dragged by hand, for this selection. */
  let customRef: { key: string; point: BoxPoint } | null = null;
  /** The last box seen, for synchronous cursor answers. */
  let lastBox: FreeTransformBox | null = null;
  /** Page rects in document space, by page id (for presses off the
   *  box's page). */
  let pageRects = new Map<string, { x: number; y: number }>();
  let notice: string | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Whether a press is still resolving its box, and the move / release
   *  that arrived meanwhile (replayed once it lands). */
  let resolving = false;
  let pendingMove: CanvasPointerEvent | null = null;
  let pendingUp: CanvasPointerEvent | null = null;

  const setting = <T extends string>(key: string, fallback: T): T => {
    const v = paged?.toolSettings.getValue(FREE_TRANSFORM_TOOL_ID, key);
    return (typeof v === "string" ? v : fallback) as T;
  };
  const mode = (): BoxMode => setting<BoxMode>("mode", "freeTransform");

  const loadPageRects = async () => {
    if (!paged) return;
    try {
      const pages = await paged.client.collection<{
        selfId: string;
        sizePt: [number, number];
      }>("pages");
      const rects = layoutPageRects(pages.map((p) => p.sizePt));
      pageRects = new Map(pages.map((p, i) => [p.selfId, rects[i]!]));
    } catch {
      /* no pages yet */
    }
  };

  /** The selection's box, from the chrome's placed geometry when the
   *  shell has it, else asked of the engine. */
  const resolveBox = async (): Promise<FreeTransformBox | null> => {
    if (!paged) return null;
    const ids = paged.selection.elementSelection;
    if (ids.length === 0) return null;
    const placed = (
      paged.selection as unknown as { placedGeometry?: ElementGeometryItem[] }
    ).placedGeometry;
    const geometry =
      placed && placed.length > 0
        ? placed
        : await paged.client.elementGeometry(ids.slice()).catch(() => []);
    const box = freeTransformBoxOf(geometry);
    lastBox = box;
    return box;
  };

  const referenceOf = (box: FreeTransformBox): BoxPoint => {
    const key = selectionKeyOf(box.targets);
    if (customRef && customRef.key === key) return customRef.point;
    return referencePointOf(box.quad, setting<ReferenceKey>("reference", "c"));
  };

  /** Draw the tool's own marks: the reference point, a client-side arm's
   *  live box, and a refusal. (The eight handles are the selection
   *  chrome's.) */
  const draw = (box: FreeTransformBox | null, live: BoxQuad | null) => {
    if (!paged) return;
    const shapes: ToolPreviewShape[] = [];
    if (box) {
      const ref = referenceOf(box);
      if (live) {
        shapes.push({ pageId: box.pageId, points: live, close: true });
        for (const p of live)
          shapes.push({
            kind: "handle",
            pageId: box.pageId,
            x: p[0],
            y: p[1],
            shape: "square",
          });
      }
      shapes.push({
        kind: "handle",
        pageId: box.pageId,
        x: ref[0],
        y: ref[1],
        shape: "centre",
      });
      if (notice) {
        const top = box.quad.reduce((m, p) => Math.min(m, p[1]), Infinity);
        shapes.push({
          kind: "text",
          pageId: box.pageId,
          x: quadCentre(box.quad)[0],
          y: top - 8,
          text: notice,
          anchor: "middle",
          background: true,
        });
      }
    }
    const signals = paged.overlaySignals;
    if (shapes.length === 0) signals.setToolPreview(null);
    else if (signals.setToolPreviews) signals.setToolPreviews(shapes);
    else signals.setToolPreview(shapes[0]!);
  };

  const redraw = () => {
    void resolveBox().then((box) => draw(box, press?.quad ?? null));
  };

  /** The press in the box page's space. */
  const pointOnPage = (
    e: CanvasPointerEvent,
    pageId: string,
  ): BoxPoint | null => {
    if (e.pageId === pageId && e.pagePoint)
      return [e.pagePoint[0], e.pagePoint[1]];
    const r = pageRects.get(pageId);
    return r ? [e.docPoint[0] - r.x, e.docPoint[1] - r.y] : null;
  };

  const unitsPerPx = () => {
    const s = (paged?.camera as unknown as { camera?: { scale?: number } })
      ?.camera?.scale;
    return typeof s === "number" && s > 0 ? 1 / s : 1;
  };

  /** Start the engine arm for an operation. */
  const startEngine = (
    p: Press,
    mods: CanvasPointerEvent["modifiers"],
  ): WorkerGestureRun | null => {
    if (!paged) return null;
    const { box, start } = p;
    const centre = quadCentre(box.quad);
    const constrain = mode() === "constrain";
    const base = { pageId: box.pageId };
    let spec: { kind: "translate" | "scale" | "rotate" | "shear" };
    let anchor: Record<string, unknown>;
    switch (p.op) {
      case "move":
        spec = { kind: "translate" };
        anchor = { ...base, pointInPage: start.start };
        break;
      case "rotate":
        spec = { kind: "rotate" };
        anchor = {
          ...base,
          pointInPage: start.start,
          pivotInPage: referenceOf(box),
        };
        break;
      case "scale": {
        if (start.hit.kind !== "handle") return null;
        const h = start.hit.handle;
        spec = { kind: "scale" };
        anchor = {
          ...base,
          pointInPage: handlePoint(box.quad, h),
          pivotInPage: mods.alt
            ? centre
            : handlePoint(box.quad, BOX_OPPOSITE[h]),
        };
        break;
      }
      case "shear": {
        if (start.hit.kind !== "handle") return null;
        const h: BoxHandle = start.hit.handle;
        const at = handlePoint(box.quad, h);
        // Which way the handle faces on the PAGE picks the axis: a side
        // facing up or down slants along x, one facing sideways along y.
        const facesVertically =
          Math.abs(at[1] - centre[1]) >= Math.abs(at[0] - centre[0]);
        spec = { kind: "shear" };
        anchor = {
          ...base,
          pointInPage: at,
          pivotInPage: mods.alt
            ? centre
            : handlePoint(box.quad, BOX_OPPOSITE[h]),
          shearAxis: facesVertically ? "x" : "y",
        };
        break;
      }
      default:
        return null;
    }
    const shift = (on: boolean) => (p.op === "scale" && constrain ? !on : on);
    const run = runWorkerGesture(
      paged,
      box.targets,
      spec,
      Promise.resolve(anchor),
      {
        label: `free transform ${p.op}`,
        modifiers: { shift: shift(mods.shift), alt: mods.alt },
        onSettled: () => {
          customRef = null;
          redraw();
        },
      },
    );
    // Constrain inverts Shift for a scale (always proportional).
    const update = run.update;
    run.update = (delta, m) => update(delta, { ...m, shift: shift(m.shift) });
    return run;
  };

  const finishClientArm = async (p: Press) => {
    if (!paged || !p.quad) return;
    const kind = p.op === "perspective" ? "projective" : "bilinear";
    const map = quadMap(p.box.quad, p.quad, kind);
    if (!map) return;
    const paths = (
      await Promise.all(
        p.box.targets.map((id) =>
          paged!.client.pathAnchors(id).catch(() => null),
        ),
      )
    ).filter((r): r is PathAnchorsResult => r !== null);
    const batch = distortBatchFor(paths, map);
    if (!batch) return;
    await paged.client.mutate(batch).catch(() => {});
    const ids = paged.selection.elementSelection;
    const items = await paged.client
      .elementGeometry(ids.slice())
      .catch(() => []);
    paged.selection.setElementGeometry(items);
    customRef = null;
  };

  const cancelPress = () => {
    if (press?.run) press.run.end(false);
    press = null;
    redraw();
  };

  const handler: GestureHandler = {
    onActivate(p) {
      paged = p;
      notice = null;
      void loadPageRects();
      unsubscribe =
        paged.toolSettings.subscribe?.(FREE_TRANSFORM_TOOL_ID, redraw) ?? null;
      redraw();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      cancelPress();
      unsubscribe?.();
      unsubscribe = null;
      customRef = null;
      notice = null;
      paged?.overlaySignals.setToolPreview(null);
    },
    onPointerDown(e) {
      if (!paged || e.button !== 0) return;
      const mods = e.modifiers;
      notice = null;
      resolving = true;
      pendingMove = null;
      pendingUp = null;
      void resolveBox().then((box) => {
        resolving = false;
        const replay = () => {
          const move = pendingMove;
          const up = pendingUp;
          pendingMove = null;
          pendingUp = null;
          if (move) handler.onPointerMove(move);
          if (up) handler.onPointerUp(up);
        };
        if (!box || !paged) return;
        const at = pointOnPage(e, box.pageId);
        if (!at) return;
        const reference = referenceOf(box);
        const hit = hitTestBox(box.quad, at, unitsPerPx(), reference);
        const op = operationFor(hit, mode(), mods);
        if (!op) {
          draw(box, null);
          pendingMove = null;
          pendingUp = null;
          return;
        }
        const p: Press = {
          box,
          start: { quad: box.quad, start: at, hit, op, reference },
          startDoc: e.docPoint,
          op,
          run: null,
          quad: null,
          refused: null,
        };
        if (op === "distort" || op === "perspective") {
          const why = box.geometry.map(distortRefusal).find((r) => r);
          if (why) {
            p.refused = why;
            notice = `${op === "perspective" ? "Perspective" : "Free Distort"} cannot reshape ${why}`;
            draw(box, null);
          }
        } else if (op !== "reference") {
          p.run = startEngine(p, mods);
        }
        press = p;
        replay();
      });
    },
    onPointerMove(e) {
      if (resolving) {
        pendingMove = e;
        return;
      }
      const p = press;
      if (!p || e.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      if (p.run) {
        p.run.update(
          [e.docPoint[0] - p.startDoc[0], e.docPoint[1] - p.startDoc[1]],
          {
            shift: e.modifiers.shift,
            alt: e.modifiers.alt,
          },
        );
        return;
      }
      if (p.refused) return;
      const at = pointOnPage(e, p.box.pageId);
      if (!at) return;
      const res = dragBox(p.start, at, e.modifiers, mode());
      if (p.op === "reference") {
        customRef = {
          key: selectionKeyOf(p.box.targets),
          point: res.reference,
        };
        draw(p.box, null);
        return;
      }
      if (isUsableQuad(res.quad)) {
        p.quad = res.quad;
        draw(p.box, p.quad);
      }
    },
    onPointerUp(e) {
      if (resolving) {
        pendingUp = e;
        return;
      }
      const p = press;
      if (!p) return;
      press = null;
      const wasDrag = e.maxDelta > CLICK_DRAG_THRESHOLD_PX;
      if (p.run) {
        if (wasDrag)
          p.run.update(
            [e.docPoint[0] - p.startDoc[0], e.docPoint[1] - p.startDoc[1]],
            {
              shift: e.modifiers.shift,
              alt: e.modifiers.alt,
            },
          );
        p.run.end(wasDrag);
        return;
      }
      if (p.op === "reference") {
        draw(p.box, null);
        return;
      }
      if (!wasDrag || p.refused || !p.quad) {
        draw(p.box, null);
        return;
      }
      void finishClientArm(p).then(redraw);
    },
    onKey(e) {
      if (e.key === "Escape") {
        cancelPress();
        customRef = null;
      }
    },
    cursorAt(e): CursorSpec | undefined {
      const box = lastBox;
      if (!box) return undefined;
      const at = pointOnPage(e, box.pageId);
      if (!at) return undefined;
      const hit = hitTestBox(box.quad, at, unitsPerPx(), referenceOf(box));
      switch (hit.kind) {
        case "handle": {
          const op = operationFor(hit, mode(), e.modifiers);
          if (op === "distort" || op === "perspective")
            return { kind: "css", token: "crosshair" };
          return {
            kind: "css",
            token: handleCursor(box.quad, hit.handle) as
              "nwse-resize" | "nesw-resize" | "ew-resize" | "ns-resize",
          };
        }
        case "rotate":
          return ROTATE_CURSOR;
        case "inside":
          return { kind: "css", token: "move" };
        case "reference":
          return { kind: "css", token: "crosshair" };
        default:
          return undefined;
      }
    },
  };
  return handler;
}
