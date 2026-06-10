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
  EditContextContribution,
  ObjectTypeContribution,
} from "./host";
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
  SceneLayer,
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
  /**
   * Pointer-Events normalized pressure, 0..1 (B-08). Browser
   * semantics are preserved verbatim: a pen reports its physical
   * pressure; a mouse reports `0` with no button and `0.5` while a
   * button is held; touch reports `0`/`0.5` likewise. The host reads
   * `PointerEvent.pressure` straight through, so a stylus drives
   * variable-width strokes (§13.12, Tier B) once the renderer can
   * consume a pressure profile. Defaults to `0.5` on synthetic
   * events that omit it.
   */
  pressure: number;
  /** Pen tilt around the X axis, −90..90 deg (Pointer Events). `0`
   *  for mouse/touch and pens without tilt support. */
  tiltX: number;
  /** Pen tilt around the Y axis, −90..90 deg (Pointer Events). `0`
   *  for mouse/touch and pens without tilt support. */
  tiltY: number;
  /** Originating device class (Pointer Events `pointerType`). Lets a
   *  tool branch stylus-only behaviour. Defaults to `"mouse"`. */
  pointerType: "mouse" | "pen" | "touch";
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

// ----------------------------------------------- importers + exporters
// Document IO contributions (K-2 / S-06 ↔ plugin-image I-05). An IMPORTER
// claims file extensions / MIME types; when the host opens a matching file
// (File menu, drag-drop, or `host.shell.pickFile`) it routes the bytes to
// the importer's `import()` INSTEAD of the default IDML loader — so the
// plugin owns what the file becomes (load into its own engine, lower a
// range, …; it does NOT replace the document unless it chooses to). An
// EXPORTER claims an extension and produces bytes on demand (the export UI
// lists it). Both mirror the `command` contract: a namespaced id the
// manifest must list, with the rich object handed in at register time.

/** A file handed to an importer — bytes already read at the host boundary
 *  (the contract never leaks a DOM `File`, so a bundle stays environment-
 *  agnostic / isolate-ready). */
export interface ImportRequest {
  /** Original file name incl. extension (e.g. `"budget.xlsx"`). */
  name: string;
  /** The file's raw bytes. */
  bytes: Uint8Array;
  /** MIME type the host reported (may be `""` when the OS gave none). */
  mimeType: string;
}

export interface ImporterContribution {
  /** Stable id, `<namespace>.<importer>` — namespace-checked at register. */
  id: string;
  /** Human label for the Open/Import UI (e.g. `"Spreadsheet"`). */
  title: string;
  /** Extensions this importer handles, leading dot, lowercased
   *  (`[".xlsx"]`). The host matches an opened file by extension first. */
  extensions: readonly string[];
  /** MIME types this importer also matches (optional; feeds the file
   *  picker's `accept` and a secondary match when the extension is
   *  ambiguous). */
  mimeTypes?: readonly string[];
  /** Handle an opened file. The importer drives the host through its own
   *  surfaces (load into an engine, lower into the document, …); it does
   *  not return a document. Async so it can boot wasm / await mutations. */
  import(file: ImportRequest): void | Promise<void>;
}

/** What an exporter yields — bytes plus the suggested download name. */
export interface ExportResult {
  bytes: Uint8Array;
  /** Suggested file name (the host may still let the user rename). */
  fileName: string;
}

export interface ExporterContribution {
  /** Stable id, `<namespace>.<exporter>` — namespace-checked at register. */
  id: string;
  /** Human label for the Export UI (e.g. `"Workbook (.xlsx)"`). */
  title: string;
  /** The extension the produced file carries, leading dot (`".xlsx"`). */
  extension: string;
  /** MIME type to stamp on the produced blob (optional). */
  mimeType?: string;
  /** Produce the bytes to save, or null to abort silently (nothing to
   *  export). Async so it can pull from a wasm engine. */
  export(): Promise<ExportResult | null> | ExportResult | null;
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

/** W3.2 — the edit-context registry (the shell owns the stack + chrome
 *  + write-scope; this narrow contract is just the registration door).
 *  The contribution type lives in ./host (the bundle-facing surface). */
export interface EditContextRegistry {
  register(contribution: EditContextContribution): Disposable;
}
/** W3.2 — the object-type registry (the shell owns hit-routing; a
 *  matching element's double-click enters its `editContextType`). */
export interface ObjectTypeRegistry {
  register(contribution: ObjectTypeContribution): Disposable;
}

/** K-2 / S-06 — the document-importer registry (the shell owns file→plugin
 *  routing in the open/drag-drop flow). Narrow: `register` only. */
export interface ImporterRegistry {
  register(contribution: ImporterContribution): Disposable;
}
/** K-2 / S-06 — the document-exporter registry (the export UI lists the
 *  registered exporters and pulls bytes on demand). */
export interface ExporterRegistry {
  register(contribution: ExporterContribution): Disposable;
}

export interface ShellRegistries {
  tools: ToolRegistry;
  panels: PanelRegistry;
  commands: CommandRegistry;
  keybindings: KeybindingRegistry;
  overlays: OverlayRegistry;
  /** W3.2 — edit contexts (B-02). Narrow: `register` only. Optional on
   *  the contract so a host that hasn't wired the registry yet stays
   *  assignable; the SDK adapter falls back to a recording stub. */
  editContexts?: EditContextRegistry;
  /** W3.2 — object types (W-03). Optional for the same reason. */
  objectTypes?: ObjectTypeRegistry;
  /** K-2 / S-06 — document importers (file → plugin). Optional on the
   *  contract so a host that hasn't wired the registry stays assignable;
   *  the SDK adapter falls back to a tracked no-op (the headless harness
   *  injects a recording registry). */
  importers?: ImporterRegistry;
  /** K-2 / S-06 — document exporters (plugin → file). Optional likewise. */
  exporters?: ExporterRegistry;
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

/**
 * A path/cubic tool preview (B-07). Where `ToolPreviewPolyline` forces
 * an in-progress pen run to FLATTEN its cubics (sampling artefacts at
 * high zoom, wasted work per pointermove), this variant carries the
 * true anchor/handle form so the host renders real Béziers — one SVG
 * `<path>` of `C` commands, exact at any zoom.
 *
 * `anchors` is the engine's `PathAnchorSpec` form (on-curve `anchor` +
 * incoming `left` + outgoing `right` handles, IDML `PathPointType`
 * semantics — structurally `draw-tools`' `AnchorTriple` and what
 * `insertPath` consumes, so the same run feeds both preview and
 * commit). `close` draws the closing cubic back to anchor 0. `dashed`
 * selects the dashed-vs-solid stroke from the shared preview vocabulary
 * (solid by default, matching the rubber-band family).
 */
export interface ToolPreviewPath {
  pageId: PageId;
  /** Cubic anchors in page-local pt (the `PathAnchorSpec` shape). */
  anchors: ReadonlyArray<{
    anchor: [number, number];
    left: [number, number];
    right: [number, number];
  }>;
  /** Close the contour (draw the cubic from the last anchor back to 0). */
  close?: boolean;
  /** Dashed stroke instead of the default solid (preview vocabulary). */
  dashed?: boolean;
}

export type ToolPreviewShape =
  | MarqueeRectPageLocal
  | ToolPreviewPolyline
  | ToolPreviewPath;

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
  /** S-13 font measurement — the editor routes this to the canvas-wasm
   *  `CanvasWorker.measureText` query (async across the worker boundary).
   *  `undefined` when the host build wires no shaper (headless / older
   *  editor); the host surface then falls back to an estimate. */
  text?: {
    measure(
      family: string,
      style: string | null,
      text: string,
      sizePt: number,
    ): Promise<{ advance: number; ascender: number; descender: number }>;
  };
  /** C-1 — in-frame plugin scene layers. The editor routes these to the
   *  canvas-wasm `submitSceneLayer` / `clearSceneLayer` channel (async,
   *  across the worker boundary). `undefined` when the host build wires no
   *  scene channel (headless / older editor); `host.contribute.sceneLayer()`
   *  then warns + no-ops and `supports("rendering.sceneLayer@1")` is false. */
  sceneLayers?: {
    submit(elementId: string, layer: SceneLayer): Promise<void>;
    clear(elementId: string): Promise<void>;
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
