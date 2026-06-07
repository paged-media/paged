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
import type { WidgetSurface } from "./widgets";

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
  /**
   * Plugin-metadata carrier (protocol v33) — read this plugin's
   * metadata envelope on a leaf page item, or `null` when absent.
   * The key is implicit: `x-paged:<manifest shortname>` — a bundle
   * can only see and write its OWN namespace (enforced by the host;
   * the engine additionally gates prefix/size/envelope).
   */
  getMetadata(id: ElementId): Promise<PluginMetadataEnvelope | null>;
  /**
   * Write (or clear, with `null`) this plugin's metadata on a leaf
   * page item. One ordinary mutation through the same door as
   * `mutate` — full undo/redo, engine-gated (64 KiB cap, JSON
   * envelope shape). IDML round-trips it as a `Properties/Label`
   * `KeyValuePair`, which InDesign preserves verbatim.
   */
  setMetadata(
    id: ElementId,
    envelope: PluginMetadataEnvelope | null,
  ): Promise<MutationOutcome>;
}

/**
 * The schema'd value of one `x-paged:*` Label entry (facility design
 * §2). `v` is the PLUGIN's metadata version (migrations are
 * plugin-owned); `engine` carries determinism pins where relevant
 * (e.g. paged.web's `{ blitz: "0.3.0-alpha.4" }`).
 */
export interface PluginMetadataEnvelope {
  v: number;
  data: Record<string, unknown>;
  engine?: Record<string, string>;
}

/**
 * The bake() contract (facility design §4) — registered via
 * `contribute.objectType`. Produces the baked IDML form (mutations
 * creating/refreshing the object's DERIVED children) from the live
 * metadata. Pure: (metadata, geometry) in, mutation batch out. The
 * host applies the batch atomically (one undo step) on metadata
 * change (debounced) and before save/export; a throwing bake blocks
 * the save with a diagnostic — never a silent degrade.
 *
 * NOTE: `contribute.objectType` is still reserved at runtime — this
 * type ships ahead of the host loop so bakers can be written against
 * it (consumer sequencing §6: paged.web W-02 first).
 */
export interface ObjectTypeBaker {
  bake(ctx: BakeContext): Mutation[];
}

export interface BakeContext {
  /** The host object the metadata lives on. */
  id: ElementId;
  envelope: PluginMetadataEnvelope;
  /** Page-local frame bounds [top, left, bottom, right] in pt. */
  bounds: [number, number, number, number];
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
  /** Host-provided panel widgets (W-04): the code editor and future
   *  heavy controls the host owns. Always present — a plain-textarea
   *  fallback stands in when the host app injects no widget catalog
   *  (probe with `host.supports("widgets.codeEditor@1")`). */
  readonly widgets: WidgetSurface;
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
