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

// `symbol` (a DEFINITION in the symbol library) and `symbolInstance` (a
// placed copy) — ADR 323.
//
// A DEFINITION is plugin state (label-hash pattern, src/recipe-store.ts):
// its name is writable; its artwork is captured from page items, so it is
// created by the typed `defineSymbol` command (and replaced by
// `redefineSymbol`), never by an object-model `create`. Deleting one
// unlinks every instance in the SAME commit — the artwork stays.
//
// An INSTANCE is core-backed: real artwork whose leaves each carry a
// `symbolInstance` link. Draw has no override RECORD — an instance's
// per-instance deviations ARE its leaves' own core properties (fill,
// stroke, transform…, at their core addresses), and Reset transform /
// Redefine rebuild from the definition. So the instance's own writable
// row is `linked` (false = break the link, keep the artwork); an
// override model with per-property tracking is recorded as a gap.

import type {
  BundleHost,
  MutationInput,
  ObjectKindContribution,
  ObjectOp,
  ObjectValue,
  ObjectWrite,
  PropertySchema,
} from "@paged-media/plugin-api";

import { stampDrawMetadata } from "../commands/appearance-bake";
import {
  SYMBOLS_PART,
  SYMBOL_REGISTRATIONS,
  findSymbol,
  readSymbolLibrary,
  removeSymbolFrom,
  renameSymbolIn,
  serializeSymbolLibrary,
  symbolBoundsOf,
  symbolInstances,
  withSymbolInstance,
  type SymbolInstance,
} from "../commands/symbols";
import { linkIndex } from "../link-index";
import { fromWrite, kindBatch, plan, rejected, type Planned, type Planner } from "./plan";
import {
  BOOL,
  INT,
  POINT,
  REFS,
  TEXT,
  addressOf,
  coreAddressOf,
  derived,
  enumOf,
  localIdOf,
  refuse,
  ro,
  row,
  val,
} from "./shared";

export const SYMBOL_KIND = "symbol";
export const SYMBOL_INSTANCE_KIND = "symbolInstance";

export const SYMBOL_SCHEMA: readonly PropertySchema[] = [
  row("name", TEXT, { title: "Name", summary: "The symbol's name — what a persisted reference selects by." }),
  ro("registration", enumOf(SYMBOL_REGISTRATIONS), "The registration point on the §16.1 nine-point grid (set at define)."),
  ro("origin", POINT, "The registration point in the definition's own coordinates (pt)."),
  derived("pieceCount", INT, "How many artwork pieces the definition holds."),
  derived("bounds", { kind: "bounds" }, "The definition's control-point hull [minX, minY, maxX, maxY]."),
  derived("instanceCount", INT, "How many placed instances follow this definition."),
];

export const SYMBOL_INSTANCE_SCHEMA: readonly PropertySchema[] = [
  ro("symbol", { kind: "ref", to: `plugin:media.paged.draw/${SYMBOL_KIND}` }, "The definition this instance follows."),
  ro("origin", POINT, "Where the registration point was placed (page pt)."),
  ro("leaves", REFS, "The instance's page items, in piece order — each one's own core properties are its overrides."),
  row("linked", BOOL, {
    title: "Linked",
    summary: "false breaks the link and keeps the artwork (Break link). Re-linking is a re-place.",
  }),
];

/** The unlink stamps for an instance's leaves. */
async function unlinkOps(host: BundleHost, instance: SymbolInstance): Promise<MutationInput[]> {
  const index = linkIndex(host);
  const out: MutationInput[] = [];
  for (const leaf of instance.leaves) {
    out.push(stampDrawMetadata(leaf, withSymbolInstance(await index.envelopeOf(leaf), null)));
  }
  return out;
}

export function makeSymbolKind(host: BundleHost): ObjectKindContribution & Planner {
  const idOf = (address: string) => localIdOf(address, SYMBOL_KIND);
  const symbolKind: ObjectKindContribution & Planner = {
    kind: SYMBOL_KIND,
    title: "Symbol",
    schema: SYMBOL_SCHEMA,
    content: { kind: "vector" },
    hostOf: () => "doc",
    async list() {
      return (await readSymbolLibrary(host)).symbols.map((s) => addressOf(SYMBOL_KIND, s.id));
    },
    async get(address, path): Promise<ObjectValue> {
      const id = idOf(address);
      const def = id ? findSymbol(await readSymbolLibrary(host), id) : null;
      if (!def) return refuse("unknownAddress", `no symbol ${address}`);
      switch (path) {
        case "name":
          return val(def.name);
        case "registration":
          return val(def.registration);
        case "origin":
          return val(def.origin);
        case "pieceCount":
          return val(def.pieces.length);
        case "bounds": {
          const b = symbolBoundsOf(def.pieces.map((p) => p.table));
          return b ? val(b) : { kind: "absent" };
        }
        case "instanceCount":
          return val((await symbolInstances(host, def.id)).length);
        default:
          return refuse("unknownPath", `symbol has no "${path}"`);
      }
    },
    batch: (ops: readonly ObjectOp[]) => kindBatch(host, (o) => symbolKind.plan(o))(ops),
    async plan(ops: readonly ObjectOp[]): Promise<Planned> {
      let library = await readSymbolLibrary(host);
      const mutations: MutationInput[] = [];
      for (const op of ops) {
        if (op.op === "create") {
          return rejected(
            `a symbol is captured from artwork — invoke ${"media.paged.draw.command.defineSymbol"} with its targets`,
          );
        }
        if (op.op === "invoke") return rejected("symbol cannot invoke");
        const id = idOf(op.address);
        const def = id ? findSymbol(library, id) : null;
        if (!def) return rejected(`no symbol ${op.address}`);
        if (op.op === "delete") {
          for (const inst of await symbolInstances(host, def.id)) mutations.push(...(await unlinkOps(host, inst)));
          library = removeSymbolFrom(library, def.id);
        } else if (op.path === "name") {
          library = renameSymbolIn(library, def.id, String(op.value));
        } else {
          return rejected(`symbol has no writable "${op.path}"`);
        }
      }
      return plan({ mutations, libraries: [{ legacyPart: SYMBOLS_PART, bytes: serializeSymbolLibrary(library) }] });
    },
  };
  return symbolKind;
}

export function makeSymbolInstanceKind(host: BundleHost): ObjectKindContribution & Planner {
  const idOf = (address: string) => localIdOf(address, SYMBOL_INSTANCE_KIND);
  const find = async (address: string): Promise<SymbolInstance | null> => {
    const id = idOf(address);
    if (!id) return null;
    return (await symbolInstances(host)).find((i) => i.instance === id) ?? null;
  };
  return {
    kind: SYMBOL_INSTANCE_KIND,
    title: "Symbol instance",
    schema: SYMBOL_INSTANCE_SCHEMA,
    // ADR 559: an instance's labels go on its first leaf (a group cannot
    // carry metadata). Resolved on demand (`hostOf` may be async since
    // plugin-sdk 0.2.43), so a page-scoped selector works on an instance
    // no earlier list or get has seen.
    hostOf: async (address) => {
      const leaf = (await find(address))?.leaves[0];
      return leaf ? coreAddressOf(leaf) : null;
    },
    async list() {
      return (await symbolInstances(host)).map((i) => addressOf(SYMBOL_INSTANCE_KIND, i.instance));
    },
    async get(address, path): Promise<ObjectValue> {
      const inst = await find(address);
      if (!inst) return refuse("unknownAddress", `no symbol instance ${address}`);
      switch (path) {
        case "symbol":
          return val(addressOf(SYMBOL_KIND, inst.symbol));
        case "origin":
          return val(inst.origin);
        case "leaves":
          return val(inst.leaves.map(coreAddressOf));
        case "linked":
          return val(true);
        default:
          return refuse("unknownPath", `symbolInstance has no "${path}"`);
      }
    },
    plan: async (ops) => fromWrite(await planInstances(ops)),
    batch: kindBatch(host, async (ops) => fromWrite(await planInstances(ops))),
  };

  async function planInstances(ops: readonly ObjectOp[]): Promise<ObjectWrite> {
      const mutations: MutationInput[] = [];
      for (const op of ops) {
        if (op.op !== "set" || op.path !== "linked") {
          return {
            kind: "rejected",
            reason: "a symbol instance is placed by placeSymbolInstance; only `linked` is writable here",
          };
        }
        const inst = await find(op.address);
        if (!inst) return { kind: "rejected", reason: `no symbol instance ${op.address}` };
        if (op.value === true) continue; // already linked (it is listed)
        mutations.push(...(await unlinkOps(host, inst)));
      }
      return { kind: "mutations", mutations };
  }
}
