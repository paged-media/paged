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

// Editor ADR 310 — LIVE-SHAPE WIDGETS on the canvas (engine ADR 10XX):
// Illustrator's on-object controls for the one selected shape.
//
//   rectangle  a widget inside each corner, on its diagonal at the
//              radius: drag = all four corners' radius (Shift: this one),
//              Alt-click = this corner's next type (rounded, inverse
//              rounded, bevel, inset, fancy)
//   polygon    (a live one) a side widget right of its box: drag up for
//              more sides, down for fewer; and the star widget on the
//              first inner point: drag in or out for the star inset
//   oval       the pie widgets on the ellipse at the start and end
//              angles (both at three o'clock on a whole ellipse, the end
//              one on top): drag around the ellipse; Shift snaps to 15°
//
// The widgets live in the selection's own space: the pointer goes
// through the inverse of the item's transform, so a turned or scaled
// shape works. A drag previews (a dashed outline or the moving widget
// and its value) and commits ONE mutation on release — one undo step.
// The engine owns the shape; this file only asks it for the parameters
// (`elementProperties`) and writes them back.
//
// A host overlay rather than a bundle's `overlay.handles@1` set: the
// parameters are the engine's and the widgets work under the host's
// own selection tools in every module's edit context, as the resize
// handles do. Pointer events are taken on the widget itself (they stop
// propagation), the way the overlay contributions of the bundles do.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";

import type {
  CanvasClient,
  ElementGeometryItem,
  ElementId,
  Mutation,
  Value,
} from "@paged-media/client";
import {
  useCanvasClient,
  useSelection,
  type OverlayContribution,
  type OverlayProps,
} from "@paged-media/shell";
import {
  CORNERS,
  affineScale,
  applyAffine,
  circleBoxOf,
  cornerRadiusAt,
  cornerWidgetPoint,
  ellipseAngleAt,
  ellipsePoint,
  inverseAffine,
  maxCornerRadius,
  nextCornerOption,
  normalizeEnd,
  normalizeStart,
  pieOutlinePath,
  polygonInCircle,
  polygonPath,
  sidesFromDrag,
  sidesWidgetPoint,
  starInsetAt,
  type Box,
  type PolygonShape,
  type Pt,
} from "@paged-media/tools";

export const LIVE_SHAPE_OVERLAY_ID = "paged.live-shape-handles";

/** Screen px. */
const WIDGET_PX = 7;
const HIT_PX = 14;
const CORNER_MIN_OFFSET_PX = 14;
const SIDES_OFFSET_PX = 16;

interface CornerState {
  option: string;
  radius: number;
}

/** What the widgets draw for the one selected shape. */
export interface LiveShapeState {
  id: ElementId;
  kind: "rectangle" | "oval" | "polygon";
  pageId: string;
  /** Inner `[top, left, bottom, right]`. */
  bounds: Box;
  /** Inner → page. */
  transform: readonly number[] | null;
  corners?: CornerState[];
  shape?: PolygonShape;
  pie?: { start: number; end: number };
}

type Entry = { path: string; value: Value | null };

function lengthOf(entries: readonly Entry[], path: string): number | null {
  const v = entries.find((e) => e.path === path)?.value as
    { type: string; value: number | null } | null | undefined;
  return v && v.type === "length" && typeof v.value === "number"
    ? v.value
    : null;
}

function textOf(entries: readonly Entry[], path: string): string | null {
  const v = entries.find((e) => e.path === path)?.value as
    { type: string; value: string } | null | undefined;
  return v && v.type === "text" ? v.value : null;
}

/** The state a shape's geometry and properties make, or null when it has
 *  no live widget (a polygon that is not a live one, another kind). */
export function liveShapeStateOf(
  item: ElementGeometryItem,
  entries: readonly Entry[],
): LiveShapeState | null {
  const kind = item.id.kind;
  if (!item.pageId) return null;
  const base = {
    id: item.id as ElementId,
    pageId: item.pageId,
    bounds: item.bounds as unknown as Box,
    transform: (item.itemTransform ?? null) as readonly number[] | null,
  };
  if (kind === "rectangle") {
    return {
      ...base,
      kind,
      corners: CORNERS.map((c) => ({
        option: textOf(entries, `frameCornerOption${c.suffix}`) || "None",
        radius: lengthOf(entries, `frameCornerRadius${c.suffix}`) ?? 12,
      })),
    };
  }
  if (kind === "polygon") {
    const sides = lengthOf(entries, "frameShapeSides");
    if (sides === null) return null;
    return {
      ...base,
      kind,
      shape: {
        sides,
        starInset: lengthOf(entries, "frameShapeStarInset") ?? 0,
      },
    };
  }
  if (kind === "oval") {
    return {
      ...base,
      kind,
      pie: {
        start: lengthOf(entries, "frameShapePieStart") ?? 0,
        end: lengthOf(entries, "frameShapePieEnd") ?? 360,
      },
    };
  }
  return null;
}

/** The selected shape's state, kept current across selection and
 *  document changes (a late reply never overwrites a newer one). */
class LiveShapeModel {
  private state: LiveShapeState | null = null;
  private readonly listeners = new Set<() => void>();
  private selected: ElementId | null = null;
  private run = 0;
  /** While a drag is in flight the model holds still. */
  private dragging = false;

  constructor(private readonly client: CanvasClient) {}

  snapshot = (): LiveShapeState | null => this.state;
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(next: LiveShapeState | null) {
    this.state = next;
    for (const l of this.listeners) l();
  }

  attach(): () => void {
    const off = this.client.subscribe((msg) => {
      if (
        msg.kind === "mutationApplied" ||
        msg.kind === "undoApplied" ||
        msg.kind === "redoApplied" ||
        msg.kind === "documentLoaded"
      ) {
        void this.refresh();
      }
    });
    return off;
  }

  select(id: ElementId | null) {
    const same =
      id === this.selected ||
      (id &&
        this.selected &&
        id.kind === this.selected.kind &&
        id.id === this.selected.id);
    this.selected = id;
    if (!same) void this.refresh();
  }

  async refresh(): Promise<void> {
    const run = ++this.run;
    const id = this.selected;
    if (
      !id ||
      (id.kind !== "rectangle" && id.kind !== "oval" && id.kind !== "polygon")
    ) {
      if (this.state) this.set(null);
      return;
    }
    try {
      const [items, props] = await Promise.all([
        this.client.elementGeometry([id]),
        this.client.elementProperties(id),
      ]);
      if (run !== this.run || this.dragging) return;
      const item = items[0];
      this.set(
        item && props
          ? liveShapeStateOf(item, props.entries as unknown as Entry[])
          : null,
      );
    } catch {
      if (run === this.run) this.set(null);
    }
  }

  /** A drag starts: hold still until it commits or is cancelled. */
  beginDrag() {
    this.dragging = true;
  }

  cancelDrag() {
    this.dragging = false;
  }

  async commit(mutation: Mutation): Promise<void> {
    this.dragging = false;
    await this.client.mutate(mutation);
    await this.refresh();
  }
}

const setOp = (elementId: ElementId, path: string, value: Value): Mutation =>
  ({ op: "setElementProperty", args: { elementId, path, value } }) as Mutation;
const len = (value: number): Value => ({ type: "length", value }) as Value;
const txt = (value: string): Value => ({ type: "text", value }) as Value;

/** The writes a corner-radius drag commits: the radius on the dragged
 *  corner (or all four), and a square corner turned round. */
export function cornerRadiusMutation(
  s: LiveShapeState,
  index: number,
  radius: number,
  only: boolean,
): Mutation {
  const ops: Mutation[] = [];
  CORNERS.forEach((c, i) => {
    if (only && i !== index) return;
    ops.push(setOp(s.id, `frameCornerRadius${c.suffix}`, len(radius)));
    if ((s.corners?.[i]?.option ?? "None") === "None" && radius > 0) {
      ops.push(
        setOp(s.id, `frameCornerOption${c.suffix}`, txt("RoundedCorner")),
      );
    }
  });
  return { op: "batch", args: { ops } } as Mutation;
}

/** Alt-click: the corner's next type. */
export function cornerCycleMutation(
  s: LiveShapeState,
  index: number,
): Mutation {
  const c = CORNERS[index]!;
  return setOp(
    s.id,
    `frameCornerOption${c.suffix}`,
    txt(nextCornerOption(s.corners?.[index]?.option ?? "None")),
  );
}

type DragKind =
  | { kind: "corner"; index: number }
  | { kind: "sides" }
  | { kind: "inset" }
  | { kind: "pieStart" }
  | { kind: "pieEnd" };

interface Preview {
  /** Inner-space outline (SVG path), drawn through the item transform. */
  d?: string;
  /** The widget's inner position while it is dragged. */
  at?: Pt;
  label?: string;
}

function LiveShapeHandlesRender(props: OverlayProps): ReactElement | null {
  const client = useCanvasClient();
  const { elementSelection, pathEditMode } = useSelection();
  const [model] = useState(() => new LiveShapeModel(client));
  const s = useSyncExternalStore(model.subscribe, model.snapshot, () => null);
  const [preview, setPreview] = useState<{
    drag: DragKind;
    p: Preview;
  } | null>(null);
  const only = elementSelection.length === 1 ? elementSelection[0]! : null;
  const key = only ? `${only.kind}:${only.id}` : "";

  useEffect(() => model.attach(), [model]);
  useEffect(() => {
    model.select(only);
  }, [model, only]);

  if (!s || !only || pathEditMode || key !== `${s.id.kind}:${s.id.id}`) {
    return <g data-live-shape-handles="" data-count={0} />;
  }
  const pr = props.pageRects.get(s.pageId);
  if (!pr) return <g data-live-shape-handles="" data-count={0} />;
  const scale = props.camera.scale || 1;
  // Screen px → the item's own units.
  const own = (px: number) => px / (scale * affineScale(s.transform));
  const toPage = (p: Pt): Pt => applyAffine(s.transform, p);

  const widgets: {
    id: string;
    at: Pt;
    drag: DragKind;
    shape: "round" | "diamond";
    cursor: string;
  }[] = [];
  if (s.kind === "rectangle" && s.corners) {
    const box = s.bounds;
    // Too small on screen to tell four widgets apart: none.
    if (maxCornerRadius(box) > own(CORNER_MIN_OFFSET_PX * 1.5)) {
      s.corners.forEach((c, i) => {
        const r = c.option === "None" ? 0 : c.radius;
        widgets.push({
          id: `corner-${i}`,
          at: cornerWidgetPoint(box, i, r, own(CORNER_MIN_OFFSET_PX)),
          drag: { kind: "corner", index: i },
          shape: "round",
          cursor: "default",
        });
      });
    }
  } else if (s.kind === "polygon" && s.shape) {
    const circle = circleBoxOf(s.bounds, s.shape);
    widgets.push({
      id: "sides",
      at: sidesWidgetPoint(s.bounds, own(SIDES_OFFSET_PX)),
      drag: { kind: "sides" },
      shape: "diamond",
      cursor: "ns-resize",
    });
    // The first inner point (where it is, or would be at inset 0).
    const n = Math.round(s.shape.sides);
    const t = -Math.PI / 2 + Math.PI / n;
    const r = 1 - s.shape.starInset / 100;
    const [top, left, bottom, right] = circle;
    widgets.push({
      id: "inset",
      at: [
        (left + right) / 2 + ((right - left) / 2) * r * Math.cos(t),
        (top + bottom) / 2 + ((bottom - top) / 2) * r * Math.sin(t),
      ],
      drag: { kind: "inset" },
      shape: "round",
      cursor: "move",
    });
  } else if (s.kind === "oval" && s.pie) {
    widgets.push({
      id: "pie-start",
      at: ellipsePoint(s.bounds, s.pie.start),
      drag: { kind: "pieStart" },
      shape: "round",
      cursor: "move",
    });
    widgets.push({
      id: "pie-end",
      at: ellipsePoint(s.bounds, s.pie.end),
      drag: { kind: "pieEnd" },
      shape: "round",
      cursor: "move",
    });
  }

  const onDown = (drag: DragKind) => (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0) return;
    // Win the pointer before the canvas starts a move or a marquee.
    e.preventDefault();
    e.stopPropagation();
    const group = (e.currentTarget as SVGElement).closest(
      "g[data-live-shape-handles]",
    ) as SVGGraphicsElement | null;
    const svg = (e.currentTarget as SVGElement).ownerSVGElement;
    // Client px → the page's own pt (through the group's screen matrix,
    // which carries the camera and any view rotation).
    const toPagePoint = (cx: number, cy: number): Pt => {
      const ctm = group?.getScreenCTM?.();
      if (ctm) {
        const inv = ctm.inverse();
        return [
          inv.a * cx + inv.c * cy + inv.e,
          inv.b * cx + inv.d * cy + inv.f,
        ];
      }
      const box = svg?.getBoundingClientRect();
      return [
        (cx - (box?.left ?? 0) - props.camera.tx) / scale - pr.x,
        (cy - (box?.top ?? 0) - props.camera.ty) / scale - pr.y,
      ];
    };
    const toInner = (ev: { clientX: number; clientY: number }): Pt =>
      inverseAffine(s.transform, toPagePoint(ev.clientX, ev.clientY));
    const start = toPagePoint(e.clientX, e.clientY);
    const alt = e.altKey;
    let moved = false;
    let last: Mutation | null = null;
    model.beginDrag();

    const update = (ev: PointerEvent | ReactPointerEvent) => {
      const p = toInner(ev);
      const page = toPagePoint(ev.clientX, ev.clientY);
      const dyScreen = (page[1] - start[1]) * scale;
      if (Math.hypot(page[0] - start[0], page[1] - start[1]) * scale > 2) {
        moved = true;
      }
      if (!moved) return;
      const shift = ev.shiftKey;
      switch (drag.kind) {
        case "corner": {
          const r = cornerRadiusAt(s.bounds, drag.index, p);
          last = cornerRadiusMutation(s, drag.index, r, shift);
          setPreview({
            drag,
            p: {
              at: cornerWidgetPoint(
                s.bounds,
                drag.index,
                r,
                own(CORNER_MIN_OFFSET_PX),
              ),
              label: `${+r.toFixed(1)} pt`,
            },
          });
          break;
        }
        case "sides": {
          const shape = s.shape!;
          const sides = sidesFromDrag(shape.sides, dyScreen / scale, scale);
          last = setOp(s.id, "frameShapeSides", len(sides));
          const next = { sides, starInset: shape.starInset };
          setPreview({
            drag,
            p: {
              d: polygonPath(
                polygonInCircle(circleBoxOf(s.bounds, shape), next),
              ),
              label: String(sides),
            },
          });
          break;
        }
        case "inset": {
          const shape = s.shape!;
          const circle = circleBoxOf(s.bounds, shape);
          const inset = starInsetAt(circle, p);
          last = setOp(s.id, "frameShapeStarInset", len(inset));
          const next = { sides: shape.sides, starInset: inset };
          setPreview({
            drag,
            p: {
              d: polygonPath(polygonInCircle(circle, next)),
              label: `${inset} %`,
            },
          });
          break;
        }
        case "pieStart":
        case "pieEnd": {
          let a = ellipseAngleAt(s.bounds, p);
          if (shift) a = Math.round(a / 15) * 15;
          const pie = s.pie!;
          const startA =
            drag.kind === "pieStart" ? normalizeStart(a) : pie.start;
          const endA =
            drag.kind === "pieEnd" ? normalizeEnd(a === 0 ? 360 : a) : pie.end;
          last = setOp(
            s.id,
            drag.kind === "pieStart"
              ? "frameShapePieStart"
              : "frameShapePieEnd",
            len(drag.kind === "pieStart" ? startA : endA),
          );
          setPreview({
            drag,
            p: {
              d: pieOutlinePath(s.bounds, startA, endA),
              at: ellipsePoint(s.bounds, a),
              label: `${+a.toFixed(1)}°`,
            },
          });
          break;
        }
      }
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      setPreview(null);
      if (commit && last) {
        void model.commit(last);
      } else if (commit && !moved && alt && drag.kind === "corner") {
        void model.commit(cornerCycleMutation(s, drag.index));
      } else {
        model.cancelDrag();
      }
    };
    const up = (ev: PointerEvent) => {
      update(ev);
      finish(true);
    };
    const cancel = () => finish(false);
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const m = s.transform;
  const matrix = m
    ? `matrix(${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]})`
    : undefined;
  const inv = 1 / scale;
  return (
    <g
      data-live-shape-handles=""
      data-live-shape-kind={s.kind}
      data-count={widgets.length}
      transform={`translate(${pr.x} ${pr.y})`}
    >
      {preview?.p.d ? (
        <path
          d={preview.p.d}
          transform={matrix}
          fill="none"
          stroke="var(--overlay-selection, #1a73e8)"
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
          data-live-shape-preview=""
        />
      ) : null}
      {widgets.map((w) => {
        const dragged =
          preview && JSON.stringify(preview.drag) === JSON.stringify(w.drag);
        const [x, y] = toPage(dragged && preview.p.at ? preview.p.at : w.at);
        const r = WIDGET_PX / 2;
        return (
          <g
            key={w.id}
            transform={`translate(${x} ${y}) scale(${inv})`}
            data-live-handle={w.id}
          >
            <circle
              r={HIT_PX / 2}
              fill="transparent"
              style={{ cursor: w.cursor, pointerEvents: "all" }}
              onPointerDown={onDown(w.drag)}
            />
            {w.shape === "diamond" ? (
              <path
                d={`M0 ${-r - 1} L${r + 1} 0 L0 ${r + 1} L${-r - 1} 0 Z`}
                fill="white"
                stroke="var(--overlay-selection, #1a73e8)"
                strokeWidth={1}
                pointerEvents="none"
              />
            ) : (
              <circle
                r={r}
                fill={dragged ? "var(--overlay-selection, #1a73e8)" : "white"}
                stroke="var(--overlay-selection, #1a73e8)"
                strokeWidth={1}
                pointerEvents="none"
              />
            )}
            {dragged && preview.p.label ? (
              <text
                x={10}
                y={-8}
                fontSize={11}
                fill="var(--overlay-selection, #1a73e8)"
                pointerEvents="none"
                data-live-shape-label=""
              >
                {preview.p.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

/** The live-shape widgets (editor ADR 310): above the resize handles, so
 *  a corner widget near a resize square wins inside the shape. */
export const liveShapeHandlesContribution: OverlayContribution = {
  id: LIVE_SHAPE_OVERLAY_ID,
  render: LiveShapeHandlesRender,
  z: 320,
};
