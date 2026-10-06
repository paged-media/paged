/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
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
import type {
  BindingProvider,
  BindingProviderHandle,
} from "./binding-provider";
import type { ClipboardSurface } from "./clipboard";
import type { MutationInput } from "./mutations";
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
 *  instead of re-discovering them with a scene walk. */
export type MutationOutcome =
  | {
      applied: true;
      createdId: ElementId | null;
      pageIds: PageId[];
      minted?: MintedElement[];
    }
  | { applied: false; error: unknown };

/** Options of {@link DocumentSurface.mutateWithBytes}. */
export interface MutateWithBytesOptions {
  /** Hand the buffer to the host instead of copying it; it may be detached
   *  afterwards. Default `false`. */
  transfer?: boolean;
}

/** What {@link DocumentSurface.onWillSave} listeners receive. */
export interface WillSaveEvent {
  /** The container being written. */
  format: "paged";
}

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

export interface DocumentSurface {
  /** The single write door. Accepts `MutationInput` — the vendored
   *  `Mutation` union PLUS the protocol-ahead ops the vendored wire
   *  hasn't absorbed yet (see mutations.ts). Widening an accepted
   *  input is additive: every `Mutation` still passes. */
  mutate(mutation: MutationInput): Promise<MutationOutcome>;
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
   * host, which may detach it; the default copies.
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
  collection<T>(name: CollectionName): Promise<readonly T[]>;
  meta(): Promise<DocumentMeta>;
  pathAnchors(id: ElementId): Promise<PathAnchorsResult | null>;
  /** B-19 — the typed element-properties read (every PropertyPath/Value
   *  entry the engine exposes for `id`, the same snapshot panels bind
   *  against). Retires the v0 `host.editor.client.send` escape hatch
   *  the draw fill panel used. `null` for an unknown element. */
  elementProperties(id: ElementId): Promise<ElementProperties | null>;
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
  tree(): Promise<SceneTreeNode[]>;
  /**
   * C-16 — the per-element PARENTAGE read: the nearest ANCESTOR that is
   * itself an addressable element (a group today — the only element kind
   * that nests page items), or `null` when there is none.
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
  set(ids: ElementId[], mode?: SelectionMode): Promise<ElementId[]>;
  onDidChange(listener: (ids: ElementId[]) => void): Disposable;
}

export interface ViewportSurface {
  /** Camera snapshot — scale + translation in CSS px. */
  camera(): { scale: number; tx: number; ty: number };
  /** Screen px → document pt at the current zoom (the constant-
   *  screen-tolerance idiom every tool needs). */
  pxToPt(px: number): number;
  /** v70 — bring a page into view, fitted to the viewport (a slide
   *  sorter's click, a link to a page). `false` when the page is unknown
   *  or the host can't navigate: probe `supports("viewport.pages@1")`. */
  goToPage(pageId: PageId, options?: { fit?: "page" | "width" }): Promise<boolean>;
  /** v70 — the page the user is on: the one the viewport's centre is
   *  over, else the nearest (the same page `host.document.meta()`
   *  reports as `activePage`). `null` with no document or no host
   *  backend. */
  activePage(): PageId | null;
  /** v70 — fires when the active page changes (scrolling, zooming,
   *  `goToPage`, a page deleted under it). Never fires without a host
   *  backend. */
  onDidChangeActivePage(listener: (pageId: PageId | null) => void): Disposable;
}

// ----------------------------------------------------------------- render

/** v70 — what `host.render.snapshot` renders. */
export interface RenderSnapshotOptions {
  /** Width of the image in device pixels, 1 to 8192; the height follows
   *  the page's aspect. The engine renders at a resolution derived from
   *  it, so the image can be a pixel off: `RenderedPage.widthPx` is exact. */
  widthPx: number;
  /** Items to leave out of this image only (a build step whose shapes
   *  have not appeared yet). The document is not changed and no undo
   *  step is recorded. */
  hideItems?: ElementId[];
}

/** v70 — one rendered page. */
export interface RenderedPage {
  pageId: PageId;
  /** The image's own size, within a pixel of the requested width. */
  widthPx: number;
  heightPx: number;
  /** PNG bytes; `createImageBitmap(new Blob([png]))` draws them. */
  png: Uint8Array;
  /** The engine's layout generation the image shows: an image with an
   *  older generation than a page's current one is stale. */
  layoutGeneration: number;
}

/**
 * v70 — render a page to an image with the engine's own renderer (CPU),
 * the same pixels the canvas shows: slide thumbnails, a slideshow's
 * frames, a build step's frames. A READ: gated on
 * `capabilities.document.read`. `supports("render.snapshot@1")`.
 */
export interface RenderSurface {
  /** The page as a PNG, or `null` when the page is unknown or the
   *  engine refused (an invalid width). */
  snapshot(pageId: PageId, options: RenderSnapshotOptions): Promise<RenderedPage | null>;
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
   *  Window-menu / panel-rail path). */
  openPanel(panelId: string): void;
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
   *  (an importer plugin produces these bytes, e.g. from IDML). */
  open(bytes: Uint8Array): Promise<void>;
}

// ------------------------------------------------------------ documents
//
// D-26 — the capability-gated DOCUMENTS door: serialize the active document
// and replace it with a document the PLUGIN built (paged.data's "Merge to new
// document": clone the template, open the clone, merge into it). The editor
// holds one document at a time, so "a second document" means "replace the
// active one", and that is destructive: unlike `nativeDocument.open` (an
// importer's door, reached only after the user chose File > Open and
// confirmed there), a plugin-initiated `open` ASKS THE USER FIRST when the
// active document has unsaved edits. Declining is an ordinary outcome, not
// an error (`{ opened: false, reason: "declined" }`).
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
  | { opened: true; pageIds: string[] }
  | { opened: false; reason: "declined" };

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
  open(bytes: Uint8Array, options?: OpenDocumentOptions): Promise<OpenDocumentResult>;
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
  /** v70 — page images from the engine's renderer (thumbnails, slideshow
   *  frames). `supports("render.snapshot@1")`; gated on document read. */
  readonly render: RenderSurface;
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
  /** The `.paged` CONTAINER parts door (file-format.md): per-plugin,
   *  namespaced bytes persisted INTO the document so they TRAVEL WITH THE
   *  FILE (unlike `host.blob`'s per-browser OPFS). Paths are relative to the
   *  plugin's own `paged/<plugin-id>/` subtree. Always present; when the host
   *  wires no container writer (older editor / headless), reads answer
   *  null/`[]`, writes reject, and `supports("storage.parts@1")` is false. The
   *  part-types are declared in `contributes.partTypes`. */
  readonly parts: PartsSurface;
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
   *  SYSTEM clipboard with a rich `{ text?, tabular? }` payload (the
   *  sheets grid's range copy/paste interchange). Always present — when
   *  the host app injects no clipboard backend, `read` answers `null`,
   *  `write` is a no-op, and `supports("clipboard@1")` is false (the
   *  honest no-clipboard door). Capability-gated on
   *  `capabilities.clipboard`: `"full"` grants text + tabular, `"vector"`
   *  grants text only, `"none"`/absent denies. */
  readonly clipboard: ClipboardSurface;
  /** The tool-settings READ door: the option values the host's
   *  tool-options UI holds for this bundle's tools, plus a change
   *  subscription. Always present; `supports("tools.settings@1")`
   *  reports whether a host store is wired. */
  readonly tools: ToolsSurface;
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
