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

// MIGRATION of a v0 symbol library onto the engine's symbols (WP6.8,
// draw ADR 365). A document made before engine ADR 1039 keeps its
// symbols in draw's container part (`symbols.json`) and its instances as
// re-emitted artwork whose leaves carry a `symbolInstance` link. When the
// host's engine keeps symbols (`supports("document.symbols@1")`), opening
// such a document moves them over, ONCE:
//
//   1. each definition's pieces are inserted as temporary artwork (the
//      v0 place batch without its links) where the definition was
//      captured — that write is the migration's undo step, and step 2
//      AMENDS it (engine ADR 1004), so one undo takes the whole migration
//      back;
//   2. the engine bounds of that artwork fix the registration point the
//      engine will centre the definition on, so every v0 instance's
//      transform is FITTED: its live anchors (page space, whatever the
//      user did to them since) against the definition's, least squares
//      (`fitAffine`) — a translation when the anchors no longer match;
//      then one batch makes the symbols (`createSymbol`, the library's
//      name and id), places one instance per v0 instance, dissolves the
//      v0 instances' groups and deletes their leaves and the temporary
//      artwork;
//   3. the library part is KEPT and records what moved (`migrated`), so
//      a reopen does not migrate twice and an undo leaves nothing to
//      redo by itself.
//
// What does not carry over: a v0 instance's own edits to a leaf (a
// changed fill) — an engine instance draws its symbol; its stacking order
// (a placed instance goes on top of its spread); and a symbol with no
// pieces. The log says how many moved.

import type {
  BundleHost,
  ElementId,
  Mutation,
  MutationInput,
} from "@paged-media/plugin-api";
import {
  fitAffine,
  splitCompound,
  type Vec2,
} from "@paged-media/draw-geometry";

import { insertPathMutationFor } from "../handlers/insert-path";
import { resolveTargetPage } from "../target-page";
import { batchMutationFor, bindCreatedMutationFor } from "./batch-handles";
import { bindMinted, mutateMinting } from "./minted";
import { parentGroupOf } from "./parentage";
import { anchorsToPage, readEditablePath, tableOfRead } from "./path-rewrite";
import {
  readSymbolLibrary,
  symbolFinishBatchFor,
  symbolHandle,
  symbolHandleBindings,
  symbolInstances,
  symbolPlacePlanFor,
  SYMBOLS_FEATURE,
  writeSymbolLibrary,
  type SymbolDefinition,
  type SymbolInstance,
  type SymbolPlacePlan,
} from "./symbols";
import { engineSymbols, readEngineSymbols } from "./symbols-engine";

/** What a migration moved. */
export interface SymbolMigration {
  symbols: number;
  instances: number;
}

/** The page a v0 instance sits on, and its leaves' page-space anchors in
 *  piece order (a leaf that is not a readable path answers none). */
async function readOldInstance(
  host: BundleHost,
  inst: SymbolInstance,
): Promise<{ pageId: string | null; anchors: Vec2[][] }> {
  let pageId: string | null = null;
  const anchors: Vec2[][] = [];
  for (const leaf of inst.leaves) {
    const read = await readEditablePath(host, leaf);
    if (!read) {
      anchors.push([]);
      continue;
    }
    pageId ??= read.pageId ?? null;
    const { table, matrix } = tableOfRead(read);
    anchors.push(
      anchorsToPage(table.anchors, matrix).map((a) => [
        a.anchor[0],
        a.anchor[1],
      ]),
    );
  }
  return { pageId, anchors };
}

/** The definition-space anchors of each piece (registration point at the
 *  origin, as the library keeps them). */
const pieceAnchors = (def: SymbolDefinition): Vec2[][] =>
  def.pieces.map((p) => p.table.anchors.map((a) => [a.anchor[0], a.anchor[1]]));

/** The instance transform (definition space centred on `centre` → page)
 *  of a v0 instance. */
export function fitInstanceTransform(
  def: SymbolDefinition,
  centre: Vec2,
  live: { anchors: Vec2[][] },
  origin: Vec2,
): [number, number, number, number, number, number] {
  const src: Vec2[] = [];
  const dst: Vec2[] = [];
  pieceAnchors(def).forEach((piece, i) => {
    const got = live.anchors[i] ?? [];
    if (got.length !== piece.length) return;
    piece.forEach((q, k) => {
      src.push([q[0] - centre[0], q[1] - centre[1]]);
      dst.push(got[k]!);
    });
  });
  const fit = fitAffine(src, dst);
  if (fit) return [...fit] as [number, number, number, number, number, number];
  // The artwork no longer matches: keep where it was placed.
  return [1, 0, 0, 1, origin[0] + centre[0], origin[1] + centre[1]];
}

/** Move the v0 library onto the engine's symbols when the host keeps
 *  them. Answers what moved, or null when nothing was to move. */
export async function migrateSymbolLibrary(
  host: BundleHost,
): Promise<SymbolMigration | null> {
  const label = "Migrate symbols";
  if (!engineSymbols(host) || !host.supports(SYMBOLS_FEATURE)) return null;
  const library = await readSymbolLibrary(host);
  const done = library.migrated ?? {};
  const todo = library.symbols.filter(
    (s) => !(s.id in done) && s.pieces.length > 0,
  );
  if (todo.length === 0) return null;
  const fallbackPage = await resolveTargetPage(host);
  const taken = new Set((await readEngineSymbols(host)).map((s) => s.id));

  // Phase 1 — every definition's pieces as temporary artwork.
  const builds: {
    def: SymbolDefinition;
    plan: SymbolPlacePlan;
    engineId: string;
    instances: {
      inst: SymbolInstance;
      pageId: string | null;
      anchors: Vec2[][];
    }[];
  }[] = [];
  for (const def of todo) {
    const instances = [];
    for (const inst of await symbolInstances(host, def.id))
      instances.push({ inst, ...(await readOldInstance(host, inst)) });
    const pageId = instances.find((i) => i.pageId)?.pageId ?? fallbackPage;
    if (!pageId) continue;
    let engineId = def.id;
    for (let n = 2; taken.has(engineId); n++) engineId = `${def.id}-${n}`;
    taken.add(engineId);
    builds.push({
      def,
      engineId,
      instances,
      plan: symbolPlacePlanFor({
        symbol: def,
        pageId,
        instanceId: `migrate-${def.id}`,
        origin: def.origin,
      }),
    });
  }
  if (builds.length === 0) return null;
  const inserts: Mutation[] = [];
  const finishes: Mutation[] = [];
  const temps: string[][] = [];
  builds.forEach(({ plan }, b) => {
    plan.pieces.forEach((piece, p) => {
      splitCompound(piece.table).forEach((contour, c) => {
        inserts.push(
          insertPathMutationFor(
            plan.pageId,
            contour.anchors,
            contour.subpathOpen?.[0] ?? false,
          ),
          bindCreatedMutationFor(symbolHandle(b, p, c)) as Mutation,
        );
      });
    });
    const finish = symbolFinishBatchFor({
      plan,
      bindings: symbolHandleBindings(plan, b),
    }) as Extract<Mutation, { op: "batch" }>;
    // The link stamps and the wrapping group are v0's instance; the
    // definition takes the paint only.
    for (const op of finish.args.ops)
      if (op.op !== "setPluginMetadata" && op.op !== "createGroup")
        finishes.push(op);
    temps.push(plan.pieces.map((_, p) => symbolHandle(b, p, 0)));
  });
  const phase1 = batchMutationFor([...inserts, ...finishes]);
  const minting = await mutateMinting(host, phase1);
  if (!minting.outcome.applied) {
    host.log.warn(
      `${label}: the definitions could not be drawn: ${JSON.stringify(minting.outcome.error)}`,
    );
    return null;
  }
  const appliedSeq = (minting.outcome as { appliedSeq?: number }).appliedSeq;
  const bound = bindMinted(minting, phase1);
  if (!bound) {
    host.log.warn(`${label}: the engine did not say what it drew — stopped`);
    return null;
  }

  // Phase 2 — the symbols, the instances, the teardown: amending phase 1.
  const creates: Mutation[] = [];
  const places: Mutation[] = [];
  const dissolves: Mutation[] = [];
  const deletes: Mutation[] = [];
  const tree = await host.document.tree().catch(() => []);
  let moved = 0;
  for (let b = 0; b < builds.length; b++) {
    const { def, engineId, instances, plan } = builds[b]!;
    const ids = temps[b]!.map((h) => bound.byHandle.get(h)).filter(
      (id): id is ElementId => !!id,
    );
    if (ids.length === 0) continue;
    // The engine centres a definition on the box of its items.
    const geo = await host.document.elementGeometry(ids).catch(() => []);
    let box: [number, number, number, number] | null = null;
    for (const g of geo) {
      if (!g.bounds) continue;
      const [top, left, bottom, right] = g.bounds;
      const m = (g.itemTransform ?? [1, 0, 0, 1, 0, 0]) as number[];
      for (const [x, y] of [
        [left, top],
        [right, top],
        [left, bottom],
        [right, bottom],
      ] as const) {
        const px = m[0]! * x + m[2]! * y + m[4]!;
        const py = m[1]! * x + m[3]! * y + m[5]!;
        box = box
          ? [
              Math.min(box[0], px),
              Math.min(box[1], py),
              Math.max(box[2], px),
              Math.max(box[3], py),
            ]
          : [px, py, px, py];
      }
    }
    if (!box) continue;
    // Registration-relative (the library's definition space).
    const centre: Vec2 = [
      (box[0] + box[2]) / 2 - plan.origin[0],
      (box[1] + box[3]) / 2 - plan.origin[1],
    ];
    creates.push({
      op: "createSymbol",
      args: {
        name: def.name,
        elementIds: ids,
        symbolId: engineId,
        replace: false,
      },
    } as Mutation);
    for (const id of ids)
      deletes.push({ op: "deleteFrame", args: { frameId: String(id.id) } });
    for (const { inst, pageId, anchors } of instances) {
      if (!pageId) continue;
      const m = fitInstanceTransform(def, centre, { anchors }, inst.origin);
      places.push({
        op: "placeSymbolInstance",
        args: {
          symbolId: engineId,
          pageId,
          at: [m[4], m[5]],
          linear: [m[0], m[1], m[2], m[3]],
        },
      } as Mutation);
      const group = inst.leaves[0] ? parentGroupOf(tree, inst.leaves[0]) : null;
      if (group && typeof group.id === "string")
        dissolves.push({ op: "dissolveGroup", args: { groupId: group.id } });
      for (const leaf of inst.leaves)
        deletes.push({ op: "deleteFrame", args: { frameId: String(leaf.id) } });
      moved++;
    }
    done[def.id] = engineId;
  }
  const phase2: MutationInput = batchMutationFor([
    ...creates,
    ...places,
    ...dissolves,
    ...deletes,
  ]);
  const amend =
    typeof appliedSeq === "number" && host.supports("document.mutate.amend@1")
      ? { amend: appliedSeq, label }
      : { label };
  const out = await host.document.mutate(phase2, amend);
  if (!out.applied) {
    host.log.warn(
      `${label}: refused by the engine: ${JSON.stringify(out.error)}`,
    );
    await host.document.undo().catch(() => undefined);
    return null;
  }
  await writeSymbolLibrary(host, { ...library, migrated: { ...done } });
  host.log.info(
    `${label}: ${creates.length} symbol(s) and ${moved} instance(s) moved onto the engine's symbols`,
  );
  return { symbols: creates.length, instances: moved };
}

/** Run the migration now (a document may already be open) and whenever
 *  a document opens. Serialised: an open during a run waits for it. */
export function installSymbolMigration(host: BundleHost): {
  dispose(): void;
  /** Resolves when the runs started so far have finished (specs). */
  idle(): Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();
  const run = () => {
    chain = chain
      .then(() => migrateSymbolLibrary(host))
      .then(
        () => undefined,
        (e) => host.log.warn(`Migrate symbols: ${String(e)}`),
      );
  };
  run();
  let sub: { dispose(): void } | null = null;
  try {
    sub = host.document.onDidOpen(run);
  } catch {
    sub = null;
  }
  return {
    dispose: () => sub?.dispose(),
    idle: () => chain,
  };
}
