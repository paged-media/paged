// Join / Average over path ENDPOINTS — pathPoint-op consumers (the
// dash.ts command pattern over the anchor-machine's pure-planner
// pattern).
//
// HONEST SUBSET, named (the task's "if true join needs an engine op"):
//   · a TRUE Illustrator join — CLOSING one open contour with a real
//     segment, or WELDING two elements into one path — is NOT
//     wire-representable: there is no `closePath`/`joinPaths`/
//     element-merge mutation (`pathOpenAt` only OPENS; `framePath`
//     carries anchors + subpathStarts but no open flags). Both are
//     named engine-op gaps for the cross-repo RFI
//     (`thoughts/docs/paged/plugin-platform/rfi-core-sdk-gaps.md`).
//   · what SHIPS is the pathPoint-op subset: **Join endpoints** moves
//     the nearest endpoint pair to COINCIDE (one open path: last anchor
//     onto the first; two open paths: the second element's nearest
//     endpoint onto the first's). **Average endpoints** moves the pair
//     to their MIDPOINT (Illustrator's Average, both axes). Topology is
//     untouched — the paths stay open, which the command names in its
//     title ("(coincide)").
//   · endpoint ADDRESSING: the facade has no anchor-level selection
//     door (selection is element-level), so the planners operate on
//     the canonical endpoints of SINGLE-SUBPATH OPEN paths in a 1- or
//     2-element selection. Compound/multi-subpath paths no-op with a
//     debug log.
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

/** The contributed command ids, in registration order. */
export const JOIN_AVERAGE_COMMAND_IDS = [JOIN_COMMAND_ID, AVERAGE_COMMAND_ID];

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

/** Register Join/Average (titles carry the honest "(coincide)" /
 *  endpoint scoping). */
export function contributeJoinAverageCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: JOIN_COMMAND_ID,
      title: "Path: Join endpoints (coincide)",
      category: JOIN_AVERAGE_COMMAND_CATEGORY,
      handler: () => applyEndpointPlan(host, JOIN_COMMAND_ID, planJoinEndpoints),
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
