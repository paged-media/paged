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

// Join / Close / Average over path ENDPOINTS.
//
// TRUE JOIN — LIVE since engine protocol v56. The engine now carries the
// two topology ops this command wanted all along:
//   · `closePath { elementId, subpath? }` — closes an open subpath (the
//     faithful inverse of `pathOpenAt`; coincident endpoints MERGE, apart
//     endpoints close with an implicit straight edge);
//   · `joinPaths { elementId, otherId }` — WELDS two open path elements
//     at their nearest endpoints (reversing orientation as needed,
//     merging coincident weld anchors, closing into a ring when both
//     endpoint pairs coincide) and DELETES the other element. One undo
//     is the faithful inverse: the other element comes back.
// Both reject honestly (closed / multi-contour / primitive / degenerate /
// self-join) — a rejection is an engine NO-OP, not a reason to fall back.
//
// THE FALLBACK, still shipped + still honest: on an engine that predates
// v56 neither op exists, so **Join** degrades to the original
// pathPoint-op subset — it moves the nearest endpoint pair to COINCIDE
// (one open path: last anchor onto the first; two open paths: the second
// element's nearest endpoint onto the first's). Topology is untouched
// there — the paths stay open and the log says so. Which lane runs is
// decided by `engineOpVocabulary()` below (a probe, not a version
// guess), so the command title carries no "(coincide)" caveat that would
// be wrong on a current engine.
//
// **Average endpoints** is unchanged: it moves the operating pair to
// their MIDPOINT (Illustrator's Average, both axes) — a pure pathPointSet
// op with no topology story.
//
// endpoint ADDRESSING (the fallback lane + Average): the facade has no
// anchor-level selection door (selection is element-level), so the
// planners operate on the canonical endpoints of SINGLE-SUBPATH OPEN
// paths in a 1- or 2-element selection. Compound/multi-subpath paths
// no-op with a debug log. The v56 ops do their OWN addressing engine-side
// (nearest endpoints), so the weld lane does not need the planners.
//
// `pathPointSet { role: "anchor" }` drags both handles by the same
// delta engine-side (verified in paged-mutate's apply layer), so a
// single op per endpoint preserves the local curve shape. All moves of
// one invocation ride ONE batch = one undo step.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";

import type { AnchorTable, Vec2 } from "@paged-media/draw-geometry";

export const JOIN_AVERAGE_COMMAND_CATEGORY = "Path";

export const JOIN_COMMAND_ID = "media.paged.draw.command.joinEndpoints";
export const AVERAGE_COMMAND_ID = "media.paged.draw.command.averageEndpoints";
export const CLOSE_PATH_COMMAND_ID = "media.paged.draw.command.closePath";

/** The contributed command ids, in registration order. */
export const JOIN_AVERAGE_COMMAND_IDS = [
  JOIN_COMMAND_ID,
  CLOSE_PATH_COMMAND_ID,
  AVERAGE_COMMAND_ID,
];

/** One planned endpoint move: `table` indexes the input table list. */
export interface EndpointMove {
  table: number;
  index: number;
  position: [number, number];
}

interface Endpoint {
  table: number;
  index: number;
  point: Vec2;
}

/** The two canonical endpoints of a SINGLE-subpath OPEN path, or null
 *  (closed, compound, or too short). */
function endpointsOf(table: AnchorTable, ti: number): [Endpoint, Endpoint] | null {
  const n = table.anchors.length;
  if (n < 2) return null;
  const starts = table.subpathStarts.length > 0 ? table.subpathStarts : [0];
  if (starts.length > 1) return null; // compound — no canonical endpoints
  if (!(table.subpathOpen?.[0] ?? false)) return null; // closed contour
  return [
    { table: ti, index: 0, point: table.anchors[0].anchor },
    { table: ti, index: n - 1, point: table.anchors[n - 1].anchor },
  ];
}

const d2 = (a: Vec2, b: Vec2): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** The endpoint pair an invocation operates on: the path's own two
 *  endpoints for ONE table, the closest CROSS-element pair for TWO.
 *  Null = the honest no-op (wrong count / closed / compound). */
function endpointPair(tables: AnchorTable[]): [Endpoint, Endpoint] | null {
  if (tables.length === 1) {
    return endpointsOf(tables[0], 0);
  }
  if (tables.length === 2) {
    const a = endpointsOf(tables[0], 0);
    const b = endpointsOf(tables[1], 1);
    if (!a || !b) return null;
    let best: [Endpoint, Endpoint] | null = null;
    let bestD = Infinity;
    for (const ea of a) {
      for (const eb of b) {
        const dd = d2(ea.point, eb.point);
        if (dd < bestD) {
          bestD = dd;
          best = [ea, eb];
        }
      }
    }
    return best;
  }
  return null;
}

/** Average endpoints: move the operating pair to its MIDPOINT. */
export function planAverageEndpoints(
  tables: AnchorTable[],
): EndpointMove[] | null {
  const pair = endpointPair(tables);
  if (!pair) return null;
  const [a, b] = pair;
  const mid: [number, number] = [
    (a.point[0] + b.point[0]) / 2,
    (a.point[1] + b.point[1]) / 2,
  ];
  return [
    { table: a.table, index: a.index, position: mid },
    { table: b.table, index: b.index, position: mid },
  ];
}

/** Join endpoints (coincide subset — see module header): move the
 *  SECOND endpoint of the operating pair onto the FIRST. Already-
 *  coincident endpoints no-op (null). */
export function planJoinEndpoints(
  tables: AnchorTable[],
): EndpointMove[] | null {
  const pair = endpointPair(tables);
  if (!pair) return null;
  const [a, b] = pair;
  if (d2(a.point, b.point) === 0) return null;
  return [
    {
      table: b.table,
      index: b.index,
      position: [a.point[0], a.point[1]],
    },
  ];
}

/** One endpoint move as the `pathPointSet{ role: "anchor" }` wire op. */
export function pathPointSetMutationFor(
  elementId: ElementId,
  index: number,
  position: [number, number],
): Mutation {
  return {
    op: "pathPointSet",
    args: { elementId, index, role: "anchor", position },
  };
}

/** The ONE batch an invocation commits (one undo step across both
 *  elements). Exported so the conformance spec asserts the exact wire
 *  sequence. */
export function endpointMovesMutationFor(
  elements: ElementId[],
  moves: EndpointMove[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: moves.map((m) =>
        pathPointSetMutationFor(elements[m.table], m.index, m.position),
      ),
    },
  };
}

// ------------------------------------------------- the v56 weld lane
//
// WIRE-TYPE NOTE (skew, named): `closePath` / `joinPaths` are protocol
// v56 ops the INSTALLED `@paged-media/plugin-api` (0.2.25-canary.0) does
// not yet carry in its curated `Mutation` union — the published contract
// lags the local engine. The builders below emit the EXACT v56 wire shape
// and cast once, here, at the boundary; when the contract catches up the
// cast is the only thing to delete.

/** `closePath { elementId, subpath? }` — close one open subpath. */
export function closePathMutationFor(
  elementId: ElementId,
  subpath?: number,
): Mutation {
  return {
    op: "closePath",
    args: subpath === undefined ? { elementId } : { elementId, subpath },
  } as unknown as Mutation;
}

/** `joinPaths { elementId, otherId }` — weld `other` INTO `elementId`
 *  at the nearest endpoint pair (the other element is deleted). */
export function joinPathsMutationFor(
  elementId: ElementId,
  otherId: ElementId,
): Mutation {
  return {
    op: "joinPaths",
    args: { elementId, otherId },
  } as unknown as Mutation;
}

/** A deliberately unknown op name. The engine answers an unknown variant
 *  with its FULL op vocabulary in the deserialize error, so ONE rejected
 *  probe — never applied, nothing on the undo stack — tells us exactly
 *  which ops this build carries. Capability detection over version
 *  sniffing, at the only door a bundle has. */
const OP_PROBE_SENTINEL = "mediaPagedDrawOpProbe";

const vocabularyCache = new WeakMap<
  object,
  Promise<ReadonlySet<string> | null>
>();

/** Pull `unknown variant \`x\`, expected one of \`a\`, \`b\`, …` out of a
 *  rejected mutation's error payload. Null when the shape is foreign
 *  (an older/other engine wording) — callers then stay optimistic and
 *  let the ATTEMPT decide (see `applyJoin`). */
export function parseOpVocabulary(error: unknown): ReadonlySet<string> | null {
  let text: string;
  try {
    text = JSON.stringify(error) ?? "";
  } catch {
    return null;
  }
  const at = text.indexOf("expected one of");
  if (at < 0) return null;
  const quoted = text.slice(at).match(/`[A-Za-z][A-Za-z0-9]*`/g);
  if (!quoted || quoted.length === 0) return null;
  return new Set(quoted.map((q) => q.slice(1, -1)));
}

/** The engine's mutation-op vocabulary, probed ONCE per host (cached).
 *  Null when it could not be read. */
export function engineOpVocabulary(
  host: BundleHost,
): Promise<ReadonlySet<string> | null> {
  const cached = vocabularyCache.get(host);
  if (cached) return cached;
  const probe = (async () => {
    try {
      const outcome = await host.document.mutate({
        op: OP_PROBE_SENTINEL,
        args: {},
      } as unknown as Mutation);
      // An unknown variant can only be REJECTED — an `applied` answer
      // means the probe told us nothing about the vocabulary.
      return outcome.applied ? null : parseOpVocabulary(outcome.error);
    } catch {
      return null;
    }
  })();
  vocabularyCache.set(host, probe);
  return probe;
}

/** Does this engine carry the true-join topology ops (protocol ≥ v56)?
 *  An unreadable vocabulary answers TRUE — optimistic, because the
 *  attempt below detects an unknown op honestly and falls back then. */
export async function supportsPathWeld(host: BundleHost): Promise<boolean> {
  const vocab = await engineOpVocabulary(host);
  if (!vocab) return true;
  return vocab.has("closePath") && vocab.has("joinPaths");
}

type WeldResult = "applied" | "rejected" | "unsupported";

/** Commit one weld op. `"unsupported"` = this engine does not know the
 *  op (fall back); `"rejected"` = the engine KNOWS it and refused (an
 *  honest no-op — never fall back, that would fake a join). */
async function commitWeld(
  host: BundleHost,
  commandId: string,
  mutation: Mutation,
): Promise<WeldResult> {
  let outcome;
  try {
    outcome = await host.document.mutate(mutation);
  } catch {
    return "unsupported";
  }
  if (outcome.applied) return "applied";
  const text = (() => {
    try {
      return JSON.stringify(outcome.error) ?? "";
    } catch {
      return "";
    }
  })();
  if (text.includes("unknown variant")) return "unsupported";
  host.log.debug(`${commandId}: engine refused the weld — no-op (${text})`);
  return "rejected";
}

async function applyEndpointPlan(
  host: BundleHost,
  commandId: string,
  plan: (tables: AnchorTable[]) => EndpointMove[] | null,
): Promise<void> {
  const selection = host.selection.get();
  if (selection.length < 1 || selection.length > 2) {
    host.log.debug(
      `${commandId}: needs 1 or 2 selected open paths (have ${selection.length}) — no-op`,
    );
    return;
  }
  const tables: AnchorTable[] = [];
  for (const id of selection) {
    const r = await host.document.pathAnchors(id).catch(() => null);
    if (!r) {
      host.log.debug(`${commandId}: ${id.kind} exposes no anchor table — no-op`);
      return;
    }
    tables.push({
      anchors: r.anchors,
      subpathStarts: r.subpathStarts,
      subpathOpen: r.subpathOpen,
    });
  }
  const moves = plan(tables);
  if (!moves) {
    host.log.debug(
      `${commandId}: selection has no operable open endpoints — no-op`,
    );
    return;
  }
  const outcome = await host.document.mutate(
    endpointMovesMutationFor(selection, moves),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${commandId} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
  }
}

/** **Join** — the real thing where the engine has it (protocol ≥ v56):
 *  a 2-element selection WELDS (`joinPaths`, one element survives), a
 *  1-element selection CLOSES (`closePath`). On an older engine — and
 *  only there — it degrades to the documented coincide fallback
 *  (`planJoinEndpoints`), which leaves both paths open. */
export async function applyJoin(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  if (selection.length < 1 || selection.length > 2) {
    host.log.debug(
      `${JOIN_COMMAND_ID}: needs 1 or 2 selected paths (have ${selection.length}) — no-op`,
    );
    return;
  }
  if (await supportsPathWeld(host)) {
    const mutation =
      selection.length === 2
        ? joinPathsMutationFor(selection[0], selection[1])
        : closePathMutationFor(selection[0]);
    const result = await commitWeld(host, JOIN_COMMAND_ID, mutation);
    if (result !== "unsupported") return;
    host.log.debug(
      `${JOIN_COMMAND_ID}: engine predates closePath/joinPaths — ` +
        `falling back to the coincide subset (the paths stay OPEN)`,
    );
  }
  await applyEndpointPlan(host, JOIN_COMMAND_ID, planJoinEndpoints);
}

/** **Close path** — the explicit 1-op door onto `closePath`, over EVERY
 *  path-bearing element in the selection (one mutation each = one undo
 *  step each; a batch would make one element's honest refusal abort the
 *  others). On an engine without the op the selection degrades to the
 *  coincide fallback, which only MOVES the endpoints together. */
export async function applyClosePath(host: BundleHost): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${CLOSE_PATH_COMMAND_ID}: no selection — no-op`);
    return;
  }
  if (await supportsPathWeld(host)) {
    let unsupported = false;
    for (const id of selection) {
      const result = await commitWeld(
        host,
        CLOSE_PATH_COMMAND_ID,
        closePathMutationFor(id),
      );
      if (result === "unsupported") {
        unsupported = true;
        break;
      }
    }
    if (!unsupported) return;
    host.log.debug(
      `${CLOSE_PATH_COMMAND_ID}: engine predates closePath — ` +
        `falling back to the coincide subset (the path stays OPEN)`,
    );
  }
  await applyEndpointPlan(host, CLOSE_PATH_COMMAND_ID, planJoinEndpoints);
}

/** Register Join / Close path / Average. The Join title carries NO
 *  "(coincide)" caveat any more: on a v56+ engine it performs the real
 *  weld/close, and the coincide lane is the probe-selected fallback for
 *  older engines (named in this module's header + a debug log). */
export function contributeJoinAverageCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: JOIN_COMMAND_ID,
      title: "Path: Join",
      category: JOIN_AVERAGE_COMMAND_CATEGORY,
      handler: () => applyJoin(host),
    }),
    host.contribute.command({
      id: CLOSE_PATH_COMMAND_ID,
      title: "Path: Close path",
      category: JOIN_AVERAGE_COMMAND_CATEGORY,
      handler: () => applyClosePath(host),
    }),
    host.contribute.command({
      id: AVERAGE_COMMAND_ID,
      title: "Path: Average endpoints",
      category: JOIN_AVERAGE_COMMAND_CATEGORY,
      handler: () =>
        applyEndpointPlan(host, AVERAGE_COMMAND_ID, planAverageEndpoints),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
