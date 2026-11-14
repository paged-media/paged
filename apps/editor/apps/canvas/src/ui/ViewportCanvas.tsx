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

// Canvas-backed viewport.
//
// Owns a real `<canvas>` element; on mount calls
// `transferControlToOffscreen()` and hands the OffscreenCanvas to the
// worker via `CanvasClient.attachCanvas`. After that, the worker
// fully owns rendering — this component's only jobs are:
//
//   1. Host the `<canvas>` element + its hosting div.
//   2. Translate pointer + wheel events into camera updates
//      (`CanvasClient.setCamera`).
//   3. Track viewport size via ResizeObserver and forward to worker.
//   4. Render a small developer HUD over the canvas (`?debug=hud`).
//
// Per spec AC-V-7 the main thread does no rendering work here — the
// `<canvas>` is opaque from React's perspective after the
// `transferControlToOffscreen` call.

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  CANVAS_POINTER,
  OverlayHost,
  pageToContentPoint,
  resolveCursorCss,
  useContentSelection,
  useEditContextEntry,
  useOptionalEditContextStack,
  useOverlaySignals,
  useSelection,
  setDebugHandle,
  useEditorScope,
  type MarqueeRectPageLocal,
  type SelectionState,
  currentPageIndex,
  useEscapeArbiter,
  ownerOfTool,
  useInteractionCoordinator,
  type EndResult,
  type GuardToken,
  type InteractionPhase,
  type InteractionSession,
  type SessionSpec,
} from "@paged-media/shell";

import type { CanvasClient, GesturePressResult } from "@paged-media/client";
import { viewportToDoc, type Camera } from "@paged-media/client";
import type { HostHandleRouter } from "@paged-media/plugin-api";
import type {
  CanvasPointerEvent,
  ContentPointerEvent,
  PathEditPointer,
  PathEditSession,
} from "@paged-media/shell";
import type {
  ElementGeometryItem,
  ElementId,
  GestureAnchor,
  GestureHandle,
  GestureModifiers,
  GestureType,
  LayoutCacheStats,
  PageId,
  PressTarget,
  ResizeHandle,
  ResolutionResult,
  RunningHeader,
  TextCellAddr,
} from "@paged-media/client";
import {
  openingView,
  fitCamera,
  layoutPages,
  zoomAt,
  type PageRect,
} from "./layout";
import { pinchCamera, startPinch, type Pinch } from "./pinch";
import { routePress, type PressRouteKind } from "./press-route";
import { debugFlag } from "../debug-flags";
import { FrameSurfaceHost } from "./FrameSurfaceHost";
import { TextInputSurface } from "./TextInputSurface";

// Re-export the (now shell-owned) overlay state types so existing
// imports from this module continue to work.
export type { MarqueeRectPageLocal, SelectionState };

export interface PointerModifiers {
  /** Shift held → add to selection. */
  shift: boolean;
  /** Cmd (macOS) or Ctrl (other) held → toggle. */
  cmd: boolean;
}

export interface ViewportCanvasProps {
  client: CanvasClient;
  /** The loaded document's id (`DocumentHandle.docId`). The view fits
   *  the document when this changes — a document was opened — and is
   *  left alone when only its page list changes. */
  docId: string;
  pageIds: ReadonlyArray<PageId>;
  pageSizesPt: ReadonlyArray<readonly [number, number]>;
  /** Engine ADR 1011 — each page's top-left on the canvas, pt (absent:
   *  the pages stack). */
  pageOriginsPt?: ReadonlyArray<readonly [number, number]>;
  camera: Camera;
  onCameraChange: (cam: Camera) => void;
  /** The viewport was resized (`from` → `to`, CSS px): a dock opened,
   *  closed or was dragged, or the window changed. The camera context
   *  keeps the document point at the centre (UXI-CAM-003). */
  onViewportResize?: (
    from: readonly [number, number],
    to: readonly [number, number],
  ) => void;
  /** Called when the user clicks (not drags) on a page, and when a
   *  press-drag on an unselected item selects it before moving it
   *  (F-26). With the Selection tool it resolves to the selection the
   *  hit made (the item, or the group it belongs to), which that drag
   *  then moves. */
  onHit?: (
    selection: SelectionState | null,
    modifiers?: PointerModifiers,
  ) => Promise<ReadonlyArray<ElementId> | null> | void;
  /** IC5 (engine ADR 1303) — a plain Selection-tool press off the
   *  selection asks the engine once: the hit, the selection it makes
   *  (`target`: the outermost group, the leaf, or a member of the entered
   *  group) and the move begun from the press point, in one round trip.
   *  `onSelected` mirrors the selection it made. Absent: the press asks
   *  for its hit, then selects, then begins (`onHit`). */
  pressAt?: {
    target: PressTarget;
    onSelected: (
      result: GesturePressResult,
      pageId: PageId,
      pagePoint: [number, number],
    ) => void;
  } | null;
  /** Phase A — called when the user finishes a marquee drag with the
   * select tool. Payload is page-local `[top, left, bottom, right]`. */
  onMarquee?: (
    pageId: PageId,
    rect: [number, number, number, number],
    modifiers?: PointerModifiers,
    /** D-01 — drawn left to right it contains, right to left it
     *  intersects. */
    mode?: "contain" | "intersect",
  ) => void;
  /** Current selection; used by the overlay to highlight the hit point + page. */
  selection?: SelectionState | null;
  /** Main-thread FPS, sampled via rAF. Shown in the HUD. */
  fps?: number;
  /** Whether the worker successfully initialised WebGPU. `null` while undetermined. */
  gpuActive?: boolean | null;
  /** Tier 3 resolution result — anchor table + per-anchor page numbers. */
  resolution?: ResolutionResult | null;
  /** Phase 4 Step 2 — last rebuild's layout-cache stats; HUD badge. */
  layoutCacheStats?: LayoutCacheStats | null;
  /** Phase A — active tool. Default is `select`; `text` falls back to
   * the existing caret/typing pathway. */
  activeTool?: "select" | "text";
  /** Phase A — currently-selected element ids (worker-mirrored). */
  elementSelection?: ReadonlyArray<ElementId>;
  /** Phase A — geometry per selected id for the overlay chrome. */
  elementGeometry?: ReadonlyArray<ElementGeometryItem>;
  /** Phase B — called when the active gesture (translate, …) commits.
   * Caller refreshes the cached element geometry so the chrome lands
   * at the committed position. */
  onGestureCommitted?: () => void;
  /** Phase H / Track L — called when the user double-clicks a frame
   * whose hit is nested inside a group. `groupId` is the outermost
   * containing group (group_chain[0]); `hitElement` is the leaf the
   * user actually clicked on. Phase H used this to expand the group
   * to its leaves; Track L uses it to ENTER the group (set
   * `activeGroup = groupId`) and select the hit leaf scoped within. */
  onDoubleClickGroup?: (
    groupId: string,
    hitElement: ElementId | null,
    /** The hit's group chain, outermost first (what Escape climbs). */
    groupChain?: readonly string[],
  ) => void;
  /** Phase 2 (Concept 1) — when set, the effective tool carries a
   * gesture handler; ViewportCanvas resolves each pointer event to
   * document coordinates and routes it here, bypassing the
   * select/text / pan / marquee path. Null (the default) for
   * select/text, so the proven legacy path runs untouched. */
  /** Set when the ACTIVE tool declares a `legacyKey` as well as a
   *  gesture — i.e. its click and its drag are different halves of one
   *  tool (the Type tool: click places a caret, drag pulls out a text
   *  frame). Drives the dual dispatch in onPointerDown/onPointerUp. */
  legacyKeyForTool?: string | null;
  toolGesture?: {
    onDown: (e: CanvasPointerEvent) => void;
    onMove: (e: CanvasPointerEvent) => void;
    onUp: (e: CanvasPointerEvent) => void;
    /** Abort the in-flight tool gesture WITHOUT committing — pointer-
     *  capture loss / window blur (INV-8). `onUp` commits; this rolls
     *  back. */
    onCancel: () => void;
    /** Per-position cursor refinement from the handler's `cursorAt`. */
    hoverCursor?: (e: CanvasPointerEvent) => string | undefined;
    /** The effective tool's id (the session's owner and trace). */
    toolId?: string;
  } | null;
  /** Editor ADR 311 — the tool in hand works on the frame an edit context
   *  was entered on (Free Transform): a press over that frame goes to the
   *  tool, not to the context's content pointer. */
  toolSharedAcrossContexts?: boolean;
  /** Phase 3 — CSS cursor for the active tool. Overrides the default
   * pan affordance when set. */
  cursor?: string;
  /** Path-edit mode's live session, or null outside it. While set,
   * every primary-button press on the canvas is the path's: the session
   * decides what it landed on (an anchor, a handle, a segment, nothing)
   * and what the drag does. Only a CLICK on nothing comes back, to run
   * the ordinary select-what-is-here path. */
  pathEdit?: PathEditSession | null;
  /** Concept 1 — the Hand tool (incl. the Space spring-load): every
   * primary-button drag pans, reusing the proven pan machinery. */
  forcePan?: boolean;
  /** A filler or a viewer (editor ADR 294): a one-finger touch drag pans
   *  the page instead of moving or marqueeing, and a tap still selects. */
  touchPans?: boolean;
  /** Concept 1 — the Zoom tool (incl. Cmd+Space): a click zooms in
   * around the pointer; Alt-click zooms out. */
  zoomClick?: boolean;
}

const CLICK_DRAG_THRESHOLD_PX = 4;

/** One wheel "line" (DOM_DELTA_LINE) in CSS pixels — Firefox's mouse
 *  wheel reports lines; the others report pixels. */
const WHEEL_LINE_PX = 16;

export function ViewportCanvas(props: ViewportCanvasProps) {
  const scope = useEditorScope();
  const pointerStore = scope.get(CANVAS_POINTER);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Set once we've transferred to the worker — guards against re-transfer (illegal). */
  const transferredRef = useRef(false);
  // Bumped when the worker asks for a NEW canvas: after a GPU device is
  // lost and none replaces it, the old canvas keeps its WebGPU context
  // and cannot draw 2D, so a fresh element is transferred and the worker
  // draws it on the CPU.
  const [canvasGeneration, setCanvasGeneration] = useState(0);

  // Editor ADR 294 — the touch points on the canvas, by pointer id, in
  // viewport px. Two of them are a pinch: it takes over from whatever the
  // first finger began (rolled back, never committed), and the touch
  // stays the pinch's until every finger has lifted.
  const touchesRef = useRef(new Map<number, [number, number]>());
  // Whether the session CONSUMED the last release. A double-click on an
  // anchor is two of those, and must not also run the canvas's
  // double-click (enter an edit context / a group) underneath it.
  const pathEditConsumedRef = useRef(false);

  // The interaction coordinator (editor ADR 1210): every pointer
  // sequence on the canvas is a SESSION of the editor's coordinator, which
  // ends it on a window blur, a hidden page, a document or tool switch and
  // unmount.
  const interactions = useInteractionCoordinator();
  // IC4 — the press that holds the pointer, and everything the canvas
  // keeps for it, in ONE record owned by ONE session. It replaces the six
  // refs the canvas kept before (the legacy drag, a tool's drag, a
  // bundle's handle drag, path edit, a content gesture, a pinch), whose
  // precedence was the order of the `if`s in four handlers: the route is
  // decided once, at pointerdown (`routePress`), and the move, the release
  // and the cancel go to it. A gesture released and still committing has
  // left the record (it keeps its own session).
  const pointerRef = useRef<PointerRecord | null>(null);
  // What undoes each open session when something outside ends it, by
  // session id: the drag it holds while it holds the pointer, the commit
  // in flight once it is released.
  const rollBacksRef = useRef(new Map<string, (reason: string) => void>());

  // Phase A / E — marquee + snap guides live on OverlaySignalsContext.
  // ViewportCanvas writes (pointer plumbing); the marquee + snap-lines
  // overlay contributions read.
  const overlaySignals = useOverlaySignals();
  const setMarqueeRect = overlaySignals.setMarqueeRect;
  const setSnapLines = overlaySignals.setSnapLines;
  const marqueeRect = overlaySignals.marqueeRect;

  // W2.11 — text-tool click granularity. The text caret/range is owned
  // by ContentSelectionContext (the round-tripping setter refreshes
  // caret + selection geometry); ViewportCanvas drives it directly for
  // double-/triple-click word/line selection so the granularity logic
  // stays out of the panel wiring (single-click → caret still flows
  // through `onHit` → the panel).
  const { setContentSelection } = useContentSelection();

  // W3.2 — the edit-context entry resolver (B-02/W-03). A double-click
  // consults this BEFORE group descent: a polygon enters the
  // vectorGraphic context, a webFrame enters its source context.
  const { tryEnterOwnedContent, enterByDoubleClick } = useEditContextEntry();
  const { activeGroup } = useSelection();

  // K-1 — the edit-context STACK (optional: the canvas mounts standalone
  // in some specs). While a context is active, a pointer over the active
  // frame is delivered to its contribution in FRAME-CONTENT coordinates
  // (the canvas inverts the frame transform; §8.5 — the plugin never
  // compensates); a pointer OUTSIDE the active frame COMMITS the context.
  const editContextStack = useOptionalEditContextStack();

  // Native `detail` on pointerup is unreliable across browsers for the
  // 3rd click, so we track the click run ourselves: same screen point
  // (within slop) within the multi-click window bumps the count.
  const clickRunRef = useRef<{
    t: number;
    x: number;
    y: number;
    count: number;
  }>({ t: 0, x: 0, y: 0, count: 0 });

  // Document-space layout — only used to compute initial fit-to-document.
  // eslint-disable-next-line no-restricted-syntax -- keeps an effect dependency stable (ADR 229)
  const rects = useMemo(
    () => layoutPages(props.pageSizesPt, props.pageOriginsPt),
    [props.pageSizesPt, props.pageOriginsPt],
  );

  // Mount: transfer the canvas. Cleanup: nothing — once an
  // OffscreenCanvas is transferred, the worker owns it for its
  // entire life. Re-mounting the React component is destructive
  // anyway (camera state resets), and the user flow that triggers
  // it (new document via file drop) also resets the worker model.
  // The initial fit reads the page layout and camera callback as they are
  // when the canvas attaches; later re-fits are driven by the document-id
  // effect below.
  const fitOnAttach = useEffectEvent((width: number, height: number) => {
    if (rects.length > 0 && width > 10 && height > 10) {
      props.onCameraChange(fitCamera(width, height, openingView(rects)));
    }
  });
  useEffect(() => {
    if (transferredRef.current) return;
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const { width, height } = wrapper.getBoundingClientRect();
    const dpr = self.devicePixelRatio || 1;
    // The HTMLCanvasElement's CSS size stays driven by the
    // wrapper's flex layout; what we transfer is the *bitmap*
    // dimensions. Match them to the wrapper at attach time.
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const offscreen = canvas.transferControlToOffscreen();
    props.client.attachCanvas(offscreen, dpr, width, height);
    transferredRef.current = true;
    // Trigger initial fit-to-document (a replacement canvas keeps the view).
    if (canvasGeneration === 0) fitOnAttach(width, height);
  }, [props.client, canvasGeneration]);

  // ResizeObserver: post size updates to the worker so the
  // OffscreenCanvas bitmap matches the device-pixel viewport, and size
  // the overlay host with the wrapper (state, not a ref read in render:
  // the overlay follows a resize no other change re-renders for).
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  // The last laid-out size, kept across a hide (an <Activity> unmounts this
  // effect): the canvas shown again anchors from the size it left at.
  const anchorSizeRef = useRef<readonly [number, number]>([0, 0]);
  const onResized = useEffectEvent(
    (from: readonly [number, number], to: readonly [number, number]) =>
      props.onViewportResize?.(from, to),
  );
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      const width = wrapper.clientWidth;
      const height = wrapper.clientHeight;
      setHostSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
      const r = wrapper.getBoundingClientRect();
      if (r.width === lastW && r.height === lastH) return;
      lastW = r.width;
      lastH = r.height;
      // UXI-CAM-003 — a resize keeps the document point at the centre (a
      // hidden canvas measures 0 and anchors nothing).
      if (r.width > 0 && r.height > 0) {
        const from = anchorSizeRef.current;
        anchorSizeRef.current = [r.width, r.height];
        if (from[0] > 0 && from[1] > 0) onResized(from, [r.width, r.height]);
      }
      const dpr = self.devicePixelRatio || 1;
      if (transferredRef.current) {
        props.client.resizeCanvas(dpr, r.width, r.height);
      }
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [props.client]);

  // Re-fit the camera when the DOCUMENT changes, not when its page list
  // does. Keyed on the page-id signature, every inserted or deleted page
  // re-fitted to the whole document: a fifty-record Data Merge left the
  // view at 3%. Adding or removing pages keeps the user's view.
  const lastFitDocRef = useRef<string | null>(null);
  useEffect(() => {
    if (props.docId === lastFitDocRef.current) return;
    if (!wrapperRef.current || rects.length === 0) return;
    const { width, height } = wrapperRef.current.getBoundingClientRect();
    if (width < 10 || height < 10) return;
    props.onCameraChange(fitCamera(width, height, openingView(rects)));
    lastFitDocRef.current = props.docId;
  }, [rects, props]);

  // Resolve a DOM pointer event to the document-coordinate
  // CanvasPointerEvent a GestureHandler expects.
  const buildToolPointer = (
    e: React.PointerEvent<HTMLDivElement>,
    maxDelta: number,
  ): CanvasPointerEvent => {
    const rect = e.currentTarget.getBoundingClientRect();
    const [docX, docY] = viewportToDoc(
      props.camera,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    const containing = findContainingPage(rects, props.pageIds, docX, docY);
    const pagePoint: [number, number] | null = containing
      ? [docX - containing[1].x, docY - containing[1].y]
      : null;
    // B-08 — carry Pointer-Events pressure/tilt/pointerType straight
    // off the DOM event onto the tool pointer so stylus input reaches
    // draw tools (variable-width strokes, §13.12 Tier B). We read the
    // browser's values verbatim to preserve its semantics (mouse:
    // pressure 0 with no button, 0.5 while held; pen: physical
    // pressure). `??` guards only the synthetic-event case where a
    // field is absent — never overrides a real 0. NOTE: these ride
    // the event OBJECT, not the gesture SAB, which is a wasm-coupled
    // fixed-layout contract (see sab/gesture.ts + B-08 closure).
    const pointerType: "mouse" | "pen" | "touch" =
      e.pointerType === "pen" || e.pointerType === "touch"
        ? e.pointerType
        : "mouse";
    const built: CanvasPointerEvent = {
      pageId: containing ? containing[0] : null,
      pagePoint,
      docPoint: [docX, docY],
      modifiers: {
        shift: e.shiftKey,
        alt: e.altKey,
        cmd: e.metaKey,
        ctrl: e.ctrlKey,
      },
      maxDelta,
      button: e.button,
      target: e.target,
      pressure: e.pressure ?? 0.5,
      tiltX: e.tiltX ?? 0,
      tiltY: e.tiltY ?? 0,
      pointerType,
    };
    // Dev/test hook (B-08 spec). Headless Chromium can't synthesize a
    // physical-stylus pressure, so the Playwright spec asserts the
    // PLUMBING: it reads the last tool pointer the canvas built and
    // checks the new fields are present + typed. Dev builds only; the
    // page entry publishes it as `__canvasPointer`, as it does `__canvas`.
    if (!import.meta.env.PROD) setDebugHandle(scope, "pointer", built);
    return built;
  };

  // Resolve a DOM pointer event for the path-edit session: page-local
  // pt on the page the PATH sits on — not the page under the pointer,
  // which a drag is free to leave — plus the zoom its pixel tolerances
  // are measured at. Null when the session has no path on a page yet.
  const buildPathEditPointer = (
    e: React.PointerEvent<HTMLDivElement>,
  ): PathEditPointer | null => {
    const view = props.pathEdit?.getView();
    if (!view) return null;
    const pageRect = rects[props.pageIds.indexOf(view.pageId)];
    if (!pageRect) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const [docX, docY] = viewportToDoc(
      props.camera,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    const scale = props.camera.scale;
    return {
      point: [docX - pageRect.x, docY - pageRect.y],
      modifiers: {
        shift: e.shiftKey,
        alt: e.altKey,
        cmd: e.metaKey || e.ctrlKey,
      },
      ptPerPx: 1 / (scale > 0 ? scale : 1),
      timeStamp: e.timeStamp,
    };
  };

  // K-1 — deliver a pointer to the ACTIVE edit context in FRAME-CONTENT
  // coordinates. Returns true when the pointer was over the active frame
  // (consumed); false when there is no active context or the pointer is
  // outside its content box.
  // The active context's frame-content point under a client position, or
  // null when there is no active context or the point is outside its
  // content box. Shared by the pointer and wheel lanes.
  const activeContentPointAt = (
    target: HTMLDivElement,
    clientX: number,
    clientY: number,
  ): { content: [number, number]; elementId: string } | null => {
    const active = editContextStack?.active;
    if (!active) return null;
    const rect = target.getBoundingClientRect();
    const [docX, docY] = viewportToDoc(
      props.camera,
      clientX - rect.left,
      clientY - rect.top,
    );
    const containing = findContainingPage(rects, props.pageIds, docX, docY);
    if (!containing) return null;
    const [pageId, pageRect] = containing;
    const pageLocal: [number, number] = [docX - pageRect.x, docY - pageRect.y];
    // The active frame's geometry (bounds + itemTransform) carries the
    // page→content transform — same geometry the selection chrome reads.
    const rootKey = `${active.scopeRoot.kind}:${active.scopeRoot.id}`;
    const geom = (props.elementGeometry ?? []).find(
      (g) => g.pageId === pageId && `${g.id.kind}:${g.id.id}` === rootKey,
    );
    if (!geom) return null;
    const content = pageToContentPoint(geom, pageLocal);
    if (!content) return null; // outside the content box
    return {
      content,
      // Frame-like ElementIds carry a string `id` (the union also covers
      // story-range / table-cell addresses, which never enter a context).
      elementId:
        typeof active.scopeRoot.id === "string" ? active.scopeRoot.id : "",
    };
  };

  const dispatchContentPointer = (
    e: React.PointerEvent<HTMLDivElement>,
    phase: "down" | "move" | "up",
  ): boolean => {
    const contribution = editContextStack?.activeContribution;
    if (!contribution) return false;
    const at = activeContentPointAt(e.currentTarget, e.clientX, e.clientY);
    if (!at) return false;
    const ev: ContentPointerEvent = {
      contentPoint: at.content,
      elementId: at.elementId,
      modifiers: {
        shift: e.shiftKey,
        alt: e.altKey,
        cmd: e.metaKey,
        ctrl: e.ctrlKey,
      },
      button: e.button,
    };
    if (phase === "down") contribution.onContentPointerDown?.(ev);
    else if (phase === "move") contribution.onContentPointerMove?.(ev);
    else contribution.onContentPointerUp?.(ev);
    return true;
  };

  /** The legacy path's drag of the press that holds the pointer. */
  const currentDrag = (): DragState | null => pointerRef.current?.drag ?? null;
  /** The press's drag is over; the record (and its session) may go on. */
  const dropDrag = () => {
    const p = pointerRef.current;
    if (p) p.drag = null;
  };

  /** Open the session of the press that just began (`UXI-INV-001`: one
   *  owner per pointer sequence) and its record. Ended from outside, the
   *  session rolls the record back (`rollBackRecord`). */
  const openSession = (
    e: React.PointerEvent<HTMLDivElement>,
    route: PressRouteKind,
    spec: Omit<SessionSpec, "pointerId" | "pointerType" | "onAbort">,
  ): PointerRecord => {
    const prev = pointerRef.current;
    if (prev?.session) {
      rollBacksRef.current.delete(prev.session.id);
      interactions.end(prev.session, "abort", "superseded");
    }
    pointerRef.current = null;
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    const record: PointerRecord = {
      session: null,
      route,
      tool: null,
      handle: null,
      path: false,
      content: false,
      drag: null,
      pinch: null,
    };
    // The abort finds its roll-back by the session's id (the closure the
    // coordinator keeps holds nothing of the press itself).
    const s = interactions.begin({
      ...spec,
      pointerId,
      pointerType: e.pointerType,
      onAbort: (reason, session) => {
        const undo = rollBacksRef.current.get(session.id);
        rollBacksRef.current.delete(session.id);
        undo?.(reason);
      },
    });
    record.session = s;
    if (s)
      rollBacksRef.current.set(s.id, () =>
        abortHeld(record, target, pointerId),
      );
    pointerRef.current = record;
    return record;
  };

  // TRN-004 — the angle of a rotation, beside the pointer, while it turns:
  // written straight onto its element (no render per move).
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const showRotateReadout = (
    pivot: [number, number],
    from: [number, number],
    to: [number, number],
    shift: boolean,
    x: number,
    y: number,
  ) => {
    const el = readoutRef.current;
    if (!el) return;
    let deg =
      ((Math.atan2(to[1] - pivot[1], to[0] - pivot[0]) -
        Math.atan2(from[1] - pivot[1], from[0] - pivot[0])) *
        180) /
      Math.PI;
    deg = ((((deg + 180) % 360) + 360) % 360) - 180;
    if (shift) deg = Math.round(deg / 15) * 15;
    el.textContent = `${deg.toFixed(1)}°`;
    el.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    el.hidden = false;
  };
  const hideRotateReadout = () => {
    const el = readoutRef.current;
    if (el) el.hidden = true;
  };

  /** A press's session was ended from outside while it held the pointer:
   *  let the pointer go and roll the press back. */
  const abortHeld = (
    record: PointerRecord,
    target: HTMLDivElement,
    pointerId: number,
  ) => {
    if (pointerRef.current === record) {
      pointerRef.current = null;
      if (target.hasPointerCapture?.(pointerId))
        target.releasePointerCapture(pointerId);
    }
    rollBackRecord(record);
  };

  /** Move the session holding the pointer to `phase`. */
  const sessionTo = (phase: InteractionPhase) => {
    const s = pointerRef.current?.session;
    if (s && s.phase !== phase) interactions.transition(s, phase);
  };

  /** End the session holding the pointer, as its owner decided. */
  const closeSession = (result: EndResult, reason?: string) => {
    const p = pointerRef.current;
    pointerRef.current = null;
    const s = p?.session;
    if (!s) return;
    rollBacksRef.current.delete(s.id);
    interactions.end(s, result, reason);
  };

  /** The pointer was let go and the session's work goes on (a commit in
   *  flight): it stops holding the pointer, and `rollBack` now undoes
   *  that work. Returns the session, for `finishSession`. */
  const releaseSession = (
    rollBack: (reason: string) => void,
  ): InteractionSession | null => {
    const p = pointerRef.current;
    pointerRef.current = null;
    const s = p?.session;
    if (!s) return null;
    if (s.phase !== "previewing") interactions.transition(s, "previewing");
    interactions.transition(s, "committing");
    rollBacksRef.current.set(s.id, rollBack);
    return s;
  };

  /** End a released session once its work is done. */
  const finishSession = (
    s: InteractionSession | null | undefined,
    result: EndResult,
    reason?: string,
  ) => {
    if (!s || s.ended) return;
    rollBacksRef.current.delete(s.id);
    interactions.end(s, result, reason);
  };

  /** IC3 — a late answer is applied only while the epochs it was asked
   *  under hold (`UXI-OWN-008`, `UXI-ASY-002`): no newer press, no other
   *  document, no other context, its session not aborted. */
  const stillCurrent = (token: GuardToken): boolean =>
    interactions.confirm(token);

  /** What a press undoes when its session is ended from outside — a lost
   *  capture, Escape, a blur, a hidden page, a document or tool switch,
   *  unmount, a pinch taking over (INV-8): a tool's drag is cancelled by
   *  its handler, a bundle's handle drag writes nothing, path edit drops
   *  its gesture, a worker gesture is cancelled, a marquee is cleared. A
   *  pan has nothing to roll back; a content gesture just ends (the
   *  context keeps its state). */
  const rollBackRecord = (p: PointerRecord) => {
    hideRotateReadout();
    if (p.tool) {
      p.tool = null;
      props.toolGesture?.onCancel();
    }
    if (p.handle) {
      const router = p.handle.router;
      p.handle = null;
      router.cancel();
    }
    if (p.path) {
      p.path = false;
      props.pathEdit?.cancel();
    }
    p.content = false;
    if (p.route === "pinch") {
      p.pinch = null;
      touchesRef.current.clear();
    }
    const drag = p.drag;
    p.drag = null;
    if (!drag) return;
    if (drag.mode === "gesture" && drag.gestureState) {
      const handle = drag.gestureState.handle;
      if (handle !== null) {
        void props.client
          .cancelGesture(handle)
          .then(() => {
            setSnapLines([]);
            props.onGestureCommitted?.();
          })
          .catch(() => {});
      }
      // handle === null: begin hasn't resolved; the resolver sees the
      // drag gone and cancels the handle itself.
    } else if (drag.mode === "marquee") {
      setMarqueeRect(null);
    }
  };

  // Begin a worker gesture. Fire-and-forget — the handle returns
  // asynchronously; pointer moves that arrive before it does are
  // accumulated into `pendingDelta` and flushed on resolve. A pointer
  // that went up in the meantime (a fast drag) is committed then.
  const beginWorkerGesture = (
    gs: GestureState,
    anchor: GestureAnchor | null,
  ) => {
    void props.client
      .beginGesture(gs.target, gs.spec, anchor, gs.modifiers)
      .then((handle) => adoptHandle(gs, handle))
      .catch((err: unknown) => refusedBegin(gs, err));
  };

  /** The engine began `gs`'s gesture: drive it if its drag is still
   *  live, commit it if the pointer was let go past the threshold, else
   *  cancel it. */
  const adoptHandle = (gs: GestureState, handle: GestureHandle) => {
    {
      {
        const drag = currentDrag();
        const live = drag?.mode === "gesture" && drag.gestureState === gs;
        if (!live && gs.release !== "commit") {
          // A click, Escape or a lost pointer before the worker
          // confirmed; cancel immediately to keep worker state clean.
          void props.client.cancelGesture(handle).catch(() => {});
          return;
        }
        gs.handle = handle;
        const pending = gs.pendingDelta;
        if (gs.release === "commit") {
          const session = gs.session;
          void props.client
            .updateGesture(handle, pending, gs.modifiers, "json")
            .then(() => props.client.commitGesture(handle))
            .then(() => {
              setSnapLines([]);
              props.onGestureCommitted?.();
              finishSession(session, "commit");
            })
            .catch(() => finishSession(session, "abort", "commit failed"));
          return;
        }
        if (pending[0] !== 0 || pending[1] !== 0) {
          // Step 5e — SAB mode. The worker drains the SAB on its
          // next tick and posts a `gestureSnapLines` notify; the
          // subscription above routes it into `setSnapLines`.
          void props.client
            .updateGesture(handle, pending, gs.modifiers, "sab")
            .catch(() => {});
        }
      }
    }
  };

  /** The engine refused `gs`'s begin. */
  const refusedBegin = (gs: GestureState, err: unknown) => {
    const drag = currentDrag();
    const holding = drag !== null && drag.gestureState === gs;
    // The engine refused the begin (a locked item, a gesture it still
    // holds, a worker that failed): the drag ends here, with no mutation,
    // and never turns into a pan (`UXI-STATE-002`, the interaction
    // contract's IC2). What follows the press is inert until the pointer is
    // let go.
    const reason = gestureFailureReason(err);
    if (holding) {
      dropDrag();
      setSnapLines([]);
      closeSession("abort", reason);
    }
    finishSession(gs.session, "abort", reason);
  };

  const touchPoint = (
    e: React.PointerEvent<HTMLDivElement>,
  ): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  /** Is the pointer a pinch's (editor ADR 294)? */
  const pinching = (): boolean => pointerRef.current?.route === "pinch";

  /** Editor ADR 294 — a touch pointer's part in a pinch. True when the
   *  pinch took the event. The second finger takes over from whatever the
   *  first began (rolled back, never committed): the camera's claim
   *  preempts (`UXI-CAM-012`). */
  const pinchDown = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    if (e.pointerType !== "touch") return false;
    const touches = touchesRef.current;
    touches.set(e.pointerId, touchPoint(e));
    if (pinching()) return true;
    if (touches.size < 2) return false;
    const first = pointerRef.current?.session;
    if (first) interactions.cancel(first, "pinch");
    else abortActiveDrag();
    const [a, b] = [...touches.values()];
    const record = openSession(e, "pinch", {
      owner: "canvas-camera",
      kind: "pinch",
      preempt: true,
    });
    record.pinch = startPinch(props.camera, a!, b!);
    e.currentTarget.setPointerCapture(e.pointerId);
    return true;
  };

  const pinchMove = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    if (e.pointerType !== "touch") return false;
    const touches = touchesRef.current;
    if (!touches.has(e.pointerId)) return pinching();
    touches.set(e.pointerId, touchPoint(e));
    const pinch = pointerRef.current?.pinch;
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      props.onCameraChange(pinchCamera(pinch, a!, b!));
    }
    return pinching();
  };

  const pinchUp = (e: React.PointerEvent<HTMLDivElement>): boolean => {
    if (e.pointerType !== "touch") return false;
    const touches = touchesRef.current;
    touches.delete(e.pointerId);
    const p = pointerRef.current;
    if (p?.route !== "pinch") return false;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (touches.size < 2) p.pinch = null;
    if (touches.size === 0) closeSession("commit");
    return true;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (pinchDown(e)) return;
    const primary = e.button === 0;
    const tool = props.activeTool ?? "select";
    // K-1 — an edit context that OPTS INTO content pointers (has
    // `onContentPointerDown` — sheet's "sheet" context; NOT draw/web, whose
    // tools must keep working) takes a primary press over its frame, in
    // content coordinates; a press OUTSIDE the frame COMMITS the context
    // and goes on, so the same click can select what was under it. A tool
    // shared across contexts (Free Transform, the Pen, …) keeps its press.
    const contentContext =
      primary &&
      !props.toolSharedAcrossContexts &&
      editContextStack?.active &&
      editContextStack.activeContribution?.onContentPointerDown
        ? editContextStack
        : null;
    const overContent =
      contentContext !== null &&
      activeContentPointAt(e.currentTarget, e.clientX, e.clientY) !== null;
    // One way out of a context (editor ADR 1214): a press outside leaves
    // it; when the leaving asks (a dirty context), the question holds the
    // press.
    if (
      contentContext &&
      !overContent &&
      contentContext.leave("click-outside").outcome === "asking"
    )
      return;
    // The Type tool declares BOTH a gesture and a legacyKey: its DRAG
    // pulls out a text frame (the handler) and its CLICK places a caret
    // (the legacy text path) — two halves of one tool, so both are armed
    // and the release decides (a click falls through to the caret).
    const legacyAlso = Boolean(props.toolGesture && props.legacyKeyForTool);
    const cameraPress =
      e.button === 1 ||
      Boolean(props.forcePan) ||
      Boolean(props.zoomClick) ||
      (Boolean(props.touchPans) && e.pointerType === "touch");
    // Extensions ADR 1103 — a bundle's handle (a preset's adjust handle)
    // under a Selection-tool press: the router that accepts the press owns
    // the drag until the release.
    const handleRouter =
      primary &&
      tool === "select" &&
      !cameraPress &&
      !overContent &&
      !props.toolGesture
        ? (overlaySignals
            .handleRouters()
            .find((r) => r.down(buildToolPointer(e, 0))) ?? null)
        : null;
    // Path-edit mode — a primary Selection-tool press is the path's.
    const pathEditPointer =
      props.pathEdit &&
      primary &&
      tool === "select" &&
      !props.forcePan &&
      !props.zoomClick &&
      !handleRouter
        ? buildPathEditPointer(e)
        : null;
    // IC4 — the one arbitration decision (`UXI-OWN-001`; press-route.ts).
    const route = routePress({
      button: e.button,
      pointerType: e.pointerType,
      secondTouch: false,
      overContent,
      toolGesture: Boolean(props.toolGesture),
      legacyAlso,
      bundleHandle: handleRouter !== null,
      pathEdit: pathEditPointer !== null,
      forcePan: Boolean(props.forcePan),
      zoomClick: Boolean(props.zoomClick),
      touchPans: Boolean(props.touchPans),
      tool,
    });
    if (route.kind === "content") {
      e.currentTarget.setPointerCapture(e.pointerId);
      const record = openSession(e, "content", {
        owner: "frame-content",
        kind: "content",
      });
      record.content = true;
      dispatchContentPointer(e, "down");
      return;
    }
    if (route.kind === "tool" && props.toolGesture) {
      // Phase 2 — a handler-bearing tool (Rectangle, …): the legacy
      // select/text/pan path is skipped.
      e.currentTarget.setPointerCapture(e.pointerId);
      const toolId = props.toolGesture.toolId;
      const record = openSession(e, "tool", {
        owner: toolId ? ownerOfTool(toolId) : "canvas-draw",
        kind: "tool",
        ...(toolId ? { toolId } : {}),
        mutating: true,
      });
      record.tool = { startPointer: [e.clientX, e.clientY], maxDelta: 0 };
      props.toolGesture.onDown(buildToolPointer(e, 0));
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (route.kind === "bundle-handle" && handleRouter) {
      const record = openSession(e, "bundle-handle", {
        owner: "canvas-transform",
        kind: "bundle-handle",
        mutating: true,
      });
      record.handle = {
        router: handleRouter,
        startPointer: [e.clientX, e.clientY],
        maxDelta: 0,
      };
      return;
    }
    if (route.kind === "type" && props.toolGesture) {
      props.toolGesture.onDown(buildToolPointer(e, 0));
    }
    const modifiers: PointerModifiers = {
      shift: e.shiftKey,
      cmd: e.metaKey || e.ctrlKey,
    };
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [docX, docY] = viewportToDoc(props.camera, cx, cy);
    const containing = findContainingPage(rects, props.pageIds, docX, docY);
    // Phase B — middle-button always pans (the convention every
    // creative tool follows). With the select tool: if the pointer
    // landed inside a currently-selected element, start a Translate
    // gesture; otherwise fall through to marquee. Text tool stays
    // pan so the existing typing UX is undisturbed.
    let mode: DragState["mode"] = "pan";
    let press: PressState | undefined;
    let rotatePivot: [number, number] | null = null;
    let gestureState: GestureState | undefined;
    // Path-edit mode — a primary press is the path's. The session
    // takes it whatever it landed on (an empty press starts its
    // anchor marquee), so none of the element gestures below is even
    // considered: no frame translate, no element marquee, no pan. The
    // drag state is still armed, as a no-op "pan" that never receives
    // a move, because ONE outcome comes back to the code below — a
    // click on nothing falls through to the ordinary hit-test click
    // on release (the Type tool's dual-dispatch rule).
    if (route.kind === "path-edit" && props.pathEdit && pathEditPointer) {
      props.pathEdit.pointerDown(pathEditPointer);
    } else if (route.kind === "camera") {
      // Concept 1 — Hand (or a Space spring-load) pans on any drag;
      // the Zoom tool also pans on drag (its click action is handled
      // in onPointerUp's click branch).
      mode = "pan";
    } else if (tool === "select") {
      // Phase C/D/G — if the pointer landed on a handle (resize
      // handle or the rotation handle), begin the matching gesture
      // for the currently-selected element(s). Single-select uses
      // bounds-resize on corners (Phase C); multi-select corners
      // route to matrix Scale because per-element bounds resize
      // can't compose into a coherent union resize.
      const handleAttr = readHandleAttr(e.target);
      const selection = props.elementSelection ?? [];
      const geometry = props.elementGeometry ?? [];
      const selectedGeom = geometry.length === 1 ? geometry[0] : null;
      const isMultiSelect = geometry.length > 1;
      // Each item is hit in the space of the page it is drawn on, so a
      // press on the part of it past the page's edge — on the
      // pasteboard, or over the next page down — still lands on it.
      const bodyHit = !handleAttr
        ? findSelectedElementUnderPointer(selection, geometry, (pageId) => {
            const r = rects[props.pageIds.indexOf(pageId)];
            return r ? [docX - r.x, docY - r.y] : null;
          })
        : null;
      const bodyHitElement = bodyHit?.id ?? null;
      // The page a gesture's anchor speaks in: the one the selection's
      // chrome is drawn on, which is not always the page under the
      // pointer (a handle past the page's edge has none, or the next
      // page's).
      const gesturePage: PageId | null = handleAttr
        ? (readHandlePage(e.target) ??
          selectedGeom?.pageId ??
          geometry.find((g) => g.pageId)?.pageId ??
          null)
        : (bodyHit?.pageId ?? null);
      // Phase F / W2.10 — Cmd-drag on the body of a single-selected
      // image-bearing frame drives the content grabber: plain Cmd
      // translates the placed image, Cmd+Alt scales it, Cmd+Shift
      // rotates it (see the gestureSpec branch below). Plain
      // body-drag stays Translate; Cmd-drag on a resize handle stays
      // Scale (Phase D).
      const bodyHitIsImage =
        !handleAttr &&
        selectedGeom?.id.kind === "rectangle" &&
        selectedGeom?.hasImage === true;
      // Build gestureSpec + target list.
      let gestureSpec: GestureType | null = null;
      let targets: ElementId[] = [];
      let scaleBox: HandleBox | null = null;
      if (handleAttr === "rotate" && (selectedGeom || isMultiSelect)) {
        gestureSpec = { kind: "rotate" };
        targets = selectedGeom ? [selectedGeom.id] : selection.slice();
        // The angle readout turns about the selection's centre (TRN-004).
        const box = selectedGeom
          ? itemHandleBox(selectedGeom)
          : gesturePage
            ? unionHandleBox(geometry.filter((g) => g.pageId === gesturePage))
            : null;
        const pr = gesturePage
          ? rects[props.pageIds.indexOf(gesturePage)]
          : null;
        rotatePivot =
          box && pr ? [pr.x + box.centre[0], pr.y + box.centre[1]] : null;
      } else if (handleAttr && handleAttr !== "rotate") {
        if (isMultiSelect) {
          // Phase G — multi-select handle drag is always matrix
          // Scale (rotated or not). Holding Cmd still does Scale —
          // it's the only sensible per-element op for N>1.
          gestureSpec = { kind: "scale" };
          targets = selection.slice();
          scaleBox = gesturePage
            ? unionHandleBox(geometry.filter((g) => g.pageId === gesturePage))
            : null;
        } else if (selectedGeom) {
          // A group has no bounds of its own to resize: its box is
          // its members' union, so a handle drag scales the members
          // (as InDesign scales a group's contents).
          gestureSpec =
            modifiers.cmd || selectedGeom.id.kind === "group"
              ? { kind: "scale" }
              : { kind: "resize", handle: handleAttr };
          targets = [selectedGeom.id];
          if (gestureSpec.kind === "scale")
            scaleBox = itemHandleBox(selectedGeom);
        }
      } else if (bodyHitElement) {
        // Body drag. For multi-select, move ALL selected items
        // together; for single-select, just the one.
        if (isMultiSelect) {
          gestureSpec = { kind: "translate" };
          targets = selection.slice();
        } else if (modifiers.cmd && bodyHitIsImage) {
          // W2.10 — content-transform gestures ride the SAME content
          // grabber the Phase F TranslateContent uses. Cmd+drag on an
          // image body translates the placed image; layering a
          // modifier promotes it to a rotate/scale of the content,
          // about the frame centroid (the engine's RotateContent /
          // ScaleContent arms, which commit SetProperty{
          // ImageContentTransform} without touching the frame's own
          // bounds or ItemTransform):
          //   Cmd + Alt   → scaleContent
          //   Cmd + Shift → rotateContent (Shift also flows to
          //                 update_gesture, so the rotation snaps to
          //                 15° — the same Shift-constrain the frame
          //                 Rotate uses; an unconstrained content
          //                 rotate is a later affordance).
          // Alt wins over Shift when both are held so the choice is
          // deterministic. Shift stays the live constraint modifier
          // (never consumed here for translate), so plain Cmd+drag is
          // still a free TranslateContent.
          if (e.altKey) {
            gestureSpec = { kind: "scaleContent" };
          } else if (modifiers.shift) {
            gestureSpec = { kind: "rotateContent" };
          } else {
            gestureSpec = { kind: "translateContent" };
          }
          targets = [bodyHitElement];
        } else {
          gestureSpec = { kind: "translate" };
          targets = [bodyHitElement];
        }
      }
      const hit = gestureSpec ? (targets[0] ?? null) : null;
      if (hit && gestureSpec && targets.length > 0) {
        mode = "gesture";
        // Phase D — Rotate / Scale need an anchor (pointer position
        // at gesture start, page-local on the selection's page).
        // Translate / Resize don't need one but we send it anyway
        // for future use.
        const gestureRect = gesturePage
          ? rects[props.pageIds.indexOf(gesturePage)]
          : undefined;
        const anchorAt: [PageId, PageRect] | null =
          gesturePage && gestureRect ? [gesturePage, gestureRect] : containing;
        const anchor: GestureAnchor | null = anchorAt
          ? {
              pageId: anchorAt[0],
              pointInPage: [docX - anchorAt[1].x, docY - anchorAt[1].y],
            }
          : null;
        // The box was measured on `gesturePage`; the pivot is named there.
        const scale: HandleScale | null =
          gesturePage &&
          gestureRect &&
          scaleBox &&
          handleAttr &&
          handleAttr !== "rotate"
            ? {
                pageId: gesturePage,
                grabbed: scaleBox.at(handleAttr),
                opposite: scaleBox.at(OPPOSITE_HANDLE[handleAttr]),
                centre: scaleBox.centre,
                alt: e.altKey,
              }
            : null;
        gestureState = {
          handle: null,
          pendingDelta: [0, 0],
          target: targets,
          spec: gestureSpec,
          modifiers: { shift: e.shiftKey, alt: e.altKey },
          scale: scale ?? undefined,
          ...(rotatePivot ? { pivot: rotatePivot } : {}),
        };
        beginWorkerGesture(gestureState, scale ? scaleAnchor(scale) : anchor);
      } else if (containing && props.onHit && !modifiers.cmd) {
        // F-26 — a press OFF the selection: what is under it decides
        // the drag. On an item the drag selects it and moves it in one
        // gesture (InDesign, Illustrator, Figma); on empty space it
        // draws the marquee. Cmd keeps the marquee (a toggle-select).
        mode = "press";
        press = {
          pageId: containing[0],
          pagePoint: [docX - containing[1].x, docY - containing[1].y],
          hit: undefined,
          releaseDoc: null,
          alt: e.altKey,
          atomic: Boolean(props.pressAt) && !modifiers.shift,
        };
      } else {
        mode = "marquee";
      }
    }
    // D-01 — a marquee may start on the pasteboard: it is measured from
    // the nearest page, and its rectangle may leave that page (engine ADR
    // 1011, amendment 1).
    const anchorPage =
      containing ?? nearestPage(rects, props.pageIds, docX, docY);
    const marqueeAnchor =
      (mode === "marquee" || mode === "press") && anchorPage
        ? {
            pageId: anchorPage[0],
            pageX: docX - anchorPage[1].x,
            pageY: docY - anchorPage[1].y,
          }
        : null;
    const pathEditing = route.kind === "path-edit";
    const record = openSession(
      e,
      route.kind === "type" || pathEditing || route.kind === "camera"
        ? route.kind
        : "legacy",
      {
        owner: pathEditing
          ? "canvas-path"
          : legacyAlso
            ? "canvas-text"
            : mode === "gesture"
              ? "canvas-transform"
              : mode === "pan"
                ? tool === "text" && e.button === 0
                  ? "canvas-text"
                  : "canvas-camera"
                : "canvas-select",
        kind: pathEditing ? "path-edit" : mode,
        mutating: mode === "gesture" || pathEditing || legacyAlso,
        phase: mode === "press" ? "pending-hit" : "pressed",
        ...(props.toolGesture?.toolId
          ? { toolId: props.toolGesture.toolId }
          : {}),
      },
    );
    if (route.kind === "type") {
      record.tool = { startPointer: [e.clientX, e.clientY], maxDelta: 0 };
    }
    record.path = pathEditing;
    const drag: DragState = {
      mode,
      startCam: props.camera,
      startDoc: [docX, docY],
      startPointer: [e.clientX, e.clientY],
      maxDelta: 0,
      modifiers,
      marqueeAnchor,
      gestureState,
      press,
    };
    record.drag = drag;
    if (press?.atomic) beginPressAt(drag);
    else if (press) resolvePress(drag);
  };

  // IC5 — the press in one call (engine ADR 1303, `UXI-OWN-006`,
  // `UXI-OWN-007`, UXI-T58): the hit, the selection and the move begun
  // from the press point. Moves that come before the answer are kept; the
  // move starts where the pointer went down, never from where it was when
  // the answer came. A click only selects (the move is cancelled); a press
  // on nothing is a marquee; a refused press (a lock) is inert.
  const beginPressAt = (drag: DragState) => {
    const press = drag.press;
    const pressAt = props.pressAt;
    if (!press || !pressAt) return;
    const token = interactions.token(
      "press-hit",
      pointerRef.current?.session ?? null,
    );
    const modifiers = { shift: drag.modifiers.shift, alt: press.alt };
    void props.client
      .beginGestureAt({
        pageId: press.pageId,
        point: press.pagePoint,
        modifiers,
        select: "replace",
        target: pressAt.target,
      })
      .then((result) => {
        const cancel = () => {
          if (result.handle !== null)
            void props.client.cancelGesture(result.handle).catch(() => {});
        };
        if (!stillCurrent(token)) {
          // A newer press, another document or an aborted press (a pinch
          // took over): nothing of this one stands — its move is
          // cancelled and the selection it made in the engine is put back.
          cancel();
          if (result.selectionChanged)
            void props.client
              .setElementSelection(
                [...(props.elementSelection ?? [])],
                "replace",
              )
              .catch(() => {});
          finishSession(drag.pressSession, "abort", "stale press-hit");
          return;
        }
        if (!result.outOfScope)
          pressAt.onSelected(result, press.pageId, press.pagePoint);
        const live = currentDrag() === drag;
        if (result.handle === null) {
          // Nothing moves: on nothing the drag is a marquee; a press the
          // engine took but would not move (a lock) is inert.
          press.hit = result.marquee ? null : result.hit;
          if (!result.marquee) {
            if (live) {
              dropDrag();
              closeSession("abort", "begin refused");
            }
            finishSession(drag.pressSession, "abort", "begin refused");
            return;
          }
          if (press.releaseDoc) finishPress(drag);
          else if (live && drag.maxDelta > CLICK_DRAG_THRESHOLD_PX)
            startPressDrag(drag);
          return;
        }
        if (press.clicked || (!live && !press.releaseDoc)) {
          // A click: the press selected; nothing moves.
          cancel();
          return;
        }
        const end = press.releaseDoc ?? press.lastDoc ?? drag.startDoc;
        const gs: GestureState = {
          handle: null,
          pendingDelta: [end[0] - drag.startDoc[0], end[1] - drag.startDoc[1]],
          target: result.selection.slice(),
          spec: { kind: "translate" },
          modifiers,
          session: drag.pressSession ?? null,
        };
        drag.mode = "gesture";
        drag.gestureState = gs;
        if (press.releaseDoc) gs.release = "commit";
        else sessionTo("previewing");
        adoptHandle(gs, result.handle);
      })
      .catch((err: unknown) => {
        press.hit = null;
        const live = currentDrag() === drag;
        if (live) {
          dropDrag();
          closeSession("abort", gestureFailureReason(err));
        }
        finishSession(drag.pressSession, "abort", gestureFailureReason(err));
      });
  };

  // F-26 — the press's hit test. Fire-and-forget: the answer lands in
  // `press.hit`; a drag already past the threshold starts as soon as it
  // does, and one already released is finished then.
  const resolvePress = (drag: DragState) => {
    const press = drag.press;
    if (!press) return;
    const token = interactions.token(
      "press-hit",
      pointerRef.current?.session ?? null,
    );
    void props.client
      .send({
        kind: "hitTest",
        payload: {
          pageId: press.pageId,
          docPoint: press.pagePoint,
          filter: "any",
        },
      })
      .then((reply) => {
        press.hit =
          reply.kind === "hitResult" && reply.payload.element
            ? reply.payload
            : null;
      })
      .catch(() => {
        press.hit = null;
      })
      .then(() => {
        if (!stillCurrent(token)) {
          // A newer press, another document or an aborted session: this
          // press is over, whatever its hit was.
          finishSession(drag.pressSession, "abort", "stale press-hit");
          return;
        }
        const live = currentDrag() === drag;
        if (press.releaseDoc) finishPress(drag);
        else if (live && drag.maxDelta > CLICK_DRAG_THRESHOLD_PX)
          startPressDrag(drag);
      });
  };

  /** A press drag past the threshold whose hit is known: on an item,
   *  select it and translate the selection; on nothing, a marquee. */
  const startPressDrag = (drag: DragState, docDelta: Pt = [0, 0]) => {
    const press = drag.press;
    if (!press || press.hit === undefined || drag.mode !== "press") return;
    if (currentDrag() === drag) sessionTo("previewing");
    if (!press.hit) {
      drag.mode = "marquee";
      return;
    }
    const gs: GestureState = {
      handle: null,
      pendingDelta: docDelta,
      target: [],
      spec: { kind: "translate" },
      // Engine ADR 193, amendment 1 — the live Alt: an Alt press-drag on an
      // unselected item duplicates it, as one on a selected item does.
      modifiers: { shift: drag.modifiers.shift, alt: press.alt },
      session: drag.pressSession ?? null,
    };
    drag.mode = "gesture";
    drag.gestureState = gs;
    const anchor: GestureAnchor = {
      pageId: press.pageId,
      pointInPage: press.pagePoint,
    };
    void Promise.resolve(
      props.onHit?.(
        { pageId: press.pageId, docPoint: press.pagePoint, hit: press.hit },
        drag.modifiers,
      ),
    ).then((ids) => {
      if (!ids || ids.length === 0) {
        if (currentDrag() === drag) {
          // Nothing was selected to move: the drag ends (no pan fallback).
          dropDrag();
          closeSession("abort", "nothing to move");
        }
        finishSession(drag.pressSession, "commit");
        return;
      }
      gs.target = ids.slice();
      beginWorkerGesture(gs, anchor);
    });
  };

  /** A press released past the threshold before its hit test answered:
   *  do now what the drag would have done. */
  const finishPress = (drag: DragState) => {
    const press = drag.press;
    const end = press?.releaseDoc;
    if (!press || !end || press.hit === undefined) return;
    if (press.hit) {
      startPressDrag(drag, [
        end[0] - drag.startDoc[0],
        end[1] - drag.startDoc[1],
      ]);
      if (drag.gestureState) drag.gestureState.release = "commit";
      return;
    }
    // Nothing under the press: the released drag was a marquee.
    finishSession(drag.pressSession, "commit");
    const anchor = drag.marqueeAnchor;
    const pageRect = anchor
      ? rects[props.pageIds.indexOf(anchor.pageId)]
      : null;
    if (!anchor || !pageRect || !props.onMarquee) return;
    const x = end[0] - pageRect.x;
    const y = end[1] - pageRect.y;
    props.onMarquee(
      anchor.pageId,
      [
        Math.min(anchor.pageY, y),
        Math.min(anchor.pageX, x),
        Math.max(anchor.pageY, y),
        Math.max(anchor.pageX, x),
      ],
      drag.modifiers,
      marqueeMode(anchor.pageX, x),
    );
  };

  // WP4.5 — publish where the pointer is (the Info panel's cursor X/Y and
  // colour sample). Every move, whatever owns the drag.
  const publishPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const [docX, docY] = viewportToDoc(
      props.camera,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    const containing = findContainingPage(rects, props.pageIds, docX, docY);
    pointerStore.set({
      pageId: containing ? containing[0] : null,
      pagePoint: containing
        ? [docX - containing[1].x, docY - containing[1].y]
        : null,
      docPoint: [docX, docY],
    });
  };
  const onPointerLeave = () => pointerStore.set(null);

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    publishPointer(e);
    if (pinchMove(e)) return;
    // The route the press took owns its moves (IC4): a content gesture
    // (content coords), a tool's drag, a bundle's handle, path edit, then
    // the legacy drag.
    const held = pointerRef.current;
    if (held?.content) {
      dispatchContentPointer(e, "move");
      return;
    }
    // Phase 2 — route to the active tool handler while it owns the drag.
    const toolDrag = held?.tool ?? null;
    if (toolDrag && props.toolGesture) {
      growDelta(toolDrag, e.clientX, e.clientY);
      if (toolDrag.maxDelta > CLICK_DRAG_THRESHOLD_PX) sessionTo("previewing");
      props.toolGesture.onMove(buildToolPointer(e, toolDrag.maxDelta));
      return;
    }
    // ADR 1103 — a bundle's handle drag.
    const handleDrag = held?.handle ?? null;
    if (handleDrag) {
      growDelta(handleDrag, e.clientX, e.clientY);
      if (handleDrag.maxDelta > CLICK_DRAG_THRESHOLD_PX)
        sessionTo("previewing");
      handleDrag.router.move(buildToolPointer(e, handleDrag.maxDelta));
      return;
    }
    // Path-edit mode — the session owns this drag.
    if (held?.path) {
      const pointer = buildPathEditPointer(e);
      if (pointer) props.pathEdit?.pointerMove(pointer);
      return;
    }
    const drag = held?.drag ?? null;
    if (!drag) {
      // plugin-draw D2 — forward HOVER moves to the active handler
      // too (the Pen's rubber band tracks them between clicks).
      // Every handler guards its drag state, so hover moves are
      // inert for drag-only tools; maxDelta 0 keeps click-vs-drag
      // semantics intact.
      if (props.toolGesture) {
        props.toolGesture.onMove(buildToolPointer(e, 0));
      }
      // Concept 1 (Phase 3) — no drag in flight: let the active
      // handler refine the cursor per pointer position (Pen near an
      // anchor ≠ Pen over empty canvas). Imperative style write so a
      // hover doesn't re-render the canvas.
      const hover = props.toolGesture?.hoverCursor;
      if (hover) {
        const refined = hover(buildToolPointer(e, 0));
        const el = wrapperRef.current;
        if (el) el.style.cursor = refined ?? props.cursor ?? "grab";
      } else if ((props.activeTool ?? "select") === "select") {
        // ADR 1103 — over a bundle's handle the Selection tool shows the
        // handle's cursor (the pointer is the default).
        const routers = overlaySignals.handleRouters();
        const el = wrapperRef.current;
        if (el && (routers.length > 0 || el.dataset.handleCursor)) {
          const p = buildToolPointer(e, 0);
          const over = routers
            .map((r) => r.hit(p.pageId, p.pagePoint))
            .find((h) => h !== null);
          if (over) {
            el.style.cursor = over.cursor
              ? resolveCursorCss(over.cursor)
              : "pointer";
            el.dataset.handleCursor = "1";
          } else if (el.dataset.handleCursor) {
            el.style.cursor = props.cursor ?? "grab";
            delete el.dataset.handleCursor;
          }
        }
      }
      return;
    }
    const dx = e.clientX - drag.startPointer[0];
    const dy = e.clientY - drag.startPointer[1];
    growDelta(drag, e.clientX, e.clientY);
    if (drag.maxDelta > CLICK_DRAG_THRESHOLD_PX && drag.mode !== "press")
      sessionTo("previewing");
    if (drag.mode === "press" && drag.press) {
      drag.press.alt = e.altKey;
      // The press's answer may be out: keep where the pointer is.
      const rect = e.currentTarget.getBoundingClientRect();
      drag.press.lastDoc = viewportToDoc(
        props.camera,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    }
    if (
      drag.mode === "press" &&
      drag.maxDelta > CLICK_DRAG_THRESHOLD_PX &&
      drag.press?.hit !== undefined
    ) {
      // The hit test has answered: become the move or the marquee.
      const rect = e.currentTarget.getBoundingClientRect();
      const [docX, docY] = viewportToDoc(
        props.camera,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      startPressDrag(drag, [docX - drag.startDoc[0], docY - drag.startDoc[1]]);
    }
    // CameraNavigationAdapter (IC4) — a spring-loaded Hand taken while a
    // press or a marquee is under way (nothing has changed yet: D-09 holds
    // the Hand back only from a document-changing drag) turns the rest of
    // the drag into a pan from here; the selection's session ends.
    if (
      props.forcePan &&
      (drag.mode === "marquee" || drag.mode === "press") &&
      !held?.path
    ) {
      setMarqueeRect(null);
      closeSession("cancel", "spring-load");
      const record = openSession(e, "camera", {
        owner: "canvas-camera",
        kind: "pan",
      });
      record.drag = {
        ...drag,
        mode: "pan",
        startCam: props.camera,
        startPointer: [e.clientX, e.clientY],
        maxDelta: CLICK_DRAG_THRESHOLD_PX + 1,
        marqueeAnchor: null,
        press: undefined,
      };
      return;
    }
    if (drag.mode === "pan") {
      props.onCameraChange({
        scale: drag.startCam.scale,
        tx: drag.startCam.tx + dx,
        ty: drag.startCam.ty + dy,
      });
    } else if (drag.mode === "gesture") {
      if (drag.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      // Re-derive the doc-space delta from the original anchor so
      // the gesture stays correct even if the user panned mid-drag.
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const [docX, docY] = viewportToDoc(props.camera, cx, cy);
      const docDelta: [number, number] = [
        docX - drag.startDoc[0],
        docY - drag.startDoc[1],
      ];
      const gs = drag.gestureState;
      if (!gs) return;
      if (gs.pivot) {
        showRotateReadout(
          gs.pivot,
          drag.startDoc,
          [docX, docY],
          e.shiftKey,
          cx,
          cy,
        );
      }
      // Plan-2 §8.4 — Ctrl bypasses snap. Read `e.ctrlKey`
      // independently of `metaKey`; on macOS the Ctrl key is its own
      // thing (not Cmd), matching InDesign's "hold Ctrl to ignore
      // snap targets" convention.
      gs.modifiers = {
        shift: e.shiftKey,
        alt: e.altKey,
        disableSnap: e.ctrlKey,
      };
      if (gs.scale && gs.handle !== null && e.altKey !== gs.scale.alt) {
        // Alt/Option moves the pivot between the opposite handle and
        // the centre. The engine fixes the pivot when the gesture
        // begins, so the drag is begun again about the other one; the
        // restarted gesture replays the whole delta, as one undo step.
        gs.scale.alt = e.altKey;
        const stale = gs.handle;
        gs.handle = null;
        gs.pendingDelta = docDelta;
        void props.client.cancelGesture(stale).catch(() => {});
        beginWorkerGesture(gs, scaleAnchor(gs.scale));
        return;
      }
      if (gs.handle === null) {
        // Begin hasn't resolved yet — buffer the delta; the
        // resolver flushes it once the handle lands.
        gs.pendingDelta = docDelta;
      } else {
        // Step 5e — SAB hot path. Fire-and-forget; the worker drains
        // the SAB at ~125 Hz and emits `gestureSnapLines` notifies
        // so the overlay still sees active guides. Falls back to
        // JSON automatically when crossOriginIsolated is false.
        void props.client
          .updateGesture(gs.handle, docDelta, gs.modifiers, "sab")
          .catch(() => {});
      }
    } else if (drag.mode === "marquee") {
      if (drag.maxDelta <= CLICK_DRAG_THRESHOLD_PX) return;
      const anchor = drag.marqueeAnchor;
      if (!anchor) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const [docX, docY] = viewportToDoc(props.camera, cx, cy);
      // Measured from the anchor's page; it may leave the page, across the
      // spread's pages and the pasteboard (D-01).
      const pageRect = rects[props.pageIds.indexOf(anchor.pageId)];
      if (!pageRect) return;
      const currentX = docX - pageRect.x;
      const currentY = docY - pageRect.y;
      setMarqueeRect({
        pageId: anchor.pageId,
        rect: [
          Math.min(anchor.pageY, currentY),
          Math.min(anchor.pageX, currentX),
          Math.max(anchor.pageY, currentY),
          Math.max(anchor.pageX, currentX),
        ],
        mode: marqueeMode(anchor.pageX, currentX),
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    hideRotateReadout();
    if (pinchUp(e)) return;
    const held = pointerRef.current;
    // K-1 — end a content gesture: deliver the up to the active context
    // and stop (don't run the tool/click path that would re-select).
    if (held?.content) {
      held.content = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      dispatchContentPointer(e, "up");
      closeSession("commit");
      return;
    }
    // Phase 2 — commit the active tool handler's gesture.
    const toolDrag = held?.tool ?? null;
    if (held && toolDrag && props.toolGesture) {
      held.tool = null;
      const wasClick = toolDrag.maxDelta <= CLICK_DRAG_THRESHOLD_PX;
      const legacyAlso = Boolean(props.legacyKeyForTool);
      props.toolGesture.onUp(buildToolPointer(e, toolDrag.maxDelta));
      // A dual tool's CLICK belongs to the legacy path (caret, click
      // run, word/line granularity). Its handler has just been told
      // the pointer went up, so it has cancelled itself, and the drag
      // state armed at pointer-down is still there to fall through on.
      if (!(wasClick && legacyAlso)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
        // A dual tool's DRAG belonged to the handler, but pointer-down
        // armed the legacy drag state too (as a "pan", for the click
        // it might have been). Left armed, every later button-less
        // move panned the view until the next press (ED-3).
        dropDrag();
        closeSession("commit");
        return;
      }
    }
    // ADR 1103 — the release of a bundle's handle drag: the bundle
    // writes its change (one undo step); nothing else runs.
    const handleDrag = held?.handle ?? null;
    if (held && handleDrag) {
      held.handle = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      handleDrag.router.up(buildToolPointer(e, handleDrag.maxDelta));
      closeSession("commit");
      return;
    }
    // Path-edit mode — hand the release to the session. Whatever it
    // did with the gesture (moved anchors, selected some, inserted
    // one) ends here; only a click on NOTHING is not its business,
    // and that one runs the ordinary click below.
    if (held?.path) {
      held.path = false;
      const pointer = buildPathEditPointer(e);
      const release =
        pointer && props.pathEdit
          ? props.pathEdit.pointerUp(pointer)
          : "consumed";
      pathEditConsumedRef.current = release === "consumed";
      if (release === "consumed") {
        if (currentDrag()) {
          e.currentTarget.releasePointerCapture(e.pointerId);
          dropDrag();
        }
        closeSession("commit");
        return;
      }
    } else {
      pathEditConsumedRef.current = false;
    }
    const drag = currentDrag();
    if (!drag) {
      closeSession("commit");
      return;
    }
    e.currentTarget.releasePointerCapture(e.pointerId);
    dropDrag();
    // Modifier state can change between down and up (user lifts
    // Shift before releasing). Take whichever was held at either
    // edge — matches industry convention.
    const modifiers: PointerModifiers = {
      shift: drag.modifiers.shift || e.shiftKey,
      cmd: drag.modifiers.cmd || e.metaKey || e.ctrlKey,
    };
    // Click vs drag: if the pointer barely moved, treat it as a
    // click and route through the worker's hit-tester. If a
    // gesture was started at pointerdown (and never moved past the
    // threshold), cancel it so the worker doesn't hold a stale
    // handle.
    if (drag.maxDelta <= CLICK_DRAG_THRESHOLD_PX) {
      // A click: the press settles; what it selects is answered later.
      if (drag.press) drag.press.clicked = true;
      closeSession("commit");
      setMarqueeRect(null);
      if (drag.mode === "gesture" && drag.gestureState) {
        const stale = drag.gestureState.handle;
        if (stale !== null) {
          void props.client.cancelGesture(stale).catch(() => {});
        }
      }
      // Concept 1 — Zoom tool: a click zooms in around the pointer
      // (Alt-click zooms out) instead of hit-testing.
      if (props.zoomClick) {
        const rect = e.currentTarget.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.altKey ? 1 / 1.25 : 1.25;
        // About the clicked point; the same formula at any view rotation.
        // One zoom range for every input (ADR 1211): the camera context's.
        props.onCameraChange(zoomAt(props.camera, cx, cy, factor));
        return;
      }
      // GT-5 — the Hand (and its Space spring-load) only pans: a click
      // with it selects nothing, as in InDesign.
      if (props.forcePan) return;
      if (!props.onHit) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // W2.11 — multi-click granularity (SEL-05). Track the click
      // run so the 2nd consecutive click on the same point selects a
      // word and the 3rd selects the line. Native `detail` is
      // unreliable for the 3rd click, so we count ourselves.
      const clickCount = bumpClickRun(clickRunRef.current, cx, cy, e.timeStamp);
      const isText = (props.activeTool ?? "select") === "text";
      const [docX, docY] = viewportToDoc(props.camera, cx, cy);
      const containing = findContainingPage(rects, props.pageIds, docX, docY);
      if (containing) {
        const [pageId, pageRect] = containing;
        const docPoint: [number, number] = [
          docX - pageRect.x,
          docY - pageRect.y,
        ];
        const filter = isText ? "text" : "any";
        // IC3 — the click's answer applies only if no newer press, document
        // or context came first (UXI-T57, UXI-T59).
        const token = interactions.token("hit-test");
        // A promise chain, not a try: the compiler does not lower
        // conditionals inside a try (ADR 229).
        const resolveHit = async () => {
          const reply = await props.client.send({
            kind: "hitTest",
            payload: { pageId, docPoint, filter },
          });
          if (!stillCurrent(token)) return;
          if (reply.kind !== "hitResult") return;
          const hit = reply.payload;
          // C-4 — owned-content interception: a Type-tool click on
          // a metadata-claimed frame (a lowered sheet table, a web
          // frame) enters the OWNING plugin's modal context instead
          // of raw text editing — manual edits must not corrupt
          // content a plugin compiles. Object-type lane only; an
          // empty objectType registry early-outs, so documents
          // without plugins pay nothing.
          if (isText && hit.element) {
            if (!stillCurrent(token)) return;
            const owned = await tryEnterOwnedContent({
              element: hit.element,
              groupChain: [],
              // W-19 — the click is the entering point.
              pageId,
              pagePoint: docPoint,
            });
            if (owned) return;
          }
          // Text tool, 2nd/3rd click on a story offset → granular
          // selection (word / line) instead of placing a caret.
          if (
            isText &&
            clickCount >= 2 &&
            hit.storyId &&
            hit.offsetWithinStory != null
          ) {
            await applyTextGranularity(
              props.client,
              hit.storyId,
              hit.offsetWithinStory,
              clickCount,
              (sel) => {
                if (stillCurrent(token)) setContentSelection(sel);
              },
            );
            return;
          }
          if (!stillCurrent(token)) return;
          props.onHit?.({ pageId, docPoint, hit }, modifiers);
        };
        void resolveHit().catch((err: unknown) => {
          console.warn("hitTest failed:", err);
        });
      } else {
        props.onHit?.(null, modifiers);
      }
      return;
    }
    // Drag committed. Pan needs no commit work; marquee hands the
    // final rect to the caller; gesture commits via the worker.
    if (drag.mode === "press" && drag.press) {
      // Released before the press's hit test answered: finish it then.
      const rect = e.currentTarget.getBoundingClientRect();
      drag.press.alt = e.altKey;
      drag.press.releaseDoc = viewportToDoc(
        props.camera,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      drag.pressSession = releaseSession(() => {
        drag.press = undefined;
        const gs = drag.gestureState;
        if (!gs) return;
        gs.release = undefined;
        if (gs.handle !== null) {
          void props.client.cancelGesture(gs.handle).catch(() => {});
        }
      });
      finishPress(drag);
    } else if (drag.mode === "marquee") {
      if (marqueeRect && props.onMarquee) {
        props.onMarquee(
          marqueeRect.pageId,
          marqueeRect.rect,
          modifiers,
          marqueeRect.mode,
        );
      }
      setMarqueeRect(null);
      closeSession("commit");
    } else if (drag.mode === "gesture" && drag.gestureState) {
      const gs = drag.gestureState;
      const handle = gs.handle;
      // The pointer is let go; the commit is still to land. Ended from
      // outside before it does, the gesture is cancelled instead.
      gs.session = releaseSession(() => {
        gs.release = undefined;
        if (gs.handle !== null) {
          void props.client.cancelGesture(gs.handle).catch(() => {});
        }
      });
      if (handle === null) {
        // Begin hasn't resolved (a fast drag, or one Alt re-began):
        // the resolver commits once the handle lands.
        gs.release = "commit";
      } else {
        const session = gs.session;
        void props.client
          .commitGesture(handle)
          .then(() => {
            setSnapLines([]);
            props.onGestureCommitted?.();
            finishSession(session, "commit");
          })
          .catch(() => finishSession(session, "abort", "commit failed"));
      }
    } else {
      closeSession("commit");
    }
  };

  // GSM-07 / INV-8 — abort the in-flight drag WITHOUT committing.
  // Pointer-capture loss (`pointercancel`) and window blur both land
  // here: the plan requires every begin to reach commit OR abort, and
  // an interrupted gesture must roll back (zero mutation), never commit
  // a phantom op. The pointer-UP path commits; this is the abort twin.
  // Covers all three drag owners: a handler-bearing tool drag (the
  // spine — cancelled via its Escape-equivalent), the legacy worker
  // gesture (cancel the handle), and a marquee (drop the rect). A pan
  // has nothing to roll back.
  const abortActiveDrag = () => {
    const p = pointerRef.current;
    if (!p) return;
    pointerRef.current = null;
    if (p.session) {
      rollBacksRef.current.delete(p.session.id);
      interactions.end(p.session, "abort", "aborted");
    }
    rollBackRecord(p);
  };

  // The interaction contract (IC2, §7.2, §12.1 case 3): Escape cancels
  // the canvas's own session that holds the pointer — a move, a handle
  // drag, a marquee or a press still waiting for its hit — and the rest of
  // the drag does nothing: it never turns into a pan. A registered tool's
  // drag is cancelled by its handler (the gesture spine hears the key);
  // the canvas only lets go of it. A pan, a content gesture and path edit
  // keep their own Escape.
  const escapeSession = () => {
    const held = pointerRef.current;
    const s = held?.session;
    if (!held || !s) return;
    if (s.kind === "tool") {
      // The tool's handler cancels its drag (its Escape), and the canvas
      // lets go of the pointer.
      held.tool = null;
      props.toolGesture?.onCancel();
      closeSession("cancel", "escape");
      return;
    }
    if (
      s.kind === "press" ||
      s.kind === "marquee" ||
      s.kind === "gesture" ||
      s.kind === "bundle-handle"
    ) {
      interactions.cancel(s, "escape", "cancel");
    }
  };

  // A lost pointer capture ends the session that held it (§7.2,
  // `UXI-INV-014`): an element that took the capture, a browser that
  // dropped it. Not a pinch's: a lifted finger hands the pinch on.
  const onLostPointerCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = pointerRef.current?.session;
    if (!s || s.kind === "pinch" || s.pointerId !== e.pointerId) return;
    interactions.cancel(s, "capture-lost");
  };

  // GSM-07 / INV-8 — pointer-capture loss (`pointercancel`: capture
  // stolen, touch cancelled, element removed mid-drag). The browser has
  // already released capture, so unlike pointer-up we don't release it
  // here; we just roll the gesture back. Previously this aliased
  // `onPointerUp`, which COMMITTED the interrupted gesture — a phantom
  // mutation. Now it aborts (the plan's pointercancel → abort).
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pinchUp(e)) return;
    // K-1 — a cancelled content gesture just ends (the context keeps its
    // state; no tool drag to abort).
    const held = pointerRef.current;
    if (held?.content) {
      held.content = false;
      closeSession("abort", "pointercancel");
      return;
    }
    const s = held?.session;
    if (s) interactions.cancel(s, "pointercancel");
    else abortActiveDrag();
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // An active edit context that scrolls its own content (a sheet's
    // in-frame grid window) takes a plain wheel over its frame; the
    // canvas pans only when it declines. Cmd/Ctrl wheel stays zoom.
    const onContentWheel = editContextStack?.activeContribution?.onContentWheel;
    if (onContentWheel && !e.ctrlKey && !e.metaKey) {
      const at = activeContentPointAt(e.currentTarget, e.clientX, e.clientY);
      if (at) {
        const toPx =
          e.deltaMode === 1
            ? WHEEL_LINE_PX
            : e.deltaMode === 2
              ? rect.height
              : 1;
        const scale = props.camera.scale > 0 ? props.camera.scale : 1;
        const taken = onContentWheel({
          contentPoint: at.content,
          elementId: at.elementId,
          delta: [(e.deltaX * toPx) / scale, (e.deltaY * toPx) / scale],
          modifiers: {
            shift: e.shiftKey,
            alt: e.altKey,
            cmd: e.metaKey,
            ctrl: e.ctrlKey,
          },
        });
        if (taken) return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.005);
      props.onCameraChange(zoomAt(props.camera, cx, cy, factor));
    } else {
      // Shift+wheel is the horizontal scroll (F-33): a mouse wheel reports
      // only deltaY, so with Shift held and no deltaX of its own the
      // vertical delta pans sideways. A device that already sends deltaX
      // (a trackpad, macOS's own Shift mapping) keeps its deltas.
      const sideways = e.shiftKey && e.deltaX === 0;
      const dx = sideways ? e.deltaY : e.deltaX;
      const dy = sideways ? 0 : e.deltaY;
      props.onCameraChange({
        scale: props.camera.scale,
        tx: props.camera.tx - dx,
        ty: props.camera.ty - dy,
      });
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Path-edit mode — a double-click whose second click the session
    // took (on an anchor it converts corner ↔ smooth) is not ALSO a
    // request to enter whatever lies under that anchor.
    if (props.pathEdit && pathEditConsumedRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const [docX, docY] = viewportToDoc(props.camera, cx, cy);
    const containing = findContainingPage(rects, props.pageIds, docX, docY);
    if (!containing) return;
    const [pageId, pageRect] = containing;
    const pagePoint: [number, number] = [docX - pageRect.x, docY - pageRect.y];
    // W2.11 — with the Type tool, double-/triple-click is text
    // granularity (handled in onPointerUp's click branch); skip the
    // group-descent path so the two don't fight over the same click.
    const typeTool = (props.activeTool ?? "select") === "text";
    // IC3 — the chain's answers apply only while no newer press, document
    // or context came first.
    const token = interactions.token("double-click");
    // IC4 — the ContentContextAdapter: the canvas's one double-click path
    // is the shell's (use-edit-context-entry.tsx).
    void enterByDoubleClick({
      pageId,
      pagePoint,
      typeTool,
      activeGroup,
      ...(props.onDoubleClickGroup
        ? { descend: props.onDoubleClickGroup }
        : {}),
      isCurrent: () => stillCurrent(token),
    }).catch((err: unknown) => {
      // Same fail-quiet approach as the click hitTest.
      console.warn("doubleClick hitTest failed:", err);
    });
  };

  // The effects that read the press record come after every handler
  // that changes it (the React Compiler reads the component in order).
  /** Does the press holding the pointer drive a worker gesture? */
  const holdsGesture = useEffectEvent(() =>
    Boolean(pointerRef.current?.drag?.gestureState),
  );

  // Step 5e — subscribe to out-of-band snap-line notifications. The
  // SAB-mode `updateGesture` path doesn't await a reply, so the worker
  // surfaces snap guides via an unsolicited `gestureSnapLines` after
  // each drain. Empty `snapLines` is meaningful (gesture left a
  // previously-snapped axis); the overlay clears stale guides on it.
  useEffect(() => {
    return props.client.subscribe((msg) => {
      if (msg.kind === "gestureSnapLines") {
        // OverlayRevisionAdapter (IC4): snap lines are the gesture's; a late
        // notify after the gesture ended draws nothing (`UXI-SNP-006`).
        const lines = msg.payload.snapLines;
        if (lines.length > 0 && !holdsGesture()) return;
        setSnapLines(lines);
      } else if (
        msg.kind === "warning" &&
        msg.payload.kind === "canvasNeeded"
      ) {
        transferredRef.current = false;
        setCanvasGeneration((g) => g + 1);
      }
    });
  }, [props.client, setSnapLines]);

  // Unmount ends the session the canvas holds (§7.2): its engine gesture
  // is cancelled, not left open for the next canvas to trip over.
  const cancelHeldSession = useEffectEvent(() => {
    const s = pointerRef.current?.session;
    if (s) interactions.cancel(s, "unmount");
  });
  useEffect(() => {
    return () => cancelHeldSession();
  }, []);

  // Escape on the canvas's own gesture is the Escape arbiter's gesture tier
  // (editor ADR 1207, §12.1 case 3): one press, one resolution — it never
  // also climbs a group or clears the selection. A pan, a content gesture
  // and path edit (its own transient handler) are not cancelled here.
  const arbiter = useEscapeArbiter();
  const escapeTakes = useEffectEvent(() => {
    const kind = pointerRef.current?.session?.kind;
    return (
      kind === "tool" ||
      kind === "press" ||
      kind === "marquee" ||
      kind === "gesture" ||
      kind === "bundle-handle"
    );
  });
  const escapeResolves = useEffectEvent(() => escapeSession());
  useEffect(() => {
    return arbiter.register({
      id: "paged.canvas.gesture",
      tier: "gesture",
      isActive: () => escapeTakes(),
      resolve: () => {
        escapeResolves();
      },
    });
  }, [arbiter]);

  return (
    <div
      ref={wrapperRef}
      // B-08 — the Playwright pressure/tilt plumbing spec targets this
      // host to dispatch a synthetic stylus pointer event and read
      // `__canvasPointer`.
      data-testid="viewport-canvas-host"
      // Phase 3 — the active tool's base cursor overrides the default
      // pan affordance; the gesture handler may refine it per position.
      style={
        props.cursor ? { ...wrapperStyle, cursor: props.cursor } : wrapperStyle
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
    >
      {/* data-paged-canvas: a stable selector for the document canvas (specs use it). */}
      <canvas
        key={canvasGeneration}
        ref={canvasRef}
        style={canvasStyle}
        data-paged-canvas=""
      />
      <OverlayHost
        camera={props.camera}
        pageIds={props.pageIds}
        pageRects={rects}
        width={hostSize.width}
        height={hostSize.height}
      />
      {/* Editor ADR 281 — a bundle's live editing surface over the
          active frame (extensions ADR 334). */}
      <FrameSurfaceHost
        camera={props.camera}
        pageIds={props.pageIds}
        pageRects={rects}
        elementGeometry={props.elementGeometry}
        hostRef={wrapperRef}
        hostSize={hostSize}
        passThrough={props.toolSharedAcrossContexts}
      />
      {/* F-36 — where typed and composed text arrives while a caret is
          in a story (ADR 234). */}
      <div
        ref={readoutRef}
        hidden
        data-rotate-readout=""
        aria-live="polite"
        style={rotateReadoutStyle}
      />
      <TextInputSurface
        camera={props.camera}
        pageIds={props.pageIds}
        pageRects={rects}
      />
      {/* F-21 — the developer readout (renderer, fps, cache, camera, frame
          ids) is a diagnostic: `?debug=hud` shows it. Users read zoom and
          page from the mode bar and the status bar. */}
      {debugFlag("hud") && (
        <ViewportHud
          camera={props.camera}
          pageCount={props.pageIds.length}
          pageIds={props.pageIds}
          pageRects={rects}
          selection={props.selection ?? null}
          fps={props.fps ?? 0}
          gpuActive={props.gpuActive ?? null}
          anchorCount={
            props.resolution
              ? Object.keys(props.resolution.numbering).length
              : 0
          }
          footnoteCount={props.resolution?.footnoteCount ?? 0}
          runningHeaders={props.resolution?.runningHeaders ?? []}
          layoutCacheStats={props.layoutCacheStats ?? null}
          viewportSize={[hostSize.width, hostSize.height]}
        />
      )}
    </div>
  );
}

/** The legacy path's drag: a pan, a marquee, a press waiting for its hit,
 *  or a worker gesture. */
interface DragState {
  /** `pan` is camera-translate; `marquee` is the element-selection rect
   *  drag; `gesture` is an in-flight worker gesture (translate, resize,
   *  …); `press` waits for its hit test. Click-vs-drag uses `maxDelta`. */
  mode: "pan" | "marquee" | "gesture" | "press";
  startCam: Camera;
  /** Anchor in doc-space pt (already camera-inverted) — used so the
   *  pointer→doc delta survives mid-gesture camera changes. */
  startDoc: [number, number];
  startPointer: [number, number];
  /** Largest pointer-delta seen during this gesture, in CSS px. */
  maxDelta: number;
  /** Modifier state captured at pointerdown. */
  modifiers: PointerModifiers;
  /** The marquee's anchor and page; `null` when the pointer started
   *  outside any page. */
  marqueeAnchor: {
    pageId: PageId;
    pageX: number;
    pageY: number;
  } | null;
  /** Gesture-mode bookkeeping. */
  gestureState?: GestureState;
  /** `press` mode: a Selection-tool press off the selection, waiting for
   *  its hit test to say whether the drag moves an item or draws a
   *  marquee. */
  press?: PressState;
  /** A press released before its hit test answered: its session, ended
   *  once the press is finished. */
  pressSession?: InteractionSession | null;
}

/** The press that holds the pointer (IC4): its session, the route it took
 *  (`routePress`), and what that route keeps. */
interface PointerRecord {
  session: InteractionSession | null;
  route: PressRouteKind;
  /** A registered tool's drag (the `tool` route, and the `type` route
   *  until its release). */
  tool: { startPointer: [number, number]; maxDelta: number } | null;
  /** A bundle's handle drag (extensions ADR 1103). */
  handle: {
    router: HostHandleRouter;
    startPointer: [number, number];
    maxDelta: number;
  } | null;
  /** Path edit owns the press until its release. */
  path: boolean;
  /** The active edit context's content gesture (K-1). */
  content: boolean;
  /** The legacy path's drag (and path edit's inert one). */
  drag: DragState | null;
  /** The pinch (editor ADR 294). */
  pinch: Pinch | null;
}

/** A worker gesture in flight (Phase B). `handle` is `null` until the
 *  worker confirms the begin. */
/** F-26 — a Selection-tool press off the selection, in the space of
 *  the page under it. */
interface PressState {
  pageId: PageId;
  pagePoint: [number, number];
  /** The hit test's answer: `undefined` while it is out, `null` for
   *  nothing (the drag is a marquee), the hit for an item (the drag
   *  selects and moves it). */
  hit: SelectionState["hit"] | null | undefined;
  /** Set when the pointer went up past the threshold before the hit
   *  test answered: the release point, document pt. */
  releaseDoc: [number, number] | null;
  /** Alt (Option) as the pointer last reported it. */
  alt: boolean;
  /** IC5 — the press asked the engine in one call (`pressAt`). */
  atomic?: boolean;
  /** The pointer's last document point while the answer was out. */
  lastDoc?: [number, number];
  /** Let go as a click before the answer: the press only selects. */
  clicked?: boolean;
}

interface GestureState {
  handle: GestureHandle | null;
  /** The released gesture's session, while its commit is in flight. */
  session?: InteractionSession | null;
  pendingDelta: [number, number];
  target: ElementId[];
  spec: GestureType;
  /** The latest pointer sample's modifiers. */
  modifiers: GestureModifiers;
  /** A handle drag that scales: the points its pivot can be. */
  scale?: HandleScale;
  /** The pointer went up before the begin was confirmed: commit when it is. */
  release?: "commit";
  /** A rotation: the centre it turns about, document pt (the readout). */
  pivot?: [number, number];
}

type Pt = [number, number];
type Affine = readonly [number, number, number, number, number, number];

/**
 * A handle drag that scales (a group, a multi-selection, Cmd on a
 * frame), in the space of the page its box is drawn on. The engine
 * scales each axis by the ratio of the pointer's and the anchor's
 * offsets from the pivot, about a pivot fixed when the gesture begins.
 * The anchor is the grabbed handle itself, so it follows the pointer
 * exactly; the pivot is the opposite handle, which stays put, or the
 * centre with Alt/Option — InDesign's rule. On a side handle the pivot
 * shares the anchor's other coordinate, so that axis scales by 1.
 */
interface HandleScale {
  pageId: PageId;
  grabbed: Pt;
  opposite: Pt;
  centre: Pt;
  alt: boolean;
}

function scaleAnchor(s: HandleScale): GestureAnchor {
  return {
    pageId: s.pageId,
    pointInPage: s.grabbed,
    pivotInPage: s.alt ? s.centre : s.opposite,
  };
}

const OPPOSITE_HANDLE: Record<ResizeHandle, ResizeHandle> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  northEast: "southWest",
  southWest: "northEast",
  northWest: "southEast",
  southEast: "northWest",
};

/** Where the handles sit on a box, page space — where the resize-handles
 *  overlay draws them. */
interface HandleBox {
  at(name: ResizeHandle): Pt;
  centre: Pt;
}

function handleBox(
  bounds: readonly number[],
  m: Affine | null | undefined,
): HandleBox {
  const [top, left, bottom, right] = bounds;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const local: Record<ResizeHandle, Pt> = {
    northWest: [left, top],
    north: [cx, top],
    northEast: [right, top],
    east: [right, cy],
    southEast: [right, bottom],
    south: [cx, bottom],
    southWest: [left, bottom],
    west: [left, cy],
  };
  const map = ([x, y]: Pt): Pt =>
    m ? [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] : [x, y];
  return { at: (name) => map(local[name]), centre: map([cx, cy]) };
}

/** A single item's oriented box. */
function itemHandleBox(g: ElementGeometryItem): HandleBox {
  return handleBox(g.bounds, g.itemTransform);
}

/** The union box of a multi-selection's items on one page. */
function unionHandleBox(
  items: readonly ElementGeometryItem[],
): HandleBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of items) {
    const box = itemHandleBox(g);
    for (const name of [
      "northWest",
      "northEast",
      "southEast",
      "southWest",
    ] as const) {
      const [x, y] = box.at(name);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return handleBox([minY, minX, maxY, maxX], null);
}

const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;

/** Advance the consecutive-click counter for SEL-05 granularity. A
 *  click within `MULTI_CLICK_MS` of, and `MULTI_CLICK_SLOP_PX` from,
 *  the previous one bumps the count (capped at 3 — triple-click is the
 *  coarsest granularity); otherwise it restarts at 1. Mutates and
 *  returns the new count. */
function bumpClickRun(
  run: { t: number; x: number; y: number; count: number },
  x: number,
  y: number,
  now: number,
): number {
  const near =
    Math.abs(x - run.x) <= MULTI_CLICK_SLOP_PX &&
    Math.abs(y - run.y) <= MULTI_CLICK_SLOP_PX;
  const inTime = now - run.t <= MULTI_CLICK_MS;
  run.count = near && inTime ? Math.min(3, run.count + 1) : 1;
  run.t = now;
  run.x = x;
  run.y = y;
  return run.count;
}

/**
 * W2.11 / SEL-05 — set a word (double-click) or paragraph (triple-click)
 * range selection on a story.
 *
 * Aftercare-A: protocol v31 added `requestWordBounds`, so double-click
 * selects the real UAX-29 WORD containing the offset (story-local byte
 * `[start, end)`); a double-click on a whitespace run selects that whole
 * whitespace run (the engine's segmentation contract).
 *
 * W2.9: protocol v35 added `requestParagraphBounds`, so triple-click now
 * selects the whole PARAGRAPH containing the offset — spanning every
 * wrapped line — instead of just the visual line. The span is story-local
 * bytes `[start, end)` (the inter-paragraph `\n` is the boundary and is
 * excluded), so typing replaces the paragraph. The `cell` qualifier (v35)
 * flows through so a triple-click inside a table cell selects THAT cell's
 * paragraph. If the engine can't resolve a paragraph (e.g. an unbuilt
 * story) we fall back to the line extent so triple-click still yields a
 * non-empty range. Every branch resolves a non-empty range, which is what
 * callers depend on (replace-on-type works).
 */
async function applyTextGranularity(
  client: CanvasClient,
  storyId: string,
  offset: number,
  clickCount: number,
  setContentSelection: (
    s: {
      storyId: string;
      start: number;
      end: number;
      cell?: TextCellAddr | null;
      affinity?: boolean;
    } | null,
  ) => void,
  cell: TextCellAddr | null = null,
): Promise<void> {
  try {
    if (clickCount >= 3) {
      // Triple-click → paragraph granularity (v35 paragraph-bounds wire).
      const para = await client.paragraphBounds(storyId, offset, cell);
      if (para) {
        setContentSelection({
          storyId,
          start: para.start,
          end: para.end,
          cell,
          affinity: false,
        });
        return;
      }
      // Fallback: paragraph unresolved → line extent (still non-empty).
      const bounds = await client.lineBounds(storyId, offset, cell);
      if (!bounds) return;
      setContentSelection({
        storyId,
        start: bounds.lineStart,
        end: bounds.lineEnd,
        cell,
        affinity: false,
      });
      return;
    }
    // Double-click → word granularity (UAX-29 segmentation).
    const word = await client.wordBounds(storyId, offset, cell);
    if (!word) return;
    setContentSelection({
      storyId,
      start: word.start,
      end: word.end,
      cell,
      affinity: false,
    });
  } catch {
    /* worker reload / disconnect — leave the selection put */
  }
}

function ViewportHud(props: {
  camera: Camera;
  pageCount: number;
  pageIds: ReadonlyArray<PageId>;
  pageRects: ReadonlyArray<PageRect>;
  selection: SelectionState | null;
  fps: number;
  gpuActive: boolean | null;
  anchorCount: number;
  footnoteCount: number;
  runningHeaders: ReadonlyArray<RunningHeader>;
  layoutCacheStats: LayoutCacheStats | null;
  /** The measured viewport, CSS px. */
  viewportSize: readonly [number, number];
}) {
  const sel = props.selection;
  const gpuBadge =
    props.gpuActive === null
      ? { label: "…", color: "var(--status-draft)" }
      : props.gpuActive
        ? { label: "GPU", color: "var(--status-approved)" }
        : { label: "CPU", color: "var(--status-review)" };
  const fpsColor =
    props.fps === 0
      ? "var(--status-draft)"
      : props.fps >= 55
        ? "var(--status-approved)"
        : props.fps >= 30
          ? "var(--status-review)"
          : "var(--status-error)";
  return (
    // data-viewport-hud: the films (tests/films) hide this readout by it.
    <div style={hudStyle} data-viewport-hud="">
      <span style={{ color: gpuBadge.color, fontWeight: 600 }}>
        {gpuBadge.label}
      </span>
      {props.fps > 0 && (
        <span style={{ color: fpsColor }}>{props.fps} fps</span>
      )}
      <span>{props.pageCount} pages</span>
      {props.layoutCacheStats &&
        props.layoutCacheStats.hits + props.layoutCacheStats.misses > 0 && (
          <CacheBadge stats={props.layoutCacheStats} />
        )}
      {props.anchorCount > 0 && (
        <span style={{ color: "var(--status-approved)" }}>
          {props.anchorCount} anchors
        </span>
      )}
      {props.footnoteCount > 0 && (
        <span style={{ color: "var(--status-progress)" }}>
          {props.footnoteCount} fn
        </span>
      )}
      {(() => {
        // The running header of the current page (the one shell rule,
        // `state/current-page.ts`) — a "where am I" anchor for long
        // documents.
        const currentIdx = Math.max(
          0,
          currentPageIndex(props.pageRects, props.camera, props.viewportSize),
        );
        const header = props.runningHeaders[currentIdx];
        if (header?.text) {
          const truncated =
            header.text.length > 24
              ? `${header.text.slice(0, 23)}…`
              : header.text;
          return (
            <span style={{ color: "var(--status-review)" }}>§ {truncated}</span>
          );
        }
        return null;
      })()}
      <span>{(props.camera.scale * 100).toFixed(0)}%</span>
      <span>
        {props.camera.tx.toFixed(0)}, {props.camera.ty.toFixed(0)}
      </span>
      {sel && (
        <span style={hudSelStyle}>
          {sel.hit.frameId
            ? `frame ${sel.hit.frameId}`
            : `page ${sel.pageId} (no frame)`}
        </span>
      )}
    </div>
  );
}

/**
 * Phase 4 Step 2 — visualise the per-paragraph layout cache win.
 *
 * Shows `hits/total` for the most recent mutation/undo/redo rebuild.
 * Green when ≥ 90% of paragraphs hit (typing-class edit), amber
 * 50-89% (style change or larger), red below 50% (cold or
 * thrashed cache).
 */
function CacheBadge(props: { stats: LayoutCacheStats }) {
  const total = props.stats.hits + props.stats.misses;
  if (total === 0) return null;
  const ratio = props.stats.hits / total;
  const color =
    ratio >= 0.9
      ? "var(--status-approved)"
      : ratio >= 0.5
        ? "var(--status-review)"
        : "var(--status-error)";
  const pct = Math.round(ratio * 100);
  const ms = props.stats.rebuildMs;
  // AC-E-1 budget — 32 ms per typed character. Green under, amber close,
  // red over.
  const msColor =
    ms <= 16
      ? "var(--status-approved)"
      : ms <= 32
        ? "var(--status-review)"
        : "var(--status-error)";
  return (
    <>
      <span
        style={{ color }}
        title={`layout cache: ${props.stats.hits} hits / ${props.stats.misses} misses (${props.stats.len} entries)`}
      >
        cache {pct}% ({props.stats.hits}/{total})
      </span>
      <span
        style={{ color: msColor }}
        title="last rebuild wall-clock; AC-E-1 budget = 32 ms"
      >
        {ms.toFixed(1)} ms
      </span>
    </>
  );
}

const wrapperStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
  background: "var(--canvas-surround)",
  cursor: "grab",
  touchAction: "none",
  userSelect: "none",
};

const rotateReadoutStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  padding: "2px 6px",
  borderRadius: 3,
  background: "var(--elevated)",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  pointerEvents: "none",
};

const canvasStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  display: "block",
};

// Floating UI per the design system: an elevated surface with a
// hairline border (theme-aware, so the status tokens keep contrast
// in BOTH themes — the old dark glass washed them out on light).
const hudStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 8,
  right: 8,
  display: "flex",
  gap: 12,
  background: "var(--elevated)",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  padding: "4px 10px",
  borderRadius: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  pointerEvents: "none",
};

const hudSelStyle: React.CSSProperties = {
  color: "var(--status-review)", // amber — highlights the click result
};

// Pure helpers of the pointer path (module scope: the component reads
// them before their place in its body, ADR 229).

/** A refused gesture begin, as a fixed diagnostic (the trace records no
 *  free text, `UXI-OBS-002`). */
function gestureFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  if (message.startsWith("canvas worker failed")) return "worker-failed";
  if (message.startsWith("beginGesture failed")) return "begin refused";
  return "begin failed";
}

/** The largest pointer travel of a press so far, CSS px (click vs drag):
 *  kept on the press's record, which the canvas's handlers share. */
function growDelta(
  t: { startPointer: [number, number]; maxDelta: number },
  x: number,
  y: number,
): void {
  const d = Math.hypot(x - t.startPointer[0], y - t.startPointer[1]);
  if (d > t.maxDelta) t.maxDelta = d;
}

/** D-01 (editor ADR 1201): a marquee drawn left to right takes what it
 *  wholly contains, right to left what it touches. */
function marqueeMode(fromX: number, toX: number): "contain" | "intersect" {
  return toX >= fromX ? "contain" : "intersect";
}

/** The page nearest a document point (a press on the pasteboard). */
function nearestPage(
  rects: ReadonlyArray<PageRect>,
  ids: ReadonlyArray<PageId>,
  docX: number,
  docY: number,
): [PageId, PageRect] | null {
  let best: [PageId, PageRect] | null = null;
  let bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    const dx = Math.max(r.x - docX, 0, docX - (r.x + r.w));
    const dy = Math.max(r.y - docY, 0, docY - (r.y + r.h));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = [ids[i]!, r];
    }
  }
  return best;
}

/** The first selected element whose ORIENTED box (its bounds through its
 *  item transform) holds the pointer, with the page it was hit on
 *  (`UXI-TRN-005`, IC7): the pointer is taken back into the item's own
 *  space and tested against its bounds, so the empty corners of a turned
 *  item's axis-aligned box are not its body. `pointerOn` gives the pointer
 *  in a page's local space. */
function findSelectedElementUnderPointer(
  selection: ReadonlyArray<ElementId>,
  geometry: ReadonlyArray<ElementGeometryItem>,
  pointerOn: (pageId: PageId) => [number, number] | null,
): { id: ElementId; pageId: PageId } | null {
  const inSel = new Set(selection.map((e) => `${e.kind}:${e.id}`));
  for (const g of geometry) {
    if (!g.pageId) continue;
    if (!inSel.has(`${g.id.kind}:${g.id.id}`)) continue;
    const pageLocal = pointerOn(g.pageId);
    if (!pageLocal) continue;
    const local = invertAffinePoint(g.itemTransform, pageLocal);
    if (!local) continue;
    const [top, left, bottom, right] = g.bounds;
    // Half a point of slack for the edge itself.
    const e = 0.5;
    if (
      local[0] >= Math.min(left, right) - e &&
      local[0] <= Math.max(left, right) + e &&
      local[1] >= Math.min(top, bottom) - e &&
      local[1] <= Math.max(top, bottom) + e
    ) {
      return { id: g.id, pageId: g.pageId };
    }
  }
  return null;
}

/** `p` taken back through the affine `m` (null for a singular one). */
function invertAffinePoint(
  m: [number, number, number, number, number, number] | null | undefined,
  p: [number, number],
): [number, number] | null {
  if (!m) return p;
  const [a, b, c, d, tx, ty] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const x = p[0] - tx;
  const y = p[1] - ty;
  return [(d * x - c * y) / det, (-b * x + a * y) / det];
}

/** Phase C/D — read the `data-handle` attribute from a pointer
 * event target. Returns the matching `ResizeHandle`, `"rotate"`
 * for the Phase D rotation handle, or `null`. The Overlay tags
 * both the visible handle and a larger hit-area rect with the same
 * attribute, so a pointerdown anywhere in the grab zone fires
 * this branch. */
function readHandleAttr(
  target: EventTarget | null,
): ResizeHandle | "rotate" | null {
  if (!(target instanceof Element)) return null;
  const v = target.getAttribute("data-handle");
  if (!v) return null;
  if (
    v === "north" ||
    v === "south" ||
    v === "east" ||
    v === "west" ||
    v === "northEast" ||
    v === "northWest" ||
    v === "southEast" ||
    v === "southWest" ||
    v === "rotate"
  ) {
    return v;
  }
  return null;
}

/** The page a handle's box is drawn in (`data-handle-page`, on the
 * handle's group). */
function readHandlePage(target: EventTarget | null): PageId | null {
  if (!(target instanceof Element)) return null;
  return (
    target.closest("[data-handle-page]")?.getAttribute("data-handle-page") ??
    null
  );
}

function findContainingPage(
  rects: ReadonlyArray<PageRect>,
  ids: ReadonlyArray<PageId>,
  docX: number,
  docY: number,
): [PageId, PageRect] | null {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (docX >= r.x && docX <= r.x + r.w && docY >= r.y && docY <= r.y + r.h) {
      return [ids[i], r];
    }
  }
  return null;
}
