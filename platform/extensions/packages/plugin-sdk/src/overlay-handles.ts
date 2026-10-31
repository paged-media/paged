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

// Extensions ADR 339 — the two overlay doors that answer the POINTER for a
// bundle: retained handle sets (`host.overlay.handles`, `overlay.handles@1`)
// and the host-drawn transform box (`host.transformBox`,
// `host.transformBox@1`).
//
// Both draw through the overlay-layer sink the editor already renders
// (`overlaySignals.setOverlayLayer`), in the `ToolPreviewHandle` primitive
// the editor draws at a constant screen size; both answer hits from the
// camera's scale, so a bundle never re-derives screen metrics. The pointer
// reaches them through the bundle's OWN tools: `wrapToolGesture` sits
// between the editor and every gesture handler the bundle contributes,
// hands the transform box first refusal on each event, and stamps
// `hitHandle` on what the tool then receives.

import type {
  CanvasPointerEvent,
  CursorSpec,
  ElementGeometryItem,
  GestureHandler,
  OverlayHandleSet,
  OverlayHandleSpace,
  OverlayHandleSpec,
  PagedEditor,
  ToolPreviewHandle,
  ToolPreviewShape,
  TransformBoxMode,
  TransformBoxOptions,
  TransformBoxSession,
  TransformBoxSurface,
  TransformBoxUpdate,
} from "@paged-media/plugin-api";

import {
  BOX_HANDLES,
  dragBox,
  handleCursor,
  handlePoint,
  hitTestBox,
  homographyFromQuads,
  identity3,
  isUsableQuad,
  operationFor,
  quadCentre,
  type BoxDragStart,
  type Point,
  type Quad,
} from "./transform-box.js";

/** The rotate cursor (a curved double arrow), hotspot at its centre —
 *  the one the host's selection chrome shows outside a corner. */
export const ROTATE_CURSOR: CursorSpec = {
  kind: "svg",
  src:
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
        '<path d="M5 15a8 8 0 0 1 14-8" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/>' +
        '<path d="M5 15a8 8 0 0 1 14-8" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round"/>' +
        '<path d="M2 12l3 4 4-3M22 10l-3-4-4 3" fill="none" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>' +
        "</svg>",
    ),
  hotspot: { x: 12, y: 12 },
};

/** The default hit radius of a handle kind, screen px. */
function defaultHitPx(kind: OverlayHandleSpec["kind"]): number {
  return kind === "rotateZone" ? 28 : 6;
}

/** What the doors need from the host adapter. */
export interface OverlayDoorDeps {
  getEditor(): PagedEditor;
  /** The bundle's manifest id (the host-wide key prefix). */
  manifestId: string;
  /** The overlay capability gate (throws when undeclared). */
  requireOverlay(door: string): void;
  warn(message: string): void;
}

interface ResolvedHandle {
  id: string;
  pageId: string;
  at: Point;
  kind: OverlayHandleSpec["kind"];
  cursor?: CursorSpec;
  hitPx: number;
  active: boolean;
}

/** The camera's px-per-pt (1 when the host reports none). */
function cameraScale(editor: PagedEditor): number {
  const s = editor.camera?.camera?.scale;
  return typeof s === "number" && s > 0 && Number.isFinite(s) ? s : 1;
}

/** The overlay-layer sink, or null when the host renders no layers. */
function layerSink(editor: PagedEditor) {
  const signals = editor.overlaySignals;
  return typeof signals?.setOverlayLayer === "function" &&
    typeof signals?.removeOverlayLayer === "function"
    ? {
        set: (key: string, shapes: readonly ToolPreviewShape[]) =>
          signals.setOverlayLayer!(key, shapes),
        remove: (key: string) => signals.removeOverlayLayer!(key),
      }
    : null;
}

/** True when the host draws handle sets and transform boxes. */
export function hostDrawsHandles(editor: PagedEditor): boolean {
  return layerSink(editor) !== null;
}

/** A frame-content point → page-local pt through the frame's geometry
 *  (its box top-left, then its item transform; the page origin is folded
 *  into the transform, as `elementGeometry` reports it). */
function contentToPage(g: ElementGeometryItem, p: Point): Point {
  const [top, left] = g.bounds;
  const x = left + p[0];
  const y = top + p[1];
  const t = g.itemTransform;
  if (!t) return [x, y];
  return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
}

/** The handle-set door and the hit router behind `hitHandle`. */
export function createHandleSets(deps: OverlayDoorDeps) {
  let seq = 0;
  const live = new Map<
    string,
    { handles: ResolvedHandle[]; generation: number; key: string }
  >();

  const draw = (key: string, handles: readonly ResolvedHandle[]) => {
    const sink = layerSink(deps.getEditor());
    if (!sink) return;
    const shapes: ToolPreviewHandle[] = handles
      .filter((h) => h.kind !== "rotateZone")
      .map((h) => ({
        kind: "handle",
        pageId: h.pageId,
        x: h.at[0],
        y: h.at[1],
        shape: h.kind as ToolPreviewHandle["shape"],
        ...(h.active ? { active: true } : {}),
      }));
    sink.set(key, shapes);
  };

  /** The first handle under a page point across every live set, in set
   *  creation order then handle order. */
  const hit = (
    pageId: string | null,
    point: Point | null,
  ): { set: string; handle: ResolvedHandle } | null => {
    if (!pageId || !point) return null;
    const scale = cameraScale(deps.getEditor());
    for (const [setId, s] of live) {
      for (const h of s.handles) {
        if (h.pageId !== pageId) continue;
        const r = h.hitPx / scale;
        const dx = Math.abs(h.at[0] - point[0]);
        const dy = Math.abs(h.at[1] - point[1]);
        const inside =
          h.kind === "square" ? dx <= r && dy <= r : Math.hypot(dx, dy) <= r;
        if (inside) return { set: setId, handle: h };
      }
    }
    return null;
  };

  const handles = (id?: string): OverlayHandleSet => {
    deps.requireOverlay("overlay.handles");
    const setId = id ?? `handles-${++seq}`;
    if (live.has(setId)) {
      throw new Error(
        `host.overlay.handles("${setId}"): a handle set with this id is ` +
          `already live in ${deps.manifestId} — dispose it first or pick another id`,
      );
    }
    const key = `${deps.manifestId}/handles:${setId}`;
    const state = { handles: [] as ResolvedHandle[], generation: 0, key };
    live.set(setId, state);
    const sink = layerSink(deps.getEditor());
    if (!sink)
      deps.warn(
        "host.overlay.handles — this host renders no handle sets " +
          '(supports("overlay.handles@1") is false); hits still answer, nothing is drawn',
      );
    sink?.set(key, []);
    let disposed = false;
    const resolve = (
      pageId: string,
      specs: readonly OverlayHandleSpec[],
      map: (p: Point) => Point,
    ): ResolvedHandle[] =>
      specs.map((h) => ({
        id: h.id,
        pageId,
        at: map(h.at),
        kind: h.kind,
        ...(h.cursor
          ? { cursor: h.cursor }
          : h.kind === "rotateZone"
            ? { cursor: ROTATE_CURSOR }
            : {}),
        hitPx: h.hitPx ?? defaultHitPx(h.kind),
        active: h.active === true,
      }));
    const set: OverlayHandleSet = {
      id: setId,
      set(space: OverlayHandleSpace, specs) {
        if (disposed) return;
        const generation = ++state.generation;
        if ("pageId" in space) {
          state.handles = resolve(space.pageId, specs, (p) => p);
          draw(key, state.handles);
          return;
        }
        // Frame-content space: resolve the frame's geometry first. A
        // later `set` supersedes one still resolving (the generation).
        const editor = deps.getEditor();
        void Promise.resolve(editor.client.elementGeometry([space.element]))
          .then((items) => {
            if (disposed || generation !== state.generation) return;
            const g = items.find((i) => i?.pageId);
            if (!g?.pageId) {
              state.handles = [];
            } else {
              state.handles = resolve(g.pageId, specs, (p) =>
                contentToPage(g, p),
              );
            }
            draw(key, state.handles);
          })
          .catch(() => {});
      },
      clear() {
        if (disposed) return;
        state.generation++;
        state.handles = [];
        draw(key, []);
      },
      hitTest(pageId, pagePoint) {
        if (disposed) return null;
        const found = hit(pageId, pagePoint);
        return found && found.set === setId ? found.handle.id : null;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        live.delete(setId);
        layerSink(deps.getEditor())?.remove(key);
      },
    };
    return set;
  };

  return { handles, hit, disposeAll: () => live.clear() };
}

// ─────────────────────────── transform box ───────────────────────────

/** The transform-box door. `route*` are called by `wrapToolGesture`. */
export function createTransformBoxes(deps: OverlayDoorDeps) {
  let current: BoxState | null = null;
  const layerKey = `${deps.manifestId}/transformBox`;

  interface BoxState {
    options: TransformBoxOptions;
    opened: Quad;
    quad: Quad;
    reference: Point;
    mode: TransformBoxMode;
    drag: BoxDragStart | null;
    lastOp: TransformBoxUpdate["operation"];
    session: TransformBoxSession;
    closed: boolean;
  }

  const report = (s: BoxState): TransformBoxUpdate => ({
    matrix: homographyFromQuads(s.opened, s.quad) ?? identity3(),
    quad: s.quad.map((p) => [p[0], p[1]]) as Quad,
    reference: [s.reference[0], s.reference[1]],
    mode: s.mode,
    operation: s.lastOp,
  });

  const draw = (s: BoxState | null) => {
    const sink = layerSink(deps.getEditor());
    if (!sink) return;
    if (!s || s.closed) {
      sink.set(layerKey, []);
      return;
    }
    const pageId = s.options.pageId;
    const active = s.drag?.hit.kind === "handle" ? s.drag.hit.handle : null;
    const shapes: ToolPreviewShape[] = [
      { pageId, points: s.quad.map((p) => [p[0], p[1]]), close: true },
      ...BOX_HANDLES.map((h): ToolPreviewHandle => ({
        kind: "handle",
        pageId,
        x: handlePoint(s.quad, h)[0],
        y: handlePoint(s.quad, h)[1],
        shape: "square",
        ...(h === active ? { active: true } : {}),
      })),
      {
        kind: "handle",
        pageId,
        x: s.reference[0],
        y: s.reference[1],
        shape: "centre",
      },
    ];
    sink.set(layerKey, shapes);
  };

  const close = (s: BoxState) => {
    s.closed = true;
    s.drag = null;
    if (current === s) current = null;
    draw(null);
  };

  const open = (options: TransformBoxOptions): TransformBoxSession => {
    deps.requireOverlay("transformBox.open");
    if (current) current.session.cancel();
    const opened = options.quad.map((p) => [p[0], p[1]]) as Quad;
    const s = {} as BoxState;
    const session: TransformBoxSession = {
      get mode() {
        return s.mode;
      },
      get open() {
        return !s.closed;
      },
      setMode(mode) {
        if (s.closed || s.mode === mode) return;
        s.mode = mode;
        s.lastOp = null;
        options.onChange?.(report(s));
      },
      current: () => report(s),
      commit() {
        if (s.closed) return;
        s.lastOp = null;
        const u = report(s);
        close(s);
        options.onCommit(u);
      },
      cancel() {
        if (s.closed) return;
        close(s);
        options.onCancel?.();
      },
      dispose() {
        session.cancel();
      },
    };
    Object.assign(s, {
      options,
      opened,
      quad: opened.map((p) => [p[0], p[1]]) as Quad,
      reference: options.reference
        ? ([options.reference[0], options.reference[1]] as Point)
        : quadCentre(opened),
      mode: options.mode ?? "freeTransform",
      drag: null,
      lastOp: null,
      session,
      closed: false,
    } satisfies Omit<BoxState, never>);
    if (!layerSink(deps.getEditor()))
      deps.warn(
        "host.transformBox — this host renders no overlay layers " +
          '(supports("host.transformBox@1") is false); the box routes and reports but is not drawn',
      );
    current = s;
    draw(s);
    // The box hears the bundle's own tools only: make the named one the
    // tool in hand.
    if (options.toolId) {
      try {
        deps.getEditor().tool?.setBaseTool(options.toolId);
      } catch {
        /* a host without the tool store keeps the tool in hand */
      }
    }
    return session;
  };

  const surface: TransformBoxSurface = {
    open,
    active: () => (current && !current.closed ? current.session : null),
  };

  const unitsPerPx = () => 1 / cameraScale(deps.getEditor());

  /** Offer a pointer event to the open box. True when the box took it. */
  const route = (
    phase: "down" | "move" | "up",
    e: CanvasPointerEvent,
  ): boolean => {
    const s = current;
    if (!s || s.closed) return false;
    if (phase === "down") {
      if (e.button !== 0 || e.pageId !== s.options.pageId || !e.pagePoint)
        return false;
      const p: Point = [e.pagePoint[0], e.pagePoint[1]];
      const hit = hitTestBox(s.quad, p, unitsPerPx(), s.reference);
      const op = operationFor(hit, s.mode, e.modifiers);
      if (!op) return false;
      s.drag = {
        quad: s.quad.map((q) => [q[0], q[1]]) as Quad,
        start: p,
        hit,
        op,
        reference: s.reference,
      };
      draw(s);
      return true;
    }
    if (!s.drag) return false;
    if (e.pagePoint && e.pageId === s.options.pageId) {
      const res = dragBox(
        s.drag,
        [e.pagePoint[0], e.pagePoint[1]],
        e.modifiers,
        s.mode,
      );
      // A drag that would fold the box keeps the last good one.
      if (isUsableQuad(res.quad)) {
        s.quad = res.quad;
        s.reference = res.reference;
        s.lastOp = s.drag.op;
        draw(s);
        s.options.onChange?.(report(s));
      }
    }
    if (phase === "up") {
      s.drag = null;
      draw(s);
    }
    return true;
  };

  /** Enter commits, Escape cancels. True when the box took the key. */
  const key = (e: KeyboardEvent): boolean => {
    const s = current;
    if (!s || s.closed) return false;
    if (e.key === "Enter") {
      s.session.commit();
      return true;
    }
    if (e.key === "Escape") {
      s.session.cancel();
      return true;
    }
    return false;
  };

  const cursorAt = (e: CanvasPointerEvent): CursorSpec | undefined => {
    const s = current;
    if (!s || s.closed || e.pageId !== s.options.pageId || !e.pagePoint)
      return undefined;
    const hit = hitTestBox(
      s.quad,
      [e.pagePoint[0], e.pagePoint[1]],
      unitsPerPx(),
      s.reference,
    );
    switch (hit.kind) {
      case "handle":
        return {
          kind: "css",
          token: handleCursor(s.quad, hit.handle) as
            "nwse-resize" | "nesw-resize" | "ew-resize" | "ns-resize",
        };
      case "rotate":
        return ROTATE_CURSOR;
      case "inside":
        return { kind: "css", token: "move" };
      case "reference":
        return { kind: "css", token: "crosshair" };
      default:
        return undefined;
    }
  };

  return {
    surface,
    route,
    key,
    cursorAt,
    disposeAll: () => current?.session.cancel(),
  };
}

/**
 * Put the overlay doors between the editor and one of the bundle's
 * gesture handlers: the open transform box takes the events it wants
 * first; every other event reaches the handler with `hitHandle` stamped
 * from the bundle's live handle sets.
 */
export function wrapToolGesture(
  inner: GestureHandler,
  sets: ReturnType<typeof createHandleSets>,
  boxes: ReturnType<typeof createTransformBoxes>,
): GestureHandler {
  const stamp = (e: CanvasPointerEvent): CanvasPointerEvent => {
    const found = sets.hit(e.pageId, e.pagePoint);
    return found
      ? { ...e, hitHandle: { set: found.set, id: found.handle.id } }
      : e;
  };
  /** A box drag runs to its release even if the pointer leaves it. */
  let boxOwnsDrag = false;
  const wrapped: GestureHandler = {
    onActivate: (p) => inner.onActivate(p),
    onDeactivate: (r) => inner.onDeactivate(r),
    onPointerDown(e) {
      if (boxes.route("down", e)) {
        boxOwnsDrag = true;
        return;
      }
      inner.onPointerDown(stamp(e));
    },
    onPointerMove(e) {
      if (boxOwnsDrag && boxes.route("move", e)) return;
      inner.onPointerMove(stamp(e));
    },
    onPointerUp(e) {
      if (boxOwnsDrag) {
        boxOwnsDrag = false;
        if (boxes.route("up", e)) return;
      }
      inner.onPointerUp(stamp(e));
    },
    onKey(e) {
      if (boxes.key(e)) return;
      inner.onKey?.(e);
    },
    cursorAt(e) {
      const fromBox = boxes.cursorAt(e);
      if (fromBox) return fromBox;
      const own = inner.cursorAt?.(e);
      if (own) return own;
      return sets.hit(e.pageId, e.pagePoint)?.handle.cursor;
    },
  };
  if (inner.renderOverlay)
    wrapped.renderOverlay = (ctx) => inner.renderOverlay!(ctx);
  return wrapped;
}
