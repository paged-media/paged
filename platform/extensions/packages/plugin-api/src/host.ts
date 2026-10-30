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
  MintedElement,
  Mutation,
  PageId,
  ElementProperties,
  PathAnchorsResult,
  PathAnchorTriple,
  SceneTreeNode,
  SelectionMode,
  SnapPointQuery,
  SnapPointResult,
  StyleCollection,
  StyleProperties,
  PropertyPath,
  Value,
  SvgExportOptions,
  SvgImportOptions,
  SvgReport,
} from "./wire.js";
import type {
  CommandContribution,
  ControlBarGroupContribution,
  StatusItemContribution,
  CursorSpec,
  ExporterContribution,
  FrameSurfaceContribution,
  ImporterContribution,
  KeybindingContribution,
  OverlayContribution,
  PagedEditor,
  PanelContribution,
  PresentationContribution,
  PresentationState,
  PresentRequest,
  PresentResult,
  SubContextProviderContribution,
  SubContextSpec,
  SubContextState,
  ToolContribution,
  ToolPreviewShape,
  ViewContribution,
} from "./editor.js";
import type { SceneLayer } from "./wire.js";
import type { MediaItem, MediaKind, MediaSource } from "./wire.js";

import type { AssetSurface } from "./assets.js";
import type {
  BindingProvider,
  BindingProviderHandle,
} from "./binding-provider.js";
import type { ClipboardSurface } from "./clipboard.js";
import type { MutationInput } from "./mutations.js";
import type { PluginManifest, WasmArtifact } from "./manifest.js";
import type { SchemaPanelContribution } from "./panel-schema.js";
import type { WidgetSurface } from "./widgets.js";
import type {
  ObjectModelContribution,
  ObjectModelHandle,
  ObjectsSurface,
} from "./object-model.js";

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
  /**
   * How the user enters it. `"doubleClick"` wires the canvas
   * double-click entry.
   *
   * THIS IS THE ONLY VALUE, and that is a product rule rather than a
   * missing feature (K-13, 2026-08-07). **Any plugin that exposes
   * content to the canvas is entered by double-clicking its frame.**
   * The gesture must mean ONE thing across the product: a user learns
   * "double-click to go inside" once, and it has to hold for a vector
   * group, a spreadsheet, a web frame, a Word document and a raster
   * image alike. A bundle with a bespoke entry would turn "how do I get
   * into this thing" into plugin-specific trivia, which is a worse cost
   * than any convenience a custom entry buys.
   *
   * `"command"` USED TO BE HERE, documented as "programmatic /
   * menu-driven", and nothing ever implemented it: the registry is
   * `register`-only, `BundleHost` has no enter member, and the shell's
   * `enter` is a React hook no bundle can reach. So it was a value the
   * platform accepted, validated and registered — and then silently
   * never honoured, which is the `absent` lie one layer up. An audit at
   * removal found 5 of 5 content plugins on `"doubleClick"` (draw, web,
   * sheets, doc, image) and ZERO users of `"command"`, so removing it
   * broke nothing and made the rule checkable by the compiler instead
   * of by review.
   *
   * Kept as a one-member union rather than deleted outright: the field
   * is where a SECOND entry gesture would be declared if one is ever
   * genuinely warranted, and a plugin author reading it should see that
   * the choice was made, not that it was never considered.
   */
  entry: "doubleClick";
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
   *  swap).
   *
   *  These are the context's OWN panels. There is deliberately no sibling
   *  field naming the SHARED host panels a context serves (ADR-023), and
   *  the reason is worth stating because the gap looks like an omission:
   *  a plugin naming `paged.layers` here would be host-panel IDENTITY in
   *  plugin code — the exact coupling binding providers removed from the
   *  value lane — and it could drift from `provides`, which is the only
   *  declaration that decides who actually answers. The host infers
   *  "serves" from `BindingProviderScope` instead (DESIGN.md §18.12).
   *
   *  WHAT THE HOST GUARANTEES, corrected 2026-08-05: it OPENS these. It
   *  raises them too, EXCEPT when raising would displace a panel the
   *  entering context's own binding providers serve — because in a dock
   *  that shows one panel at a time, "raise mine" IS "hide the shared
   *  one", and hiding it at the instant it retargets defeats the whole
   *  point. (This comment used to promise "it does not hide others"
   *  unconditionally; that was never true in such a dock.) A withheld
   *  raise still opens the tab, so the surface is reachable either way. */
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
  /** A plain wheel over the ACTIVE context's frame, in frame-content
   *  points. Return `true` when the context scrolled its own content (a
   *  sheet's in-frame grid window) — the canvas then does not pan;
   *  `false` keeps the host's pan. Cmd/Ctrl wheel is the host's zoom and
   *  never reaches here. Optional: absent ⇒ the canvas always pans. */
  onContentWheel?(e: ContentWheelEvent): boolean;
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
  /** Labels for the host's Edit-menu items while this context owns undo
   *  (e.g. "Undo Brush Stroke"). `null` or absent ⇒ the host's generic
   *  label. Read when the menu renders, so return the current step. */
  undoLabel?(): string | null;
  redoLabel?(): string | null;
  /** Editor ADR 285 — this context's OWN step list, for the host's History
   *  panel while the context is active (its pixel steps, say, where the
   *  document's would not change). `null` or absent ⇒ the panel lists the
   *  document's steps. Read when the panel renders and again after every
   *  {@link onDidChangeHistory} notification. Probe
   *  `supports("editContext.historySteps@1")`: true when the host's
   *  History panel reads it. */
  historySteps?(): EditContextHistory | null;
  /** Editor ADR 285 — notify the host whenever {@link historySteps} would
   *  answer differently. Returns the unsubscribe. Absent ⇒ the panel reads
   *  the list again only when the document changes. */
  onDidChangeHistory?(listener: () => void): () => void;
  /** HOST-STAMPED, not author-supplied: the `x-paged:<manifest id>`
   *  metadata key the host resolves the candidate's `metadata` from
   *  before calling `matches`. The SDK adapter fills this from the
   *  bundle's manifest at registration; authors leave it undefined. */
  metadataKey?: string;
}

/** Editor ADR 285 — an edit context's own history ({@link
 *  EditContextContribution.historySteps}). */
export interface EditContextHistory {
  /** Undo steps, OLDEST first: the last one is what an undo reverts. */
  undo: readonly string[];
  /** Redo steps, the next redo first. */
  redo: readonly string[];
  /** Walk the history `delta` steps: negative undoes `-delta` steps,
   *  positive redoes `delta`. The History panel calls it with the distance
   *  from the current position to the row clicked. */
  step(delta: number): void | Promise<unknown>;
}

/** The live handle a context's `onEnter` / `onExit` receives — the
 *  element entered on + the context type, a clonable snapshot. */
export interface EnteredEditContext {
  type: string;
  /** The element the context was entered on (the write-scope root). */
  id: ElementId;
  /**
   * W-19 — WHERE the pointer entered, when the entry was a pointer
   * (the double-click, or the Type-tool click on plugin-owned content).
   * All three are absent for an entry with no pointer
   * (`host.shell.enterEditContext`) and on `onExit`.
   *
   * Without them a context that edits by pointer had to make the user
   * click a SECOND time after the double-click before anything landed
   * where they pointed (a caret in a web frame, a cell in a sheet).
   *
   * Probe `supports("editContext.enterPoint@1")`: true only when the host
   * shell fills these on a pointer entry. On a host where it is false the
   * fields are always absent and the context places its own default.
   */
  /** The page the pointer was on. */
  pageId?: PageId;
  /** The pointer in PAGE-LOCAL points (origin = the page's top-left), the
   *  space `hitTest` and the tool-preview shapes use. */
  pagePoint?: [number, number];
  /** The pointer in FRAME-CONTENT points — the same mapping and origin
   *  as `ContentPointerEvent.contentPoint` (the frame's content transform
   *  inverted, origin = the content-box top-left), so a context hands it
   *  straight to the code that handles `onContentPointerDown`. Absent
   *  when the point falls outside the content box or the frame's
   *  transform is singular. */
  contentPoint?: [number, number];
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

/** A wheel delivered to the ACTIVE edit context (`onContentWheel`).
 *  `delta` is the scroll in frame-content points — the screen delta
 *  divided by the camera scale, line/page modes normalised to pixels
 *  first — x right / y down, the same axes as `contentPoint`. */
export interface ContentWheelEvent {
  /** Pointer in frame-content points (origin = the content-box top-left). */
  contentPoint: [number, number];
  /** The frame the active context edits (the stack's scope root). */
  elementId: string;
  /** Scroll amount in frame-content points [x, y]. */
  delta: [number, number];
  modifiers: { shift: boolean; alt: boolean; cmd: boolean; ctrl: boolean };
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
/** A menu entry a plugin places in the host's menu bar.
 *
 *  WHY THIS EXISTS. Until it did, the contract had eleven contribution
 *  types and no way to reach the menu bar, so a plugin command's only
 *  host-wide home was the command palette — where the row shows the raw
 *  command id where every other application puts the key, and where
 *  nobody ever sees two creation verbs side by side. That is how six
 *  content types came to teach six different creation idioms (Insert /
 *  Place / Import, plus a `lowerToFrame` that is compiler vocabulary for
 *  the step that puts the sheet on the page). The host had begun
 *  hand-curating entries on plugins' behalf, which works and does not
 *  scale: the host has to know each plugin by name.
 *
 *  TWO SCOPES, because there are two different problems and either one
 *  alone leaves the other standing.
 *
 *  `"document"` is the front door: the entry is in the bar whenever a
 *  document is open, which is what makes a content type discoverable to
 *  someone who has not met it yet.
 *
 *  `{ editContext }` is the in-context surface: the entry exists only
 *  while that edit context is active. This is the larger gap. Inside a
 *  `vectorGraphic` the draw plugin has ~92 relevant commands; inside a
 *  `sheet` the tool rail is deliberately EMPTY and the plugin still has
 *  sort, find-and-replace and cell-style verbs — and in both the menu
 *  bar shows the host's own menus, about the document the user stepped
 *  out of. The shell already scopes the tool rail (`toolIds`) and the
 *  Window menu (`panelIds`) to the active context; this is the same
 *  idea applied to the third surface, and it lands on machinery that
 *  already exists.
 */
export interface MenuContribution {
  /** Slash-separated path, as the host's own menu items use.
   *  `"Object/Insert web frame…"`, `"Sheet/Sort range…"`. A path whose
   *  first segment names an existing menu merges into it; a new first
   *  segment inserts a new top-level menu. */
  path: string;
  /** Command id this entry invokes. Must be a command the bundle has
   *  registered — the host refuses an entry pointing at nothing, on the
   *  same principle the tool rail refuses a dead slot: an affordance
   *  that accepts a click and silently does nothing is worse than an
   *  absent one, because the user reads it as their own mistake. */
  command: string;
  /** Lower floats up within the group. Default 100. */
  order?: number;
  /** Separator group; items sharing one cluster together. */
  group?: string;
  /** When the entry is in the bar.
   *
   *  `"document"` — whenever a document is open.
   *  `{ editContext }` — only while that context is active.
   *
   *  Defaults to `"document"`, because an entry nobody can find is the
   *  problem this exists to solve. */
  scope?: "document" | { editContext: string };
  /** How a context-scoped menu meets the host's own menus.
   *
   *  `"augment"` (the default) leaves every host menu live alongside it.
   *  `"replace"` hides the host's document-level menus that the context
   *  cannot serve.
   *
   *  paged.doc is the case that forces this to exist: it hands the tool
   *  rail back to the HOST's type and select tools, because a DOCX
   *  lowers to real text frames and real stories, so the host's Type and
   *  Edit menus genuinely still apply inside it. A door that only knew
   *  how to replace would be right for `sheet` and `webFrame` and wrong
   *  for precisely the one plugin whose content is native. */
  mode?: "augment" | "replace";
}

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
  /**
   * Register a MENU ENTRY. See {@link MenuContribution} for the two
   * scopes and why both are needed. The path's first segment may name an
   * existing host menu (merging into it) or a new one.
   */
  menu(contribution: MenuContribution): Disposable;
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
   * Register a FRAME SURFACE (extensions ADR 334): a live DOM surface the
   * host mounts exactly over the frame while this bundle's edit context
   * `contextType` is active on it. See {@link FrameSurfaceContribution}.
   * The context must already be registered by this bundle (the surface
   * borrows its declaration). Probe `supports("editContext.frameSurface@1")`
   * — false when the host wires no frame-surface registry (the door then
   * warns and registers nothing).
   */
  frameSurface(contribution: FrameSurfaceContribution): Disposable;
  /**
   * Register a PRESENTATION (extensions ADR 345, C1): a full-screen
   * surface the host shows on `host.shell.present({ id })`, on the
   * editor's screen, in a window of its own, or as a console with an
   * audience window. See {@link PresentationContribution}. The id must be
   * listed in `contributes.presentations[]`. Probe
   * `supports("shell.present@1")` for a host that can show it (the door
   * warns and registers nothing on one that cannot).
   */
  presentation(contribution: PresentationContribution): Disposable;
  /**
   * Register a module VIEW (extensions ADR 345, C5): a work surface that
   * replaces the canvas while `host.shell.showView(id)` shows it (a slide
   * sorter). See {@link ViewContribution}. The id must be listed in
   * `contributes.views[]`. Probe `supports("shell.views@1")`.
   */
  view(contribution: ViewContribution): Disposable;
  /**
   * Register a SUB-CONTEXT PROVIDER (extensions ADR 349, C6): while the
   * edit context `editContext` is active, or is the document context, a
   * double-click on a page is offered to `resolve` before the host's own
   * handling; a {@link SubContextSpec} answer enters that header, footer
   * or note in place (editor ADR 301). The context must be registered by
   * this bundle (the provider borrows its declaration). Probe
   * `supports("shell.subContext@1")` (without the host's registry the door
   * warns and registers nothing).
   */
  subContextProvider(contribution: SubContextProviderContribution): Disposable;
  /**
   * Register a CONTROL-BAR GROUP (extensions ADR 348, C1): a segment of
   * the host's control bar shown while the edit context `scope` names is
   * active. See {@link ControlBarGroupContribution}. The id is
   * namespaced; the scope borrows the context's declaration
   * (`contributes.editContexts[]`) and the context must be registered by
   * this bundle. Probe `supports("contribute.controlBarGroup@1")` for the
   * door and `supports("controlBar.groups@1")` for a host that renders
   * it (without one the door warns and registers nothing).
   */
  controlBarGroup(contribution: ControlBarGroupContribution): Disposable;
  /**
   * Register a STATUS-BAR ITEM (extensions ADR 348, C3), shown while the
   * edit context `scope` names is active. Same gates as
   * {@link controlBarGroup}; probe `supports("contribute.statusItem@1")`
   * and `supports("statusBar.items@1")`.
   */
  statusItem(contribution: StatusItemContribution): Disposable;
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
   * Register a BINDING PROVIDER (ADR-023 phase A): while the edit
   * context named by `contextType` is ACTIVE, this bundle resolves what
   * the HOST's own panels bind to — typed property paths, named
   * collections, and first refusal on structural mutation ops. Reads and
   * writes both.
   *
   * This is the inversion the panel-duplication problem needs: instead
   * of minting a fourth Layers panel, a bundle serves the ONE host
   * Layers panel's values for its own content type. See
   * binding-provider.ts for the three-lane shape, the core-vocabulary-
   * only rule, and the precedence model.
   *
   * LIFETIME is borrowed, not declared: `contextType` must be a type
   * this SAME bundle already registered through `contribute.editContext`
   * (an unregistered type is refused loudly — a provider that can never
   * activate is a bug, not a stance). The capability gate is that
   * context's: `contributes.editContexts[]` must declare the type. There
   * is deliberately NO separate manifest field and NO separate
   * capability — the authority a provider exercises is the authority the
   * active context already holds over the selection it owns.
   *
   * Always present. When the host wires no shared registry, the door
   * warns + returns an inert handle (nothing will ever consult the
   * provider) and `supports("bindings.provider@1")` is false; probe
   * `supports("contribute.bindingProvider@1")` for whether this SDK has
   * the door at all.
   */
  bindingProvider(
    contextType: string,
    provider: BindingProvider,
  ): BindingProviderHandle;
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
  /**
   * Contribute this bundle's OBJECT MODEL (ADR 323, DESIGN.md §21): its
   * object kinds — typed schema rows plus `list` / `get` / `set` / `batch`
   * handlers — and typed commands. Every kind becomes addressable as
   * `plugin:<manifest.id>/<kind>/<id>` through `host.objects` (and so from
   * bindings, Boa, the Node CLI and schema-driven panel fields), headless
   * and outside any edit context.
   *
   * Capability-gated: every kind must be declared in
   * `contributes.objectModel.kinds[]` and every command in
   * `contributes.objectModel.commands[]`; a kind with no schema rows, a row
   * whose type is not a `ValueType`, or a duplicate path is refused loudly.
   * Probe `supports("contribute.objectModel@1")`.
   */
  objectModel(model: ObjectModelContribution): ObjectModelHandle;
}

/** The scene-layer surface (C-1) returned by `contribute.sceneLayer()`.
 *  `elementId` is the host `Self` id of the frame to render into. */
export interface SceneLayerSurface extends Disposable {
  /**
   * Submit (replacing any previous) the vector layer for `elementId`.
   *
   * Protocol 68 — a text item draws in the face it names: `family` plus
   * `style` (IDML `FontStyle` spelling, `"Bold Italic"`) or, when `style`
   * is absent, `weight` (CSS `100..900`, also the `wght` of a variable
   * face) and `italic`. The engine resolves the face through the fonts the
   * host registered for the document; a family that does not resolve draws
   * in the document default font and is listed in the result's
   * `fontFallbacks`. Probe `supports("rendering.sceneLayer.faces@1")`.
   */
  submit(elementId: string, layer: SceneLayer): Promise<SceneLayerSubmitResult>;
  /** Clear the layer for `elementId` (returns the frame to native
   *  content). */
  clear(elementId: string): Promise<void>;
  /**
   * Make the frame's layer ONE RGBA8 image (protocol 66). Where the host
   * wires the binary lane (`supports("rendering.sceneLayer.binary@1")`)
   * the bytes cross as a `Uint8Array` — no `number[]`, no JSON parse —
   * and only the pages showing the frame repaint. On an older host the
   * SDK falls back to `submit()` with an image item; the bundle calls
   * the same method either way. Replaces any previous layer.
   */
  submitImage(
    elementId: string,
    image: SceneImage,
    options?: SceneImageSubmitOptions,
  ): Promise<void>;
  /**
   * Patch rectangles of the image this surface last `submitImage`d for
   * `elementId` (a brush stroke dirties a window, not the image). Rejects
   * when no image was submitted for the element. A tile outside the
   * image, or a byte count that does not match `width*height*4`, rejects
   * the whole call and changes nothing.
   */
  submitImageTiles(
    elementId: string,
    tiles: readonly SceneImageTile[],
    options?: SceneImageSubmitOptions,
  ): Promise<void>;
}

/** What {@link SceneLayerSurface.submit} reports (protocol 68). */
export interface SceneLayerSubmitResult {
  /** The faces this layer's text items named that the engine could not
   *  resolve, each drawn in the document default font instead
   *  (`"Family Style"`, report order). Empty when every named family
   *  resolved, when the layer names none, and on a host that does not
   *  report (no scene channel, or an older editor). */
  readonly fontFallbacks: readonly string[];
}

/** One whole RGBA8 image for {@link SceneLayerSurface.submitImage}. */
export interface SceneImage {
  /** Tightly packed RGBA8, row-major, `width*height*4` bytes. */
  rgba: Uint8Array;
  /** Pixel width of the buffer. */
  width: number;
  /** Pixel height of the buffer. */
  height: number;
  /** Destination `[x, y, w, h]` in frame-content points. */
  dest: [number, number, number, number];
}

/** One rectangle of new pixels for
 *  {@link SceneLayerSurface.submitImageTiles}; the origin is in IMAGE
 *  pixels of the submitted image. */
export interface SceneImageTile {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Tightly packed RGBA8, `width*height*4` bytes. */
  rgba: Uint8Array;
}

/** How the bytes of a scene-image submission are handed over. */
export interface SceneImageSubmitOptions {
  /** `true`: the buffers are TRANSFERRED to the host and are detached
   *  (unusable) in the bundle afterwards — no copy. Default `false`: the
   *  host copies, and the bundle keeps its buffers. */
  transfer?: boolean;
}

// ------------------------------------------------------- images (C-6)
//
// The renderer RESOURCE-PROVIDER door (C-6 / I-06; the v44 wire). A
// bundle CLAIMS a placed image's pyramid: it tells the renderer how the
// image is tiled (levels / tile size / base extent) and hands a `source`
// callback. The renderer PULLS tiles it needs at composite time (it
// knows the visible rect + scale; the bundle knows the pixels) — a pull
// seam keyed by element id, NOT a plugin push (push would re-invent
// damage tracking on the wrong side of the wire). The SDK adapter owns
// the needed → source → submit plumbing: on a `resourceTilesNeeded`
// event it calls `source(level, x, y)` for each missing tile, batches the
// results, and submits them (echoing the generation); the bundle supplies
// only `source` + `revision`. Capability-gated on `capabilities.rendering`
// ∋ `"resourceProvider"`. Probe `supports("rendering.resourceProvider@1")`
// — false when the host wires no resource channel (the door then warns +
// no-ops). Disposing a claim releases it (the renderer drops to the
// whole-image fallback lane).

/** One pyramid tile the bundle's `source` callback returns (C-6). `rgba`
 *  is tightly packed RGBA8 (`width*height*4` bytes, row-major); `[x, y]`
 *  is the tile's origin in LEVEL-space px (the provider's grid origin at
 *  that mip level). Returning `null` is the honest "no pixels for this
 *  tile yet" answer — the renderer keeps the best cached/fallback level. */
export interface TileBytes {
  /** Tile origin x in level-space px. */
  x: number;
  /** Tile origin y in level-space px. */
  y: number;
  /** Pixel width of the buffer. */
  width: number;
  /** Pixel height of the buffer. */
  height: number;
  /** Tightly packed RGBA8, row-major (`width*height*4` bytes). */
  rgba: Uint8Array;
}

/** What `host.images.claimImageResource` is handed (C-6). The first four
 *  fields describe the provider-owned pyramid; `source` serves a tile,
 *  `revision` is a monotonic damage signal (bump it and the renderer
 *  re-pulls — same etag discipline as the data provider). */
export interface ImageResourceClaimOptions {
  /** Number of mip levels the provider serves (0 = full res; each level
   *  halves). */
  levels: number;
  /** Tile edge in level-space px (the grid step). */
  tileSize: number;
  /** Natural pixel width of the level-0 image. */
  baseWidth: number;
  /** Natural pixel height of the level-0 image. */
  baseHeight: number;
  /** Serve one tile at pyramid `level` whose origin is `(x, y)` in
   *  level-space px, or `null` when the provider has no pixels for it
   *  yet (the renderer holds the fallback level). Invoked by the SDK
   *  adapter for each tile the renderer reports needing. */
  source(level: number, x: number, y: number): Promise<TileBytes | null>;
  /** The current content revision — a monotonic counter the SDK sends
   *  on claim; bump the value your closure returns and re-claim (or rely
   *  on the renderer's damage) to invalidate. */
  revision(): number;
}

/**
 * The renderer resource-provider door (C-6 / I-06). A bundle claims a
 * placed image's tiled mip pyramid; the renderer pulls tiles at the
 * level its current scale needs. The SDK adapter owns the
 * needed → source → submit plumbing (the bundle supplies only the
 * `source` + `revision` callbacks). Always present — when the host wires
 * no resource channel, `claimImageResource` warns + returns an inert
 * Disposable and `supports("rendering.resourceProvider@1")` is false (the
 * honest no-provider door). Capability-gated: `capabilities.rendering`
 * must include `"resourceProvider"`.
 */
export interface ImagesSurface {
  /** Claim `elementId`'s image resource (the v44 wire's `image_id`). The
   *  renderer registers the claim and pulls tiles as it composites;
   *  disposing the returned handle releases the claim (the renderer drops
   *  to the whole-image fallback lane). */
  claimImageResource(
    elementId: string,
    opts: ImageResourceClaimOptions,
  ): Disposable;
}

// ------------------------------------------------------------- workers

// The WORKER door (K-3 / S-07 / I-02). A bundle spawns a host-owned
// worker — it never touches `new Worker()` directly (mirrors every other
// host door: the SDK owns the primitive, the manifest gates it, the host
// can budget + tear down). The worker module is DECLARED-ONLY (a
// bundle-relative path, like the wasm artifacts) — a bundle can't spawn
// an arbitrary URL. The worker gets NO ambient authority (no engine/DOM/
// network handle); a `SharedArrayBuffer` is a separate bundle-owned
// allocation the host budgets (a per-bundle ceiling). The host facade
// tracks every spawned worker for automatic teardown on bundle dispose.
// Capability-gated on `capabilities.workers`. Probe
// `supports("workers@1")` — false when the host wires no `WorkerBackend`
// (the door then rejects spawns honestly).

/** Options for `host.workers.spawn` (K-3). `module` is a bundle-relative
 *  path the host resolves through the bundle's own asset base (the same
 *  `/@fs/`-allowed sibling path the wasm artifacts use) — never an
 *  arbitrary URL. `name` is an optional debug label. */
export interface SpawnWorkerOptions {
  /** Bundle-relative path to the worker module (an ES-module worker — JS
   *  or wasm-bindgen worker glue). Resolved through the bundle's asset
   *  base; a bundle can only spawn a module it ships. */
  module: string;
  /** Optional debug label (surfaced in the host log / devtools). */
  name?: string;
}

/**
 * A host-spawned, bundle-owned worker (K-3). Talk over `post`/`onMessage`
 * (structured-clone, optional transfer); `allocateShared` hands back a
 * host-budgeted `SharedArrayBuffer` (or `null` when SAB is unavailable or
 * the bundle didn't declare `sharedMemory` / would exceed its budget).
 * `terminate` stops the worker — and the host runs it automatically on
 * bundle dispose, so a bundle that forgets to terminate still leaks
 * nothing (the platform-honesty smoke test by construction).
 */
export interface BundleWorker {
  /** Post a message to the worker (structured-clone; `transfer` moves
   *  ownership of the listed transferables, e.g. an `ArrayBuffer`). */
  post(message: unknown, transfer?: Transferable[]): void;
  /** Subscribe to messages FROM the worker. Dispose to stop listening
   *  (and free the listener); all subscriptions drop on `terminate`. */
  onMessage(handler: (message: unknown) => void): Disposable;
  /**
   * Allocate a `SharedArrayBuffer` of `bytes` for zero-copy hand-off,
   * host-budgeted against the per-bundle shared-memory ceiling. Returns
   * `null` when the bundle did not declare `capabilities.workers.
   * sharedMemory`, the environment is not cross-origin-isolated (SAB is
   * unconstructible), or the request would exceed the budget — the
   * honest, frequent answer. Pass the returned buffer through `post` to
   * share it with the worker.
   */
  allocateShared(bytes: number): SharedArrayBuffer | null;
  /** Stop the worker + drop its listeners. Idempotent; also run by the
   *  host on bundle dispose. */
  terminate(): void;
}

/**
 * The capability-gated WORKER door (K-3 / S-07 / I-02). `spawn` resolves
 * a bundle-relative `module`, constructs a host-owned `Worker`, and tracks
 * it for automatic teardown. Always present — when the host injects no
 * `WorkerBackend`, `spawn` REJECTS honestly (no worker realm to give) and
 * `supports("workers@1")` is false. Capability-gated:
 * `capabilities.workers` must be declared (the host gate throws on an
 * undeclared spawn); the granted worker-count cap is
 * `min(declared.max, hardwareConcurrency, 8)` (read it via `concurrency`).
 */
export interface WorkersSurface {
  /** Spawn `opts.module` (a declared, bundle-relative path) as a
   *  host-owned `BundleWorker`. Rejects when the use is undeclared
   *  (capability gate), the host wired no backend, the count cap is
   *  reached, or the module fails to resolve/construct. */
  spawn(opts: SpawnWorkerOptions): Promise<BundleWorker>;
  /** The granted worker-count cap (`min(declared.max, hardwareConcurrency,
   *  8)`, or 0 when undeclared / no backend) — a bundle sizes its pool to
   *  this rather than guessing. */
  concurrency(): number;
}

// ------------------------------------------------------------- modules
//
// The MODULE door (ADR 326): a bundle resolves one of its DECLARED
// `capabilities.wasm` artifacts through the HOST, which may serve the bytes
// from somewhere better than the bundle's own directory — a first-party
// module host (`https://modules.paged.media/<package>/<version>/<path>`,
// immutable per version, brotli-compressed, shared across sites), like a
// shared library resolved by the loader instead of copied next to every
// program. Declared-only: a name the manifest does not list is refused (a
// bundle cannot ask the host for an arbitrary URL). `null` is the ordinary
// answer of a host that does not serve that artifact: the bundle then loads
// its bundle-relative copy, as it always did. Probe `supports("modules@1")`
// — false when the host wires no `ModulesBackend` (every answer is `null`).

/** Where the host serves one declared wasm artifact (`host.modules.resolve`). */
export interface HostedModule {
  /** Absolute URL of the artifact's bytes. */
  url: string;
  /** Subresource Integrity for the bytes (`sha384-…`), or `null` when
   *  neither the manifest nor the host vouches for them. The manifest's own
   *  `integrity` wins; a host answer that contradicts it is refused. */
  integrity: string | null;
  /** The declared artifact the answer is for (straight off the manifest). */
  artifact: WasmArtifact;
}

/**
 * The MODULE door (ADR 326). Resolves a DECLARED `capabilities.wasm`
 * artifact by `name` to a URL the host serves, with Subresource Integrity.
 * Always present — with no host backend every answer is `null` and
 * `supports("modules@1")` is false; the bundle falls back to its
 * bundle-relative URL (plugin-sdk's `resolveWasm` / `fetchWasm` do the
 * fallback). An undeclared name rejects (capability gate).
 */
export interface ModulesSurface {
  /** The host's answer for `name`: URL + integrity, or `null` when the host
   *  does not serve it. */
  resolve(name: string): Promise<HostedModule | null>;
  /** `resolve(name)`'s URL alone, or `null`. */
  url(name: string): Promise<string | null>;
  /** Fetch the hosted artifact — `fetch(url, { integrity })` when an
   *  integrity is known, so a byte that differs fails the fetch instead of
   *  reaching `WebAssembly`. `null` when the host does not serve it. Hand
   *  the response to `WebAssembly.instantiateStreaming` or to a
   *  wasm-bindgen `init({ module_or_path })`. */
  fetch(name: string): Promise<Response | null>;
}

// ------------------------------------------------------------- secrets
//
// The host CREDENTIAL-STORE door (D-11; rfc-credential-store). A
// REFERENCE-ONLY, host-owned secret store for authenticated DB-attach /
// remote data sources. The trust line: a plugin holds `credentialRef`
// STRINGS (e.g. `keychain:source-4`), never secret material — so there is
// DELIBERATELY NO `get()`. Secret bytes never enter the plugin realm; the
// plugin passes the ref to the host attach/fetch door and the HOST injects
// the connection string / Authorization header on its side of the wire
// (the injection point pairs with the D-03 consent door). `set` is the
// only door that takes a secret, and the RFC says "via host UI only" — the
// SDK surface accepts it, but the editor backing PROMPTS the user (the
// reference adapter never persists a plugin-supplied secret silently).
// Capability-gated on `capabilities.secrets`. Probe `supports("secrets@1")`
// — false when the host wires no `SecretStoreBackend` (the door then
// rejects honestly).

/** The secret a `host.secrets.set` carries (D-11). v1 is a connection
 *  string / token / password as a UTF-8 string — opaque to the contract;
 *  the host stores it under the `ref` and injects it at attach/fetch time.
 *  This is the ONLY place a secret value crosses the door, inbound; there
 *  is no outbound read (no `get`). */
export type SecretMaterial = string;

/**
 * The capability-gated, REFERENCE-ONLY credential store (D-11;
 * rfc-credential-store). The plugin maps a source to a `credentialRef`
 * string and asks the host to `set` (prompting the user), `exists`, or
 * `forget` it — but it can NEVER read the secret back. `set` resolves once
 * the host has stored the material (its backing decides whether to prompt;
 * the editor reference backing PROMPTS — "via host UI only"). Always
 * present — when the host injects no `SecretStoreBackend`, `set`/`forget`
 * reject and `exists` answers `false` (the honest no-store door), and
 * `supports("secrets@1")` is false. Capability-gated:
 * `capabilities.secrets` must be declared (the host gate throws on an
 * undeclared use).
 *
 * NOTE: this surface has NO `get`. That absence IS the contract (the
 * trust line — secret bytes never enter the plugin realm); a `get` here
 * would defeat the entire D-11 design.
 */
export interface SecretsSurface {
  /** Store `secret` under `ref` (the editor backing PROMPTS the user — the
   *  RFC's "via host UI only"). Rejects when undeclared (capability gate),
   *  no backend is wired, or the user declines the prompt. The plugin
   *  keeps only the `ref`. */
  set(ref: string, secret: SecretMaterial): Promise<void>;
  /** Does the host hold a secret under `ref`? `false` when none is stored
   *  OR no backend is wired (the honest no-store answer). A bundle uses
   *  this to decide whether a source still needs its credential entered. */
  exists(ref: string): Promise<boolean>;
  /** Forget the secret under `ref` (the source goes inert until re-entered
   *  — the RFC's honest degradation). Idempotent; rejects only when the
   *  door is undeclared (capability gate). A no-op when no backend wired. */
  forget(ref: string): Promise<void>;
}

// ------------------------------------------------------------ document

/** Expected mutation failures are results, not throws — mirroring the
 *  editor's mutate-never-throws convention.
 *
 *  `createdId` is the engine's single-creation answer: for a `batch` it is
 *  only the LAST element the batch minted. `minted` is the whole list, in
 *  mint order — every element a `batch` (or a `duplicateElements`)
 *  created, each with the `bindCreated` handle that named it (`null` when
 *  none did) and the story minted alongside it (a text frame's
 *  `ParentStory`, else `null`). Present whenever the engine reported it
 *  (it is additive on the wire; an older engine omits it), so a bundle
 *  placing a frame + table + chart in ONE mutate reads back every id here
 *  instead of re-discovering them with a scene walk.
 *
 *  A page is not an element, so neither `createdId` nor `minted` names one:
 *  `createdPages` lists the pages the mutation created. */
export type MutationOutcome =
  | {
      applied: true;
      createdId: ElementId | null;
      pageIds: PageId[];
      minted?: MintedElement[];
      /** The pages the mutation created, in the order it created them: an
       *  `insertPage`'s page and a `duplicatePage`'s copy, alone or inside
       *  a `batch` (a page the batch deleted again is not listed). Absent
       *  when it created none. Read the new page here instead of diffing
       *  the `pages` collection around the write, which takes two reads
       *  and yields the new pages in document order rather than per
       *  insert. */
      createdPages?: PageId[];
      /** The engine's sequence number of this write (the wire's
       *  `mutationApplied.appliedSeq`), when the host knows it. A script
       *  host bridge reports it back as `HostObjectsResult.committed` so
       *  the write folds into the script's undo step (protocol 71). */
      appliedSeq?: number;
    }
  | { applied: false; error: unknown };

/** Options of {@link DocumentSurface.mutate}. */
export interface MutateOptions {
  /**
   * Engine ADR 1004 — apply the mutation INTO the undo step this number
   * names instead of as a step of its own: one undo reverts both, one redo
   * replays both. The number is the `appliedSeq` of the change that
   * committed that step ({@link DocumentChangeEvent.appliedSeq}, or a
   * previous {@link MutationOutcome}'s `appliedSeq`). The write a change
   * provokes — rebuilding what an edit invalidated — joins the edit this
   * way, so it neither clears the redo stack nor needs an undo of its own.
   *
   * Refused (`applied: false`, nothing applied; `error` is the engine's
   * `{ error: { kind: "notAmendable", details } }`) once that step is no longer the last in the undo
   * history, or an undo or a redo ran since. The outcome's `appliedSeq`
   * names the amended step from then on: a further write amends THAT
   * number. Probe `supports("document.mutate.amend@1")` first: an older
   * host does not know the option and would apply the mutation as a step
   * of its own.
   */
  amend?: number;
  /**
   * Engine ADR 1030 — the undo step's name, in the caller's words ("Add
   * caption"), shown by the History panel and the Edit menu instead of
   * the engine's default for the mutation ("Insert text frame"). With
   * `amend` it renames the amended step. Blank keeps the default. The host
   * names the step right after the write lands (the engine's `labelStep`),
   * so a write that loses a race to another one keeps the default name.
   * Probe `supports("document.undoLog@1")`: an older host ignores it.
   */
  label?: string;
}

/** Engine ADR 1030 — one named step of the undo timeline. */
export interface UndoLogStep {
  /** The step's number — what {@link DocumentSurface.undoTo} /
   *  {@link DocumentSurface.redoTo} take, and the `appliedSeq` of the
   *  change that made it. */
  appliedSeq: number;
  /** The step's name: the caller's label, or the engine's English default
   *  ("Move", "Change fill", "Insert path"). */
  label: string;
  /** The key the engine derived a default from (`moveFrame`,
   *  `set:fillColor`, `gesture:rotate`, `batch`, `script`) — a host
   *  translates the defaults it knows by it. `null` when a caller named the
   *  step. */
  key: string | null;
}

/** Engine ADR 1030 — the named undo timeline ({@link DocumentSurface.undoLog}). */
export interface UndoLog {
  /** OLDEST first: the last step is what an undo reverts. */
  undo: readonly UndoLogStep[];
  /** The next redo first. */
  redo: readonly UndoLogStep[];
  /** The whole logs' lengths (the lists may be cut to the limit). */
  undoLen: number;
  redoLen: number;
  /** How many undo steps the engine keeps (oldest evicted first). */
  depth: number;
}

/** Options of {@link DocumentSurface.mutateWithBytes}. */
export interface MutateWithBytesOptions {
  /** Hand the buffer to the host instead of copying it; it may be detached
   *  afterwards. Default `false`. */
  transfer?: boolean;
  /** Engine ADR 1004 amendment — join the undo step this `appliedSeq`
   *  names, exactly as {@link MutateOptions.amend} does for `mutate`: one
   *  undo reverts both, a refusal is `applied: false` with the engine's
   *  `notAmendable`, and the outcome's `appliedSeq` names the step from
   *  then on. Probe `supports("document.mutate.amend@2")`: an older host
   *  ignores the option and would apply the write as a step of its own. */
  amend?: number;
  /** Engine ADR 1030 — the undo step's name, as {@link MutateOptions.label}
   *  (without `amend`). Probe `supports("document.undoLog@1")`. */
  label?: string;
}

/** What {@link DocumentSurface.onWillSave} listeners receive. */
export interface WillSaveEvent {
  /** The container being written. */
  format: "paged";
}

/**
 * One committed change to the document's content — one step in its history.
 * `kind` names what committed it (the engine's own reply kind):
 *
 * - `mutationApplied` — a `mutate`: a bundle's write, a panel field, a command;
 * - `undoApplied` / `redoApplied` — an undo or a redo;
 * - `gestureCommitted` — a canvas gesture (a frame dragged, resized or
 *   rotated by its handles) committed on the engine (0.2.55);
 * - `scriptResult` — a `paged.*` script that wrote finished (0.2.55). On an
 *   engine from 0.71.13 (0.2.58, `document.onDidChange@3`) a script that only
 *   read is no change, and `pageIds` are the pages its writes changed. On an
 *   older engine the reply names neither, so every script run is a change,
 *   `pageIds` is empty and `pagesUnknown` is set: treat every page as changed.
 *
 * A host from before 0.2.55 reports the first three only; probe
 * `supports("document.onDidChange@2")` for the full set.
 */
export interface DocumentChangeEvent {
  kind:
    | "mutationApplied"
    | "undoApplied"
    | "redoApplied"
    | "gestureCommitted"
    | "scriptResult";
  /** The pages whose content the change touched (empty: none, unless
   *  `pagesUnknown`). */
  pageIds: PageId[];
  /** Set when the host cannot say which pages changed (a script run on an
   *  engine older than 0.71.13): `pageIds` is then empty and any page may
   *  have changed. */
  pagesUnknown?: true;
  /** Content-box reflow (protocol v38, C-2/S-05): present ONLY when the
   *  change RESIZED a frame's content box — never on a pure transform
   *  (move/scale/rotate is display-only, §8.5). A pagination consumer
   *  re-splits on this and ignores transform-only changes (where it is
   *  absent). The engine reports it for a `resizeFrame` mutation and, from
   *  0.71.13 (`document.onDidChange@3`), for a `gestureCommitted` that
   *  resized ONE frame by its handles. A resize of several frames at once
   *  carries none, as a batch of `resizeFrame`s does not; nor does a
   *  gesture commit on an older engine, so a consumer that follows frame
   *  sizes there re-reads geometry on a gesture commit. */
  reflow?: { frameId: string; contentBox: [number, number, number, number] };
  /** Engine ADR 1004 — the engine's number of the undo step this change
   *  committed: present on a `mutationApplied` and a `gestureCommitted`
   *  where the host knows it (`supports("document.mutate.amend@1")`),
   *  absent on an undo and a redo. On a `scriptResult` it is present when
   *  the run's writes are ONE step that may still be joined
   *  (`supports("document.mutate.amend@2")`; a run is one undo step):
   *  absent when the run moved the history (`paged.undo()`) or an edit made
   *  while it waited on the host split it. Pass it as
   *  `mutate(…, { amend })` to make a follow-up write part of the same
   *  step. A change with `kind` `undoApplied` / `redoApplied` moved the
   *  history: a listener that rebuilds on edits leaves those alone, since
   *  the undo or redo already restored what the rebuild had written. */
  appliedSeq?: number;
}

/** W-22 — what `document.onDidOpen` reports: the new document's page
 *  structure, a clonable snapshot of the engine's load reply. */
export interface DocumentOpenedEvent {
  /** The engine's id for the loaded document. */
  docId: string;
  pageCount: number;
  /** Page ids in document order. */
  pageIds: PageId[];
  /** Per-page `[width, height]` in points, the same order as `pageIds`. */
  pageSizesPt: [number, number][];
}

/** One link in a text-frame thread (protocol v38, C-2/S-05). `next` is
 *  the following frame's id (null at the tail); `overflow` marks the tail
 *  frame as overset (story content past the chain end). */
/** D-01 — one tagged placeholder field (`requestDocumentPlaceholders`
 *  item): its address (story + run-start offset), the owning plugin id,
 *  the placeholder key, and the resolved value (`null` = unresolved —
 *  the field displays its `<key>` token). */
export interface DocumentPlaceholder {
  storyId: string;
  offset: number;
  plugin: string;
  key: string;
  value: string | null;
}

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
/**
 * DOC-03 (protocol v54) — a story's full CONTENT: its paragraphs → runs → text +
 * applied styles + direct character overrides. Where `collection<StorySummary>
 * ("stories")` gives only counts, this gives the decoded text + formatting a
 * content plugin needs to read an EDITED document back (e.g. paged.doc diffs it
 * against its import baseline to drive edited save-back). Field names mirror the
 * engine's `CharacterRun`/`Paragraph`; each `null`/absent override = inherit.
 */
export interface StoryContent {
  selfId: string;
  paragraphs: ParagraphContent[];
}

/** DOC-03 — one paragraph's applied style + its runs. */
export interface ParagraphContent {
  paragraphStyle?: string | null;
  runs: RunContent[];
}

/** DOC-03 — one run's text + applied character style + direct overrides. A run
 *  styled only through an applied style carries just `characterStyle`. */
export interface RunContent {
  text: string;
  characterStyle?: string | null;
  font?: string | null;
  fontStyle?: string | null;
  pointSize?: number | null;
  fillColor?: string | null;
  underline?: boolean | null;
  strikethru?: boolean | null;
  capitalization?: string | null;
  baselineShift?: number | null;
  position?: string | null;
  tracking?: number | null;
  /** The text variable this run is an instance of (its id), when it is one;
   *  `text` is the variable's current value. */
  textVariable?: string | null;
}

/**
 * B-22 (protocol v57) — one FACE of a planar arrangement: a connected
 * region of the plane whose containment signature is constant. This is
 * the level BELOW element hit-testing (the areas overlapping paths
 * divide the plane into), which is what a Shape Builder needs.
 *
 * Coordinates are in the RAW path space `pathAnchors` reports —
 * per-element `itemTransform`s are NOT composed in (the arrangement runs
 * on the anchors as stored, exactly like `pathfinderBoolean`). A consumer
 * that draws faces on canvas maps them with the frontmost input's
 * `itemTransform`, the same chain the anchor overlays use.
 */
export interface PlanarFace {
  /** Stable id (`"<signature>#<component>"`, e.g. `"0-1#0"`) — stable
   *  across calls with the same inputs, which is what lets a hovered
   *  face's id ride straight into the `pathfinderFaces` mutation
   *  (mutations.ts) without a second query. */
  id: string;
  /** Indices into the REQUEST's `elementIds` whose interior contains
   *  this face. */
  signature: number[];
  /** The face outline (closed). A face with holes carries them as extra
   *  contours. */
  anchors: PathAnchorTriple[];
  /** Per-contour boundaries into `anchors`. */
  subpathStarts: number[];
  /** Unsigned area, outer contour minus holes. */
  area: number;
  /** A point strictly inside the face — what a hover highlight or a fill
   *  drop keys off without re-deriving containment. */
  inside: [number, number];
}

/**
 * B-22 (protocol v57) — the full result of `document.planarRegions`.
 *
 * Deliberately NOT a bare face array: the door has THREE distinct
 * answers a caller must be able to tell apart, and flattening them
 * would make a refusal indistinguishable from "these paths divide into
 * nothing":
 *   · `found: true` — `faces` is the answer (possibly empty: a point
 *     query outside every input);
 *   · `found: false` + `reason` — a REFUSAL (no document, an id that
 *     doesn't resolve, more inputs than the kernel's cap, or a host
 *     whose engine predates the door). Never a truncated answer;
 *     surface the engine's own words, never an empty face list.
 *   · `complete: false` — the listed faces are all REAL but do not tile
 *     the union of the inputs (the enumeration missed a sliver). Always
 *     `true` for a point query — one face is not a tiling claim.
 */
export interface PlanarRegionsResult {
  /** `false` ⇒ the query could not be answered at all; read `reason`. */
  found: boolean;
  /** Populated when `found`. With a `point` in the request this holds at
   *  most one face (empty ⇒ the point is outside every input). */
  faces: PlanarFace[];
  /** How many inputs the arrangement was built from. */
  inputCount: number;
  /** `true` when the resolved faces tile the union of the inputs. */
  complete: boolean;
  /** Why `found` is false — the engine's own words (or the host
   *  adapter's, when no v57 engine answered). Absent on success. */
  reason?: string | null;
}

/** One swatch's on-screen colour (`DocumentSurface.swatchDisplay`). */
export interface SwatchDisplay {
  id: string;
  /** Display colour, `#rrggbb`, after the document's colour management. */
  rgbHex: string;
  /** The swatch's IDML colour model (`process`, `spot`, …). */
  model: string;
  /** CMYK percent when the swatch is CMYK or has a CMYK alternate. */
  cmyk: [number, number, number, number] | null;
  outOfGamut: boolean;
}

/** `document.importSvg` options (engine ADR 1031). */
export interface SvgImportRequest extends SvgImportOptions {
  /** The page to import onto; the active page when absent. */
  pageId?: PageId;
}

/** `document.importSvg`'s answer. */
export interface SvgImportResult {
  /** Whether the import's batch applied (one undo step). */
  applied: boolean;
  /** The batch's outcome: its `minted` items, the last one the
   *  import's top item. Absent when nothing applied. */
  outcome?: MutationOutcome;
  /** What was approximated or left out. */
  report: SvgReport;
  /** Why nothing applied: an unreadable file, an empty drawing, a
   *  refused batch, a host without the door. */
  error?: string;
}

/** `document.exportSvg`'s request (engine ADR 1031). */
export interface SvgExportRequest extends SvgExportOptions {
  /** The page; the active page when absent. */
  pageId?: PageId;
  /** Nothing but these items, the view box fitted to them. */
  elementIds?: readonly ElementId[];
}

/** `document.exportSvg`'s answer. */
export interface SvgExportResult {
  /** The SVG document, or `null` with `error`. */
  svg: string | null;
  report: SvgReport;
  error?: string;
}

export interface DocumentSurface {
  /** The single write door. Accepts `MutationInput` — the vendored
   *  `Mutation` union PLUS the protocol-ahead ops the vendored wire
   *  hasn't absorbed yet (see mutations.ts). Widening an accepted
   *  input is additive: every `Mutation` still passes. */
  mutate(
    mutation: MutationInput,
    options?: MutateOptions,
  ): Promise<MutationOutcome>;
  /**
   * Protocol 66 — the same write door as {@link mutate}, with image bytes
   * that cross as a `Uint8Array` instead of a JSON `number[]`. `bytes` goes
   * to the FIRST `replaceImageBytes` in `mutation` whose `bytes` is `[]`
   * (depth-first through a `batch`), so a baked image and the
   * `setPluginMetadata` that describes it commit as one undoable step:
   *
   * ```ts
   * await host.document.mutateWithBytes(
   *   { op: "batch", args: { ops: [
   *     { op: "replaceImageBytes", args: { elementId, bytes: [] } },
   *     { op: "setPluginMetadata", args: { elementId, key, value } },
   *   ] } },
   *   png,
   *   { transfer: true },
   * );
   * ```
   *
   * A mutation with no such slot is refused (`applied: false`) rather
   * than applied without the bytes. Same gates and outcome as `mutate`:
   * `capabilities.document.write`, metadata only under this plugin's own
   * key, never a throw. `options.transfer: true` hands the buffer to the
   * host, which may detach it; the default copies. `options.amend` joins
   * the write to an existing undo step, as `mutate`'s does.
   *
   * Call it unconditionally. Where the host wires the binary lane,
   * `supports("document.mutateBinary@1")` is true and the bytes are not
   * converted; otherwise the SDK splices `Array.from(bytes)` into the slot
   * and takes the `mutate` path (the size limit of the JSON channel then
   * applies).
   */
  mutateWithBytes(
    mutation: MutationInput,
    bytes: Uint8Array,
    options?: MutateWithBytesOptions,
  ): Promise<MutationOutcome>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /**
   * Engine ADR 1030 — the named undo timeline: the newest `limit` undo
   * steps (oldest first) and redo steps (next redo first); all of them
   * without a limit. A read: `capabilities.document.read`. Probe
   * `supports("document.undoLog@1")`; an older host rejects.
   */
  undoLog(options?: { limit?: number }): Promise<UndoLog>;
  /**
   * Engine ADR 1030 — undo every step down to and including the step
   * `appliedSeq` names (an {@link UndoLog.undo} entry), in one engine round
   * trip; the document is then as it was before that step. `false` when
   * that step is not on the undo log (nothing moved). A write door:
   * `capabilities.document.write`. Probe `supports("document.undoLog@1")`.
   */
  undoTo(appliedSeq: number): Promise<boolean>;
  /** Engine ADR 1030 — redo every step up to and including the step
   *  `appliedSeq` names (an {@link UndoLog.redo} entry), in one round
   *  trip. `false` when it is not on the redo log. */
  redoTo(appliedSeq: number): Promise<boolean>;
  collection<T>(name: CollectionName): Promise<readonly T[]>;
  meta(): Promise<DocumentMeta>;
  pathAnchors(id: ElementId): Promise<PathAnchorsResult | null>;
  /** B-19 — the typed element-properties read (every PropertyPath/Value
   *  entry the engine exposes for `id`, the same snapshot panels bind
   *  against). Retires the v0 `host.editor.client.send` escape hatch
   *  the draw fill panel used. `null` for an unknown element. */
  elementProperties(id: ElementId): Promise<ElementProperties | null>;
  /**
   * A document style's properties as the engine resolves them (extensions
   * ADR 336): its own entries plus what it inherits through `BasedOn`, the
   * same snapshot the host's style panels read. A bundle that shows
   * content in a document style draws with these. `null` for an unknown
   * style. Probe `supports("document.styleProperties@1")`.
   */
  styleProperties(
    collection: StyleCollection,
    styleId: string,
  ): Promise<StyleProperties | null>;
  /**
   * How document swatches look on screen (extensions ADR 336): each id's
   * display colour after the document's colour management, so CMYK, spot
   * and Lab swatches show as the canvas shows them, plus the out-of-gamut
   * verdict. Unknown ids are left out. Re-read after a `swatches` change
   * (`document.onDidChange`). Probe `supports("document.swatchDisplay@1")`.
   */
  swatchDisplay(swatchIds: readonly string[]): Promise<SwatchDisplay[]>;
  /**
   * B-22 (protocol v57) — the planar-REGION read door: resolve the faces
   * of the arrangement `elementIds` forms (the areas the overlapping
   * paths divide the plane into, one level below element hit-testing).
   * Retires the v0 `host.editor.client.send({ kind:
   * "requestPlanarRegions" })` escape hatch paged.draw's Shape Builder
   * used.
   *
   * With `point` (in the RAW path space `pathAnchors` reports) it answers
   * ONLY the face under it — the hover query, which costs N
   * point-in-path tests plus one region materialisation instead of a
   * full enumeration. Without it, every face comes back.
   *
   * Pure READ, gated on `capabilities.document.read`. Face ids are stable
   * for the same inputs, so a hovered id is handed straight to the
   * `pathfinderFaces` mutation.
   *
   * Answers the FULL {@link PlanarRegionsResult} — never a bare face
   * array — because a refusal (`found: false` + `reason`: input cap,
   * unresolvable id, or a host whose engine predates the door) must not
   * be readable as "no regions". A host that cannot answer comes back as
   * a refusal with a reason — never a throw (the undeclared-capability
   * gate is the one exception, as on every read door). Probe
   * `supports("document.planarRegions@1")` for whether the facade
   * forwards at all.
   */
  planarRegions(
    elementIds: ElementId[],
    point?: [number, number],
  ): Promise<PlanarRegionsResult>;
  /**
   * v67 (RFI C-68) — snap one page-local point the way the host's own
   * tools do: to the anchors, frame corners and centres of every visible
   * element, the page, the x / y lines through all of them (smart
   * guides), ruler guides, the document grid and the nearest outline,
   * with the session's tolerance and switches. One engine resolver
   * answers the Pen, Direct Selection, a move and this door, so a plugin
   * tool snaps exactly like the host.
   *
   * Leave the path being edited out with `exclude` (`anchors` names the
   * dragged ones; the element's outline is then skipped too, since the
   * host is previewing a shape the engine has not seen), and add the
   * points of a path still being drawn with `extraPoints`.
   *
   * Pure READ, gated on `capabilities.document.read`. Never throws: a
   * host whose engine predates v67 answers the point unsnapped
   * (`snapped: false`). Probe `supports("document.snapPoint@1")`.
   */
  snapPoint(query: SnapPointQuery): Promise<SnapPointResult>;
  /** D-01 (protocol v43) — enumerate every plugin-tagged placeholder
   *  field in the document, in story order. Offsets are FRESH-READ
   *  addresses (a placeholder is its own tagged run; re-enumerate
   *  before each write pass — the refresh loop's contract). Writes ride
   *  `mutate`: `insertField` with the `placeholder` FieldKind places
   *  one; `setFieldValue` re-resolves it (one undoable step). */
  placeholders(): Promise<readonly DocumentPlaceholder[]>;
  hitTest(
    pageId: PageId,
    point: [number, number],
    filter?: HitFilter,
  ): Promise<HitResult | null>;
  elementGeometry(ids: ElementId[]): Promise<ElementGeometryItem[]>;
  /**
   * The scene outline: spread → page → page items, a group's members as
   * its `children`. Engine ADR 1010 (`supports("document.clipGroups@1")`):
   * a frame's pasted-in (paste-into) content is listed as ITS `children`
   * too, so every page item of the document is reachable here — a bundle
   * no longer keeps its own index of what it pasted in — and a clip
   * group's row carries `clip: true` (its last child is the clipping
   * path). An older engine lists no pasted-in content.
   */
  tree(): Promise<SceneTreeNode[]>;
  /**
   * C-16 — the per-element PARENTAGE read: the nearest ANCESTOR that is
   * itself an addressable element (a group, or since engine ADR 1010 the
   * frame a page item is pasted into — the two element kinds that nest
   * page items), or `null` when there is none.
   *
   * Consumer: paged.draw's `selectParentGroup` command
   * (`draw-bundle/src/commands/select-parent-group.ts`), which climbs to
   * the containing group on every press. Without this door it re-read
   * `tree()` and walked the WHOLE scene tree per invocation — O(document)
   * per keystroke, a cost its own module header records as a named gap.
   *
   * `null` is the honest answer for three distinct cases a caller need
   * not distinguish: the element is top-level (its container is a Page /
   * Spread, which is NOT an element and never a selection target), the
   * id does not resolve, or the address is a story/table range (those
   * never nest in groups).
   *
   * A pure READ gated on `capabilities.document.read`, resolved from the
   * SAME scene-tree the `tree()` door reads — no extra engine query and
   * no wire op of its own (DESIGN.md §4.3d). The host keeps a parent
   * index and rebuilds it when the document changes, so the O(document)
   * walk happens once per EDIT rather than once per press. It is
   * therefore exactly as fresh as `tree()` and no fresher.
   */
  parentOf(id: ElementId): Promise<ElementId | null>;
  /** Read a text frame's thread topology (protocol v38, C-2/S-05) — the
   *  ordered chain of frames a story flows through, tail-overflow flagged.
   *  Empty when the story has no frame or no document is loaded. A
   *  pagination consumer reads this to know the real host chain (rather
   *  than a caller-supplied one). */
  frameChain(storyId: string): Promise<FrameChainLink[]>;
  /** DOC-03 (protocol v54) — read a story's full content (paragraphs → runs →
   *  text + applied styles + direct overrides), or `null` when the story id
   *  doesn't resolve. Where `collection<StorySummary>("stories")` gives counts,
   *  this gives the decoded text + formatting needed to read an EDITED document
   *  back and diff it (paged.doc edited save-back). Gated:
   *  `supports("document.readStory@1")`; a host without the v54 read backend
   *  throws `PluginApiNotImplemented` (a visible seam, never a fake value). */
  storyContent(storyId: string): Promise<StoryContent | null>;
  /**
   * Engine ADR 1031 (protocol v77) — import an SVG (or SVGZ) file as
   * native page items, as ONE undo step. The engine reads it with usvg
   * (`<use>`, `<defs>`, `<symbol>`, CSS, units and transforms resolved)
   * and lowers it to paths and compound paths, swatches, gradients,
   * groups, clips, opacity masks, placed pictures and text frames; the
   * batch is applied through `mutate` (gated on
   * `capabilities.document.write`). `report` names every construct that
   * was approximated or left out (a filter, an external image, text in a
   * font the document lacks, …).
   *
   * Lands on `options.pageId` (else the active page); `options.origin`
   * is where the drawing's top-left lands (page-local pt; else centred).
   * Never throws: a host or engine without the door answers
   * `{ applied: false, error }`. Probe `supports("document.importSvg@1")`.
   */
  importSvg(
    bytes: Uint8Array,
    options?: SvgImportRequest,
  ): Promise<SvgImportResult>;
  /**
   * Engine ADR 1031 (protocol v77) — a page, or some of its items, as an
   * SVG document: paths with their fills and strokes, linear and radial
   * gradients, opacity and blend modes, clips and masks, pictures as data
   * URIs, and text as outlines or (`options.text: "text"`) as `<text>`
   * naming its font. With `elementIds` the view box fits what they draw.
   * Pure READ, gated on `capabilities.document.read`. Never throws: an
   * engine without the door answers `{ svg: null, error }`. Probe
   * `supports("document.exportSvg@1")`.
   */
  exportSvg(request?: SvgExportRequest): Promise<SvgExportResult>;
  /**
   * Every committed change to the document, whatever committed it: a
   * mutation, an undo or redo, a canvas gesture's commit, a script run
   * (see {@link DocumentChangeEvent} for the kinds). A gesture still in
   * flight, a cancelled one and a script suspended on the host's objects
   * are not changes, nor (from engine 0.71.13) a script that only read.
   * Gated on `capabilities.document.read`. Probe
   * `supports("document.onDidChange@2")`: a host without it reports
   * mutations, undos and redos only. `document.onDidChange@3`: the host
   * passes a gesture's `reflow` and a script's pages through when the
   * engine sends them.
   */
  onDidChange(listener: (e: DocumentChangeEvent) => void): Disposable;
  /**
   * W-22 — a document became the active one: opened from a file, created
   * with File ▸ New, or loaded by a plugin through `host.nativeDocument`.
   * Fires AFTER the engine holds the new document, so the listener can
   * read it (parts, metadata, collections) straight away.
   *
   * A bundle that keeps per-document state (a render cache, a parts
   * index) resets it here. Before this door the only way to hear it was
   * the raw client `documentLoaded` message through `host.editor`.
   *
   * Gated on `capabilities.document.read`, like `onDidChange`. Probe
   * `supports("document.onDidOpen@1")`. A document already open when the
   * bundle activates is NOT replayed: read it at activation.
   */
  onDidOpen(listener: (e: DocumentOpenedEvent) => void): Disposable;
  /**
   * Called before the host serialises the document to a file; the save
   * WAITS for the returned promise, so a bundle can commit pending state
   * (write parts, bake pixels) first. An error is logged and does not
   * stop the save. Probe `supports("document.onWillSave@1")`: without a
   * host backend the listener is held but never called.
   */
  onWillSave(listener: (e: WillSaveEvent) => void | Promise<void>): Disposable;
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
  /**
   * Protocol 69 — read this plugin's DOCUMENT-scoped metadata envelope
   * (the document's own Label, not a page item's), or `null` when absent
   * or when the engine predates protocol 69. Same implicit key as
   * {@link getMetadata}: `x-paged:<manifest id>`. Probe
   * `supports("document.documentMetadata@1")`.
   */
  getDocumentMetadata(): Promise<PluginMetadataEnvelope | null>;
  /**
   * Protocol 69 — write (or clear, with `null`) this plugin's
   * document-scoped metadata: state that belongs to no frame, such as a
   * data session or the version of this plugin's container parts that is
   * live. One undoable step through `mutate` (engine op
   * `setDocumentMetadata`, which also composes inside a `batch`), engine-
   * gated like {@link setMetadata}. Persisted in a `.paged` document; from
   * protocol 70 an `.idml` export keeps it as a `Properties/Label` entry
   * on the designmap's `Document` (InDesign preserves it verbatim). An
   * engine older than 69 answers `applied: false`.
   */
  setDocumentMetadata(
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
  /** Select as a click does: the host's selection AND the selection box
   *  drawn around it follow. Resolves the ids the engine applied. */
  set(ids: ElementId[], mode?: SelectionMode): Promise<ElementId[]>;
  onDidChange(listener: (ids: ElementId[]) => void): Disposable;
}

export interface ViewportSurface {
  /** Camera snapshot — scale + translation in CSS px, and since v77 the
   *  view rotation (radians, clockwise on screen; absent = 0): the screen
   *  shows `scale · R(rotation) · doc + (tx, ty)`. */
  camera(): { scale: number; tx: number; ty: number; rotation?: number };
  /** Screen px → document pt at the current zoom (the constant-
   *  screen-tolerance idiom every tool needs). */
  pxToPt(px: number): number;
  /** v70 — bring a page into view, fitted to the viewport (a slide
   *  sorter's click, a link to a page). `false` when the page is unknown
   *  or the host can't navigate: probe `supports("viewport.pages@1")`. */
  goToPage(
    pageId: PageId,
    options?: { fit?: "page" | "width" },
  ): Promise<boolean>;
  /** v70 — the page the user is on: the one the viewport's centre is
   *  over, else the nearest (the same page `host.document.meta()`
   *  reports as `activePage`). `null` with no document or no host
   *  backend. */
  activePage(): PageId | null;
  /** v70 — fires when the active page changes (scrolling, zooming,
   *  `goToPage`, a page deleted under it). Never fires without a host
   *  backend. */
  onDidChangeActivePage(listener: (pageId: PageId | null) => void): Disposable;
  /** Bring a range of a story's text into view: the camera moves to the
   *  page and position where the range is laid out, and with
   *  `select: true` (the default) the range becomes the text selection.
   *  The door an outline, a find result or a diagnostic needs to take the
   *  user TO a piece of text. Offsets are story-relative UTF-16 indices,
   *  `start <= end`; an empty range places the caret. `false` when the
   *  story is unknown, the range is not laid out (overset) or the host
   *  can't navigate: probe `supports("viewport.revealText@1")`. */
  revealText(
    range: TextRange,
    options?: { select?: boolean },
  ): Promise<boolean>;
}

/** A range of a story's text, by story id and story-relative offsets. */
export interface TextRange {
  storyId: string;
  start: number;
  end: number;
}

// ----------------------------------------------------------------- render

/** v70 — what `host.render.snapshot` renders. The fields after
 *  `hideItems` are `render.snapshot@2` (extensions ADR 338): an engine
 *  without them draws the whole page as a PNG, and the SDK then answers
 *  `null` for a request whose reply it cannot honour (`clip`, `trim`,
 *  `format: "rgba"`). */
export interface RenderSnapshotOptions {
  /** Width of the image in device pixels, 1 to 8192; the height follows
   *  the page's aspect (the clip's, with `clip`). The engine renders at a
   *  resolution derived from it, so the image can be a pixel off:
   *  `RenderedPage.widthPx` is exact. Required unless `dpi` is given. */
  widthPx?: number;
  /** Items to leave out of this image only (a build step whose shapes
   *  have not appeared yet). The document is not changed and no undo
   *  step is recorded. */
  hideItems?: ElementId[];
  /** @2 — the resolution in pixels per inch (72 = one pixel per pt),
   *  1 to 2400. Wins over `widthPx`. */
  dpi?: number;
  /** @2 — draw nothing but these items, in their stacking order, on a
   *  page otherwise empty: a group draws its members, a container what
   *  is pasted into it, a story (`{ kind: "storyRange" }`) every frame of
   *  its thread. Layout is the page's own: a text wrap from an item left
   *  out still shapes the text. */
  only?: ElementId[];
  /** @2 — draw this region of the page alone, in page pt (`(0, 0)` the
   *  page's top-left; it may reach onto the pasteboard). Grown outward to
   *  whole pixels: `RenderedPage.region` is the region drawn. */
  clip?: RenderRect;
  /** @2 — `"png"` (the default) or `"rgba"`: raw pixels in
   *  `RenderedPage.rgba` instead of a PNG. */
  format?: "png" | "rgba";
  /** @2 — what lies under the content: `"paper"` (white, the default)
   *  or `"transparent"`. */
  background?: "paper" | "transparent";
  /** @2 — with a transparent background, crop the image to the pixels
   *  something was drawn on — an item's stroke and effects included,
   *  which no geometry read reports. `null` when nothing is drawn. */
  trim?: boolean;
}

/** @2 — a rectangle in page pt. */
export interface RenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** v70 — one rendered page. */
export interface RenderedPage {
  pageId: PageId;
  /** The image's own size, within a pixel of the requested width. */
  widthPx: number;
  heightPx: number;
  /** PNG bytes; `createImageBitmap(new Blob([png]))` draws them. Empty
   *  when the request asked for `format: "rgba"`. */
  png: Uint8Array;
  /** The engine's layout generation the image shows: an image with an
   *  older generation than a page's current one is stale. */
  layoutGeneration: number;
  /** @2 — `"rgba"` when `rgba` holds the pixels, else `"png"`. */
  format?: "png" | "rgba";
  /** @2 — `format: "rgba"`: `widthPx × heightPx` pixels, four bytes each
   *  (R, G, B, A), rows top to bottom, STRAIGHT alpha (not
   *  premultiplied) — `new ImageData(new Uint8ClampedArray(rgba.buffer),
   *  widthPx)` draws them. A PNG of a transparent image is straight
   *  alpha too. */
  rgba?: Uint8Array;
  /** @2 — the page region the image covers, in page pt, when the request
   *  had a `clip` or `trim`: the image maps onto it exactly. */
  region?: RenderRect;
}

/** @2 — what `host.render.element` renders. */
export interface RenderElementOptions {
  /** Pixels per inch, 1 to 2400 (default 72: one pixel per pt). */
  dpi?: number;
  /** `"png"` (the default) or `"rgba"`. */
  format?: "png" | "rgba";
  /** `"transparent"` (the default) or `"paper"`. */
  background?: "paper" | "transparent";
  /** How far past the item's geometric bounds, in pt, the image may
   *  reach for its stroke and effects (default 72). The image is trimmed
   *  to what the item draws within that margin. */
  marginPt?: number;
}

/** @2 — one rendered item: a page image of nothing but the item, cropped
 *  to it, with the page region it covers. */
export interface RenderedElement extends RenderedPage {
  region: RenderRect;
}

/**
 * v70 — render a page to an image with the engine's own renderer (CPU),
 * the same pixels the canvas shows: slide thumbnails, a slideshow's
 * frames, a build step's frames. A READ: gated on
 * `capabilities.document.read`. `supports("render.snapshot@1")`;
 * `supports("render.snapshot@2")` adds the region, item, raw-pixel and
 * transparent options and `element` (extensions ADR 338).
 */
export interface RenderSurface {
  /** The page as a PNG, or `null` when the page is unknown or the
   *  engine refused (an invalid width, a region too large, nothing
   *  drawn with `trim`). */
  snapshot(
    pageId: PageId,
    options: RenderSnapshotOptions,
  ): Promise<RenderedPage | null>;
  /** @2 — one item as it draws on its page, alone, cropped to what it
   *  draws (stroke and effects included) at `dpi`: what a rasterize
   *  command, an image layer of a story or a vector smart object needs.
   *  `null` for an unknown item, one on the pasteboard (no page draws
   *  it), one that draws nothing, or an engine without @2. */
  element(
    id: ElementId,
    options?: RenderElementOptions,
  ): Promise<RenderedElement | null>;
  /** Extensions ADR 346 (C2) — a page as LAYERS: the background (the page
   *  without `items` and `hideItems`) and each of `items` alone on a
   *  transparent ground, cropped to what it draws, all at one scale — the
   *  frames a slide show composites and animates. `null` for an unknown
   *  page. `supports("render.layers@1")`. */
  layers(
    pageId: PageId,
    options?: RenderLayersOptions,
  ): Promise<RenderedLayers | null>;
  /** Extensions ADR 342 — a story the DOCUMENT DOES NOT HOLD, laid out by
   *  the engine (its composer, justification, hyphenation and the
   *  document's fonts) in a frame at `story.bounds` on `pageId`, and drawn
   *  alone on a transparent ground, cropped to what it draws within
   *  `marginPt` of the frame. The document is not changed: no undo step,
   *  no item, no id. What paged.image's type layers are made of: their
   *  text lives in the image, the engine draws it. `null` for an unknown
   *  page, a story that draws nothing, or an engine without the door:
   *  `supports("render.story@1")`. */
  story(
    pageId: PageId,
    story: RenderStory,
    options?: RenderStoryOptions,
  ): Promise<RenderedElement | null>;
}

/** Extensions ADR 342 — a story for {@link RenderSurface.story}. Every
 *  absent value is the document's default paragraph style's. */
export interface RenderStory {
  /** The frame, page pt: `[top, left, bottom, right]`. Lines wrap at its
   *  width; text past its bottom is overset and not drawn. */
  bounds: [number, number, number, number];
  paragraphs: RenderStoryParagraph[];
  verticalJustification?: "top" | "center" | "bottom" | "justify";
  /** The first line's baseline this far (pt) below the frame's top: what
   *  places point type exactly on its anchor. Absent: one ascent. */
  firstBaseline?: number;
}

/** Extensions ADR 342 — one paragraph of a {@link RenderStory}. */
export interface RenderStoryParagraph {
  runs: RenderStoryRun[];
  /** IDML's names: `LeftAlign`, `CenterAlign`, `RightAlign`,
   *  `LeftJustified`, `CenterJustified`, `RightJustified`,
   *  `FullyJustified`. */
  justification?: string;
  firstLineIndent?: number;
  leftIndent?: number;
  rightIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  hyphenation?: boolean;
  composer?: "paragraph" | "single";
}

/** Extensions ADR 342 — one run of a {@link RenderStoryParagraph}: text in
 *  one set of character attributes. A `\n` in `text` is a forced line
 *  break. Lengths are pt. */
export interface RenderStoryRun {
  text: string;
  font?: string;
  fontStyle?: string;
  pointSize?: number;
  /** Absent is auto leading. */
  leading?: number;
  /** sRGB, 0 to 255 per channel. Absent is the style's (black). */
  fillRgb?: [number, number, number];
  /** 1/1000 em. */
  tracking?: number;
  baselineShift?: number;
  /** Percent (100 = none). */
  horizontalScale?: number;
  verticalScale?: number;
  /** Degrees. */
  skew?: number;
  underline?: boolean;
  strikethru?: boolean;
  ligatures?: boolean;
  /** IDML's `Normal`, `AllCaps`, `SmallCaps`, `CapToSmallCap`. */
  capitalization?: string;
  /** IDML's `Normal`, `Superscript`, `Subscript`. */
  position?: string;
}

/** Extensions ADR 342 — how {@link RenderSurface.story} draws. */
export interface RenderStoryOptions {
  /** Pixels per inch, 1 to 2400 (default 72: one pixel per pt). */
  dpi?: number;
  /** `"rgba"` (the default) or `"png"`. */
  format?: "png" | "rgba";
  /** How far past the frame, in pt, the pixels may reach (an italic's
   *  overhang, a descender below the last line); default 0. */
  marginPt?: number;
  /** Crop the image to the pixels drawn (default `true`); `false` keeps
   *  the frame's box grown by `marginPt`. */
  trim?: boolean;
}

/** Extensions ADR 346 — what `host.render.layers` renders. */
export interface RenderLayersOptions {
  /** Items drawn as layers of their own (and left out of the
   *  background). A group is one layer with its members. */
  items?: ElementId[];
  /** Items left out of every layer (a hidden build step). */
  hideItems?: ElementId[];
  /** Pixels per pt, 1/72 to 2400/72 (default 1: 72 dpi). */
  scale?: number;
  /** `"bitmap"` (the default where `createImageBitmap` exists, else
   *  `"png"`): decoded `ImageBitmap`s ready to upload as textures;
   *  `"png"` PNG bytes; `"rgba"` straight-alpha pixels. */
  format?: "bitmap" | "png" | "rgba";
  /** How far past an item's geometric bounds, in pt, its layer may reach
   *  for stroke and effects (default 72). */
  marginPt?: number;
  /** Extensions ADR 346, amendment C4 (slide ADR 714) — text frames whose
   *  PARAGRAPHS come back as layers of their own (`RenderedLayers.paragraphs`):
   *  each paragraph the frame shows, the frame's pixels within the band of
   *  that paragraph's lines, so a build can bring a list in paragraph by
   *  paragraph. A frame here is also left out of the background. An empty
   *  paragraph, or one the frame does not show, has no layer.
   *  `supports("render.layers.paragraphs@1")`. */
  paragraphs?: ElementId[];
}

/** One layer of {@link RenderedLayers}. */
export interface RenderedLayer {
  /** The item, or null for the background. */
  id: ElementId | null;
  widthPx: number;
  heightPx: number;
  /** The page region the image covers, in page pt (the whole page for
   *  the background). */
  region: RenderRect;
  /** `format: "bitmap"`. The caller owns it (`close()` when done). */
  bitmap?: ImageBitmap;
  /** `format: "png"`. */
  png?: Uint8Array;
  /** `format: "rgba"`: straight alpha, rows top to bottom. */
  rgba?: Uint8Array;
  /** C4 — a paragraph layer: the paragraph's index in its story
   *  (0-based); `id` is its text frame. */
  paragraph?: number;
}

/** What `host.render.layers` answers. */
export interface RenderedLayers {
  pageId: PageId;
  /** Pixels per pt the layers were drawn at. */
  scale: number;
  /** The engine's layout generation the background shows. */
  layoutGeneration: number;
  background: RenderedLayer;
  /** One per requested item that draws something, in request order. An
   *  item on another page, one that draws nothing, or every item on an
   *  engine without `render.snapshot@2` is left out. */
  items: RenderedLayer[];
  /** C4 — the paragraph layers `paragraphs` asked for: per frame, in story
   *  order. Absent on a host without `render.layers.paragraphs@1`. */
  paragraphs?: RenderedLayer[];
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
 * C-9 — the user's text caret: the story + insertion offset a
 * text-inserting plugin should target (paged.data first-insert
 * placement — without this door a freshly-placed variable field lands
 * at story start, offset 0).
 *
 * `offset` is a story-local content offset in the SAME convention the
 * engine's text mutations consume (`insertText.offset`,
 * `deleteRange.start/end` — the `ContentSelection` addressing: run
 * bytes plus one synthetic `\n` per inter-paragraph boundary), so the
 * value can be passed straight to `host.document.mutate`.
 *
 * The field operations (`insertField.offset`, `setFieldValue`,
 * `placeholders()`) count CHARACTERS with no paragraph separator; the two
 * units agree only inside the first paragraph of ASCII text. To place a
 * field at the caret, pass the caret as `insertField.contentOffset`
 * (protocol 69): the engine converts it against the story at apply time.
 */
export interface TextCaret {
  storyId: string;
  /** Insertion offset (see the offset-convention note above). */
  offset: number;
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
  /**
   * C-9 — read the user's text caret (the active `ContentSelection`),
   * or `null` when no text caret is active OR the host injects no
   * caret reader (probe `supports("text.caret@1")` to tell the two
   * apart). For a collapsed selection this is the caret offset; for a
   * RANGE selection it answers the range START (where a replace
   * inserts). Honest v1 gap: a caret inside a TABLE CELL
   * (cell-qualified selection) answers `null` — cell-local offsets
   * would be misread as story-local body offsets.
   */
  caret(): TextCaret | null;
  /**
   * D-27 — measure MANY strings in one face + size in one host call: the
   * batched {@link measureString}. Resolves one {@link TextMetrics} per
   * input, in input order (an empty input answers `[]` without a host
   * call). Each entry is exactly what `measureString(family, style,
   * texts[i], sizePt)` would answer — same shaper, same fallback face —
   * so a bundle may switch between the two freely.
   *
   * Probe `supports("text.measureStrings@1")`: true when the host serves
   * the batch in ONE round-trip to its shaper. Without it the door still
   * answers (the host fans out to `measureString`, or to the estimate
   * when `text.measure@1` is false), only without the call saving.
   * Measuring once per word was 133 of the 148 host calls of a 57-record
   * paged.data merge.
   */
  measureStrings(
    family: string,
    style: string | null,
    texts: readonly string[],
    sizePt: number,
  ): Promise<TextMetrics[]>;
  /**
   * Extensions ADR 348 (C4) — the user's text SELECTION: the story and the
   * range the caret spans, in the same content-offset convention as
   * {@link caret} (`start == end` is a collapsed caret). `null` when no
   * text is selected, inside a table cell (the v1 gap `caret` documents),
   * or when the host injects no selection reader: probe
   * `supports("text.selection@1")`.
   */
  selection(): TextSelection | null;
  /** Called after the text selection changes (a click, a key, a find).
   *  Inert without a selection reader. */
  onDidChangeSelection(listener: () => void): Disposable;
  /**
   * The EFFECTIVE values the selected text is set with (what its runs and
   * paragraphs resolve to through their styles), one entry per asked path:
   * `{ value }`, `"mixed"` when the selection's runs or paragraphs disagree,
   * or `null` when the path does not read here. A collapsed caret reads the
   * character before it (the one after it at a paragraph start), as a
   * word processor shows the format it will type with. Gated on
   * `capabilities.document.read`. `null` without a selection.
   */
  properties(
    paths: readonly PropertyPath[],
  ): Promise<Partial<Record<PropertyPath, TextPropertyRead | null>> | null>;
  /**
   * Set character and paragraph properties on the selected text in ONE
   * undo step (one batch of the engine's `setElementProperty` on the
   * selection's story range). Paragraph paths apply to every paragraph the
   * selection touches (the caret's paragraph when collapsed); character
   * paths to the selected characters, and at a collapsed caret to the word
   * around it, as Word does (`{ applied: false }` between words: there is
   * nothing to format, and the engine stores no format on an empty range).
   * Gated on `capabilities.document.write`. Probe `supports("text.format@1")`.
   */
  format(properties: readonly TextPropertyWrite[]): Promise<TextFormatResult>;
  /**
   * Apply a paragraph or character STYLE (its `Self` id) to the selected
   * text: the paragraph style to every paragraph the selection touches,
   * the character style to the selected characters (the word at a caret).
   * The same story-range write {@link format} makes, through
   * `appliedParagraphStyle` / `appliedCharacterStyle`; one undo step.
   */
  applyStyle(
    scope: "paragraph" | "character",
    styleId: string,
  ): Promise<TextFormatResult>;
  /**
   * Extensions ADR 348 amendment 1 — the selection in story CHARACTERS
   * (the offsets the story-range paths and the engine's paragraph
   * operations — `setListLevel`, `restartNumbering` — take), converted from
   * the content offsets {@link selection} carries. `null` without a
   * selection or when the story is not readable. Gated on
   * `capabilities.document.read`.
   */
  characterRange(): Promise<TextSelection | null>;
  /**
   * Extensions ADR 348 amendment 1 (engine ADR 1021) — find text: every
   * hit of `spec` in story order (document story order across stories),
   * each in caret offsets (`start` / `end`, what {@link selection} and
   * `viewport.revealText` take) and in characters. Word's specials (`^p`
   * `^t` `^l` `^m` `^?` `^#` `^$` `^^`) work in every mode. A bad pattern
   * answers `error` and no hits. Gated on `capabilities.document.read`;
   * probe `supports("text.find@1")`.
   */
  find(spec: TextFindSpec): Promise<TextFindResult>;
  /**
   * Replace the first hit of `spec` (or every hit with `all: true`) with
   * `replace` (`^p` `^t` `^l` `^&` `^^`, `$1`… in regex mode, `\1`… with
   * wildcards), optionally styled: ONE undo step however many hits (the
   * engine's `findReplace`). `replaced` counts the hits replaced. Nothing
   * matching answers `{ applied: false }`. Gated on
   * `capabilities.document.write`.
   */
  replace(spec: TextReplaceSpec): Promise<TextReplaceResult>;
}

/** Amendment 1 — how a find pattern reads (engine ADR 1021). */
export type TextFindMode = "literal" | "wildcards" | "regex";

/** Amendment 1 — what {@link TextSurface.find} looks for. */
export interface TextFindSpec {
  find: string;
  /** One story; every story when absent. */
  storyId?: string;
  /** Default `"literal"`. */
  mode?: TextFindMode;
  /** Default false (Word's case-insensitive find). */
  matchCase?: boolean;
  wholeWord?: boolean;
  /** Only hits in paragraphs of this paragraph style (its `Self` id). */
  paragraphStyle?: string;
  /** Only hits whose runs all carry this character style. */
  characterStyle?: string;
  /** At most this many hits. */
  limit?: number;
}

/** Amendment 1 — one find hit. */
export interface TextFindHit {
  storyId: string;
  /** `[start, end)` in caret (content) offsets. */
  start: number;
  end: number;
  /** The same hit in story characters. */
  charStart: number;
  charEnd: number;
  /** The paragraph the hit starts in. */
  paragraph: number;
  /** The matched text. */
  text: string;
  /** Up to 30 characters either side, within the paragraph. */
  context: string;
  /** Where the hit starts in `context`, in UTF-8 bytes. */
  contextOffset: number;
}

/** Amendment 1 — what a find answered. */
export interface TextFindResult {
  hits: TextFindHit[];
  /** A pattern the engine could not read. */
  error?: string;
}

/** Amendment 1 — what {@link TextSurface.replace} does. */
export interface TextReplaceSpec extends TextFindSpec {
  replace: string;
  /** Every hit (Replace All); the first only when absent. */
  all?: boolean;
  /** Apply this paragraph style to the replacement's paragraphs. */
  replaceParagraphStyle?: string;
  /** Apply this character style to the replacement. */
  replaceCharacterStyle?: string;
}

/** Amendment 1 — what a replace did. */
export interface TextReplaceResult {
  applied: boolean;
  /** The hits replaced (0 when not applied). */
  replaced: number;
  error?: string;
}

/** C4 — the text selection {@link TextSurface.selection} reads. */
export interface TextSelection {
  storyId: string;
  /** Content offsets (see {@link TextCaret}); `start <= end`. */
  start: number;
  end: number;
}

/** C4 — one effective value of the selected text. */
export type TextPropertyRead = { value: Value["value"] } | "mixed";

/** C4 — one property to set on the selected text. `value` is the wire
 *  `Value` the engine's `setElementProperty` takes for `path`. */
export interface TextPropertyWrite {
  path: PropertyPath;
  value: Value;
  /** `"paragraphs"` sets a CHARACTER path on every character of the
   *  paragraphs the selection touches (a word processor's line spacing,
   *  which the engine holds per character as `characterLeading`). Absent:
   *  a character path covers the selection (the word at a caret). */
  extent?: "paragraphs";
}

/** C4 — what a text format write did. */
export interface TextFormatResult {
  applied: boolean;
  /** Why not, when `applied` is false (no selection, a caret between
   *  words, the engine's refusal). */
  error?: string;
}

// -------------------------------------------------------------- overlay

/** The v0 overlay channel: the shared tool-preview signal (polyline /
 *  rect / path — and, with `supports("overlay.text@1")`, the TEXT
 *  primitive `ToolPreviewText` for on-canvas readouts). Retained
 *  plugin scene layers are the P2 channel — reserved, not faked. */
export interface OverlaySurface {
  setToolPreview(shape: ToolPreviewShape | null): void;
  /**
   * K-9 — publish MANY preview shapes at once (DESIGN.md §4.5a). The
   * single-slot `setToolPreview` is last-write-wins, so a tool could
   * show geometry OR a label, never both: paged.draw's **Measure** trades
   * the frozen line for the frozen readout at pointer-up, and its region
   * **Shape Builder** can highlight one hovered face but not shade the
   * whole collected set. Both trades are named in that bundle's code;
   * this door retires them.
   *
   * ONE SLOT, two writers: this REPLACES whatever the tool-preview slot
   * holds with `shapes` (rendered in array order, first = bottom-most);
   * `null` — or an empty array — clears it, exactly like
   * `setToolPreview(null)`. It is not a second overlay layer (that would
   * resurrect z-ordering and double the teardown paths).
   *
   * Shapes may address DIFFERENT pages: each carries its own `pageId`
   * and the host resolves the page rect per shape.
   *
   * Same `capabilities.rendering` ∋ `"overlay"` gate as
   * `setToolPreview` — one channel, one gate. Probe
   * `supports("overlay.multiPreview@1")`: it is DYNAMIC (unlike the
   * static `overlay.text@1`), true only when the host wired a real
   * multi-shape sink. When it is false the door still works and never
   * throws — it forwards the FIRST shape through the single slot, which
   * is precisely the pre-K-9 behaviour a bundle used to hand-code.
   */
  setToolPreviews(shapes: readonly ToolPreviewShape[] | null): void;
  /**
   * W-20 — a RETAINED overlay layer of this bundle's own: preview shapes
   * that stay on the canvas until the bundle changes or clears them,
   * independent of the tool-preview slot and of every other layer.
   *
   * The tool-preview slot is ONE slot for whichever tool is active, so a
   * bundle drawing two persistent things (a text caret and an outline
   * highlight) had them overwrite each other, and an active tool's
   * preview wiped both. A layer is data only (the same `ToolPreviewShape`
   * vocabulary, no React component), so it works where
   * `contribute.overlay` cannot reach.
   *
   * A bundle may hold several layers. They stack in the order they were
   * CREATED (first = bottom-most) and keep that place across `set` and
   * `clear`; all of them draw below the tool-preview slot. `id` names the
   * layer within the bundle (generated when omitted); asking for an id
   * that is already live throws. Every layer is disposed with the bundle.
   *
   * Same `capabilities.rendering` ∋ `"overlay"` gate as `setToolPreview`.
   * Probe `supports("overlay.layers@1")`: true only when the host renders
   * layers. Without it the handle still works and never throws, but
   * draws nothing.
   */
  layer(id?: string): OverlayLayer;
  /**
   * Extensions ADR 339 — a RETAINED HANDLE SET of this bundle's own:
   * handles the HOST draws (at a constant screen size, like its selection
   * handles) and HIT-TESTS, so a bundle's crop box, gradient endpoints or
   * transform box behave like the host's own chrome without each bundle
   * re-deriving the pixel metrics from the camera.
   *
   * Hit answers come two ways: every pointer event of this bundle's own
   * tools carries `hitHandle` (`{ set, id }`) when the pointer is over a
   * handle of a live set, and `set.hitTest` answers a point directly. A
   * handle's `cursor` becomes the tool's cursor over it, unless the tool's
   * own `cursorAt` answers first.
   *
   * Sets draw on the overlay-layer channel (they stack with the bundle's
   * layers in creation order, below the tool-preview slot) and are
   * disposed with the bundle. `id` names the set (generated when
   * omitted); an id already live throws.
   *
   * Same `capabilities.rendering` ∋ `"overlay"` gate as the other overlay
   * doors. Probe `supports("overlay.handles@1")`: true only when the host
   * renders the handle primitive (`ToolPreviewHandle`) and retained
   * layers. Without it the set still answers `hitTest` and stamps
   * `hitHandle` (that is pure geometry), but draws nothing.
   */
  handles(id?: string): OverlayHandleSet;
}

/** Extensions ADR 339 — the space a handle set's positions are in. */
export type OverlayHandleSpace =
  /** Page-local pt of `pageId` (the tool-preview space). */
  | { pageId: PageId }
  /** The frame-content space of `element`: origin at the frame's
   *  geometric box top-left, x right, y down, through the frame's item
   *  transform (so the handles follow a moved, scaled or turned frame).
   *  The host resolves the frame's geometry when the set is `set`. */
  | { element: ElementId };

/** Extensions ADR 339 — one handle of a set. */
export interface OverlayHandleSpec {
  /** The handle's id within the set (echoed in `hitHandle`). */
  id: string;
  /** Centre, in the set's space. */
  at: [number, number];
  /** What it looks like and how it hits: `square` / `round` / `centre`
   *  draw as `ToolPreviewHandle`; `rotateZone` draws nothing and hits a
   *  larger round area (a rotate band outside a corner). */
  kind: "square" | "round" | "centre" | "rotateZone";
  /** The cursor over it (a `rotateZone` defaults to the host's rotate
   *  cursor). */
  cursor?: CursorSpec;
  /** Hit radius in screen px. Defaults: 6 (square/round/centre), 28
   *  (rotateZone). Handles listed EARLIER win an overlap. */
  hitPx?: number;
  /** Draw it as the handle being dragged. */
  active?: boolean;
}

/** Extensions ADR 339 — a retained handle set (`host.overlay.handles`). */
export interface OverlayHandleSet extends Disposable {
  /** The set's id within the bundle (the `set` of `hitHandle`). */
  readonly id: string;
  /** REPLACE the set's handles. An empty list clears it. */
  set(space: OverlayHandleSpace, handles: readonly OverlayHandleSpec[]): void;
  /** Remove every handle; the set keeps its place in the stack. */
  clear(): void;
  /** The handle under a PAGE-LOCAL point of `pageId` (the space of
   *  `CanvasPointerEvent.pagePoint`), or null. Uses the camera's current
   *  scale for the screen-px radii. */
  hitTest(pageId: string, pagePoint: [number, number]): string | null;
}

// --------------------------------------------------------- transformBox

/** Extensions ADR 339 — a 3×3 projective matrix, ROW-MAJOR on column
 *  vectors: (x, y) ↦ ((m0·x + m1·y + m2)/w, (m3·x + m4·y + m5)/w) with
 *  w = m6·x + m7·y + m8. Affine when the last row is [0, 0, 1]. */
export type ProjectiveMatrix = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Extensions ADR 339 — a quad's corners: NW, NE, SE, SW. */
export type TransformQuad = [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
];

/** The box's mode (Illustrator's touch widget). `freeTransform` reads
 *  the modifiers: a handle scales (Shift proportional, Alt from the
 *  centre), outside a corner rotates (Shift 15°), Cmd/Ctrl on a side
 *  shears, Cmd/Ctrl on a corner distorts, Cmd/Ctrl+Alt+Shift on a corner
 *  is perspective. `constrain` scales proportionally without Shift;
 *  `freeDistort` and `perspective` make a corner drag that. */
export type TransformBoxMode =
  "freeTransform" | "constrain" | "freeDistort" | "perspective";

/** What a drag did. `reference` moved the reference point. */
export type TransformBoxOperation =
  | "move"
  | "scale"
  | "rotate"
  | "shear"
  | "distort"
  | "perspective"
  | "reference";

/** One report of a transform box. */
export interface TransformBoxUpdate {
  /** The map from the box as OPENED to the box now (page-local pt on
   *  both sides). Projective after a distort or perspective drag, affine
   *  otherwise. Apply it to what the box stands for. */
  matrix: ProjectiveMatrix;
  /** The box's corners now (NW, NE, SE, SW), page-local pt. */
  quad: TransformQuad;
  /** The reference point now (the rotation pivot), page-local pt. */
  reference: [number, number];
  mode: TransformBoxMode;
  /** The drag this report comes from; null for a commit or a mode change
   *  with no drag. */
  operation: TransformBoxOperation | null;
}

/** Options of `host.transformBox.open`. */
export interface TransformBoxOptions {
  /** The page the box is on; `quad` is in its page-local pt. */
  pageId: PageId;
  /** The box's corners (NW, NE, SE, SW) — the bounds of what the bundle
   *  transforms (a layer, a selection, a placed item). */
  quad: TransformQuad;
  /** Starting mode (default `freeTransform`). */
  mode?: TransformBoxMode;
  /** Starting reference point (default the box's centre). */
  reference?: [number, number];
  /** One of this bundle's tools to make the active tool while the box is
   *  open, so a command can open a box whatever tool is in hand (the box
   *  hears only the bundle's own tools). */
  toolId?: string;
  /** Every drag step (live preview). */
  onChange?(update: TransformBoxUpdate): void;
  /** The box was committed (Enter, `commit()`, or a double-click
   *  inside it): apply `update.matrix` — once, as ONE undo step. The box
   *  closes. */
  onCommit(update: TransformBoxUpdate): void;
  /** The box was cancelled (Escape, `cancel()`, the bundle disposed):
   *  drop the preview. The box closes. */
  onCancel?(): void;
}

/** A live transform box (`host.transformBox.open`). */
export interface TransformBoxSession extends Disposable {
  /** The current mode. */
  readonly mode: TransformBoxMode;
  /** Switch mode (the widget); reports through `onChange`. */
  setMode(mode: TransformBoxMode): void;
  /** The current report. */
  current(): TransformBoxUpdate;
  /** Commit now (as Enter does). */
  commit(): void;
  /** Cancel now (as Escape does). */
  cancel(): void;
  /** True until commit, cancel or dispose. */
  readonly open: boolean;
}

/**
 * Extensions ADR 339 — a HOST-DRAWN TRANSFORM BOX over a quad the bundle
 * owns. The host draws the box (its eight handles, the rotate zones
 * outside the corners and the reference point), routes the pointer to it,
 * does the gesture math — the same as the host's own Free Transform tool —
 * and reports a 3×3 projective matrix with the mode on every move and on
 * commit. The bundle applies the matrix to its own content (an image
 * layer's pixels, a selection) — the host never touches it.
 *
 * Pointer routing: while a box is open, the pointer events and keys of
 * this bundle's own tools go to the box first (Enter commits, Escape
 * cancels); a press OUTSIDE the box, beyond the rotate zones, reaches the
 * tool as usual. One box per bundle at a time: opening a second cancels
 * the first.
 *
 * Gated on `capabilities.rendering` ∋ `"overlay"` (the box draws on the
 * overlay). Probe `supports("host.transformBox@1")`: true when the host
 * renders the handle primitive; without it the box still routes and
 * reports (the geometry is the SDK's) but nothing is drawn.
 */
export interface TransformBoxSurface {
  open(options: TransformBoxOptions): TransformBoxSession;
  /** The open box, or null. */
  active(): TransformBoxSession | null;
}

/** W-20 — one retained overlay layer (`host.overlay.layer`). */
export interface OverlayLayer extends Disposable {
  /** The layer's id within the bundle. */
  readonly id: string;
  /** REPLACE the layer's shapes, drawn in array order (first =
   *  bottom-most within the layer). Shapes may address different pages.
   *  An empty array clears the layer. */
  set(shapes: readonly ToolPreviewShape[]): void;
  /** Remove the layer's shapes; the layer keeps its place in the stack. */
  clear(): void;
}

// ---------------------------------------------------------------- shell

/** Extensions ADR 348 amendment 1 — how {@link ShellSurface.openPanel}
 *  opens a panel. */
export interface OpenPanelOptions {
  /** The object the panel should edit (an ADR 131 address). */
  target?: string;
}

/**
 * Shell actions the HOST APP injects at `loadBundle` time (the
 * cockpit owns panel placement; the SDK's adapter stays a pure
 * function over the editor handle). When the host app provides no
 * implementation, calls warn and no-op — probe with
 * `host.supports("shell.openPanel@1")`.
 *
 * The two FILE doors are a pair: `pickFile` reads bytes IN (K-5 / S-11),
 * `saveFile` hands bytes OUT (K-10). Both are byte-level by design —
 * no DOM `File`/`Blob` ever crosses the contract — and both answer an
 * honest "nothing happened" value rather than throwing.
 */
export interface ShellSurface {
  /** Open a REGISTERED panel as the active dock tab (the
   *  Window-menu / panel-rail path). Extensions ADR 348 amendment 1:
   *  `options.target` first points a panel that edits one object at it —
   *  an ADR 131 address, e.g. `style:paragraph/ParagraphStyle/Heading 1`
   *  for the host's Style Options (`paged.style-options`); a panel that
   *  takes no target ignores it. */
  openPanel(panelId: string, options?: OpenPanelOptions): void;
  closePanel(panelId: string): void;
  /** Open the host's file picker and resolve to the chosen files' bytes
   *  (read at the host boundary — the contract never leaks a DOM `File`,
   *  so a bundle stays isolate-ready, K-5 / S-11). Resolves to `[]` when
   *  the user cancels OR no picker is wired (the honest no-picker door);
   *  probe `host.supports("shell.pickFile@1")` for the latter. */
  pickFile(options?: FilePickerOptions): Promise<readonly PickedFile[]>;
  /**
   * K-10 — the WRITE half of the picker door: hand the host bytes to
   * deliver to the user's filesystem under `suggestedName` (DESIGN.md
   * §4.5c). The mirror of `pickFile`: bytes cross, never a DOM `File`
   * or a `Blob`, so a bundle stays isolate-ready.
   *
   * Consumer: **paged.image**, which can compute an adjusted
   * PSD/PNG/JPEG but — with `pickFile` READ-only — could only deliver it
   * through the Export Center's exporter registry, so "Save adjusted
   * copy…" was unofferable from the bundle's own panel.
   *
   * Answers `true` when the host ACCEPTED the bytes and handed them to
   * its save path, `false` when it did not — no saver wired (probe
   * `supports("shell.saveFile@1")` to know that up front), the user
   * declined, or the host refused. Never throws: a refused save is a
   * result, like a refused mutation. Honest ceiling: a host backed by
   * the browser's anchor-download cannot observe a user cancel, so
   * `true` means "delivered to the browser's download path", not "a file
   * exists on disk"; a File System Access backing can answer a real
   * `false`.
   */
  saveFile(options: SaveFileOptions): Promise<boolean>;
  /**
   * Enter one of THIS bundle's registered edit contexts on `elementId`
   * programmatically (a panel button, an importer that just placed a
   * frame) — the same stack push a double-click on the frame performs.
   * Throws for a type the bundle did not register. Resolves `false` when
   * the host could not enter (no backend — probe
   * `supports("shell.enterEditContext@1")` — or the element does not
   * exist / is not the context's).
   */
  enterEditContext(type: string, elementId: ElementId): Promise<boolean>;
  /**
   * Leave the ACTIVE edit context if it is one of THIS bundle's: with
   * `commit: true` its `onCommit` runs first, otherwise its `onCancel`,
   * then `onExit` (extensions ADR 334). Answers whether a context was left;
   * `false` when none of this bundle's is active or the host cannot (probe
   * `supports("shell.exitEditContext@1")`).
   */
  exitEditContext(opts: { commit: boolean }): Promise<boolean>;
  /**
   * Extensions ADR 348 — declare that the OPEN DOCUMENT is one of this
   * bundle's content types, or `null` to withdraw it: the document context.
   * A Word document opened as the whole document has no frame to enter,
   * yet it is Word content on every page, so its control-bar groups, scoped
   * keybindings, status items and context-scoped menus must apply wherever
   * the user is in it. They do while no frame-level edit context is
   * active above it. It changes nothing else: the tool rail, the panels
   * and the selection stay the document's.
   *
   * `type` must be an edit context this bundle registered (throws
   * otherwise). The host drops the document context when the document is
   * replaced or closed, and when the bundle is disposed; a bundle sets it
   * again for a document it recognises (on `document.onDidOpen`). Answers
   * whether the host took it: probe `supports("shell.documentContext@1")`.
   */
  setDocumentContext(type: string | null): boolean;
  /**
   * Extensions ADR 345 (C1) — show one of THIS bundle's presentations
   * (throws for an id it did not register). The host hides its chrome
   * and calls the presentation's `render` per surface. Answers whether it
   * is shown and where: a `"secondary"` request whose audience window
   * cannot open falls back to `"screen"` with the console alone. Call it
   * from a user gesture (a key, a click): a browser opens a window and
   * enters full screen only then. `{ presented: false }` on a host
   * without presentations (`supports("shell.present@1")`).
   */
  present(request: PresentRequest): Promise<PresentResult>;
  /** End the presentation shown, if it is one of this bundle's. */
  exitPresent(): Promise<void>;
  /** The presentation shown (any bundle's), or null. */
  presentation(): PresentationState | null;
  /** Fires when a presentation starts or ends (null: ended). */
  onDidChangePresentation(
    handler: (state: PresentationState | null) => void,
  ): Disposable;
  /**
   * Extensions ADR 345 (C5) — show one of THIS bundle's module views in
   * place of the canvas, or give the canvas back (`null`, which also
   * closes another bundle's view). Answers whether it changed; false
   * without views (`supports("shell.views@1")`) or for an unknown id.
   */
  showView(id: string | null): boolean;
  /** The module view shown, or null while the canvas is. */
  activeView(): string | null;
  /** Fires when a view is shown or closed (null: the canvas is back). */
  onDidChangeView(handler: (id: string | null) => void): Disposable;
  /**
   * Extensions ADR 349 (C6) — edit a header, footer or note IN PLACE on a
   * page (editor ADR 301): the host puts the caret into `spec.storyId`,
   * shows it on `spec.pageId`, dims the rest of the page and shows a bar
   * with `spec.commands`; Esc, a click on the body or
   * {@link exitSubContext} leaves. Replaces a sub-context already shown.
   * Answers false without the host's sub-contexts
   * (`supports("shell.subContext@1")`).
   */
  enterSubContext(spec: SubContextSpec): boolean;
  /** Leave the sub-context shown, if it is this bundle's. */
  exitSubContext(): boolean;
  /** The sub-context shown (any bundle's), or null. */
  subContext(): SubContextState | null;
  /** Fires when a sub-context is entered or left (null: left). */
  onDidChangeSubContext(
    handler: (state: SubContextState | null) => void,
  ): Disposable;
}

/** What `ShellSurface.saveFile` delivers (K-10) — the inverse of
 *  {@link PickedFile}, field-for-field, so bytes picked from disk can be
 *  handed straight back after an edit. */
export interface SaveFileOptions {
  /** File name incl. extension the host proposes to the user (it may
   *  sanitize or de-duplicate it — the name is a suggestion, not a
   *  path; a bundle can never target a location). */
  suggestedName: string;
  /** The bytes to write. */
  bytes: Uint8Array;
  /** MIME type for the saved file (same field name as `PickedFile`).
   *  Absent ⇒ the host uses `application/octet-stream`. */
  mimeType?: string;
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

// ------------------------------------------------------------- parts

/**
 * The `.paged` CONTAINER parts door (file-format.md). Per-plugin, NAMESPACED
 * bytes persisted INTO the document container (the `.paged`/IDML package) that
 * TRAVEL WITH THE FILE — unlike `host.blob` (per-browser OPFS, local-only).
 *
 * Paths are RELATIVE to this plugin's own `paged/<plugin-id>/` subtree (the
 * host prepends it; a bundle can neither read nor write another plugin's
 * parts, and `..`/absolute paths are rejected), so a path is typically
 * `<object-id>/<role>.<ext>` — e.g. `o1/spec.json` (spec, canonical JSON),
 * `o1/values.parquet` (source, binary), `o1/chart.svg` (derived). The
 * part-types a plugin persists are declared in `contributes.partTypes`; the
 * container's `manifest.json` binds to that declaration.
 *
 * Always present — when the host wires no container writer (older editor /
 * headless), `read` answers `null`, `list` is `[]`, `write` rejects, and
 * `supports("storage.parts@1")` is false (the honest no-container door).
 */
export interface PartsSurface {
  /** Write/overwrite the part at `path` (relative to this plugin's namespace).
   *  Persisted into the container on the next document save. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Read a part's bytes (the live edit overlay first, else the loaded
   *  container), or `null` if absent. */
  read(path: string): Promise<Uint8Array | null>;
  /** List part paths under `prefix` (relative) — this plugin's namespace only,
   *  returned as relative paths. */
  list(prefix?: string): Promise<string[]>;
  /** Delete the part at `path` (protocol 66, `storage.parts@2`). Resolves
   *  `true` when it existed. A part the loaded file carries is dropped
   *  from the next save, not only hidden. Not undoable, like `write`. */
  delete(path: string): Promise<boolean>;
}

// -------------------------------------------------------------- media

/**
 * Extensions ADR 347 (contract C6) — the MEDIA door. A movie or sound frame
 * (engine ADR 1027) is a rectangle whose placed picture is its poster and
 * whose `frameMedia` property says where its medium is and how it plays.
 * The engine never plays a medium; a bundle that presents the document (a
 * slide show on its presentation surface, ADR 345) reads the medium here and
 * plays it in its own `<video>` / `<audio>` element over the frame.
 *
 * Always present. Without a document, `read` answers `null`; `store`
 * rejects when the host wires no container writer. Probe
 * `supports("document.media@1")`.
 */
export interface MediaSurface {
  /**
   * The medium of frame `id`: its description, and its bytes (a medium kept
   * as a container part, `source.type === "part"`, read from the document)
   * or its URL (a linked one). `null` when `id` names no movie or sound
   * frame. A medium whose part the document lacks answers `bytes: null`.
   * Gated on `capabilities.document.read`.
   */
  read(id: ElementId): Promise<MediaRead | null>;
  /**
   * Keep `bytes` in the document as a media part and answer the source a
   * frame's medium names it by (`{ type: "part", path }`), for a
   * `setElementProperty(id, "frameMedia", …)` write. The part lives in the
   * engine's shared media folder (`paged/core/media/`), named by its content,
   * written once: storing the same bytes again answers the same path, and no
   * bundle can change a stored medium. It travels with the `.paged` file and
   * is not undoable (a part, like `host.parts`). Gated on
   * `capabilities.document.write`.
   */
  store(bytes: Uint8Array, options: MediaStoreOptions): Promise<MediaSource>;
}

/** What {@link MediaSurface.read} answers. */
export interface MediaRead {
  media: MediaItem;
  /** The medium's bytes when it is a part of the document, else null. */
  bytes: Uint8Array | null;
  /** The medium's URL when it is linked, else null. */
  url: string | null;
}

/** Options of {@link MediaSurface.store}. */
export interface MediaStoreOptions {
  /** The medium's type (`video/mp4`, `audio/mpeg`, …): names the part's
   *  extension. */
  mime: string;
  kind?: MediaKind;
}

// ------------------------------------------------------- nativeDocument
//
// The isolate-safe NATIVE-DOCUMENT door (ADR-021 / document-model direction):
// capability-gated read access to the host document's CORE-OWNED native parts
// (the `paged/core/` subtree — the native MODEL + COMPOSITION parts, which a
// plugin can neither write nor namespace under `host.parts`) PLUS the ability
// to LOAD a plugin-produced native/importable package as the active document.
// It forwards to an EDITOR-INJECTED backend (exactly like `host.assets` /
// `assetSource`), replacing the non-isolate `host.editor.client` escape hatch
// for importers/exporters.
//
// Always present — when the host injects no backend, `readModel`/`readComposition`
// answer `null`, `listParts` is `[]`, `open` REJECTS (the honest no-backend
// door), and `supports("document.readNative@1")` /
// `supports("document.openNative@1")` are false. Capability-gated: the reads
// require `capabilities.document.readNative`; `open` requires
// `capabilities.document.openNative`.
export interface NativeDocumentSurface {
  /** Read the core-owned native MODEL part (`paged/core/model/document.pgm`)
   *  bytes, or null if the document carries no native model part. */
  readModel(): Promise<Uint8Array | null>;
  /** Read the core-owned COMPOSITION part (`paged/core/composition/document.pgd`)
   *  bytes, or null if absent. */
  readComposition(): Promise<Uint8Array | null>;
  /** List the container's `paged/core/` native part paths (optionally under a
   *  relative prefix). Empty when the host wires no backend. */
  listParts(prefix?: string): Promise<string[]>;
  /** Replace the active document by loading a native/importable package
   *  (an importer plugin produces these bytes, e.g. from IDML). When the
   *  active document has unsaved edits the host asks the user first (save,
   *  don't save, cancel); when they keep it, nothing changes and the
   *  promise rejects with an error named `AbortError`. */
  open(bytes: Uint8Array): Promise<void>;
}

// ------------------------------------------------------------ documents
//
// D-26 — the capability-gated DOCUMENTS door: serialize the active document
// and replace it with a document the PLUGIN built (paged.data's "Merge to new
// document": clone the template, open the clone, merge into it). The editor
// holds one document at a time, so "a second document" means "replace the
// active one", and that is destructive: like `nativeDocument.open` (an
// importer's door), a plugin-initiated `open` ASKS THE USER FIRST when the
// active document has unsaved edits. Here declining is an ordinary outcome,
// not an error (`{ opened: false, reason: "declined" }`).
//
// Always present — when the host injects no backend both doors reject and
// `supports("documents.open@1")` / `supports("documents.exportPaged@1")` are
// false. Capability-gated on `capabilities.documents`: `export` gates
// `exportPaged` (it reads the WHOLE container, other plugins' parts
// included), `open` gates `open`.

/** Options for {@link DocumentsSurface.open}. */
export interface OpenDocumentOptions {
  /** The opened document's display name (title bar, the Save default)
   *  when its own metadata carries none, e.g. `"Catalog (merged)"`. The
   *  host falls back to a generic name when omitted. */
  name?: string;
}

/** The answer of {@link DocumentsSurface.open}. `declined` means the user
 *  kept the active document (it had unsaved edits and they chose not to
 *  discard them); nothing changed. */
export type OpenDocumentResult =
  { opened: true; pageIds: string[] } | { opened: false; reason: "declined" };

export interface DocumentsSurface {
  /** Serialize the ACTIVE document to `.paged` bytes (the same container
   *  File > Save writes: the IDML entries plus the core model and every
   *  plugin's `paged/<id>/` parts). Feed the bytes to `open` to work on a
   *  copy. Gated on `capabilities.documents.export`. Rejects when no
   *  document is loaded or the host wired no backend. */
  exportPaged(): Promise<Uint8Array>;
  /** Replace the active document with `bytes` (`.paged` or `.idml`).
   *  When the active document has unsaved edits the HOST asks the user to
   *  keep or discard them first and resolves `{ opened: false, reason:
   *  "declined" }` if they keep them. On success the host broadcasts
   *  `documentLoaded` (every bundle sees a document switch, the caller
   *  included) and the opened document starts with an empty undo history
   *  and NO unsaved edits: mutations the caller makes next are what mark
   *  it edited. Gated on `capabilities.documents.open`. Rejects when the
   *  bytes do not load or the host wired no backend. */
  open(
    bytes: Uint8Array,
    options?: OpenDocumentOptions,
  ): Promise<OpenDocumentResult>;
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
  requestConsent(
    origins: readonly string[],
    purpose: string,
  ): Promise<ConsentResult>;
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

// ------------------------------------------------------------ data (data@1)
//
// The DATA door (extensions ADR 343, PM-0015): the document's data as a
// platform layer. One bundle SERVES it (paged.data in the editor: its
// sources, queries and bindings over the engine's store); every other bundle
// READS tables and records, WRITES rows (paged.sheet edits a table) and BINDS
// object properties, without knowing who serves. The host only routes and
// fans out changes. The record shape is the provider shape above, so a
// consumer of `dataProviders@1` reads `data@1` with the same code.

/** One table of the document's data: an imported source or a query. */
export interface DataTableInfo {
  name: string;
  kind: "source" | "query";
  schema: ProviderSchema;
  rowCount: number;
  /** An opaque content etag; it changes whenever the rows do. */
  revision: string;
  /** Whether `write` accepts edits to it (a source table, not a query). */
  writable: boolean;
}

/** A window of a table's rows (`offset` from 0, at most `limit`). */
export interface DataRange {
  offset?: number;
  limit?: number;
}

/** One edit of a table's rows. `row` is the 0-based row of the table as
 *  `records` returned it at the revision the edit was made against. */
export type DataRowEdit =
  | { op: "set"; row: number; field: string; value: unknown }
  | { op: "insert"; values: Readonly<Record<string, unknown>> }
  | { op: "delete"; row: number };

/** What a write left behind. */
export interface DataWriteResult {
  revision: string;
  rowCount: number;
}

/** A binding of one object property to data: `target` is an address or a
 *  selector (ADR 131), `path` a property path of it (ADR 132), `expr` an
 *  expression of the binding language over `query`'s fields. */
export interface DataBindingSpec {
  target: string;
  path: string;
  query: string;
  expr: string;
}

/** A defined binding. */
export interface DataBindingInfo extends DataBindingSpec {
  id: string;
}

/** A table whose rows changed. */
export interface DataChange {
  table: string;
  revision: string;
}

/** What a serving bundle implements (`host.data.serve`). Members it leaves
 *  out are refused for every consumer with the reason. */
export interface DataService {
  tables(): Promise<readonly DataTableInfo[]> | readonly DataTableInfo[];
  records(table: string, range?: DataRange): Promise<ProviderRecordSet>;
  /** One query over the tables, checked by the service's own guard. */
  query?(sql: string): Promise<ProviderRecordSet>;
  write?(
    table: string,
    edits: readonly DataRowEdit[],
  ): Promise<DataWriteResult>;
  bind?(spec: DataBindingSpec): Promise<DataBindingInfo>;
  unbind?(id: string): Promise<void>;
  bindings?(): Promise<readonly DataBindingInfo[]>;
  /** An expression's value at a record of `query`, defining nothing (a bind
   *  popover's live preview, editor ADR 292). */
  evaluate?(
    query: string,
    expr: string,
    record: number,
  ): Promise<DataEvaluation>;
  /** Every binding with its sync state (the Data panel's colour cues). */
  status?(): Promise<readonly DataBindingStatus[]>;
  /** Read the data again and bring the placed content up to date (the Data
   *  panel's Update document). */
  refresh?(): Promise<void>;
  /** Where the bindings are placed: each page item a binding's content lands
   *  in, with the binding's sync state (the canvas field markers, a binding's
   *  instances in the Data panel). */
  placements?(): Promise<readonly DataPlacement[]>;
  /** Place a field on a page item, as dropping it there means (the Data
   *  panel's drag to place): into a text frame a variable, onto a graphic
   *  frame its picture. The service refuses a target it cannot place on. */
  place?(target: string, query: string, field: string): Promise<DataPlaced>;
  /** Place a query's records as a table in a text frame (the Data panel's
   *  table tab dropped on a frame); `fields` picks and orders the columns,
   *  all of them when absent. */
  placeTable?(
    target: string,
    query: string,
    fields?: readonly string[],
  ): Promise<DataPlaced>;
  /** Fill a design with one record (a grid row dropped on a group or a
   *  frame): every `<<field>>` written in its text frames, as Data Merge
   *  reads them, becomes that record's field. */
  placeRecord?(
    target: string,
    query: string,
    record: number,
  ): Promise<readonly DataPlaced[]>;
  /** How the data is made: each source, query and transform with what it
   *  reads, in the order a refresh runs them (the Data panel's pipeline). */
  pipeline?(): Promise<readonly DataPipelineStep[]>;
  /** Define or replace a transform; refused with the reason (a bad source,
   *  an input that does not exist). */
  defineTransform?(def: DataTransformDef): Promise<void>;
  /** Remove a transform; false when there was none. */
  removeTransform?(id: string): Promise<boolean>;
  /** The asset columns: a query's field whose values name pictures, fetched
   *  and run through an action chain before they are placed. */
  assetColumns?(): Promise<readonly DataAssetColumn[]>;
  /** Declare a field an asset column (with its chain), or stop (`null`). */
  setAssetColumn?(
    query: string,
    field: string,
    def: DataAssetColumnDef | null,
  ): Promise<void>;
  /** Each record's state since the content was last placed: new in the
   *  data, changed, unchanged, and how many were removed; and which records
   *  are placed. */
  recordStatus?(query: string): Promise<DataRecordStatus>;
  /** Put sample data in the document (the first run's "Try it with sample
   *  data"): a source and a query over it; the query's name. */
  loadSample?(): Promise<string>;
  /** What may be wrong with the placed content: text that does not fit its
   *  frame (overset), a picture missing or too coarse for its frame, a value
   *  empty or failed, records a flow could not place. Each names where it
   *  is, so the Data panel, the canvas markers and Problems can point there. */
  issues?(): Promise<readonly DataIssue[]>;
}

/** A possible mistake in the content the data placed. */
export interface DataIssue {
  kind:
    | "overset"
    | "missingAsset"
    | "lowResolution"
    | "emptyValue"
    | "error"
    | "unplacedRecords";
  severity: "error" | "warning" | "info";
  /** Said for the user, with what to do about it. */
  message: string;
  /** The binding the content comes from. */
  binding?: string;
  /** The page item it is in (ADR 131 address). */
  address?: string;
  /** The record it shows. */
  record?: number;
}

/** One step of the data's pipeline. */
export interface DataPipelineStep {
  /** The table the step yields. */
  id: string;
  kind: "source" | "query" | "transform";
  /** The tables it reads (none for a source). */
  inputs: readonly string[];
  /** A query's SQL. */
  sql?: string;
  /** A transform's source: `(tables, params) => rows`. */
  source?: string;
  params?: Readonly<Record<string, unknown>>;
  /** Its rows at the last refresh. */
  rowCount?: number;
  /** Why it did not run. */
  error?: string;
}

/** A transform (data ADR 562): JavaScript over tables, giving a table. */
export interface DataTransformDef {
  id: string;
  inputs: readonly string[];
  source: string;
  params?: Readonly<Record<string, unknown>>;
}

/** What an asset column does with its pictures. */
export interface DataAssetColumnDef {
  /** The actions each picture goes through (`actions@1` ids). */
  chain?: readonly ActionStep[];
  /** What a relative reference is resolved against. */
  base?: string;
}

/** An asset column of a query. */
export interface DataAssetColumn extends DataAssetColumnDef {
  query: string;
  field: string;
}

/** A query's records against what was last placed, by record index. */
export interface DataRecordStatus {
  query: string;
  /** Records new in the data. */
  added: readonly number[];
  /** Records whose values changed. */
  changed: readonly number[];
  /** How many placed records are gone from the data. */
  removed: number;
  /** Records whose content is in the document. */
  placed: readonly number[];
}

/** What a placed field became. */
export interface DataPlaced {
  binding: string;
  kind: string;
}

/** One placed instance of a binding: the page item its content lands in. */
export interface DataPlacement {
  /** The binding's id (`DataBindingStatus.id`). */
  binding: string;
  /** The ADR 131 address of the placed page item (`rectangle:u12`,
   *  `textFrame:u3`). */
  address: string;
  status: DataBindingStatus["status"];
  /** The record it shows, for a binding placed once per record. */
  record?: number;
}

/** A binding and its sync state: `linked` (placed and in step with the
 *  data), `stale` (the data changed since it was placed), `pinned` or
 *  `overridden` (kept as it is on purpose), `error`, `unresolved` (not
 *  resolved yet). */
export interface DataBindingStatus {
  id: string;
  kind: string;
  query?: string;
  /** The fields its expressions read. */
  fields: readonly string[];
  status: "linked" | "stale" | "pinned" | "overridden" | "error" | "unresolved";
  message?: string;
}

/** What an expression gives at a record. */
export interface DataEvaluation {
  /** As a field shows it. */
  display: string;
  /** As JSON (`null` when it has none or failed). */
  value: unknown;
  /** The parse or evaluation error. */
  error?: string;
}

/** The handle a serving bundle holds. */
export interface DataServiceHandle {
  /** Announce changed rows; every `onDidChange` listener hears it. */
  changed(change: DataChange): void;
  /** Stop serving; consumers' calls are refused again. */
  dispose(): void;
}

export interface DataSurface {
  /** SERVE side (`capabilities.data.serve`). One service at a time: a
   *  second `serve` while one is live throws. */
  serve(service: DataService): DataServiceHandle;
  /** Whether a service is live (calls below reject when not). */
  available(): boolean;
  /** READ side (`capabilities.data.read`). */
  tables(): Promise<readonly DataTableInfo[]>;
  records(table: string, range?: DataRange): Promise<ProviderRecordSet>;
  query(sql: string): Promise<ProviderRecordSet>;
  /** WRITE side (`capabilities.data.write`). */
  write(table: string, edits: readonly DataRowEdit[]): Promise<DataWriteResult>;
  /** BIND side (`capabilities.data.bind`). */
  bind(spec: DataBindingSpec): Promise<DataBindingInfo>;
  unbind(id: string): Promise<void>;
  bindings(): Promise<readonly DataBindingInfo[]>;
  /** An expression's value at a record of `query` (`read`). */
  evaluate(
    query: string,
    expr: string,
    record: number,
  ): Promise<DataEvaluation>;
  /** Every binding with its sync state (`read`). */
  status(): Promise<readonly DataBindingStatus[]>;
  /** Read the data again and update the document (`bind`). */
  refresh(): Promise<void>;
  /** The page items each binding is placed in (`read`). */
  placements(): Promise<readonly DataPlacement[]>;
  /** Place a field on a page item (`bind`). */
  place(target: string, query: string, field: string): Promise<DataPlaced>;
  /** Place a query's records as a table in a text frame (`bind`). */
  placeTable(
    target: string,
    query: string,
    fields?: readonly string[],
  ): Promise<DataPlaced>;
  /** Fill a design's `<<field>>`s with one record (`bind`). */
  placeRecord(
    target: string,
    query: string,
    record: number,
  ): Promise<readonly DataPlaced[]>;
  /** The sources, queries and transforms, in refresh order (`read`). */
  pipeline(): Promise<readonly DataPipelineStep[]>;
  /** Define or replace a transform (`write`). */
  defineTransform(def: DataTransformDef): Promise<void>;
  /** Remove a transform (`write`). */
  removeTransform(id: string): Promise<boolean>;
  /** The asset columns (`read`). */
  assetColumns(): Promise<readonly DataAssetColumn[]>;
  /** Declare or clear an asset column (`write`). */
  setAssetColumn(
    query: string,
    field: string,
    def: DataAssetColumnDef | null,
  ): Promise<void>;
  /** Each record's state against what was placed (`read`). */
  recordStatus(query: string): Promise<DataRecordStatus>;
  /** Put sample data in the document (`write`). */
  loadSample(): Promise<string>;
  /** Possible mistakes in the placed content (`read`). */
  issues(): Promise<readonly DataIssue[]>;
  /** Fires when a table's rows change (`read`). */
  onDidChange(listener: (change: DataChange) => void): Disposable;
}

// ------------------------------------------------------ actions (actions@1)
//
// The ACTIONS door (extensions ADR 344, PM-0015): named, typed, PURE steps
// any bundle registers and any bundle runs, alone or chained. An action
// computes; it never edits the document (a command may apply its result in
// one undo step). A result is cached under the hash of its input and of the
// chain with its parameters, so running it again computes nothing.

/** What an action takes and gives. `asset` is bytes (`Uint8Array`) with a
 *  media type, `table` a `ProviderRecordSet`, `selection` a snapshot of
 *  addresses, `value` any JSON value. */
export type ActionValueKind = "asset" | "table" | "selection" | "value";

/** An asset as actions pass it. */
export interface ActionAsset {
  bytes: Uint8Array;
  mediaType: string;
}

/** What `run` hands an action besides its input. */
export interface ActionContext {
  /** Aborted when the caller gives up. */
  readonly signal?: AbortSignal;
}

/** An action as its bundle registers it. */
export interface ActionDefinition {
  /** Unique across bundles: `<bundle id>/<name>` by convention. */
  id: string;
  title: string;
  input: ActionValueKind;
  output: ActionValueKind;
  /** The parameters' defaults; also what a picker shows. */
  params?: Readonly<Record<string, unknown>>;
  /** Runs only where its host can (an npm-backed action in paged-node). */
  headlessOnly?: boolean;
  run(
    input: unknown,
    params: Readonly<Record<string, unknown>>,
    context: ActionContext,
  ): Promise<unknown> | unknown;
}

/** A registered action (no code). */
export interface ActionInfo {
  id: string;
  title: string;
  input: ActionValueKind;
  output: ActionValueKind;
  params: Readonly<Record<string, unknown>>;
  headlessOnly: boolean;
}

/** One step of a chain. */
export interface ActionStep {
  action: string;
  params?: Readonly<Record<string, unknown>>;
}

/** What a run gave. `key` is the cache key (input hash + chain hash). */
export interface ActionRunResult {
  output: unknown;
  key: string;
  cached: boolean;
}

export interface ActionsSurface {
  /** `capabilities.actions.register`. An id already registered throws. */
  register(definition: ActionDefinition): Disposable;
  /** Every registered action, or those taking `input`. */
  list(input?: ActionValueKind): readonly ActionInfo[];
  /** `capabilities.actions.run`. */
  run(
    action: string,
    input: unknown,
    params?: Readonly<Record<string, unknown>>,
    context?: ActionContext,
  ): Promise<ActionRunResult>;
  /** Each step's output is the next step's input; the kinds must agree. */
  runChain(
    steps: readonly ActionStep[],
    input: unknown,
    context?: ActionContext,
  ): Promise<ActionRunResult>;
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

// ------------------------------------------------------------- journal
//
// ADR 025. The rule that separates this from `diagnostics` above:
//
//   Diagnostics describe the DOCUMENT. The journal describes the PROGRAM.
//
// A diagnostic is a STATE keyed to a location in the user's content and is
// user-actionable — it belongs in the Problems panel next to that content. A
// journal entry is an EVENT keyed to a moment and is developer-actionable —
// it belongs in a bounded ring the user can inspect and export.
//
// Nothing recorded here is ever transmitted. The host keeps a local ring; the
// user exports it explicitly if they want to attach it to a bug report. It is
// KEPT, not SENT, which is why it is not called telemetry.

/** One entry a bundle contributes to the host's journal.
 *
 *  The host stamps `plugin`, `seq`, `t` and `origin` — a bundle cannot forge
 *  attribution, the same provenance rule `contribute.panel` already applies. */
export interface JournalRecord {
  /** Dotted, and MUST be namespaced under the manifest id — the same
   *  chokepoint as every other contribution id, so an entry is always
   *  attributable. e.g. `media.paged.draw.boolean.union`. */
  code: string;
  severity?: "debug" | "info" | "warn" | "error";
  durMs?: number;
  /** Bounded scalars. String values MUST match
   *  `/^[a-z0-9][a-z0-9._:-]{0,63}$/` — a sentence, a file path, a font
   *  family or any user text CANNOT pass, BY DESIGN. There is deliberately no
   *  free-text field anywhere on this type: that is the field through which
   *  PII leaks in every telemetry system ever built. A rejected value is
   *  dropped and COUNTED, never silently truncated (a truncated path is still
   *  a path). Keep the human sentence in `host.log`, which goes to the
   *  console and is not part of any exported artifact. */
  data?: Record<string, number | boolean | string>;
}

/** The JOURNAL door — a local, in-memory flight recorder.
 *
 *  With no host buffer wired this surface is INERT and
 *  `supports("journal@1")` is false. That means "recording goes nowhere",
 *  never "calling this throws": an instrumentation door that can break the
 *  plugin it instruments is worse than no door. */
export interface JournalSurface {
  record(entry: JournalRecord): void;
  /** Time a thunk (sync or async) and record one entry carrying `durMs` and
   *  `data.ok`. The thunk's own result and exceptions pass through unchanged
   *  — instrumenting a call must not alter what it returns or hide a throw. */
  time<T>(code: string, fn: () => T | Promise<T>): Promise<T>;
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

// ---------------------------------------------------------------- tools

/** A tool-option value as the host's tool-options UI stores it. */
export type ToolSettingValue = number | boolean | string;

/** Read access to the values the host's tool-options UI holds for this
 *  bundle's tools (the fields declared in `ToolContribution.options`).
 *  `toolId` must be one of this bundle's own tool ids. Probe
 *  `supports("tools.settings@1")`: without a host backend `settings`
 *  answers `{}` and `onDidChangeSettings` never fires. */
export interface ToolsSurface {
  settings(toolId: string): Readonly<Record<string, ToolSettingValue>>;
  onDidChangeSettings(
    toolId: string,
    listener: (settings: Readonly<Record<string, ToolSettingValue>>) => void,
  ): Disposable;
}

// ----------------------------------------------------------------- host

/**
 * What `activate(host)` receives. Types from `@paged-media/plugin-sdk/api`,
 * values from here — never import host values into a bundle's module
 * graph.
 */
/** `{name}` parameters of a message. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * `host.strings` (extensions ADR 333). Messages are `{name}`-parameterised
 * text with one plural form (`{count, plural, one {# item} other {# items}}`);
 * a key is `<manifest.id>.<name>`, so bundles cannot collide.
 */
export interface StringsSurface {
  /** The editor's language (BCP 47 tag); `"en"` without one. */
  readonly locale: string;
  /** Defines this bundle's messages with their English text; answers their
   *  keys (`<manifest.id>.<name>`). Defining a key again with other text
   *  throws. */
  define<K extends string>(
    messages: Readonly<Record<K, string>>,
  ): Readonly<Record<K, string>>;
  /** This bundle's translation into `locale`, by key (`<manifest.id>.<name>`);
   *  a key outside the bundle's namespace throws. */
  translate(locale: string, catalogue: Readonly<Record<string, string>>): void;
  /** The message for `key` in the editor's language, else its English. */
  t(key: string, params?: MessageParams): string;
}

export interface BundleHost {
  /** The bundle's own manifest (read-only). */
  readonly manifest: PluginManifest;
  readonly log: PluginLogger;
  readonly contribute: ContributionSurface;
  readonly document: DocumentSurface;
  readonly selection: SelectionSurface;
  readonly viewport: ViewportSurface;
  /** v70 — page images from the engine's renderer (thumbnails, slideshow
   *  frames). `supports("render.snapshot@1")`; gated on document read. */
  readonly render: RenderSurface;
  /** Font measurement against the document's fonts (S-13). A read door,
   *  no capability gate; `supports("text.measure@1")` reports whether the
   *  host wired the engine shaper (it is false under a host that injects
   *  no measurement backend — the headless harness returns an estimate). */
  readonly text: TextSurface;
  readonly overlay: OverlaySurface;
  /** Extensions ADR 339 — the host-drawn transform box over a quad the
   *  bundle owns (`supports("host.transformBox@1")`). */
  readonly transformBox: TransformBoxSurface;
  readonly shell: ShellSurface;
  readonly storage: StorageSurface;
  /** The capability-gated BINARY blob store (K-4 / S-08): OPFS-backed,
   *  per-plugin, quota-bounded bytes for payloads too large for the KV
   *  `storage`. Always present; gated on `capabilities.storage` ∋ blob.
   *  When the host injects no backend, reads answer null / `[]` /
   *  `{used:0,quota:0}`, writes reject, and `supports("storage.blob@1")`
   *  is false (the honest no-store door). */
  readonly blob: BlobSurface;
  /** The `.paged` CONTAINER parts door (file-format.md): per-plugin,
   *  namespaced bytes persisted INTO the document so they TRAVEL WITH THE
   *  FILE (unlike `host.blob`'s per-browser OPFS). Paths are relative to the
   *  plugin's own `paged/<plugin-id>/` subtree. Always present; when the host
   *  wires no container writer (older editor / headless), reads answer
   *  null/`[]`, writes reject, and `supports("storage.parts@1")` is false. The
   *  part-types are declared in `contributes.partTypes`. */
  readonly parts: PartsSurface;
  /** Extensions ADR 347 (C6) — a movie or sound frame's medium: read its
   *  bytes or URL, and keep new media in the document. Always present;
   *  probe `supports("document.media@1")`. */
  readonly media: MediaSurface;
  /** The isolate-safe NATIVE-DOCUMENT door (ADR-021): capability-gated read of
   *  the host document's CORE-OWNED native parts (`paged/core/` MODEL +
   *  COMPOSITION) + loading a plugin-produced native/importable package as the
   *  active document — the isolate-safe replacement for the `host.editor.client`
   *  escape hatch used by importers/exporters. Gated on
   *  `capabilities.document.readNative` (the reads) and
   *  `capabilities.document.openNative` (`open`). Always present; when the host
   *  wires no backend, reads answer null/`[]`, `open` rejects, and
   *  `supports("document.readNative@1")` / `supports("document.openNative@1")`
   *  are false. */
  readonly nativeDocument: NativeDocumentSurface;
  /** D-26 — the capability-gated DOCUMENTS door: serialize the active
   *  document (`exportPaged`) and replace it with plugin-built bytes
   *  (`open`), the host asking the user before unsaved edits are discarded.
   *  Gated on `capabilities.documents` (`export` / `open`). Always present;
   *  when the host wires no backend both doors reject and
   *  `supports("documents.open@1")` / `supports("documents.exportPaged@1")`
   *  are false. */
  readonly documents: DocumentsSurface;
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
  /** The DATA door (extensions ADR 343): the document's tables, records and
   *  bindings, served by one bundle and read, written and bound by any,
   *  gated on `capabilities.data`. Always present; when the host wires no
   *  data backend every call rejects and `supports("data@1")` is false. */
  readonly data: DataSurface;
  /** The ACTIONS door (extensions ADR 344): named pure steps registered by
   *  any bundle and run, alone or chained, by any, with their results
   *  cached; gated on `capabilities.actions`. Always present; when the host
   *  wires no action registry `register` throws, `list` is empty and
   *  `supports("actions@1")` is false. */
  readonly actions: ActionsSurface;
  readonly diagnostics: DiagnosticsSurface;
  /** ADR 025 — the local flight recorder. Probe `supports("journal@1")`
   *  before relying on it reaching a buffer; calling it is always safe. */
  readonly journal: JournalSurface;
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
  /** The words a bundle shows, in the editor's language (extensions ADR
   *  333): the bundle defines its English, may ship translations, and reads
   *  each message through `t`. Without a host catalogue (headless) the
   *  English answers; `supports("strings@1")` says whether the editor's
   *  language is wired. */
  readonly strings: StringsSurface;
  /** The capability-gated RENDERER RESOURCE-PROVIDER door (C-6 / I-06):
   *  claim a placed image's tiled mip pyramid so the renderer pulls tiles
   *  at the level its current scale needs (the v44 wire). The SDK adapter
   *  owns the needed → source → submit plumbing; the bundle supplies the
   *  `source` + `revision` callbacks. Always present — when the host wires
   *  no resource channel, `claimImageResource` warns + returns an inert
   *  Disposable and `supports("rendering.resourceProvider@1")` is false.
   *  Capability-gated on `capabilities.rendering` ∋ `"resourceProvider"`. */
  readonly images: ImagesSurface;
  /** The capability-gated WORKER door (K-3 / S-07 / I-02): spawn a
   *  host-owned, bundle-owned worker (declared-only module, no ambient
   *  authority) + allocate a host-budgeted `SharedArrayBuffer`. Always
   *  present — when the host injects no `WorkerBackend`, `spawn` rejects
   *  honestly, `concurrency()` is 0, and `supports("workers@1")` is false.
   *  Capability-gated on `capabilities.workers`. The host facade tracks
   *  every spawned worker for automatic teardown on bundle dispose. */
  readonly workers: WorkersSurface;
  /** The MODULE door (ADR 326): resolve a DECLARED `capabilities.wasm`
   *  artifact through the host — a URL it serves (a first-party module host,
   *  immutable per version) plus Subresource Integrity. Always present; with
   *  no host backend every answer is `null` (load the bundle-relative copy)
   *  and `supports("modules@1")` is false. An undeclared name rejects. */
  readonly modules: ModulesSurface;
  /** The capability-gated, REFERENCE-ONLY CREDENTIAL STORE (D-11;
   *  rfc-credential-store): `set` (host-UI-prompted) / `exists` / `forget`
   *  a `credentialRef` — and DELIBERATELY NO `get` (secret bytes never
   *  enter the plugin realm; the HOST injects them at the attach/fetch
   *  door). Always present — when the host injects no `SecretStoreBackend`,
   *  `set`/`forget` reject, `exists` is false, and `supports("secrets@1")`
   *  is false (the honest no-store door). Capability-gated on
   *  `capabilities.secrets`. */
  readonly secrets: SecretsSurface;
  /** The capability-gated CLIPBOARD door (K-6 / S-14): read/write the
   *  SYSTEM clipboard with a rich `{ text?, tabular?, svg? }` payload
   *  (the sheets grid's range copy/paste interchange; the vector
   *  interchange, `image/svg+xml`, behind `clipboard.svg@1`). Always
   *  present — when the host app injects no clipboard backend, `read`
   *  answers `null`, `write` is a no-op, and `supports("clipboard@1")` is
   *  false (the honest no-clipboard door). Capability-gated on
   *  `capabilities.clipboard`: `"full"` grants text + tabular + svg,
   *  `"vector"` grants text + svg, `"none"`/absent denies. */
  readonly clipboard: ClipboardSurface;
  /** The tool-settings READ door: the option values the host's
   *  tool-options UI holds for this bundle's tools, plus a change
   *  subscription. Always present; `supports("tools.settings@1")`
   *  reports whether a host store is wired. */
  readonly tools: ToolsSurface;
  /** The OBJECT registry (ADR 323): one `query` / `get` / `set` / `batch` /
   *  `schema` over core addresses and every plugin's contributed kinds.
   *  Always present. Reads are gated on `capabilities.document.read`,
   *  writes on `capabilities.document.write` (a refused write answers
   *  `{ applied: false }`). `supports("objects@1")`; cross-plugin routing
   *  (a SHARED registry the host injected) is `supports("objects.shared@1")`. */
  readonly objects: ObjectsSurface;
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
