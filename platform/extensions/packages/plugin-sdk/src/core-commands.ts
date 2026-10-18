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

// TYPED CORE COMMANDS (DESIGN.md §21.12): every engine content / structure
// op as a `host.objects` command — `core.<op>` — with an argument schema
// GENERATED from the vendored wire (`core-commands.generated.ts`, written by
// scripts/gen-core-commands.mjs). A command:
//
//   - takes its wire args, but an id position also takes an ADR 131
//     ADDRESS (`storyId: "story:u1"`, `elementIds: ["rectangle:u12"]`,
//     `page: "page:#2"`, `tableId: "$h:t"`), resolved here;
//   - is validated against the schema (never coerced), with the wire's
//     required-but-nullable fields filled with null;
//   - plans to ONE mutation (plus a `bindCreated` when it creates), so it
//     joins `host.objects.batch` beside set / create / delete — one undo
//     step — and `handle` names what it created for the batch's later ops
//     (`cell:$h:t/0,1`, `$h:p`);
//   - answers `created[]`: the addresses of what it made, where the engine
//     reports them (minted elements, new pages / layers, named creates).
//
// The guard spec fails a catalog operation that is neither a command here
// nor in CORE_COMMAND_EXCLUSIONS with a reason.

import type {
  ElementId,
  MutationInput,
  MutationOutcome,
  ObjectCommandInfo,
  ObjectErrorCode,
  StructField,
  ValueType,
} from "@paged-media/plugin-api";

import type { CoreObjects } from "./core-objects";
import { CORE_WIRE_OPS, type CoreWireOpRow } from "./core-commands.generated";
import { fromElementId, parseAddress, parseSelector } from "./object-address";
import { validateValue } from "./object-schema";

/** The command id prefix: `core.insertTable`. */
export const CORE_COMMAND_PREFIX = "core.";

/** Wire ops that are NOT typed commands, each with the reason. */
export const CORE_COMMAND_EXCLUSIONS: Readonly<Record<string, string>> = {
  batch: "the composition itself: host.objects.batch runs commands, sets, creates and deletes as ONE undo step",
  bindCreated: "a batch handle, not an operation: a creating command takes `handle` and binds what it made",
  set: "host.objects.set / a batch `set` op (ADR 132 Set) on the object's address",
  setElementProperty: "superseded by Set: host.objects.set on the item's address",
  setPluginMetadata:
    "labels are written by the registry's label-hash pattern under the caller's own x-paged:<pluginId> key (caller-checked); a free-form command would bypass that check",
  setPageMetadata: "labels: as setPluginMetadata (a plugin's page-hosted state write)",
  setDocumentMetadata: "labels: as setPluginMetadata (a plugin's doc-hosted state write)",
  onMaster: "wraps a raw Mutation; typed commands carry no raw wire (address a master's items as master:<id> > <item>)",
};

/** What a creating command makes. `element`: the engine mints it (reported
 *  in `minted`, bindable by handle) — `multi` mints one per `elementIds`
 *  entry; `page` / `layer`: found by diffing the page / layer list;
 *  `named`: the address follows from the args. The Rust side of this table
 *  is paged-canvas `created_element_id` (and `duplicate_roots`). */
type Creates =
  | { by: "element"; kind: "frame" | "table"; multi?: true }
  | { by: "page" }
  | { by: "layer" }
  | { by: "named"; address: (args: Record<string, unknown>) => string | null };

const selfOfSpec = (prefix: string) => (a: Record<string, unknown>) => {
  const id = (a["spec"] as { selfId?: unknown } | undefined)?.selfId;
  return typeof id === "string" && id ? `${prefix}:${id}` : null;
};
const styleNamed = (family: string) => (a: Record<string, unknown>) =>
  typeof a["selfId"] === "string" && a["selfId"] ? `style:${family}/${a["selfId"] as string}` : null;

export const CORE_COMMAND_CREATES: Readonly<Record<string, Creates>> = {
  insertFrame: { by: "element", kind: "frame" },
  insertTextFrame: { by: "element", kind: "frame" },
  insertOval: { by: "element", kind: "frame" },
  insertLine: { by: "element", kind: "frame" },
  insertPath: { by: "element", kind: "frame" },
  insertAnchoredFrame: { by: "element", kind: "frame" },
  createGroup: { by: "element", kind: "frame" },
  duplicateElements: { by: "element", kind: "frame", multi: true },
  insertTable: { by: "element", kind: "table" },
  insertPage: { by: "page" },
  duplicatePage: { by: "page" },
  layerInsert: { by: "layer" },
  createSwatch: { by: "named", address: selfOfSpec("swatch") },
  createGradient: { by: "named", address: selfOfSpec("gradient") },
  createColorGroup: { by: "named", address: selfOfSpec("colorGroup") },
  createNumberingList: { by: "named", address: selfOfSpec("numberingList") },
  createParagraphStyle: { by: "named", address: styleNamed("paragraph") },
  createCharacterStyle: { by: "named", address: styleNamed("character") },
  createObjectStyle: { by: "named", address: styleNamed("object") },
  createCellStyle: { by: "named", address: styleNamed("cell") },
  createTableStyle: { by: "named", address: styleNamed("table") },
  createMaster: { by: "named", address: (a) => (typeof a["master"] === "string" ? `master:${a["master"]}` : null) },
  createTextVariable: { by: "named", address: (a) => (typeof a["name"] === "string" ? `textVariable:dTextVariablen${a["name"]}` : null) },
};

/** The ops that are typed commands, in wire order. */
export const CORE_COMMAND_OPS: readonly string[] = Object.keys(CORE_WIRE_OPS).filter((op) => !(op in CORE_COMMAND_EXCLUSIONS));

const HANDLE_FIELD: StructField = { kind: "text", optional: true };

const titleOf = (op: string): string => {
  const words = op.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function resultType(op: string): ValueType {
  const c = CORE_COMMAND_CREATES[op];
  const to = !c ? "object" : c.by === "element" ? (c.kind === "table" ? "table" : "item") : c.by === "named" ? "object" : c.by;
  return {
    kind: "struct",
    fields: {
      created: { kind: "list", of: { kind: "ref", to } },
      undoSteps: { kind: "number", integer: true },
    },
  };
}

/** The typed command list (static: it is the vendored wire's). */
export function coreCommandInfos(): ObjectCommandInfo[] {
  return CORE_COMMAND_OPS.map((op) => {
    const row = CORE_WIRE_OPS[op]!;
    const bindable = CORE_COMMAND_CREATES[op]?.by === "element" || CORE_COMMAND_CREATES[op]?.by === "page";
    const args: ValueType = bindable ? { ...row.args, fields: { ...row.args.fields, handle: HANDLE_FIELD } } : row.args;
    return { id: `${CORE_COMMAND_PREFIX}${op}`, title: titleOf(op), owner: "core", args, result: resultType(op) };
  });
}

export const isCoreCommand = (id: string): boolean =>
  id.startsWith(CORE_COMMAND_PREFIX) && CORE_COMMAND_OPS.includes(id.slice(CORE_COMMAND_PREFIX.length));

export class CommandRefusal extends Error {
  constructor(
    readonly code: ObjectErrorCode,
    reason: string,
  ) {
    super(reason);
  }
}

/** A planned command: its mutations, the handle it binds, and how to name
 *  what it created once the batch committed. */
export interface CoreCommandPlan {
  op: string;
  mutations: MutationInput[];
  /** `$h:` name bound after the op, and the SDK kind of what it names. */
  handle: { name: string; kind: string } | null;
  resolve(outcome: MutationOutcome, ctx: ResolveContext): Promise<string[]>;
}

export interface ResolveContext {
  /** Positions of every minted entry, by its handle. */
  minted: NonNullable<Extract<MutationOutcome, { applied: true }>["minted"]>;
  /** Pages / layers that are new after the commit, shared out in op order. */
  take(list: "page" | "layer"): Promise<string | null>;
}

const isOpaque = (t: ValueType): boolean => t.kind === "struct" && Object.keys(t.fields).length === 0;

/** Validate a converted value: null where optional, opaque structs passed
 *  to core, nested structs field by field. */
function check(t: StructField | ValueType, v: unknown, at: string): string | null {
  if (v === null || v === undefined) return (t as StructField).optional ? null : `${at} is missing`;
  if (t.kind === "ref") {
    return typeof v === "string" || (typeof v === "object" && v !== null) ? null : `${at} must be a ${t.to} id or address`;
  }
  if (t.kind === "struct") {
    if (isOpaque(t)) return null;
    if (typeof v !== "object" || Array.isArray(v)) return `${at} must be a record`;
    const rec = v as Record<string, unknown>;
    for (const [k, ft] of Object.entries(t.fields)) {
      const e = check(ft, rec[k], `${at}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (t.kind === "list") {
    if (!Array.isArray(v)) return `${at} must be a list`;
    for (const [i, item] of v.entries()) {
      const e = check(t.of, item, `${at}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  return validateValue(t, v, undefined, at);
}

export interface CoreCommands {
  list(): ObjectCommandInfo[];
  /** Plan one command. `handles` are the batch's live `$h:` names. */
  plan(id: string, args: unknown, handles: ReadonlySet<string>, autoHandle: () => string): Promise<CoreCommandPlan>;
  /** Snapshot taken before the commit (pages / layers), when a planned
   *  command needs to diff them. */
  snapshot(plans: readonly CoreCommandPlan[]): Promise<() => Promise<ResolveContext["take"]>>;
}

export function createCoreCommands(core: CoreObjects): CoreCommands {
  const list = async (kind: "page" | "layer"): Promise<string[]> => core.query(parseSelector(kind)!.steps);

  /** A string id position: a raw wire id passes; an address becomes its id. */
  async function toId(v: string, at: string): Promise<string> {
    if (v.startsWith("$h:") || v === "$created" || !v.includes(":")) return v;
    const p = parseAddress(v);
    if (!p) return v;
    switch (p.kind) {
      case "handle":
        return `$h:${p.name}`;
      case "pageIndex": {
        const [a] = await core.query([{ head: { type: "address", address: p }, predicates: [] }]);
        const page = a ? parseAddress(a) : null;
        if (!page || page.kind !== "page") throw new CommandRefusal("unknownAddress", `${at}: no page ${v}`);
        return page.id;
      }
      case "storyRange":
      case "field":
        return p.story;
      case "cell":
        return p.table;
      case "onMaster":
      case "doc":
        throw new CommandRefusal("invalidValue", `${at}: ${v} is not an id position's object`);
      case "plugin":
        throw new CommandRefusal("invalidValue", `${at}: ${v} is a plugin object, not a core one`);
      case "style":
      case "swatch":
      case "gradient":
      case "colorGroup":
      case "numberingList":
      case "condition":
      case "conditionSet":
        return p.name;
      default:
        return (p as { id: string }).id;
    }
  }

  /** An `ElementId` position: an address, a `$h:` handle, or the wire object. */
  async function toElementId(v: unknown, at: string): Promise<ElementId> {
    if (typeof v === "object" && v !== null && "kind" in v && "id" in v) return v as ElementId;
    if (typeof v !== "string") throw new CommandRefusal("invalidValue", `${at} must be an item address (rectangle:<id>, frame:<id>, $h:<name>)`);
    if (v.startsWith("$h:") || v === "$created") return { kind: "rectangle", id: v };
    const p = parseAddress(v);
    if (!p) throw new CommandRefusal("invalidValue", `${at}: "${v}" is not an address`);
    if (p.kind === "handle") return { kind: "rectangle", id: `$h:${p.name}` };
    const id = await core.elementIdOf(p);
    if (!id) throw new CommandRefusal("unknownAddress", `${at}: ${v} names no page item`);
    return id;
  }

  async function convert(field: StructField, v: unknown, at: string): Promise<unknown> {
    if (v === null || v === undefined) return v;
    if (field.kind === "ref") {
      if (field.to === "item") return toElementId(v, at);
      return typeof v === "string" ? toId(v, at) : v;
    }
    if (field.kind === "list" && field.of.kind === "ref" && Array.isArray(v)) {
      const of = field.of;
      return Promise.all(v.map((x, i) => convert(of as StructField, x, `${at}[${i}]`)));
    }
    return v;
  }

  async function wireArgs(op: string, row: CoreWireOpRow, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [k, field] of Object.entries(row.args.fields)) {
      const raw = args[k];
      const v = await convert(field, raw, `${op}.${k}`);
      const why = check(field, v, `${op}.${k}`);
      if (why) throw new CommandRefusal("invalidValue", why);
      if (v === undefined || v === null) {
        if (row.nullFill.includes(k)) out[k] = null;
        else if (v === null && field.optional) out[k] = null;
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  return {
    list: coreCommandInfos,

    async plan(id, rawArgs, handles, autoHandle) {
      const op = id.slice(CORE_COMMAND_PREFIX.length);
      const row = CORE_WIRE_OPS[op];
      if (!row || !CORE_COMMAND_OPS.includes(op)) throw new CommandRefusal("unknownCommand", `no typed command "${id}"`);
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      if (typeof args !== "object" || Array.isArray(args)) throw new CommandRefusal("invalidValue", `${id}: args must be a record`);
      const creates = CORE_COMMAND_CREATES[op];
      const bindable = creates?.by === "element" || creates?.by === "page";
      for (const k of Object.keys(args)) {
        if (!(k in row.args.fields) && !(k === "handle" && bindable)) {
          throw new CommandRefusal("invalidValue", `${id}: no argument "${k}"${k === "handle" ? " (this command creates nothing to bind)" : ""}`);
        }
      }
      const given = args["handle"];
      if (given !== undefined && (typeof given !== "string" || !/^[A-Za-z0-9_]+$/.test(given) || handles.has(given))) {
        throw new CommandRefusal("invalidValue", `${id}: handle "${String(given)}" is repeated or not [A-Za-z0-9_]+`);
      }
      const wire = await wireArgs(id, row, args);
      const mutations: MutationInput[] = [{ op, args: wire } as unknown as MutationInput];
      let handle: CoreCommandPlan["handle"] = null;
      if (bindable) {
        const name = (given as string | undefined) ?? autoHandle();
        mutations.push({ op: "bindCreated", args: { handle: name } });
        handle = { name, kind: creates.by === "page" ? "page" : creates.kind };
      }
      const count = op === "duplicateElements" ? ((wire["elementIds"] as unknown[] | undefined)?.length ?? 1) : 1;
      return {
        op,
        mutations,
        handle,
        async resolve(_outcome, ctx) {
          if (!creates) return [];
          if (creates.by === "named") {
            const a = creates.address(args);
            return a ? [a] : [];
          }
          if (creates.by === "page" || creates.by === "layer") {
            const a = await ctx.take(creates.by);
            return a ? [a] : [];
          }
          const at = ctx.minted.findIndex((m) => m.handle === handle!.name);
          if (at < 0) return [];
          const from = creates.multi ? Math.max(0, at - (count - 1)) : at;
          return ctx.minted.slice(from, at + 1).map((m) => fromElementId(m.element));
        },
      };
    },

    async snapshot(plans) {
      const need = new Set<"page" | "layer">();
      for (const p of plans) {
        const c = CORE_COMMAND_CREATES[p.op];
        if (c?.by === "page" || c?.by === "layer") need.add(c.by);
      }
      const before = new Map<"page" | "layer", Set<string>>();
      for (const k of need) before.set(k, new Set(await list(k)));
      return async () => {
        const fresh = new Map<"page" | "layer", string[]>();
        for (const k of need) fresh.set(k, (await list(k)).filter((a) => !before.get(k)!.has(a)));
        return async (k) => fresh.get(k)?.shift() ?? null;
      };
    },
  };
}
