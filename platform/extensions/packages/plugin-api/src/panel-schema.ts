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

// The declarative panel SCHEMA (W3.1 — closes plugin-draw B-01).
//
// B-01 recorded that the concept paper's `visibleWhen`/`enabledWhen`
// CONDITIONAL BINDING LANGUAGE is rejected by design: the editor
// catalog's binding ceiling is `literal | selectionProperty` (no
// expression language). The resolution direction it pointed at —
// "derived bound values from plugin state + expert leaves, not
// conditionals" — is what this file makes a contract.
//
// THE MECHANISM, in one breath:
//   · a `PanelSchema` is pure data (sections → rows → widgets) drawn
//     from the EXISTING catalog vocabulary — the same primitive leaf
//     ids the editor's `registerBuiltInCatalogEntries` already ships;
//   · a row's WIDGET `value` binding stays on the binding ceiling
//     (`Binding`, mirrored below from the catalog) — `literal |
//     selectionProperty`, UNCHANGED;
//   · DYNAMIC visibility / enablement comes from a `BindingRef`
//     (`{ bind: "name" }`) that names a reactive value the PLUGIN
//     publishes through the new `host.bindings` door (see host.ts
//     `BindingsSurface`). The host does a LOOKUP of that named value
//     at render time and re-renders the row when it changes. There is
//     NO expression to evaluate — the plugin computes the boolean in
//     its own realm (from tool state, selection, anything) and
//     publishes the RESULT. That is the whole point: the binding
//     ceiling stays; conditional logic lives in the plugin, not in a
//     host DSL.
//
// THE TRUST-LINE PAYOFF: a schema panel carries NO React component
// across the boundary (unlike `PanelContribution.component`). It is
// `structuredClone`-able data + named reactive values, so it is the
// panel/overlay ISOLATE EXIT the trust line needs (DESIGN.md §6: the
// panel React component is the one knowingly-non-clonable member; a
// schema panel removes it). Expert-leaf React stays the escape hatch
// for genuinely custom UI — SAME-REALM ONLY, by definition.
//
// HONEST LIMITS (recorded in DESIGN.md §12 + B-01 closure):
//   · the row widget set is the curated catalog leaves — no custom
//     CANVASES (a bespoke on-canvas widget stays an expert leaf).
//     SCHEMA v1.1 lifted the "no LISTS" half of this limit: the
//     catalog grew a `paged.list` leaf, so `PanelSchemaRow.list`
//     below carries a `SchemaListSpec` (see DESIGN.md §12.6);
//   · binding evaluation is a host-side LOOKUP keyed by name, never an
//     expression language (`{bind:"x"}` reads value `x`; it cannot say
//     `x && !y`, `strokeType == "dashed"`, etc. — the plugin publishes
//     the already-combined boolean);
//   · `value` bindings still resolve only against the SELECTION
//     (`selectionProperty`) or a `literal` — a widget cannot bind its
//     value to a published `bindings` value in v1 (visibility/enabled
//     can; value can't — that keeps writes on the typed property door).

import type { ComponentType } from "react";

import type { BindingsSurface } from "./host";
import type { PropertyPath, Value } from "./wire";

// ---------------------------------------------------------------- value binding
//
// MIRRORED from `@paged-media/catalog` `Binding` so the contract is
// self-contained (plugin-api must not import the private editor's
// catalog package). The shapes are kept structurally identical — the
// editor's SchemaPanelRenderer maps a `WidgetValueBinding` 1:1 onto a
// catalog `Binding`, and a compat assertion guards the drift. This is
// the §11.5 binding CEILING, unchanged: literal or one typed
// selection-property path, with an optional unit coercion.

export type WidgetValueBinding =
  | { kind: "literal"; value: Value }
  | {
      kind: "selectionProperty";
      /** Which selection surface to address (defaults to `"element"`). */
      scope?: "element" | "content";
      /** The PropertyPath the widget reads from + commits to. */
      path: PropertyPath;
      /** Optional unit coercion on read + write (`pt` / `px` / `%`). */
      coerce?: "pt" | "px" | "%";
    };

// ---------------------------------------------------------------- binding ref
//
// A reference to a NAMED reactive value the plugin publishes through
// `host.bindings.publish(name, value)`. Used for a row's `visible` /
// `enabled` gates (and a section's). The host LOOKS IT UP — it does
// not evaluate it. `negate` is the ONE sanctioned transform (a NOT),
// because publishing both `x` and `!x` is wasteful and a single
// boolean inversion is not an expression language. Anything richer
// (AND / OR / comparisons) is computed by the plugin and published as
// its own named boolean.

export interface BindingRef {
  /** The published binding name to look up (`host.bindings.publish`). */
  bind: string;
  /** Invert the looked-up boolean. The only transform — NOT a DSL. */
  negate?: boolean;
}

/** A visibility / enablement gate: either a static literal or a
 *  lookup of a published plugin binding. Absent = always shown /
 *  enabled. A non-boolean published value is coerced with `Boolean()`
 *  (and a missing name reads as `false` — a visible seam, never a
 *  throw). */
export type SchemaGate = boolean | BindingRef;

// ---------------------------------------------------------------- lists
//
// SCHEMA v1.1 — the COLLECTION tier (B-01 list widget + the G3
// apply-entity write). §12.4 recorded "no lists" as a v1 honest limit:
// layer/style lists stayed expert-leaf React because the curated
// primitive leaves had no list. The editor has since GROWN one (the
// `paged.list` leaf + the schema-list demo panel), so the contract
// adopts it — the same "when the catalog grows it, not invent a rival"
// rule §12 was built on. See DESIGN.md §12.6.
//
// Every member below is ADDITIVE and OPTIONAL: a v1 schema (scalar rows
// only) is unchanged and still renders, and the widened row stays
// structurally identical to the editor's mirror
// (`shell/src/catalog/schema-panel-types.ts`), so the editor's
// injection-seam assert (apps/canvas `main.tsx`
// `_AssertSchemaRenderer`) keeps its teeth — the contract's
// `SchemaPanelRendererProps` must stay assignable to the shell's.
//
// The binding CEILING is untouched. A list does not evaluate anything:
// its rows come from a named collection or a published array, and its
// actions either dispatch a registered command or write ONE typed
// PropertyPath through the same mutation door the scalar widgets
// commit on. No expression language enters here either.

/** Where a `list` row's items come from. Two sources, mirroring the
 *  two live-collection lanes the host already has:
 *    · `documentCollection` — a named engine collection (the same
 *      `host.document.collection(name)` lane the editor's own panels
 *      read);
 *    · `binding` — an ARRAY the plugin publishes through
 *      `host.bindings.publish(name, rows)` (the §12.2 published-
 *      bindings door, now carrying rows instead of a boolean). */
export type WidgetCollectionBinding =
  | { kind: "documentCollection"; collection: string }
  | { kind: "binding"; bind: string };

/** G3 — a schema row ACTION. Either dispatches a registered command
 *  with the row id as payload, or the `applyEntity` write kind: apply
 *  the row's entity id (style / swatch self-id) to the current
 *  selection through the SAME `setElementProperty` mutation channel the
 *  scalar widgets commit on. `valueType` picks the wire payload
 *  (`text` for applied-style paths, `colorRef` for swatch/gradient
 *  paths) — the collection-select leaf's convention. Note the ceiling
 *  holds: an action writes ONE typed PropertyPath, it does not compute. */
export type SchemaRowAction =
  | { kind: "command"; command: string }
  | {
      kind: "applyEntity";
      /** Selection surface to write to (defaults to `"element"`). */
      scope?: "element" | "content";
      /** The applied-entity PropertyPath (e.g. `frameFillColor`,
       *  `appliedParagraphStyle`). */
      path: PropertyPath;
      /** Wire payload variant; defaults to `"text"`. */
      valueType?: "text" | "colorRef";
    };

/** One per-row action button on a `list` widget. */
export interface SchemaListAction {
  /** Button label (sentence case, no emoji — brand content rules). */
  label: string;
  action: SchemaRowAction;
  /** Gate the button on a published binding (absent = enabled;
   *  `applyEntity` actions additionally disable while the target
   *  selection is empty — the honest no-write-path rule). */
  enabled?: SchemaGate;
}

/** The `list` widget spec (widget id `paged.list`). Renders rows from a
 *  collection binding; publishes the clicked row's id back through
 *  `selectionBinding` so other rows/sections can gate on it — which is
 *  how a list participates in §12.2 without a DSL. */
export interface SchemaListSpec {
  items: WidgetCollectionBinding;
  /** Dot-path into a row object for the primary label ("name"). */
  labelField: string;
  /** Optional secondary line (mono), e.g. "kind". */
  secondaryField?: string;
  /** Dot-path carrying the row's stable id; defaults to "selfId" (the
   *  summary-shape convention every document collection uses). */
  idField?: string;
  /** Published binding name that receives the selected row id on click
   *  (string). Absent = the list keeps private selection. */
  selectionBinding?: string;
  /** Per-row action buttons. */
  actions?: SchemaListAction[];
}

// ---------------------------------------------------------------- rows
//
// A row names a catalog WIDGET id (one of the curated primitive leaves
// — `paged.input.length`, `paged.input.color-swatch`,
// `paged.input.toggle-group`, `paged.readout`, …), supplies the static
// `props` that leaf accepts (label, options, …), and optionally a
// `value` binding. The row's `visible`/`enabled` gates are the dynamic
// surface — driven by published plugin bindings.

export interface PanelSchemaRow {
  /** Catalog widget id (a curated primitive-leaf id the host
   *  registered). An unknown id renders a visible "unknown widget"
   *  placeholder, not a throw. */
  widget: string;
  /** Static props forwarded to the leaf (label, options, placeholder,
   *  …). Must match the leaf's declared `PropSchema`; unknown keys are
   *  ignored by the leaf. */
  props?: Record<string, unknown>;
  /** The widget's primary value binding — the §11.5 ceiling
   *  (`literal | selectionProperty`). Absent = a layout-only / display
   *  leaf (label, section). */
  value?: WidgetValueBinding;
  /** ADDITIVE (schema v1.1) — present iff `widget` is the list widget
   *  (`paged.list`). Scalar rows ignore it; a v1 schema never sets it. */
  list?: SchemaListSpec;
  /** Show the row only when this gate is truthy. Absent = always. */
  visible?: SchemaGate;
  /** Enable the row's control only when this gate is truthy. Absent =
   *  always enabled (subject to the widget's own no-write-path
   *  disable). */
  enabled?: SchemaGate;
}

// ---------------------------------------------------------------- sections
//
// A titled group of rows. The section title rides the catalog's
// existing `paged.layout.section` leaf; the section's own `visible`
// gate hides the whole group (and its title) on a published binding.

export interface PanelSchemaSection {
  /** Section title (the kicker / disclosure header). Absent = an
   *  untitled flat group. */
  title?: string;
  /** Render as a collapsible disclosure (the catalog section's
   *  `collapsible` chrome). */
  collapsible?: boolean;
  rows: PanelSchemaRow[];
  /** Hide the entire section (title + rows) on this gate. */
  visible?: SchemaGate;
}

// ---------------------------------------------------------------- the schema
//
// The whole panel: identity + chrome + sections. Registered through
// `contribute.panel` exactly like a React `PanelContribution`, but
// with a `schema` instead of a `component` (the host renders it from
// the catalog). The two are mutually exclusive — a contribution is
// EITHER expert-leaf React OR a schema, never both.

export interface PanelSchema {
  /** Stable id, `<namespace>.<panel>` — namespace-checked at register
   *  exactly like a React panel. */
  id: string;
  title: string;
  icon?: string;
  defaultDock?: "left" | "right" | "top" | "bottom" | "center";
  defaultGroup?: string;
  sections: PanelSchemaSection[];
}

/** A panel contribution that is a declarative SCHEMA rather than an
 *  expert-leaf React component. The host renders it from the catalog
 *  and subscribes to the bundle's published bindings. Carries no
 *  React — the isolate-ready panel form. */
export interface SchemaPanelContribution {
  id: string;
  title: string;
  icon?: string;
  defaultDock?: "left" | "right" | "top" | "bottom" | "center";
  defaultGroup?: string;
  /** The declarative body (sections/rows/widgets from the catalog). */
  schema: PanelSchema;
  closable?: boolean;
  movable?: boolean;
}

// ------------------------------------------------------------- host renderer
//
// The HOST APP injects a React renderer that turns a `PanelSchema` +
// the bundle's `BindingsSurface` into the actual panel UI (the editor's
// `SchemaPanelRenderer`, which walks the schema through the catalog's
// composition machinery and subscribes to the bindings). Same shape as
// `WidgetSurface` / `ShellSurface`: a value the host injects at
// `loadBundle` time so the SDK adapter stays a pure function over the
// editor handle. Knowingly non-clonable (a React component, like panel
// components — DESIGN.md §6); across the isolate it becomes a host-side
// renderer addressed by the cloned schema + a bindings RPC channel,
// which is a SECOND implementation, not a contract change.
//
// When the host injects NO renderer, `contribute.schemaPanel` registers
// a visible placeholder panel (an honest seam — "schema panel needs a
// host renderer"), never a throw and never fake UI.

export interface SchemaPanelRendererProps {
  schema: PanelSchema;
  /** The bundle's published-bindings surface — the renderer subscribes
   *  to it so `visible`/`enabled` gates react to plugin state. */
  bindings: BindingsSurface;
}

/** The host-injected schema-panel renderer (React). Resolves a schema
 *  through the host's catalog + the bundle's bindings. */
export type SchemaPanelRenderer = ComponentType<SchemaPanelRendererProps>;
