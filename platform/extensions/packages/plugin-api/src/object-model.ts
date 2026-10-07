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

// The OBJECT MODEL contract (ADR 323; DESIGN.md §21): one addressable
// object graph spanning core and every plugin. Every object has an ADDRESS
// (ADR 131), every property a typed PROPERTY SCHEMA (ADR 132), and one
// `get` / `set` / `query` / `batch` works the same from data bindings, Boa
// scripts, the Node CLI, editor automation and every schema-driven field.
//
//   · `host.contribute.objectModel({ kinds, commands })` — a plugin
//     contributes its object kinds (schema rows + handlers) and typed
//     commands. Handlers run headless: no DOM, no edit context.
//   · `host.objects` — the merged registry (core + every plugin).
//
// Type-only like the rest of this package. The address parser/formatter,
// the selector parser and the value validator are VALUES and live in
// `@paged-media/plugin-sdk` (`parseAddress`, `formatAddress`,
// `parseSelector`, `validateValue`, `coerceValue`).

import type { MutationInput } from "./mutations";
import type { Disposable, MutationOutcome } from "./host";

// ------------------------------------------------------------ addresses

/**
 * One object's address (ADR 131). A SESSION HANDLE, not a durable
 * reference: InDesign renumbers every `Self` on save, so anything stored in
 * a document (a binding target) is a selector over a stable key — a `Name`
 * or an `x-paged:` label — never a raw id.
 *
 * Canonical core forms (what the formatter emits):
 *   `doc` · `textFrame:<id>` (and `rectangle:` `oval:` `polygon:`
 *   `graphicLine:` `group:`) · `page:<id>` · `page:#<n>` · `spread:<id>` ·
 *   `layer:<id>` · `master:<id>` · `story:<id>` ·
 *   `storyRange:<id>@<start>..<end>` · `field:<story>@<offset>` ·
 *   `table:<id>` · `cell:<table>/<row>,<col>` · `style:<family>/<rest>` ·
 *   `swatch:<rest>` · `gradient:<rest>` · `colorGroup:<rest>` ·
 *   `numberingList:<rest>` · `guide:<id>` · `condition:<rest>` ·
 *   `conditionSet:<rest>` · `section:<id>` · `hyperlink:<id>` ·
 *   `textVariable:<id>` (protocol 71) ·
 *   `master:<id> > <item address>`
 * Aliases that parse and are never emitted: `frame:<id>`,
 * `story:<id>@a..b`, `textframe`, `rect`, `graphicline`, `storyrange`.
 * Plugin objects: `plugin:<pluginId>/<kind>/<rest>`. Batch handles:
 * `$h:<name>`.
 */
export type Address = string;

/** ADR 131 selector: `step *( (" > " | " ") step )`, a step being an
 *  address, a kind or `*` followed by predicates — `[key op value]` with
 *  `= != ^= *=`, keys `name` `label` `label.<key>` `kind` `layer` `style`
 *  or any property path, and `:nth(n)`. */
export type Selector = string;

/** A property path: `frameStrokeWeight`, `name`, `points[3].anchor`,
 *  `labels[x-paged:oid]`. The reserved path `"content"` reads/writes an
 *  object's content (its `ContentSchema`). */
export type PropertyPathName = string;

/** The page-item kinds (core's `ElementId` string-id kinds). */
export type PageItemKind =
  | "textFrame"
  | "rectangle"
  | "oval"
  | "polygon"
  | "graphicLine"
  | "group";

/** Style families a `style:` address names (= core's `StyleCollection`). */
export type StyleFamily = "paragraph" | "character" | "object" | "cell" | "table";

/** A parsed address — what the SDK's `parseAddress` returns and
 *  `formatAddress` takes. Plain data. */
export type ParsedAddress =
  | { kind: "doc" }
  | { kind: "item"; itemKind: PageItemKind; id: string }
  /** `frame:<id>` — kind-agnostic; the resolver finds the item kind. */
  | { kind: "frame"; id: string }
  | { kind: "page"; id: string }
  /** `page:#<n>` — the n-th page, 1-based, document order. */
  | { kind: "pageIndex"; index: number }
  | { kind: "spread"; id: string }
  | { kind: "layer"; id: string }
  | { kind: "master"; id: string }
  | { kind: "story"; id: string }
  | { kind: "storyRange"; story: string; start: number; end: number }
  | { kind: "field"; story: string; offset: number }
  | { kind: "table"; id: string }
  | { kind: "cell"; table: string; row: number; col: number }
  | { kind: "style"; family: StyleFamily; name: string }
  | {
      kind:
        | "swatch"
        | "gradient"
        | "colorGroup"
        | "numberingList"
        | "condition"
        | "conditionSet";
      name: string;
    }
  | { kind: "guide" | "section" | "hyperlink" | "textVariable"; id: string }
  | { kind: "onMaster"; master: string; item: ParsedAddress }
  | { kind: "plugin"; plugin: string; objectKind: string; id: string }
  | { kind: "handle"; name: string };

/** The ADR 131 address kind of a parsed address (`ParsedAddress` folds the
 *  six item kinds into `item` and the page index into `pageIndex`). */
export type AddressKind = ParsedAddress["kind"];

// ------------------------------------------------------------- schemas

/** ADR 132's value types, mirrored verbatim. Value shapes:
 *   bool → boolean · number → number (in `unit`) · length → number (pt;
 *   unit strings like "3mm" coerce) · color → a swatch ref (`Color/Red`)
 *   · enum → one of `members` · text → string · ref → an address or the
 *   target's self id · bounds → [top,left,bottom,right] · transform →
 *   [a,b,c,d,tx,ty] · point → [x,y] · bytes/asset → Uint8Array / asset ref
 *   · list → array · map → record keyed by string · struct → record. */
export type ValueType =
  | { kind: "bool" }
  | {
      kind: "number";
      integer?: boolean;
      unit?: "pt" | "deg" | "percent" | "em1000" | "ppi";
    }
  | { kind: "length" }
  | { kind: "color" }
  | { kind: "enum"; members: readonly string[] }
  | { kind: "text"; multiline?: boolean; maxLength?: number }
  | { kind: "ref"; to: string }
  | { kind: "bounds" }
  | { kind: "transform" }
  | { kind: "point" }
  | { kind: "bytes"; mime?: readonly string[] }
  | { kind: "asset" }
  | { kind: "list"; of: ValueType; maxItems?: number }
  | { kind: "map"; of: ValueType; keyPattern?: string }
  /** `shape` names a core wire struct (`SwatchColorSpec`, `TabStopSpec`);
   *  `open: true` accepts fields `fields` does not list — core's catalog
   *  (protocol 71) names the shape but not its fields, and the engine
   *  validates them. */
  | { kind: "struct"; fields: Readonly<Record<string, StructField>>; shape?: string; open?: true };

export type ValueTypeKind = ValueType["kind"];

/**
 * One field of a `struct`: a value type, plus whether a record may omit it.
 *   · `optional: true` — the field may be absent; nothing is filled in.
 *   · `default` — the field may be absent; `host.objects.invoke` (and a
 *     struct-typed `set`) fill the default in before the handler or the
 *     plugin sees the value. The default must satisfy the field's type
 *     (checked at registration).
 * A field with neither is required.
 */
export type StructField = ValueType & { optional?: true; default?: unknown };

/** ADR 132's schema ROW (the JSON shape the core catalog publishes, and
 *  the one plugins publish). One row per (address kind, path). */
export interface PropertySchema {
  /** ADR 131 kind (`frame`, `swatch`, …); plugin rows: `plugin:<id>/<kind>`
   *  (the registry fills it in when a kind omits it). */
  addressKind?: string;
  /** Item kinds the row applies to; omitted = all. */
  appliesTo?: readonly string[];
  path: PropertyPathName;
  type: ValueType;
  /** `null` clears / inherits. */
  nullable?: boolean;
  range?: { min?: number; max?: number; step?: number };
  default?: unknown;
  /** Default `readWrite`. `derived` is computed from other paths. */
  access?: "readWrite" | "readOnly" | "derived";
  /** Core only: the dedicated op a virtual path resolves to. */
  virtual?: { op: string; field?: string } | null;
  idml?: { element: string; attribute: string } | null;
  /** Default: `access === "readWrite"`. */
  bindable?: boolean;
  since?: number;
  summary?: string;
  title?: string;
  /** An expensive read (pixels, a whole sheet, story text): `getAll`
   *  skips it unless asked (`getAll(address, { content: true })`). The
   *  `content` row is always heavy. */
  heavy?: boolean;
}

/** What an object's CONTENT is; drives content ops and `get … --content`. */
export interface ContentSchema {
  kind: "text" | "rows" | "cells" | "pixels" | "vector" | "html" | "blob";
  mime?: readonly string[];
}

// -------------------------------------------------------------- values

/** Why a call was refused. Expected failures are results, never throws. */
export type ObjectErrorCode =
  | "badAddress"
  | "unknownAddress"
  | "unknownPath"
  | "unknownCommand"
  | "invalidValue"
  | "readOnly"
  /** In the grammar, but no backend routes it yet (core forms whose write
   *  lands with core's `Set`, ADR 132). */
  | "unmapped"
  | "denied"
  | "failed";

/** One read (ADR 323). `refused` is this SDK's addition: an unknown
 *  address, a bad path or an unmapped kind answer a typed reason rather
 *  than an `absent` that would read as "the path does not apply". */
export type ObjectValue =
  | { kind: "value"; value: unknown }
  | { kind: "mixed" }
  | { kind: "absent" }
  | { kind: "refused"; code: ObjectErrorCode; reason: string };

/** One op of a batch (ADR 323). */
export type ObjectOp =
  | { op: "set"; address: Address; path: PropertyPathName; value: unknown }
  | {
      op: "create";
      kind: string;
      within?: Address;
      props?: Record<string, unknown>;
      handle?: string;
    }
  | { op: "delete"; address: Address }
  | { op: "invoke"; command: string; args: unknown };

/**
 * An edit of a LIST value (ADR 323 property rows; DESIGN.md §12.8): what a
 * host's list field does when the user adds, removes, reorders or edits
 * one item. It is not a new batch op: `planValueEdit` / `editValue`
 * (plugin-sdk) read the current value and LOWER the edit to plain `set`
 * ops — the whole new list on the list's own path, or, when the kind only
 * types its items (`path[].field` rows, no `path` row), `set path[i].field`
 * — so it lands as ONE batch = ONE undo step, through the same validation
 * as any write, and every planner keeps receiving `set` / `create` /
 * `delete` only.
 *   · `add` — insert `item` (absent: the item type's default) at `index`
 *     (absent: the end).
 *   · `remove` — drop the item at `index`.
 *   · `move` — move the item at `from` so it ends up at `to`.
 *   · `itemSet` — replace the item at `index`, or with `field` one field of
 *     a struct item.
 * Indices are positions in the VALUE (a stack painted bottom → top is
 * still indexed bottom-first, whatever order the UI lists it in).
 */
export type ListEdit =
  | { edit: "add"; index?: number; item?: unknown }
  | { edit: "remove"; index: number }
  | { edit: "move"; from: number; to: number }
  | { edit: "itemSet"; index: number; field?: string; value: unknown };

/** An edit of one field of a STRUCT value (a gradient stop, an anchor
 *  point): lowered like {@link ListEdit} to a `set` of the whole struct,
 *  or `set path.field` when the kind types the field as its own row. */
export type StructEdit = { edit: "fieldSet"; field: string; value: unknown };

/** One edit of a list or struct value. */
export type ValueEdit = ListEdit | StructEdit;

/** A container part change, in the WRITER's own `paged/<plugin-id>/`
 *  namespace (relative path; `bytes: null` deletes). */
export interface PartChange {
  path: string;
  bytes: Uint8Array | null;
}

/**
 * What a plugin write produces; the host commits it as ONE undo step.
 *   · `mutations` — core-backed state: folded into the batch.
 *   · `state` — plugin-backed state (the label-hash pattern): the parts
 *     are written first (content-addressed, never overwritten), then the
 *     plugin's label is set on `host` INSIDE the batch. Undo reverts the
 *     label; the plugin reloads the state the label points back to.
 *
 *     `host` is a page item, a story (range), a page (`page:<id>`,
 *     `page:#n` — protocol 70 `setPageMetadata`) or the document (`doc` —
 *     `setDocumentMetadata`).
 *
 *     Core holds ONE label per plugin per host, under exactly
 *     `x-paged:<pluginId>`, whose value is the envelope
 *     `{"v": <int >= 1>, "data": {…}}` (≤ 64 KiB). So `labelKey` is either
 *       - `x-paged:<pluginId>` — `labelValue` IS that whole envelope
 *         (JSON text), and replaces the label; or
 *       - `x-paged:<pluginId>.<sub>` — a SUB-KEY: the registry reads the
 *         current envelope, sets `data[<sub>]` to `labelValue` (parsed
 *         when it is JSON text, else kept as the string) and writes the
 *         merged envelope back. Several sub-keys on one host — in one
 *         write or across writes of one batch — merge into one label.
 *     Any other key is refused before anything applies.
 *   · `both` — the two together.
 *   · `rejected` — a typed no.
 *
 * `created` — the address of each object the write's `create` ops make,
 * ONE per `create` op the planner received, in the order received (the
 * registry splices them into `ObjectWriteResult.created` at the ops'
 * batch positions). When the engine mints the id, write the placeholder
 * `$h:<handle>` (the `bindCreated` handle of that insert) or `$created`
 * (the batch's `createdId`) inside the address; the registry replaces it
 * with the minted element's id after the commit. Omitted: each of those
 * creates answers `""`. A list of the wrong length is refused (`failed`)
 * before anything applies.
 */
export type ObjectWrite =
  | { kind: "mutations"; mutations: readonly MutationInput[]; created?: readonly Address[] }
  | {
      kind: "state";
      parts: readonly PartChange[];
      host: Address;
      labelKey: string;
      labelValue: string;
      created?: readonly Address[];
    }
  | {
      kind: "both";
      mutations: readonly MutationInput[];
      parts: readonly PartChange[];
      host: Address;
      labelKey: string;
      labelValue: string;
      created?: readonly Address[];
    }
  | { kind: "rejected"; reason: string };

/** What a kind's `list` receives. The registry ALSO post-filters the
 *  selector's predicates by reading paths through `get`, so honouring
 *  `predicates` in `list` is an optimisation, never a duty. */
export interface ObjectQuery {
  /** The selector step that selected this kind (`plugin:x/layer[name="a"]`). */
  selector?: Selector;
  kind?: string;
  /** The container the selector scoped the step to (`scope > kind`):
   *  a page item or story (a host), or one of this plugin's own
   *  addresses (`plugin:x/image/1 > plugin:x/layer`). Container scopes
   *  (`doc`, `page:`, `spread:`, `master:`, `layer:`) never reach `list`:
   *  the registry lists unscoped and keeps the objects whose `hostOf` lies
   *  in the container. */
  within?: Address;
  limit?: number;
  /** The step's parsed predicates (this SDK's addition to ADR 323). */
  predicates?: readonly ObjectPredicate[];
}

export interface ObjectPredicate {
  key: string;
  op: "=" | "!=" | "^=" | "*=";
  value: string;
}

// ------------------------------------------------- plugin contribution

/** One object KIND a plugin contributes (ADR 323). Headless; live for the
 *  whole session; declared under `contributes.objectModel.kinds[]`. */
export interface ObjectKindContribution {
  /** Plugin-local kind name (`layer`, `cell`). Addresses are
   *  `plugin:<manifest.id>/<kind>/<id>`. */
  kind: string;
  title: string;
  /** At least one row; validated at registration. */
  schema: readonly PropertySchema[];
  content?: ContentSchema;
  /** The core element hosting an object (frame / scene layer / page /
   *  `doc`): where its labels live (ADR 559), and how the registry scopes
   *  `page:x > plugin:…` selectors. May answer asynchronously. */
  hostOf(address: Address): Address | null | Promise<Address | null>;
  list(query: ObjectQuery): readonly Address[] | Promise<readonly Address[]>;
  get(address: Address, path: PropertyPathName): ObjectValue | Promise<ObjectValue>;
  set?(address: Address, path: PropertyPathName, value: unknown): ObjectWrite | Promise<ObjectWrite>;
  /** Preferred over repeated `set`: many ops, one write, one undo step.
   *  Receives this kind's `set` / `create` / `delete` ops. Ignored when
   *  the contribution has a plugin-level `batch`. */
  batch?(ops: readonly ObjectOp[]): ObjectWrite | Promise<ObjectWrite>;
}

/**
 * A TYPED command (ADR 323): its args and result carry value types, so the
 * CLI, Boa and a generated form can call it without knowing the plugin.
 * `host.objects.invoke` validates `args` first. The untyped
 * `contribute.command` stays for the migration (a shrink-only list).
 */
export interface TypedCommandContribution<A = unknown, R = unknown> {
  id: string;
  title: string;
  /** Usually `{ kind: "struct", fields }`. */
  args: ValueType;
  result?: ValueType;
  handler(ctx: { objects: ObjectsSurface }, args: A): R | Promise<R>;
}

export interface ObjectModelContribution {
  kinds: readonly ObjectKindContribution[];
  commands?: readonly TypedCommandContribution[];
  /**
   * PLUGIN-level planner: receives every `set` / `create` / `delete` op of
   * a batch that targets ANY of this plugin's kinds, in batch order, and
   * answers ONE write. Use it whenever two kinds share state (an image's
   * layers and adjustments live in one stack): planned per kind, each
   * kind would start from the same state and the second write would drop
   * the first one's changes. When present, the kinds' own `batch`/`set`
   * are not used for writes. Without it, ops are planned per kind, and
   * two per-kind `state` writes landing on the same host are refused
   * (`failed`, "conflicting state writes") rather than silently merged.
   */
  batch?(ops: readonly ObjectOp[]): ObjectWrite | Promise<ObjectWrite>;
}

/** What `contribute.objectModel` returns: a `Disposable` (ADR 323) that
 *  can also announce changes the engine does not see (wasm-held state). */
export interface ObjectModelHandle extends Disposable {
  /** No argument = every object of this plugin may have changed. */
  changed(addresses?: readonly Address[]): void;
}

// -------------------------------------------------------- host.objects

export interface ObjectWriteResult {
  applied: boolean;
  reason?: string;
  /** Engine undo steps the write took: a batch is ONE. */
  undoSteps: 0 | 1;
  /** This SDK's additions: the refusal code and the failing op. */
  code?: ObjectErrorCode;
  index?: number;
  /** The engine outcome (minted ids for `create`/`$h:`). */
  outcome?: MutationOutcome;
  /** The address of every object a `create` op made, in op order (this
   *  SDK's addition; a core create needs engine protocol 71). */
  created?: readonly Address[];
  /** One entry per typed CORE command (`invoke` of `core.<op>`) the batch
   *  ran, in op order: its op index and the addresses of what it created
   *  (this SDK's addition, DESIGN.md §21.12). */
  commands?: readonly ObjectCommandResult[];
}

/** What one typed core command of a batch made. */
export interface ObjectCommandResult {
  index: number;
  command: string;
  created: readonly Address[];
}

export interface ObjectChange {
  /** Empty = "anything may have changed" (core reports page-level damage
   *  today, not addresses). */
  addresses: readonly Address[];
  paths?: readonly string[];
  origin: "core" | string;
}

export interface ObjectKindInfo {
  owner: "core" | string;
  /** Qualified: core kinds bare (`frame`), plugin kinds
   *  `plugin:<pluginId>/<kind>`. */
  kind: string;
  title: string;
  /** The address form, e.g. `plugin:acme.notes/note/<id>`. */
  addressForm: string;
}

export interface ObjectCommandInfo {
  id: string;
  title: string;
  owner: string;
  args: ValueType;
  result?: ValueType;
}

/** `host.objects` — the one registry over core and every plugin. */
export interface ObjectsSurface {
  query(selector: Selector, opts?: { limit?: number }): Promise<Address[]>;
  get(address: Address, path: PropertyPathName): Promise<ObjectValue>;
  /** Every schema path of the object, read — except `heavy` rows (and
   *  `content`), which are read only with `{ content: true }`. */
  getAll(address: Address, opts?: { content?: boolean }): Promise<Record<string, ObjectValue>>;
  set(
    address: Address,
    path: PropertyPathName,
    value: unknown,
    opts?: { label?: string },
  ): Promise<ObjectWriteResult>;
  /** All-or-nothing: validated and planned before anything applies; core
   *  ops and plugin plans land as ONE engine batch = one undo step. */
  batch(ops: readonly ObjectOp[], opts?: { label?: string }): Promise<ObjectWriteResult>;
  /** The rows of an address's kind, or of a qualified kind name. Empty
   *  when the kind is unknown. */
  schema(addressOrKind: Address | string): Promise<readonly PropertySchema[]>;
  kinds(): Promise<readonly ObjectKindInfo[]>;
  /** Typed commands contributed through `contribute.objectModel`. */
  commands(): Promise<readonly ObjectCommandInfo[]>;
  /** Run a typed command. Rejects with an `Error` whose message starts
   *  with the refusal code (`unknownCommand: …`, `invalidValue: …`).
   *  A CORE command (`core.<op>`, listed by `commands()` with owner
   *  `"core"`) runs as ONE batch and answers `{ created, undoSteps }`;
   *  it also joins `batch` as an `invoke` op (one undo step with the
   *  batch's sets / creates / deletes). */
  invoke(command: string, args: unknown): Promise<unknown>;
  onDidChange(
    listener: (e: ObjectChange) => void,
    filter?: { selector?: Selector },
  ): Disposable;
}
