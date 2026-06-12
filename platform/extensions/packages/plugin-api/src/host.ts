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
  ExporterContribution,
  ImporterContribution,
  KeybindingContribution,
  OverlayContribution,
  PagedEditor,
  PanelContribution,
  ToolContribution,
  ToolPreviewShape,
} from "./editor";
import type { SceneLayer } from "./wire";

import type { AssetSurface } from "./assets";
import type { PluginManifest } from "./manifest";
import type { SchemaPanelContribution } from "./panel-schema";
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

/**
 * What a matcher sees about a candidate element — a plain snapshot, so
 * the predicate is clonable + isolate-portable (DESIGN.md §6). The host
 * resolves it once per double-click (or programmatic test) from the
 * engine: the element's kind, its containing-group ancestry, and —
 * crucially — this plugin's OWN metadata envelope on the element (the
 * `x-paged:<id>` carrier, W-02). A bundle matches on the namespace it
 * already owns; it never sees a foreign plugin's metadata.
 */
export interface EditContextCandidate {
  /** The hit leaf element. */
  id: ElementId;
  /** The element's engine kind (`"polygon"`, `"rectangle"`, …) when the
   *  host knows it; `undefined` when the hit carried none. */
  kind?: string;
  /** Containing-group ancestry, outer-most first (the hit's
   *  `groupChain`). Empty when the element is not nested. */
  groupChain: readonly string[];
  /** THIS plugin's metadata envelope on the element, pre-resolved by the
   *  host (the `x-paged:<manifest id>` carrier — never a foreign key).
   *  `null` when the element carries none. The objectType matcher reads
   *  this to claim a webFrame ("has my source metadata"). */
  metadata: PluginMetadataEnvelope | null;
}

/**
 * An edit-context CLAIM (paged.draw B-02 / paged.web §8). Entering one
 * (double-click on a matching element, or programmatically) pushes a
 * context onto the shell's stack with: a restricted active tool-set, an
 * emphasized panel-set, a breadcrumb, a narrowed write-scope (the
 * context element's subtree), and Esc-pops-one-level. The plugin owns
 * the matcher + the lifecycle hooks; the shell owns the stack, the
 * chrome, and the scope enforcement.
 */
export interface EditContextContribution {
  /** The context TYPE — must match a `contributes.editContexts[].type`
   *  the manifest declares (the capability gate). Not namespace-prefixed
   *  (a content-type name, e.g. `"vectorGraphic"`, `"webFrame"`), but
   *  the bundle can only claim a type it declared. */
  type: string;
  /** How the user enters it. `"doubleClick"` wires the canvas
   *  double-click entry; `"command"` is programmatic / menu-driven. */
  entry: "doubleClick" | "command";
  /** Does this element warrant entering THIS context? Pure predicate
   *  over the candidate snapshot (kind / groupChain / this plugin's
   *  metadata). When an `objectType` already routes a double-click to a
   *  context (via `editContextType`), this matcher is not consulted —
   *  it is the fallback path for elements claimed by KIND, not metadata
   *  (the vectorGraphic case). Optional: a context entered only by
   *  command needs no matcher. */
  matches?(candidate: EditContextCandidate): boolean;
  /** Tool ids the context restricts the rail to (the active tool-set
   *  swap). Namespaced ids the bundle registered, plus host built-ins it
   *  names. Empty = no restriction (all tools stay available). */
  toolIds?: string[];
  /** Panel ids the cockpit emphasizes / raises on enter (the panel-set
   *  swap). The shell opens/raises these; it does not hide others. */
  panelIds?: string[];
  /** Called when the context becomes active (after the stack push + the
   *  scope narrowing). The element entered on is passed so the hook can
   *  prime panel state / publish bindings. */
  onEnter?(ctx: EnteredEditContext): void;
  /** Called when the context pops (Esc, or a programmatic exit), before
   *  the stack unwinds. */
  onExit?(ctx: EnteredEditContext): void;
  /** K-1 — pointer inside the context's frame, delivered in FRAME-CONTENT
   *  coordinates: the editor resolved the frame's content transform
   *  (`frame_outer ∘ content-box offset`), inverted it, and mapped the
   *  page-space pointer into the plugin's own space — so the plugin (a
   *  sheet grid) hit-tests in content coords regardless of how the frame
   *  is moved / scaled / rotated (§8.5 — the plugin never compensates).
   *  Optional: a context that doesn't edit by pointer omits them. */
  onContentPointerDown?(e: ContentPointerEvent): void;
  onContentPointerMove?(e: ContentPointerEvent): void;
  onContentPointerUp?(e: ContentPointerEvent): void;
  /** K-1 — a key while the context is active. The shell owns Esc (→
   *  `onCancel`) and Enter (→ `onCommit`); every other key forwards here. */
  onContentKey?(e: KeyboardEvent): void;
  /** K-1 — unsaved-edit probe: gates the discard prompt + the §8.0
   *  seamless-undo boundary. Absent ⇒ treated as never dirty. */
  isDirty?(): boolean;
  /** K-1 — modal COMMIT (Enter / a click outside the frame): keep the
   *  in-flight edits. Fires before `onExit`. */
  onCommit?(): void;
  /** K-1 — modal CANCEL (Esc): revert the in-flight edits. Fires before
   *  `onExit`. */
  onCancel?(): void;
  /** ADR-012 Tier 1 — in-session undo OWNERSHIP. While this context is
   *  active and declares these hooks, the shell routes Cmd-Z /
   *  Cmd-Shift-Z HERE (the plugin's own op-log — for sheets, workbook
   *  Operations) instead of the document undo stack; the document stack
   *  is suspended until exit (Tier 2: commit-exit re-lowers the net
   *  change as ONE atomic batch = one document undo step). Return
   *  `true` when a step was un/re-done, `false` when this context's log
   *  is exhausted (the shell does NOT fall through to the document
   *  stack mid-session — the boundary is the modal entry/exit,
   *  ADR-012). Absent ⇒ the context doesn't own undo and the document
   *  stack behaves as ever. */
  onUndo?(): boolean;
  onRedo?(): boolean;
  /** ADR-012 — enablement probes for the un/redo affordances while the
   *  context owns the stack. Absent (with `onUndo` present) ⇒ assumed
   *  always enabled. */
  onCanUndo?(): boolean;
  onCanRedo?(): boolean;
  /** HOST-STAMPED, not author-supplied: the `x-paged:<manifest id>`
   *  metadata key the host resolves the candidate's `metadata` from
   *  before calling `matches`. The SDK adapter fills this from the
   *  bundle's manifest at registration; authors leave it undefined. */
  metadataKey?: string;
}

/** The live handle a context's `onEnter` / `onExit` receives — the
 *  element entered on + the context type, a clonable snapshot. */
export interface EnteredEditContext {
  type: string;
  /** The element the context was entered on (the write-scope root). */
  id: ElementId;
}

/** K-1 — a pointer delivered to the ACTIVE edit context, in FRAME-CONTENT
 *  coordinates (the editor inverted the frame's content transform). */
export interface ContentPointerEvent {
  /** Pointer in frame-content points (origin = the content-box top-left,
   *  x right, y down). */
  contentPoint: [number, number];
  /** The frame the active context edits (the stack's scope root). */
  elementId: string;
  modifiers: { shift: boolean; alt: boolean; cmd: boolean; ctrl: boolean };
  /** Mouse button (0 = primary). */
  button: number;
}

/**
 * A plugin-defined OBJECT TYPE (paged.web §9.1.2). A webFrame is an
 * ordinary rectangle with attached `x-paged:media.paged.web` source
 * metadata; registering an object type lets the shell recognize it
 * (`matches`) and route a double-click to a SOURCE edit context
 * (`editContextType`) instead of descending into a group. The metadata
 * namespace is the matcher's domain — `matches` reads the candidate's
 * pre-resolved (own-namespace) envelope.
 */
export interface ObjectTypeContribution {
  /** The object-type name — must match a `contributes.objectTypes[].type`
   *  the manifest declares (the capability gate). */
  type: string;
  /** Is this element an instance of this object type? Reads the
   *  candidate's metadata envelope (this plugin's `x-paged:<id>` carrier)
   *  — e.g. "has a `source` field" for a webFrame. */
  matches(candidate: EditContextCandidate): boolean;
  /** The edit-context type a double-click on a matching element enters,
   *  instead of group descent. Must be a context the SAME bundle
   *  registered via `contribute.editContext`. Absent = the object type is
   *  recognized for selection/chrome but double-click falls through to
   *  the default (group descent) — the honest partial. */
  editContextType?: string;
  /** What the baked IDML form degrades to without the plugin (the
   *  metadata-plus-baked-fallback contract; `ObjectTypeBaker` produces
   *  the derived children). Carried for the bake loop (still reserved)
   *  and for selection-chrome hints. */
  bakedFallback: "group" | "rectangle" | "raster";
  /** HOST-STAMPED (see `EditContextContribution.metadataKey`): the
   *  `x-paged:<manifest id>` key the host resolves the candidate's
   *  `metadata` from before calling `matches`. Authors leave it
   *  undefined; the SDK adapter fills it. */
  metadataKey?: string;
}

/** Back-compat aliases (the v0 reserved descriptors) — the rich
 *  contributions above supersede them; kept so existing references
 *  resolve. New code uses `EditContextContribution` /
 *  `ObjectTypeContribution`. */
export type EditContextDescriptor = EditContextContribution;
export type ObjectTypeDescriptor = ObjectTypeContribution;

/**
 * The contribution surface. Every method enforces the namespace rule
 * (ids start with `<manifest.id>.`) and tracks the registration for
 * automatic teardown on deactivate.
 */
export interface ContributionSurface {
  tool(contribution: ToolContribution): Disposable;
  panel(contribution: PanelContribution): Disposable;
  /**
   * Register a DECLARATIVE panel (W3.1, closes B-01): sections/rows/
   * widgets from the catalog vocabulary, with visibility/enablement
   * driven by the bundle's PUBLISHED bindings (`host.bindings`) — no
   * React crosses the boundary (the isolate-ready panel form; see
   * panel-schema.ts). Same namespace + capability gate as `panel`
   * (`contributes.panels[]` must list the id). The host renders the
   * schema from the catalog and subscribes to the bundle's bindings;
   * an expert-leaf React `panel` stays the escape hatch for custom UI.
   */
  schemaPanel(contribution: SchemaPanelContribution): Disposable;
  command(contribution: CommandContribution): Disposable;
  keybinding(contribution: KeybindingContribution): Disposable;
  overlay(contribution: OverlayContribution): Disposable;
  /**
   * Register an EDIT CONTEXT (W3.2, closes B-02): a double-click (or
   * programmatic) entry on a content type that pushes a scoped context
   * — restricted tool-set, emphasized panels, breadcrumb, narrowed
   * write-scope, Esc-pops. Capability-gated: the `type` must be listed
   * in `contributes.editContexts[]`. The shell owns the stack + chrome
   * + scope; the plugin owns the matcher + the onEnter/onExit hooks.
   */
  editContext(contribution: EditContextContribution): Disposable;
  /**
   * Register an OBJECT TYPE (W3.2, closes W-03): a plugin-defined object
   * (a webFrame is a rectangle with attached source metadata). A
   * double-click on a matching element enters its `editContextType`
   * instead of descending into a group. Capability-gated: the `type`
   * must be listed in `contributes.objectTypes[]`. The matcher reads the
   * element's OWN-namespace metadata envelope (the `x-paged:<id>`
   * carrier).
   */
  objectType(contribution: ObjectTypeContribution): Disposable;
  /**
   * Register a document IMPORTER (K-2 / S-06): claim file extensions /
   * MIME types so an opened file (File menu, drag-drop, or
   * `host.shell.pickFile`) routes its bytes to THIS plugin's `import()`
   * instead of the default IDML loader — the plugin owns what the file
   * becomes (load into its own engine, lower a range, …; it does not
   * replace the document unless it chooses to). Capability-gated: the
   * `id` must be listed in `contributes.importers[]`. Probe
   * `supports("contribute.importer@1")`.
   */
  importer(contribution: ImporterContribution): Disposable;
  /**
   * Register a document EXPORTER (K-2 / S-06): produce bytes for a file
   * type on demand (the export UI lists it and pulls on save).
   * Capability-gated: the `id` must be listed in
   * `contributes.exporters[]`.
   */
  exporter(contribution: ExporterContribution): Disposable;
  /**
   * Open a SCENE-LAYER surface (C-1): submit vector content that renders
   * INSIDE a frame, in frame-content coordinates — core applies the
   * frame's `ItemTransform` and clips to the content box (§8.5), so the
   * plugin never compensates for the transform. The layer lowers through
   * the same display-list → GPU/CPU path as native content (colour-
   * managed, print-correct). Capability-gated: `capabilities.rendering`
   * must include `"sceneLayer"`. Probe `supports("rendering.sceneLayer@1")`
   * — false when the host wires no scene channel (the surface then warns +
   * no-ops). The returned surface is disposable: disposing it clears every
   * layer it submitted.
   */
  sceneLayer(): SceneLayerSurface;
}

/** The scene-layer surface (C-1) returned by `contribute.sceneLayer()`.
 *  `elementId` is the host `Self` id of the frame to render into. */
export interface SceneLayerSurface extends Disposable {
  /** Submit (replacing any previous) the vector layer for `elementId`. */
  submit(elementId: string, layer: SceneLayer): Promise<void>;
  /** Clear the layer for `elementId` (returns the frame to native
   *  content). */
  clear(elementId: string): Promise<void>;
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
  /** Content-box reflow (protocol v38, C-2/S-05): present ONLY when the
   *  change RESIZED a frame's content box (a `resizeFrame`) — never on a
   *  pure transform (move/scale/rotate is display-only, §8.5). A
   *  pagination consumer re-splits on this and ignores transform-only
   *  changes (where it is absent). */
  reflow?: { frameId: string; contentBox: [number, number, number, number] };
}

/** One link in a text-frame thread (protocol v38, C-2/S-05). `next` is
 *  the following frame's id (null at the tail); `overflow` marks the tail
 *  frame as overset (story content past the chain end). */
export interface FrameChainLink {
  frameId: string;
  next: string | null;
  overflow: boolean;
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
  /** Read a text frame's thread topology (protocol v38, C-2/S-05) — the
   *  ordered chain of frames a story flows through, tail-overflow flagged.
   *  Empty when the story has no frame or no document is loaded. A
   *  pagination consumer reads this to know the real host chain (rather
   *  than a caller-supplied one). */
  frameChain(storyId: string): Promise<FrameChainLink[]>;
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

// ----------------------------------------------------------------- text

/** Font advance + vertical metrics, in document points (pt). */
export interface TextMetrics {
  /** Total advance width of the run at `sizePt`. */
  advance: number;
  /** Face ascender at `sizePt`. */
  ascender: number;
  /** Face descender at `sizePt` (negative below the baseline). */
  descender: number;
}

/**
 * Text measurement against the loaded document's fonts (S-13). A read
 * door — no capability gate (like {@link ViewportSurface}); it wraps the
 * engine's shaper (`paged-text::shape_run`) so a plugin can size grid
 * columns / lower content to widths the page surface will agree with
 * (the §8.3 cross-surface-consistency requirement). Resolves the face
 * from the document's font registry; falls back to the default face when
 * `family` is unknown.
 */
export interface TextSurface {
  measureString(
    family: string,
    style: string | null,
    text: string,
    sizePt: number,
  ): Promise<TextMetrics>;
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
  /** Open the host's file picker and resolve to the chosen files' bytes
   *  (read at the host boundary — the contract never leaks a DOM `File`,
   *  so a bundle stays isolate-ready, K-5 / S-11). Resolves to `[]` when
   *  the user cancels OR no picker is wired (the honest no-picker door);
   *  probe `host.supports("shell.pickFile@1")` for the latter. */
  pickFile(options?: FilePickerOptions): Promise<readonly PickedFile[]>;
}

/** Filter + multiplicity for `ShellSurface.pickFile` (K-5 / S-11). */
export interface FilePickerOptions {
  /** Accept filter — extensions (leading dot) and/or MIME types, passed
   *  straight to the picker's `accept` (e.g. `[".xlsx"]`). Absent = any. */
  accept?: readonly string[];
  /** Allow choosing more than one file. Default `false`. */
  multiple?: boolean;
}

/** A file the user chose through `pickFile`, bytes already read. */
export interface PickedFile {
  /** File name incl. extension. */
  name: string;
  /** The file's raw bytes. */
  bytes: Uint8Array;
  /** MIME type the browser reported (may be `""`). */
  mimeType: string;
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

// ----------------------------------------------------------------- blob

/** Per-plugin usage + the granted ceiling, in bytes (`BlobSurface.usage`). */
export interface BlobUsage {
  /** Bytes this plugin currently stores. */
  used: number;
  /** The granted ceiling in bytes — the stricter of the host's hard
   *  per-plugin cap and the manifest's requested `storage.quotaBytes`.
   *  `0` when no store is wired. */
  quota: number;
}

/**
 * Persistent BINARY blob storage (K-4 / S-08): an OPFS-backed,
 * per-plugin, quota-bounded store for bytes too large for the KV
 * `host.storage` (multi-MB workbook bytes, decode spill). Keys are
 * namespaced to THIS plugin (a bundle never sees another's bytes).
 * Capability-gated: every door requires `capabilities.storage` ∋
 * `blob: true`. Always present — when the host injects no backend a
 * `read` answers `null`, `keys` is `[]`, `usage` is `{used:0,quota:0}`,
 * and a `write` REJECTS (the honest no-store door; probe
 * `supports("storage.blob@1")` first). A `write` that would exceed the
 * granted quota rejects.
 */
export interface BlobSurface {
  write(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  usage(): Promise<BlobUsage>;
}

// -------------------------------------------------------------- network
//
// The capability-gated NETWORK CONSENT door (paged.data D-03; base-idea §11).
// `capabilities.network` (a per-origin allow-list + purpose) is the OUTER bound;
// this door makes reach EXPLICIT + CONSENTED. Documents carrying queries are
// treated as carrying code: NOTHING fetches on open; external origins are inert
// until the user reviews the data-source manifest (origins + purpose) and
// consents — per-origin, rememberable. The host does NOT proxy bytes; it owns
// the consent UI and enforces the boundary (a CSP `connect-src` derived from the
// granted set). A bundle gates its OWN fetch / DuckDB `httpfs` on
// `consentedOrigins()`. Always present; when the host injects no consent
// backend the door DENIES every origin (the honest no-consent posture) and
// `supports("network.consent@1")` answers false.

/** The per-origin outcome of a consent request. */
export interface ConsentResult {
  /** Origins the user granted (a subset of the requested set). */
  granted: readonly string[];
  /** Origins denied (out-of-allow-list or user-declined). */
  denied: readonly string[];
  /** Whether the grant was remembered for this document (survives reopen). */
  remembered: boolean;
}

export interface NetworkSurface {
  /** Request consent to reach `origins` (`scheme://host[:port]`) for a stated
   *  `purpose`; the host renders the data-source manifest for review and
   *  resolves the per-origin decision. NOTHING fetches before this resolves.
   *  Origins outside the declared `capabilities.network` allow-list are denied.
   *  Requires `capabilities.network` to be declared (else a capability error). */
  requestConsent(origins: readonly string[], purpose: string): Promise<ConsentResult>;
  /** The currently-granted origins (session grants + remembered) — a bundle
   *  gates its own reach on this. */
  consentedOrigins(): readonly string[];
}

// ------------------------------------------------------ data providers
//
// The cross-plugin DATA-PROVIDER registry (paged.data §7.1 / D-09). One plugin
// PUBLISHES a resolved dataset; another DISCOVERS + reads it — e.g. a sheet
// sourced from a governed query. They rendezvous ONLY here, never by direct
// contact (§2.1): the consumer learns a provider's id/category/schema, never the
// backing plugin's identity, and the consumer API has NO parameter by which it
// could drive the provider's queries/sources (it reads published data; it cannot
// induce a fetch). The interchange is the Arrow-aligned columnar shape the data
// engine emits (`ty`, not `type`, on a field — the same shape it ingests).

/** A field of a provider's schema (Arrow-seam shape). */
export interface ProviderField {
  name: string;
  /** Arrow-aligned logical type: `text|int|float|bool|date|datetime|bytes|null`. */
  ty: string;
  nullable?: boolean;
}

/** A provider's schema descriptor (the half `discover` surfaces without rows). */
export interface ProviderSchema {
  fields: ProviderField[];
}

/** The columnar row payload a provider serves (Arrow-aligned): one array per
 *  schema field. Opaque to the contract beyond its shape — the consumer maps it
 *  to its own model. */
export interface ProviderRecordSet {
  schema: ProviderSchema;
  columns: unknown[][];
  rowCount: number;
}

/** What a provider hands `register`: a discovery descriptor + a LAZY snapshot
 *  getter (invoked only when a consumer pulls, in the provider's own realm under
 *  the provider's own capability/consent) + the current content revision. */
export interface DataProviderRegistration {
  id: string;
  category: string;
  schema: ProviderSchema;
  /** An opaque content etag; bump it via the handle when the data changes. */
  revision: string;
  getSnapshot(): Promise<ProviderRecordSet> | ProviderRecordSet;
}

/** The handle a provider holds to signal refresh / tear its provider down. */
export interface DataProviderHandle {
  /** Announce a new revision — consumers subscribed via `onDidChange` re-pull. */
  update(revision: string): void;
  /** Remove the provider; `discover` stops listing it. */
  dispose(): void;
}

/** A discovery record (schema + revision, NO rows). */
export interface DataProviderInfo {
  id: string;
  category: string;
  schema: ProviderSchema;
  revision: string;
}

/** A pulled snapshot (the rows). */
export interface DataProviderSnapshot {
  id: string;
  revision: string;
  records: ProviderRecordSet;
}

export interface DataProvidersSurface {
  /** PROVIDER side — register a named provider (gated on
   *  `capabilities.dataProviders.publish` ∋ category). Returns a handle to
   *  signal refresh / dispose. */
  register(registration: DataProviderRegistration): DataProviderHandle;
  /** CONSUMER side — enumerate providers by category (schema + revision, NO
   *  rows). Gated on `capabilities.dataProviders.consume`. Empty when no shared
   *  registry is wired (graceful absence). */
  discover(category?: string): readonly DataProviderInfo[];
  /** CONSUMER side — pull a provider's current snapshot, or `null` if it no
   *  longer exists. Gated on `consume`. */
  get(id: string): Promise<DataProviderSnapshot | null>;
  /** CONSUMER side — fire when a provider's revision changes; re-pull on your
   *  own schedule. Subscribing to an absent id is inert. */
  onDidChange(id: string, listener: (revision: string) => void): Disposable;
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

// ------------------------------------------------------------- bindings
//
// The PUBLISH-BINDINGS door (W3.1 — the dynamic half of the panel
// schema). A bundle publishes NAMED reactive values that schema rows
// reference via `{ bind: "name" }` for their `visible` / `enabled`
// gates. The plugin computes the value in ITS OWN realm (from tool
// state, selection, document reads — anything) and publishes the
// RESULT; the host stores it and re-renders any schema row that reads
// it. This is the deliberate non-conditional design (B-01): the binding
// ceiling stays `literal | selectionProperty`; conditional VISIBILITY
// comes from a derived bound value, NOT a host-evaluated expression.
//
// Values are plain JSON (`structuredClone`-able) so the door proxies
// across the future isolate boundary unchanged: the bundle posts
// `{ name, value }`, the host re-renders. Booleans drive gates; other
// values are reserved for when a widget's display can read a published
// value (a v2 widen — v1 widgets read only selection for `value`).
export interface BindingsSurface {
  /** Publish (or update) a named reactive value. Schema rows reading
   *  `{ bind: name }` re-render on every change. JSON only. */
  publish(name: string, value: unknown): void;
  /** Read the current value of a published binding (or `undefined`).
   *  The host uses this when first rendering a row; bundles rarely
   *  need it. */
  get(name: string): unknown;
  /** Remove a published binding. Rows reading it fall back to the
   *  gate's "absent" semantics (visible / enabled). */
  delete(name: string): void;
  /** Subscribe to changes of ANY published binding (the host's render
   *  subscription; the argument is the changed name). */
  onDidChange(listener: (name: string) => void): Disposable;
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
  /** Font measurement against the document's fonts (S-13). A read door,
   *  no capability gate; `supports("text.measure@1")` reports whether the
   *  host wired the engine shaper (it is false under a host that injects
   *  no measurement backend — the headless harness returns an estimate). */
  readonly text: TextSurface;
  readonly overlay: OverlaySurface;
  readonly shell: ShellSurface;
  readonly storage: StorageSurface;
  /** The capability-gated BINARY blob store (K-4 / S-08): OPFS-backed,
   *  per-plugin, quota-bounded bytes for payloads too large for the KV
   *  `storage`. Always present; gated on `capabilities.storage` ∋ blob.
   *  When the host injects no backend, reads answer null / `[]` /
   *  `{used:0,quota:0}`, writes reject, and `supports("storage.blob@1")`
   *  is false (the honest no-store door). */
  readonly blob: BlobSurface;
  /** The capability-gated NETWORK CONSENT door (D-03; base-idea §11). Always
   *  present; gated on `capabilities.network` and per-origin user consent.
   *  When the host injects no consent backend, every request is DENIED (the
   *  honest no-consent posture) and `supports("network.consent@1")` is false. */
  readonly network: NetworkSurface;
  /** The cross-plugin DATA-PROVIDER registry (paged.data §7.1 / D-09). A bundle
   *  PUBLISHES a resolved dataset (gated on `capabilities.dataProviders.publish`)
   *  and/or DISCOVERS + reads others' (gated on `consume`) — the neutral
   *  rendezvous, never direct plugin contact. Always present; when the host wires
   *  no shared registry, `discover()` is empty + `register()` is a no-op and
   *  `supports("dataProviders@1")` is false (the honest no-registry posture). */
  readonly dataProviders: DataProvidersSurface;
  readonly diagnostics: DiagnosticsSurface;
  /** Published reactive values (W3.1) — the dynamic half of schema
   *  panels: a bundle publishes named booleans (and JSON values) that
   *  schema rows reference for `visible`/`enabled`. The plugin owns the
   *  derivation; the host owns the lookup + re-render. Always present
   *  (in-memory store; trivially proxyable across the isolate). */
  readonly bindings: BindingsSurface;
  /** Host-provided panel widgets (W-04): the code editor and future
   *  heavy controls the host owns. Always present — a plain-textarea
   *  fallback stands in when the host app injects no widget catalog
   *  (probe with `host.supports("widgets.codeEditor@1")`). */
  readonly widgets: WidgetSurface;
  /** The capability-gated ASSET STORE (W-06): a READ-ONLY door over the
   *  bytes the DOCUMENT already embeds/loads. v1 serves font face bytes
   *  (`getFontFace`) so a bundle can compose real `@font-face`. Always
   *  present — when the host app injects no asset source, every read
   *  answers `null` (the honest no-bytes door) and
   *  `supports("assets.fonts@1")` is false. Capability-gated:
   *  `getFontFace` requires `capabilities.assets` ∋ `"fonts"`. */
  readonly assets: AssetSurface;
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
