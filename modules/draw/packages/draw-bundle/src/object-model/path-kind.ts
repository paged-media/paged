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

// `path` — a page item's GEOMETRY and POINTS (ADR 323).
//
// CORE-BACKED. Core models the anchor table and writes it through ONE
// door, `setElementProperty { framePath }` (the whole table, contour
// boundaries included — the door Make Compound Path and core's own
// pathfinder use). Core's object seam publishes NO schema row for it
// (`framePath` is an "op" in plugin-sdk `core-schema.ts`: reachable only
// with a raw wire value), so this kind is the typed face of that door:
// `points` and `subpathStarts` are list values, and a write is the
// `framePath` mutation — ONE batch, ONE undo step. Nothing is stored by
// the plugin.
//
// ONE POINT is an INDEXED row (plugin-sdk DESIGN.md §21.8): `points[]`
// is one anchor triple, `points[].anchor` / `.left` / `.right` one of its
// points, so `points[3].anchor` reads or moves one handle; a write is
// still the whole table through `framePath` (one mutation per element,
// however many points a batch touches). An index past the table is
// refused, never appended. `subpathOpen` is read-only because
// `framePath` takes no open flags (the open/close doors are `pathOpenAt`
// / `closePath` — draw's Join / Close commands).

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

import { framePathMutationFor } from "../commands/compound-path";
import { fromWrite, kindBatch, type Planner } from "./plan";
import {
  ANCHOR,
  BOOL,
  INT,
  POINT,
  addressOf,
  coreAddressOf,
  derived,
  elementOfId,
  localIdOf,
  refuse,
  ro,
  row,
  treeItems,
  val,
} from "./shared";

export const PATH_KIND = "path";

export const PATH_SCHEMA: readonly PropertySchema[] = [
  row(
    "points",
    { kind: "list", of: ANCHOR },
    {
      title: "Points",
      summary:
        "Every anchor with its two direction handles, in the item's inner coordinates (pt), contour after contour. A write replaces the whole table (framePath).",
    },
  ),
  row("points[]", ANCHOR, {
    title: "Point",
    summary: "One anchor with its two direction handles (`points[3]`); a write replaces that point only.",
  }),
  row("points[].anchor", POINT, { title: "Anchor", summary: "One point's anchor (`points[3].anchor`)." }),
  row("points[].left", POINT, { title: "Left handle", summary: "One point's incoming direction handle." }),
  row("points[].right", POINT, { title: "Right handle", summary: "One point's outgoing direction handle." }),
  row(
    "subpathStarts",
    { kind: "list", of: INT },
    {
      title: "Contour starts",
      summary:
        "Index of each contour's first point; empty = one contour. A compound path has more than one.",
    },
  ),
  ro("subpathOpen", { kind: "list", of: BOOL }, "Per contour: true = open. Write through Join / Close (pathOpenAt / closePath)."),
  derived("pointCount", INT, "How many points the table holds."),
  derived("contourCount", INT, "How many contours (1 + compound holes)."),
  ro(
    "itemTransform",
    { kind: "transform" },
    "The item's transform [a,b,c,d,tx,ty]; written through the core frame path frameTransform.",
  ),
];

/** The page-item kinds that carry an anchor table. */
const PATH_BEARING = new Set(["polygon", "graphicLine", "rectangle", "oval"]);

type Triple = { anchor: [number, number]; left: [number, number]; right: [number, number] };

interface Table {
  anchors: Triple[];
  subpathStarts: number[];
  subpathOpen: boolean[];
  itemTransform: number[] | null;
}

const pair = (p: readonly number[]): [number, number] => [p[0]!, p[1]!];

/** `points[3]` → { index: 3 }, `points[3].left` → { index: 3, field: "left" }. */
export function pointPathOf(path: string): { index: number; field?: "anchor" | "left" | "right" } | null {
  const m = /^points\[(\d+)\](?:\.(anchor|left|right))?$/.exec(path);
  if (!m) return null;
  return { index: Number(m[1]), ...(m[2] ? { field: m[2] as "anchor" | "left" | "right" } : {}) };
}

async function readTable(host: BundleHost, id: ElementId): Promise<Table | null> {
  const r = await host.document.pathAnchors(id);
  if (!r) return null;
  return {
    anchors: r.anchors.map((a) => ({ anchor: pair(a.anchor), left: pair(a.left), right: pair(a.right) })),
    subpathStarts: [...r.subpathStarts],
    subpathOpen: [...(r.subpathOpen ?? [])],
    itemTransform: r.itemTransform ? [...r.itemTransform] : null,
  };
}

/** A contour list is valid for N points when it is strictly ascending,
 *  in range, and does not start a contour at 0 twice. Pure. */
export function validSubpathStarts(starts: readonly number[], n: number): boolean {
  let last = -1;
  for (const s of starts) {
    if (!Number.isInteger(s) || s <= last || s < 0 || s >= n) return false;
    last = s;
  }
  return true;
}

export function makePathKind(host: BundleHost): ObjectKindContribution & Planner {
  const elementOf = (address: string): ElementId | null => {
    const id = localIdOf(address, PATH_KIND);
    const el = id ? elementOfId(id) : null;
    return el && PATH_BEARING.has(el.kind) ? el : null;
  };
  return {
    kind: PATH_KIND,
    title: "Path",
    schema: PATH_SCHEMA,
    content: { kind: "vector" },
    hostOf: (address) => localIdOf(address, PATH_KIND),
    async list() {
      const roots = await host.document.tree();
      return treeItems(roots)
        .filter((id) => PATH_BEARING.has(id.kind))
        .map((id) => addressOf(PATH_KIND, coreAddressOf(id)));
    },
    async get(address, path): Promise<ObjectValue> {
      const el = elementOf(address);
      if (!el) return refuse("unknownAddress", `${address} is not a path-bearing page item`);
      const t = await readTable(host, el);
      if (!t) return refuse("unknownAddress", `${address}: the engine answered no anchor table`);
      const one = pointPathOf(path);
      if (one) {
        const p = t.anchors[one.index];
        if (!p) return refuse("unknownPath", `${address} has ${t.anchors.length} points, no ${path}`);
        return val(one.field ? p[one.field] : p);
      }
      switch (path) {
        case "points":
        case "content":
          return val(t.anchors);
        case "subpathStarts":
          return val(t.subpathStarts);
        case "subpathOpen":
          return val(t.subpathOpen);
        case "pointCount":
          return val(t.anchors.length);
        case "contourCount":
          return val(Math.max(1, t.subpathStarts.length));
        case "itemTransform":
          return t.itemTransform ? val(t.itemTransform) : { kind: "absent" };
        default:
          return refuse("unknownPath", `path has no "${path}"`);
      }
    },
    plan: async (ops) => fromWrite(await planPath(ops)),
    batch: kindBatch(host, async (ops) => fromWrite(await planPath(ops))),
  };

  async function planPath(ops: readonly ObjectOp[]): Promise<ObjectWrite> {
      // Fold every op per element onto its table, then ONE framePath each.
      const tables = new Map<string, { el: ElementId; t: Table; starts: boolean }>();
      for (const op of ops) {
        if (op.op !== "set") {
          return {
            kind: "rejected",
            reason:
              `path ${op.op}: a path is a core page item — create it with insertPath ` +
              "(draw's tools / insert commands) and delete it as a core item",
          };
        }
        const el = elementOf(op.address);
        if (!el) return { kind: "rejected", reason: `${op.address} is not a path-bearing page item` };
        const key = `${el.kind}:${String(el.id)}`;
        let entry = tables.get(key);
        if (!entry) {
          const t = await readTable(host, el);
          if (!t) return { kind: "rejected", reason: `${op.address}: no anchor table to edit` };
          entry = { el, t, starts: false };
          tables.set(key, entry);
        }
        if (op.path === "points" || op.path === "content") {
          entry.t.anchors = (op.value as Triple[]).map((p) => ({
            anchor: pair(p.anchor),
            left: pair(p.left),
            right: pair(p.right),
          }));
        } else if (pointPathOf(op.path)) {
          const one = pointPathOf(op.path)!;
          const p = entry.t.anchors[one.index];
          if (!p) {
            return {
              kind: "rejected",
              reason: `${op.address} has ${entry.t.anchors.length} points, no ${op.path} (set points to add one)`,
            };
          }
          if (one.field) {
            p[one.field] = pair(op.value as number[]);
          } else {
            const v = op.value as Triple;
            entry.t.anchors[one.index] = { anchor: pair(v.anchor), left: pair(v.left), right: pair(v.right) };
          }
        } else if (op.path === "subpathStarts") {
          entry.t.subpathStarts = [...(op.value as number[])];
          entry.starts = true;
        } else {
          return { kind: "rejected", reason: `path has no writable "${op.path}"` };
        }
      }
      const mutations: MutationInput[] = [];
      for (const { el, t, starts } of tables.values()) {
        if (t.anchors.length === 0) return { kind: "rejected", reason: "a path needs at least one point" };
        if (!validSubpathStarts(t.subpathStarts, t.anchors.length)) {
          if (starts) {
            return {
              kind: "rejected",
              reason: `subpathStarts ${JSON.stringify(t.subpathStarts)} is not ascending within 0..${t.anchors.length - 1}`,
            };
          }
          // A new point list the old contours no longer fit: one contour.
          t.subpathStarts = [];
        }
        mutations.push(
          framePathMutationFor(el, { anchors: t.anchors, subpathStarts: t.subpathStarts }),
        );
      }
      return { kind: "mutations", mutations };
  }
}
