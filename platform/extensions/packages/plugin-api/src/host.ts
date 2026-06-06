// The BundleHost surface — the complete set of values a bundle may
// touch at runtime, area by area. Design rationale + per-member
// justification in DESIGN.md (§4); every member maps to a proven
// consumer need from paged.draw (plugin-draw/BREAKAGE_LOG.md) or
// paged.web (base-idea §9.1). Nothing here is speculative.
//
// RPC-readiness rule (DESIGN.md §6): state crosses as serializable
// snapshots + `onDid*` events. The three knowingly non-clonable
// members (tool gesture factories, panel React components,
// `host.editor`) each have a written exit.

import type {
  CollectionName,
  DocumentMeta,
  ElementGeometryItem,
  ElementId,
  HitFilter,
  HitResult,
  Mutation,
  PageId,
  PathAnchorsResult,
  SceneTreeNode,
  SelectionMode,
} from "./wire";
import type {
  CommandContribution,
  KeybindingContribution,
  OverlayContribution,
  PagedEditor,
  PanelContribution,
  ToolContribution,
  ToolPreviewShape,
} from "./editor";

import type { PluginManifest } from "./manifest";

// ---------------------------------------------------------------- core

/** Everything a bundle registers is disposable; the host ALSO tracks
 *  it, so deactivation teardown is structural, not conventional. */
export interface Disposable {
  dispose(): void;
}

/** Namespaced logger; doubles as the console mirror of the
 *  diagnostics channel. */
export interface PluginLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ---------------------------------------------------------- contribute

/** Reserved (P0 shell work, paged.draw B-02 / paged.web §8): an
 *  edit-context claim — double-click entry on a content type, scoped
 *  panel/tool sets. Throws PluginApiNotImplemented in v0. */
export interface EditContextDescriptor {
  type: string;
  entry: "doubleClick" | "command";
}

/** Reserved (paged.web §9.1.2): a plugin-defined object type under
 *  the metadata-plus-baked-fallback contract. Throws in v0. */
export interface ObjectTypeDescriptor {
  type: string;
  /** What the baked IDML form degrades to without the plugin. */
  bakedFallback: "group" | "rectangle" | "raster";
}

/**
 * The contribution surface. Every method enforces the namespace rule
 * (ids start with `<manifest.id>.`) and tracks the registration for
 * automatic teardown on deactivate.
 */
export interface ContributionSurface {
  tool(contribution: ToolContribution): Disposable;
  panel(contribution: PanelContribution): Disposable;
  command(contribution: CommandContribution): Disposable;
  keybinding(contribution: KeybindingContribution): Disposable;
  overlay(contribution: OverlayContribution): Disposable;
  /** Reserved — throws PluginApiNotImplemented until edit contexts
   *  land in the shell. Declared so manifests/docs can reference it. */
  editContext(descriptor: EditContextDescriptor): Disposable;
  /** Reserved — throws PluginApiNotImplemented (paged.web W1). */
  objectType(descriptor: ObjectTypeDescriptor): Disposable;
}

// ------------------------------------------------------------ document

/** Expected mutation failures are results, not throws — mirroring the
 *  editor's mutate-never-throws convention. */
export type MutationOutcome =
  | { applied: true; createdId: ElementId | null; pageIds: PageId[] }
  | { applied: false; error: unknown };

export interface DocumentChangeEvent {
  kind: "mutationApplied" | "undoApplied" | "redoApplied";
  pageIds: PageId[];
}

/**
 * Read-broad / write-through-one-door. `mutate` is the single write
 * path; undo/validation/collaboration semantics stay engine-owned.
 * The future write-scope (edit-context subtree) attaches at this same
 * chokepoint.
 */
export interface DocumentSurface {
  mutate(mutation: Mutation): Promise<MutationOutcome>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  collection<T>(name: CollectionName): Promise<readonly T[]>;
  meta(): Promise<DocumentMeta>;
  pathAnchors(id: ElementId): Promise<PathAnchorsResult | null>;
  hitTest(
    pageId: PageId,
    point: [number, number],
    filter?: HitFilter,
  ): Promise<HitResult | null>;
  elementGeometry(ids: ElementId[]): Promise<ElementGeometryItem[]>;
  tree(): Promise<SceneTreeNode[]>;
  onDidChange(listener: (e: DocumentChangeEvent) => void): Disposable;
}

// --------------------------------------------------- selection/viewport

export interface SelectionSurface {
  get(): ElementId[];
  set(ids: ElementId[], mode?: SelectionMode): Promise<ElementId[]>;
  onDidChange(listener: (ids: ElementId[]) => void): Disposable;
}

export interface ViewportSurface {
  /** Camera snapshot — scale + translation in CSS px. */
  camera(): { scale: number; tx: number; ty: number };
  /** Screen px → document pt at the current zoom (the constant-
   *  screen-tolerance idiom every tool needs). */
  pxToPt(px: number): number;
}

// -------------------------------------------------------------- overlay

/** The v0 overlay channel: the shared tool-preview signal (polyline /
 *  rect). Retained plugin scene layers are the P2 channel — reserved,
 *  not faked. */
export interface OverlaySurface {
  setToolPreview(shape: ToolPreviewShape | null): void;
}

// ---------------------------------------------------------------- shell

/**
 * Shell actions the HOST APP injects at `loadBundle` time (the
 * cockpit owns panel placement; the SDK's adapter stays a pure
 * function over the editor handle). When the host app provides no
 * implementation, calls warn and no-op — probe with
 * `host.supports("shell.openPanel@1")`.
 */
export interface ShellSurface {
  /** Open a REGISTERED panel as the active dock tab (the
   *  Window-menu / panel-rail path). */
  openPanel(panelId: string): void;
  closePanel(panelId: string): void;
}

// -------------------------------------------------------------- storage

/** Namespaced key-value persistence (`paged.plugin.<id>.*`), JSON
 *  values. Backing is host-provided (localStorage in-process;
 *  injectable for tests/headless). */
export interface StorageSurface {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

// ---------------------------------------------------------- diagnostics

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** Free-form origin, e.g. a file/frame/panel identifier. */
  source?: string;
  line?: number;
  column?: number;
}

/** The diagnostics channel (paged.web §9.1.4): per-plugin keyed
 *  diagnostic sets, console-mirrored in v0; the problems-panel UI
 *  consumes the same store later. */
export interface DiagnosticsSurface {
  set(key: string, diagnostics: Diagnostic[]): void;
  clear(key?: string): void;
  get(key: string): Diagnostic[];
  onDidChange(listener: (key: string) => void): Disposable;
}

// ----------------------------------------------------------------- host

/**
 * What `activate(host)` receives. Types from `@paged-media/plugin-api`,
 * values from here — never import host values into a bundle's module
 * graph.
 */
export interface BundleHost {
  /** The bundle's own manifest (read-only). */
  readonly manifest: PluginManifest;
  readonly log: PluginLogger;
  readonly contribute: ContributionSurface;
  readonly document: DocumentSurface;
  readonly selection: SelectionSurface;
  readonly viewport: ViewportSurface;
  readonly overlay: OverlaySurface;
  readonly shell: ShellSurface;
  readonly storage: StorageSurface;
  readonly diagnostics: DiagnosticsSurface;
  /** Capability detection over version sniffing: feature strings of
   *  the form `"area.member@major"` (see HOST_FEATURES in plugin-sdk). */
  supports(feature: string): boolean;
  /**
   * The marked escape hatch (DESIGN.md §4.9): the raw editor handle,
   * v0-only. Any use not reachable through a facade is a
   * BREAKAGE_LOG entry — and this member does not survive the isolate
   * boundary.
   */
  readonly editor: PagedEditor;
}
