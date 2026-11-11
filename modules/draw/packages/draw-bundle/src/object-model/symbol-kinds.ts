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
// Both live in the engine (engine ADR 1039, draw ADR 365). A DEFINITION's
// name is writable; its artwork is captured from page items, so it is
// created by the typed `defineSymbol` command (and replaced by
// `redefineSymbol`), never by an object-model `create`. Deleting one
// breaks every instance first — the artwork stays.
//
// An INSTANCE is one engine page item that draws its symbol. Its own
// writable row is `linked` (false = break the link, keep the artwork).

import type {
  BundleHost,
  ElementId,
  MutationInput,
  ObjectKindContribution,
  ObjectOp,
  ObjectValue,
  ObjectWrite,
  PropertySchema,
} from "@paged-media/plugin-api";

import { formatAddress, parseAddress } from "@paged-media/plugin-sdk";
import { SYMBOL_REGISTRATIONS, type SymbolInstance } from "../commands/symbols";
import {
  engineInstanceIds,
  readEngineSymbols,
  readInstanceStates,
  type EngineSymbol,
} from "../commands/symbols-engine";
import {
  fromWrite,
  kindBatch,
  plan,
  rejected,
  type Planned,
  type Planner,
} from "./plan";
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
  row("name", TEXT, {
    title: "Name",
    summary: "The symbol's name — what a persisted reference selects by.",
  }),
  ro(
    "registration",
    enumOf(SYMBOL_REGISTRATIONS),
    "The registration point on the §16.1 nine-point grid (set at define).",
  ),
  ro(
    "origin",
    POINT,
    "The registration point in the definition's own coordinates (pt).",
  ),
  derived("pieceCount", INT, "How many artwork pieces the definition holds."),
  derived(
    "bounds",
    { kind: "bounds" },
    "The definition's control-point hull [minX, minY, maxX, maxY].",
  ),
  derived(
    "instanceCount",
    INT,
    "How many placed instances follow this definition.",
  ),
];

export const SYMBOL_INSTANCE_SCHEMA: readonly PropertySchema[] = [
  ro(
    "symbol",
    { kind: "ref", to: `plugin:media.paged.draw/${SYMBOL_KIND}` },
    "The definition this instance follows.",
  ),
  ro("origin", POINT, "Where the registration point was placed (page pt)."),
  ro(
    "leaves",
    REFS,
    "The instance's page items, in piece order — each one's own core properties are its overrides.",
  ),
  row("linked", BOOL, {
    title: "Linked",
    summary:
      "false breaks the link and keeps the artwork (Break link). Re-linking is a re-place.",
  }),
];

export function makeSymbolKind(
  host: BundleHost,
): ObjectKindContribution & Planner {
  const idOf = (address: string) => localIdOf(address, SYMBOL_KIND);
  const symbolKind: ObjectKindContribution & Planner = {
    kind: SYMBOL_KIND,
    title: "Symbol",
    schema: SYMBOL_SCHEMA,
    content: { kind: "vector" },
    hostOf: () => "doc",
    async list() {
      return (await readEngineSymbols(host)).map((s) =>
        addressOf(SYMBOL_KIND, s.id),
      );
    },
    async get(address, path): Promise<ObjectValue> {
      const id = idOf(address);
      const row = id
        ? (await readEngineSymbols(host)).find((s) => s.id === id)
        : undefined;
      if (!row) return refuse("unknownAddress", `no symbol ${address}`);
      return engineSymbolValue(row, path);
    },
    batch: (ops: readonly ObjectOp[]) =>
      kindBatch(host, (o) => symbolKind.plan(o))(ops),
    async plan(ops: readonly ObjectOp[]): Promise<Planned> {
      return planEngineSymbols(host, ops, idOf);
    },
  };
  return symbolKind;
}

export function makeSymbolInstanceKind(
  host: BundleHost,
): ObjectKindContribution & Planner {
  const idOf = (address: string) => localIdOf(address, SYMBOL_INSTANCE_KIND);
  const find = async (address: string): Promise<SymbolInstance | null> => {
    const id = idOf(address);
    if (!id) return null;
    const [state] = await readInstanceStates(host, [
      { kind: "instance", id } as unknown as ElementId,
    ]);
    if (!state) return null;
    // An engine instance is ONE page item: it is its own leaf, and its
    // origin is where its registration point lands.
    return {
      symbol: state.symbol ?? "",
      instance: id,
      origin: [state.matrix[4], state.matrix[5]],
      leaves: [state.id],
    };
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
    async list(query) {
      let ids = await engineInstanceIds(host);
      const within = query.within ? parseAddress(query.within) : null;
      if (within?.kind === "item") {
        const item = formatAddress(within);
        ids = ids.filter((i) => coreAddressOf(i) === item);
      }
      return ids.map((i) => addressOf(SYMBOL_INSTANCE_KIND, String(i.id)));
    },
    async get(address, path): Promise<ObjectValue> {
      const inst = await find(address);
      if (!inst)
        return refuse("unknownAddress", `no symbol instance ${address}`);
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
          reason:
            "a symbol instance is placed by placeSymbolInstance; only `linked` is writable here",
        };
      }
      const inst = await find(op.address);
      if (!inst)
        return { kind: "rejected", reason: `no symbol instance ${op.address}` };
      if (op.value === true) continue; // already linked (it is listed)
      mutations.push({
        op: "breakSymbolLink",
        args: { elementId: inst.leaves[0]! },
      } as MutationInput);
    }
    return { kind: "mutations", mutations };
  }
}

// ------------------------------------------------------------- WP6.8
// Draw ADR 365 — the `symbol` kind reads the engine's store: name and delete are `redefineSymbol` /
// `deleteSymbol` (one undo step each, the engine breaks every instance
// first); registration is the engine's (the centre) and the piece count
// is its item count.

function engineSymbolValue(row: EngineSymbol, path: string): ObjectValue {
  const [top, left, bottom, right] = row.bounds;
  switch (path) {
    case "name":
      return val(row.name);
    case "registration":
      return val("center");
    case "origin":
      return val([0, 0]);
    case "pieceCount":
      return val(row.itemCount);
    case "bounds":
      return val([left, top, right, bottom]);
    case "instanceCount":
      return val(row.instances.length);
    default:
      return refuse("unknownPath", `symbol has no "${path}"`);
  }
}

async function planEngineSymbols(
  host: BundleHost,
  ops: readonly ObjectOp[],
  idOf: (address: string) => string | null,
): Promise<Planned> {
  const rows = await readEngineSymbols(host);
  const mutations: MutationInput[] = [];
  for (const op of ops) {
    if (op.op === "create")
      return rejected(
        `a symbol is captured from artwork — invoke ${"media.paged.draw.command.defineSymbol"} with its targets`,
      );
    if (op.op === "invoke") return rejected("symbol cannot invoke");
    const id = idOf(op.address);
    if (!id || !rows.some((r) => r.id === id))
      return rejected(`no symbol ${op.address}`);
    if (op.op === "delete") {
      mutations.push({
        op: "deleteSymbol",
        args: { symbolId: id },
      } as MutationInput);
    } else if (op.path === "name") {
      mutations.push({
        op: "redefineSymbol",
        args: { symbolId: id, name: String(op.value) },
      } as MutationInput);
    } else {
      return rejected(`symbol has no writable "${op.path}"`);
    }
  }
  return plan({ mutations });
}
