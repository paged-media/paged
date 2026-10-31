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

// THE SYMBOLISM TOOLS' document lane (WP6.8, draw ADR 365) — what the
// Symbol Sprayer and the six modifiers read and write, in one place:
//
//   · READ: the instances the brush may act on — the selection's on the
//     page, or every instance on it with none selected (Illustrator's
//     tools act on the selected symbol set) — in PAGE space;
//   · WRITE: a drag's commit as ONE batch, one undo step: the sprayed
//     instances placed (`placeSymbolInstance`, at + linear in page
//     space), the modified ones' `frameTransform` (SPREAD space,
//     `../page-origin.ts`), `symbolInstanceTint` and `frameOpacity`, and
//     the removed ones deleted (`deleteFrame` resolves an instance) —
//     inserts first, deletes last, the order every engine accepts.

import type {
  BundleHost,
  Mutation,
  MutationInput,
} from "@paged-media/plugin-api";
import type { SymbolismCommit, SymbolismTarget } from "@paged-media/draw-tools";

import { batchMutationFor } from "./batch-handles";
import {
  currentSymbol,
  engineInstanceIds,
  engineSymbols,
  instancesIn,
  readInstanceStates,
  storedInstanceTransform,
  type EngineSymbol,
  type InstanceState,
} from "./symbols-engine";

/** What a gesture acts on. */
export interface SymbolismScope {
  pageId: string;
  states: InstanceState[];
  targets: SymbolismTarget[];
  /** The Sprayer's symbol, when the document has one. */
  symbol: EngineSymbol | null;
}

/** The instances on `pageId` the brush may act on. */
export async function symbolismScope(
  host: BundleHost,
  pageId: string,
): Promise<SymbolismScope> {
  let ids = instancesIn(host.selection.get());
  if (ids.length === 0) ids = await engineInstanceIds(host);
  const states = (await readInstanceStates(host, ids)).filter(
    (s) => s.pageId === pageId,
  );
  return {
    pageId,
    states,
    targets: states.map((s) => ({
      id: String(s.id.id),
      item: { matrix: s.matrix, box: s.box, tint: s.tint, opacity: s.opacity },
    })),
    symbol: await currentSymbol(host),
  };
}

/** The Sprayer's symbol box (`[x0, y0, x1, y1]`, definition space). */
export function symbolBox(s: EngineSymbol): [number, number, number, number] {
  const [top, left, bottom, right] = s.bounds;
  return [left, top, right, bottom];
}

/** The batch a commit writes (null when it changes nothing). */
export function symbolismBatchFor(
  scope: SymbolismScope,
  commit: SymbolismCommit,
): MutationInput | null {
  const placements: Mutation[] = [];
  if (scope.symbol) {
    for (const p of commit.placements) {
      const [a, b, c, d, e, f] = p.matrix;
      placements.push({
        op: "placeSymbolInstance",
        args: {
          symbolId: scope.symbol.id,
          pageId: scope.pageId,
          at: [e, f],
          linear: [a, b, c, d],
        },
      } as Mutation);
    }
  }
  const writes: Mutation[] = [];
  for (const u of commit.updates) {
    const state = scope.states.find((s) => String(s.id.id) === u.id);
    if (!state) continue;
    if (u.matrix)
      writes.push({
        op: "setElementProperty",
        args: {
          elementId: state.id,
          path: "frameTransform",
          value: {
            type: "transform",
            value: storedInstanceTransform(u.matrix, state.pageOrigin),
          },
        },
      } as Mutation);
    if (u.tint !== undefined)
      writes.push({
        op: "setElementProperty",
        args: {
          elementId: state.id,
          path: "symbolInstanceTint",
          value: { type: "lengths", value: u.tint ? [...u.tint] : [] },
        },
      } as Mutation);
    if (u.opacity !== undefined)
      writes.push({
        op: "setElementProperty",
        args: {
          elementId: state.id,
          path: "frameOpacity",
          value: { type: "length", value: u.opacity },
        },
      } as Mutation);
  }
  const deletes: Mutation[] = commit.removals.map(
    (id) => ({ op: "deleteFrame", args: { frameId: id } }) as Mutation,
  );
  const ops = [...placements, ...writes, ...deletes];
  return ops.length === 0 ? null : batchMutationFor(ops);
}

/** Write a commit: one batch, one undo step. Answers whether it applied. */
export async function writeSymbolism(
  host: BundleHost,
  label: string,
  scope: SymbolismScope,
  commit: SymbolismCommit,
): Promise<boolean> {
  if (!engineSymbols(host)) {
    host.log.warn(`${label}: the Symbolism tools need the engine's symbols`);
    return false;
  }
  const batch = symbolismBatchFor(scope, commit);
  if (!batch) return false;
  const out = await host.document.mutate(batch);
  if (!out.applied)
    host.log.warn(
      `${label}: refused by the engine: ${JSON.stringify(out.error)}`,
    );
  return out.applied;
}
