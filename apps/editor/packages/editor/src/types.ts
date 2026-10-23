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

// The public types of `@paged-media/editor` (docs/adr/PM-0013). The
// implementation is the editor's embedding API (apps/canvas/src/embed); this
// file is its published contract, written out so the declarations a host
// installs name no private package. Wire types come from the engine package,
// `@paged-media/paged`, a dependency. `test/conformance.ts` checks, at
// typecheck, that the implementation fits every type here.

import type {
  ExportPdfWireOptions,
  FieldValue as WireFieldValue,
  Role,
  TemplateFieldProblem,
  TemplateFieldSummary,
} from "@paged-media/paged";

export type {
  ExportPdfWireOptions,
  Role,
  TemplateFieldProblem,
  TemplateFieldSummary,
};

/** A field's value, as the handle takes and gives it. */
export type FieldValue = WireFieldValue;

/** A value `setFieldValues` takes: a field value, or text, or visibility. */
export type FieldInput = FieldValue | string | boolean;

// ── Profiles (docs/composable-editor.md §5) ─────────────────────────────

/** The regions of the editor's chrome a profile fills. */
export type RegionId =
  | "header"
  | "menubar"
  | "context-toolbar"
  | "tool-rail"
  | "left"
  | "canvas"
  | "right"
  | "panel-rail"
  | "mode-bar"
  | "palette"
  | "context-menu"
  | "form"
  | "actions-bar";

/** An entry of a region: an id, a separator, a spacer, a group, or the
 *  element left for a host component (`hostSlot`). */
export type RegionItem =
  | string
  | { readonly kind: "separator" }
  | { readonly kind: "spacer" }
  | {
      readonly kind: "group";
      readonly id: string;
      readonly items: readonly RegionItem[];
    }
  | { readonly kind: "host"; readonly id: string };

export interface RegionSpec {
  readonly items: "all" | readonly RegionItem[];
}

/** An item by id, or by position. */
export type ItemMatcher = string | number;

export type RegionEdit =
  | {
      readonly region: RegionId;
      readonly op: "remove";
      readonly match: ItemMatcher;
    }
  | {
      readonly region: RegionId;
      readonly op: "insert";
      readonly items: readonly RegionItem[];
      readonly before?: ItemMatcher;
      readonly after?: ItemMatcher;
    }
  | {
      readonly region: RegionId;
      readonly op: "set";
      readonly items: readonly RegionItem[];
    };

/** Where a workflow mode puts its panels. */
export interface ModeSlots {
  left: string;
  tabs?: string[];
  inspector?: string;
  canvas?: string;
}

export interface ProfileMode {
  readonly id: string;
  readonly title: string;
  readonly blurb?: string;
  readonly slots?: ModeSlots;
  readonly paletteSuggestions?: readonly string[];
  /** Context menus the mode keeps on the menu bar; `"*"` keeps all. */
  readonly menus?: readonly string[];
}

export interface CanvasFurniture {
  readonly titleBar?: boolean;
  readonly rulers?: boolean;
  readonly thumbnails?: boolean;
}

/**
 * What an editor shows: a preset it extends and what it changes
 * (docs/composable-editor.md §5). Ids are the ones in
 * `@paged-media/editor/feature-ids.json`.
 */
export interface EditorProfile {
  /** The preset this profile starts from (`full`, `template-fill`, …). */
  readonly extends?: string;
  /** Product name: the mode title and the title-bar badge. */
  readonly title?: string;
  readonly blurb?: string;
  /** Plugin bundles to activate, by manifest id; `"all"` for every one. */
  readonly bundles?: "all" | readonly string[];
  /** The editor's own panels; plugin panels arrive with their bundle. */
  readonly panels?: "all" | readonly string[];
  /** Workflow modes; `"all"` keeps the editor's own set. */
  readonly modes?: "all" | readonly ProfileMode[];
  /** Regions. An absent key inherits the preset's; `null` removes it. */
  readonly regions?: Partial<Record<RegionId, RegionSpec | null>>;
  /** Region edits, applied in order after the chain is merged. */
  readonly adjust?: readonly RegionEdit[];
  readonly canvas?: CanvasFurniture;
  /** The size of the document created at start when none is open, in points. */
  readonly documentSizePt?: readonly [number, number];
  /** Suffix that separates this profile's stored layout and mode. */
  readonly storageScope?: string;
  /** Feature switches seeded at start, by feature id or glob. */
  readonly features?: Readonly<Record<string, boolean>>;
  /** The session's role. */
  readonly role?: Role;
}

// ── Features (docs/composable-editor.md §6) ─────────────────────────────

export type FeatureKind =
  "command" | "panel" | "tool" | "menu" | "keybinding" | "overlay" | "chrome";

/** `command:paged.object.lock`, `menu:Window/*`, `chrome:rulers`, … */
export type FeatureId = `${FeatureKind}:${string}`;

/** A rule: on, off, or a predicate over the editor state and the answer
 *  of the rules set before it. */
export type FeatureRule =
  | boolean
  | ((ctx: { id: FeatureId; state: unknown; previous: boolean }) => boolean);

export interface FeatureStore {
  enable(pattern: FeatureId | readonly FeatureId[]): void;
  disable(pattern: FeatureId | readonly FeatureId[]): void;
  /** Sets a rule for an id or a glob (`command:paged.object.*`). */
  set(pattern: FeatureId | readonly FeatureId[], rule: FeatureRule): void;
  /** Removes every rule set for exactly this pattern. */
  reset(pattern: FeatureId): void;
  /** Whether a concrete feature is enabled now. */
  isEnabled(id: FeatureId): boolean;
  /** Shorthand for `isEnabled(\`${kind}:${id}\`)`. */
  allows(kind: FeatureKind, id: string): boolean;
  /** The rules, oldest first. */
  rules(): readonly { pattern: FeatureId; rule: FeatureRule }[];
  /** Fires after any rule changes. */
  onChange(handler: () => void): { dispose(): void };
}

// ── The host ────────────────────────────────────────────────────────────

/** What the host decides (docs/composable-editor.md §8.3). */
export interface HostActions {
  /** Save: the `.paged` bytes, instead of a file write or a download. */
  save?(file: { bytes: Uint8Array; name: string }): Promise<void> | void;
  /** The actions bar's primary button (`paged.host.submit`). */
  submit?(): Promise<void> | void;
  /** Leave the editor (`paged.host.close`). */
  close?(): void;
  /** Go back in the host (`paged.host.back`). */
  back?(): void;
}

export interface EditorConfig {
  /** A preset id (`template-fill`, `viewer`, `solo:draw`, …) or a profile. */
  profile?: string | EditorProfile;
  /** The session's role; overrides the profile's. */
  role?: Role;
  /** The document to open: a `.paged`, `.idml` or template. */
  document?: { bytes: Uint8Array; name?: string };
  /** What the host decides: save, submit, close, back. */
  actions?: HostActions;
  /** Field values to set once the document is open. */
  values?: Readonly<Record<string, FieldInput>>;
  /** The language of the editor's words (`de`); English by default. */
  locale?: string;
  /** The locale's catalogue, when the host supplies it; else the editor's
   *  own, else `<assetBase>/locales/<locale>.json`. */
  messages?: Readonly<Record<string, string>>;
  /**
   * Where the host serves a copy of this package's `dist/` directory, as a
   * URL ending in `/`. Needed only when the host's bundler does not copy the
   * package's files (README, "Assets"): the engine's wasm is then read from
   * `<assetBase>paged_canvas_wasm_bg.wasm`, the default faces from
   * `<assetBase>assets/`, paged.data's engines from `<assetBase>bin/`, and
   * locales from `<assetBase>locales/`.
   */
  assetBase?: string;
  /**
   * The URL of the engine's wasm (`@paged-media/paged/paged_canvas_wasm_bg.wasm`),
   * when the host serves it somewhere of its own. Wins over `assetBase`.
   */
  engineWasm?: string;
  /**
   * Where the editor keeps its settings (theme, workflow mode, dock tabs,
   * palette recents, export options, remembered grants): `"memory"` (the
   * default) for this editor's lifetime only, so an embedded editor never
   * reads or writes the host's origin storage unasked; `"local"` the
   * page's `localStorage`, under the editor's own keys; `"none"` nothing
   * kept; or the host's own store (Web Storage's getItem / setItem /
   * removeItem).
   */
  storage?: "local" | "memory" | "none" | EditorStorage;
}

/** A host's settings store for the editor (`EditorConfig.storage`): Web
 *  Storage's item methods, so `localStorage` is one. */
export interface EditorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type EditorEvent =
  | { type: "ready" }
  | { type: "change" }
  | { type: "fieldChange"; fields: readonly TemplateFieldSummary[] };

/** A mounted editor, as the host drives it (docs/composable-editor.md §8.2). */
export interface EditorHandle {
  /** Open a document (replaces the open one). */
  load(document: { bytes: Uint8Array; name?: string }): Promise<void>;
  /** Start a blank one-page document of this size, in points. */
  newDocument(widthPt: number, heightPt: number): Promise<void>;
  /** The open document as `.paged` bytes. */
  save(): Promise<Uint8Array>;
  /** The open document as a PDF. */
  exportPdf(options?: ExportPdfWireOptions): Promise<Uint8Array>;
  /** The template's fields, in form order, with their values. */
  fields(): Promise<readonly TemplateFieldSummary[]>;
  /**
   * The editor's look: its dark or light theme, and design tokens
   * (`--paged-*`, `--chrome-*`, … from `@paged-media/editor/theme-tokens.json`)
   * the host overrides with its brand. A token set to null returns to the
   * editor's own. Both are set on the editor's root element
   * (`[data-paged-editor]`), never on the host's page.
   */
  setTheme(theme: {
    mode?: "dark" | "light";
    tokens?: Readonly<Record<string, string | null>>;
  }): void;
  /** The template's values by field name. */
  getFieldValues(): Promise<Record<string, FieldValue>>;
  /** Fill fields: one undo step, checked against the session's role. */
  setFieldValues(
    values: Readonly<Record<string, FieldInput>>,
  ): Promise<
    { ok: true } | { ok: false; problems: readonly TemplateFieldProblem[] }
  >;
  /** Change the session's role (the engine's and the UI's). */
  setRole(role: Role): Promise<void>;
  /** Switch features on and off (ids from `feature-ids.json`). */
  readonly features: FeatureStore;
  /** Listen; returns the unsubscribe. */
  on(listener: (event: EditorEvent) => void): () => void;
  /**
   * The element a profile's `{ kind: "host", id }` region item leaves for
   * the host: the host renders its own component into it. Null until the
   * region is rendered, or when the profile has no such item.
   */
  hostSlot(id: string): HTMLElement | null;
  /** Unmount the editor and release its worker. */
  dispose(): void;
}

/** Options of the lower-level `mountEditor`. */
export interface MountOptions {
  /** A preset id or a profile. */
  profile?: string | EditorProfile;
  /** What the host decides: save, submit, close, back. */
  actions?: HostActions;
  /** As `EditorConfig.assetBase`. */
  assetBase?: string;
  /** As `EditorConfig.engineWasm`. */
  engineWasm?: string;
  /** Where the editor keeps its settings; default memory, for this
   *  editor's lifetime (as `EditorConfig.storage`). */
  storage?: EditorStorage;
}

/** A mounted editor without the handle: only its disposal. */
export interface MountedEditor {
  /** Unmount the editor and release its worker. */
  dispose(): void;
}

// ── The iframe bridge (`@paged-media/editor/iframe`) ──────────────────────

/** The handle's methods a host reaches through a frame. */
export type BridgedMethod =
  | "load"
  | "newDocument"
  | "save"
  | "exportPdf"
  | "fields"
  | "getFieldValues"
  | "setFieldValues"
  | "setRole"
  | "setTheme";

type Async<F> = F extends (...a: infer A) => infer R
  ? (...a: A) => Promise<Awaited<R>>
  : never;

/** The handle over a frame: the data methods of `EditorHandle`, async. */
export type RemoteEditorHandle = {
  [M in BridgedMethod]: Async<EditorHandle[M]>;
} & {
  on(listener: (event: EditorEvent) => void): () => void;
  dispose(): void;
};

/** The config of a framed editor: `EditorConfig` without its functions. */
export interface ConnectConfig extends Omit<
  EditorConfig,
  "actions" | "engineWasm"
> {
  actions?: HostActions;
  /** The frame's origin; else the iframe's `src` origin. */
  origin?: string;
  /** How long to wait for the frame, in ms (default 60 s). */
  timeout?: number;
}
