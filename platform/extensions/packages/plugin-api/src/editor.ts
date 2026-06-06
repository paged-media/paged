// The hand-written editor contract (M1.1(a), decision 2026-06-06).
//
// Until this pass, these types were re-exports from the private
// editor's @paged-media/shell — unpublishable. Now plugin-api OWNS
// them; the EDITOR asserts compatibility against this file
// (apps/canvas/src/plugin-api-compat.ts) through the dev link, so
// drift fails the editor's typecheck, not a third party's build.
//
// Two kinds of types live here, with different fidelity rules:
//  · CONTRIBUTION shapes (ToolContribution, PanelContribution, …)
//    mirror the editor 1:1 — bundles author them, the host consumes
//    them, so assignability must hold in BOTH directions.
//  · HANDLE shapes (PagedEditor, PagedClient, registries) are
//    deliberately NARROW — the contract names only what the SDK and
//    real bundles use; the editor's richer reality stays assignable
//    TO the contract (extra members are invisible, not promised).
//    Widening a handle type here is an API addition and gets the
//    same review as any other surface change.

import type { ComponentType } from "react";

import type {
  CollectionName,
  ContentSelection,
  DocumentMeta,
  ElementGeometryItem,
  ElementId,
  MainToWorkerKind,
  Mutation,
  PageId,
  PathAnchorsResult,
  SelectionMode,
  WorkerToMain,
} from "./wire";

// ---------------------------------------------------------------- base

export interface Disposable {
  dispose(): void;
}

export type DockEdge = "left" | "right" | "top" | "bottom" | "center";

/** Enablement/visibility predicate. The string DSL form is inert
 *  until the host grows an evaluator; the function form receives the
 *  live editor handle. */
export type VisibilityPredicate = string | ((state: unknown) => boolean);

// -------------------------------------------------------------- cursors

export type CssCursorToken =
  | "default"
  | "crosshair"
  | "grab"
  | "grabbing"
  | "move"
  | "text"
  | "pointer"
  | "not-allowed"
  | "copy"
  | "cell"
  | "zoom-in"
  | "zoom-out"
  | "nwse-resize"
  | "nesw-resize"
  | "ew-resize"
  | "ns-resize";

export type CursorSpec =
  | { kind: "css"; token: CssCursorToken }
  | { kind: "svg"; src: string; hotspot: { x: number; y: number } };

// ------------------------------------------------------------- gestures

/** Why a handler is being deactivated: a real tool change ("switch")
 *  commits/cancels in-flight state; a spring-load push/pop
 *  ("suspend") must keep it. */
export type DeactivateReason = "switch" | "suspend";

/** A pointer event on the canvas overlay, already page-resolved and
 *  camera-inverted by the host — handlers never touch camera math.
 *  Coordinates are document points (pt). */
export interface CanvasPointerEvent {
  /** Page the pointer is over, or null on the pasteboard. */
  pageId: string | null;
  /** Page-local point in pt. null off-page. */
  pagePoint: [number, number] | null;
  /** Page-independent document point in pt. */
  docPoint: [number, number];
  modifiers: { shift: boolean; alt: boolean; cmd: boolean; ctrl: boolean };
  /** Largest pointer delta this gesture, CSS px — click-vs-drag. */
  maxDelta: number;
  /** Mouse button (0 = primary). */
  button: number;
  /** Underlying DOM target — handlers may read `data-*` hooks. */
  target: unknown;
}

/** Ephemeral overlay primitive published during a gesture. Kept
 *  opaque so the contract is stable across host overlay growth. */
export type OverlayPrimitive = Record<string, unknown>;

export interface OverlayContext {
  setPreview(primitives: readonly OverlayPrimitive[]): void;
}

/** The contract every tool's `gesture()` factory returns. Mutate only
 *  through `paged.client` / the document surface — never by reaching
 *  into model state. */
export interface GestureHandler {
  onActivate(paged: PagedEditor): void;
  onDeactivate(reason: DeactivateReason): void;
  onPointerDown(e: CanvasPointerEvent): void;
  onPointerMove(e: CanvasPointerEvent): void;
  onPointerUp(e: CanvasPointerEvent): void;
  onKey?(e: KeyboardEvent): void;
  cursorAt?(e: CanvasPointerEvent): CursorSpec | undefined;
  renderOverlay?(ctx: OverlayContext): void;
}

// ---------------------------------------------------------------- tools

export type ToolId = string;
export type ToolGroupId = string;
export type ToolSectionId = "selection" | "drawType" | "transform" | "modNav";

export type ToolOptionField =
  | {
      kind: "number";
      key: string;
      label: string;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
    }
  | { kind: "toggle"; key: string; label: string }
  | {
      kind: "select";
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
    };

export interface ToolOptionsSpec {
  toolId: string;
  fields: ToolOptionField[];
}

export interface ToolContribution {
  /** Stable id, `<namespace>.<tool>` — namespace-checked at register. */
  id: ToolId;
  title: string;
  icon: string;
  /** Single-key shortcut (`"p"`, `"shift+c"`). Wire it through the
   *  SDK's `contributeTool` so the activation command + guard exist. */
  shortcut?: string;
  /** Flyout group — one rail slot; shared group = shared flyout. */
  group: ToolGroupId;
  section: ToolSectionId;
  order?: number;
  /** Slot position hint within the section (B-14): the rail orders
   *  slots by the minimum slotOrder across a group's members; absent
   *  = first-seen registration order (late bundles trail). */
  slotOrder?: number;
  isGroupDefault?: boolean;
  cursor?: CursorSpec;
  /** Handler factory the host mounts when the tool activates. Absent
   *  = rail data only (inert). */
  gesture?: () => GestureHandler;
  options?: ToolOptionsSpec;
  when?: VisibilityPredicate;
}

// --------------------------------------------------------------- panels

export interface PanelApi {
  id: string;
}

export interface PanelProps {
  /** The live editor handle (cast to `PagedEditor`). */
  paged: unknown;
  api: PanelApi;
}

export interface PanelContribution {
  id: string;
  title: string;
  component: ComponentType<PanelProps>;
  defaultDock?: DockEdge;
  defaultGroup?: string;
  icon?: string;
  when?: VisibilityPredicate;
  closable?: boolean;
  movable?: boolean;
}

// ------------------------------------------------------------- overlays

export interface OverlayPageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OverlayProps {
  paged: unknown;
  /** Camera snapshot at the current frame. */
  camera: { scale: number; tx: number; ty: number };
  /** Page rectangles in document space, in page-id order. */
  pageRects: ReadonlyMap<PageId, OverlayPageRect>;
}

export interface OverlayContribution {
  id: string;
  render: ComponentType<OverlayProps>;
  /** Z-order; higher renders on top. Default 100. */
  z?: number;
  when?: VisibilityPredicate;
}

// --------------------------------------------- commands + keybindings

export interface CommandContribution {
  id: string;
  title: string;
  category?: string;
  icon?: string;
  handler: (paged: unknown, payload?: unknown) => unknown | Promise<unknown>;
  when?: VisibilityPredicate;
}

export interface KeybindingContribution {
  /** Lowercased combo: `"cmd+shift+h"`, `"p"`, `"escape"`. */
  key: string;
  command: string;
  when?: VisibilityPredicate;
}

// ----------------------------------------------------------- registries
// NARROW handle contracts: `register` is the only promised member —
// the editor's richer registries stay assignable.

export interface ToolRegistry {
  register(contribution: ToolContribution): Disposable;
}
export interface PanelRegistry {
  register(contribution: PanelContribution): Disposable;
}
export interface CommandRegistry {
  register(contribution: CommandContribution): Disposable;
}
export interface KeybindingRegistry {
  register(contribution: KeybindingContribution): Disposable;
}
export interface OverlayRegistry {
  register(contribution: OverlayContribution): Disposable;
}

export interface ShellRegistries {
  tools: ToolRegistry;
  panels: PanelRegistry;
  commands: CommandRegistry;
  keybindings: KeybindingRegistry;
  overlays: OverlayRegistry;
}

// ---------------------------------------------------- overlay signals

export interface MarqueeRectPageLocal {
  pageId: PageId;
  /** `[top, left, bottom, right]` in page-local pt. */
  rect: [number, number, number, number];
}

export interface ToolPreviewPolyline {
  pageId: PageId;
  points: ReadonlyArray<[number, number]>;
  /** Draw the closing edge (pen/polygon previews). */
  close?: boolean;
}

export type ToolPreviewShape = MarqueeRectPageLocal | ToolPreviewPolyline;

// ------------------------------------------------------------- client
// The NARROW engine-client contract — what the SDK and real bundles
// call. The editor's CanvasClient (100+ methods) stays assignable.

export interface PagedClient {
  mutate(mutation: Mutation): Promise<WorkerToMain>;
  undo(): Promise<WorkerToMain>;
  redo(): Promise<WorkerToMain>;
  collection<T>(name: CollectionName): Promise<readonly T[]>;
  documentMeta(): Promise<DocumentMeta>;
  pathAnchors(id: ElementId): Promise<PathAnchorsResult | null>;
  elementGeometry(ids: ElementId[]): Promise<ElementGeometryItem[]>;
  setElementSelection(
    ids: ElementId[],
    mode: SelectionMode,
  ): Promise<ElementId[]>;
  send(message: MainToWorkerKind): Promise<WorkerToMain>;
  subscribe(listener: (msg: WorkerToMain) => void): () => void;
}

// -------------------------------------------------------- PagedEditor
// The NARROW editor handle: what gesture handlers receive from the
// host's tool spine and what `host.editor` exposes (the marked v0
// escape hatch — DESIGN.md §4.9).

export interface PagedEditor {
  client: PagedClient;
  registries: ShellRegistries;
  selection: {
    elementSelection: ElementId[];
    setElementSelection(ids: ElementId[]): void;
    setElementGeometry(items: ElementGeometryItem[]): void;
  };
  camera: {
    camera: { scale: number; tx: number; ty: number };
  };
  overlaySignals: {
    setToolPreview(value: ToolPreviewShape | null): void;
  };
  tool: {
    setBaseTool(id: ToolId): void;
  };
  contentSelection: {
    contentSelection: ContentSelection | null;
  };
}
