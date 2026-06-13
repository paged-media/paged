// Select-same — select every element sharing the active element's fill /
// stroke / stroke-weight (concept §13.9 "Select by same fill/stroke/
// appearance/etc.", Tier A). PURE SELECTION — no mutation: it reads the
// reference element's typed properties (`host.document.elementProperties`),
// enumerates the document's leaf elements (`host.document.tree`), reads
// each candidate's same property, and `host.selection.set`s the matches.
//
// Three commands (one criterion each): same FILL color, same STROKE color,
// same STROKE WEIGHT. The reference is the FIRST selected element; no
// selection (or the reference exposes no such property) ⇒ no-op (a debug
// log, never a throw). The reference itself is always included in the
// result (it trivially matches itself).
//
// Host-agnostic: imports only plugin-api types; every engine touch is a
// `host.*` facade (elementProperties / tree / selection).

import type {
  BundleHost,
  Disposable,
  ElementId,
  PropertyPath,
  SceneTreeNode,
} from "@paged-media/plugin-api";

export const SELECT_SAME_COMMAND_CATEGORY = "Select";

export const SELECT_SAME_FILL_COMMAND_ID =
  "media.paged.draw.command.selectSameFill";
export const SELECT_SAME_STROKE_COMMAND_ID =
  "media.paged.draw.command.selectSameStroke";
export const SELECT_SAME_STROKE_WEIGHT_COMMAND_ID =
  "media.paged.draw.command.selectSameStrokeWeight";

/** The contributed command ids, in registration order. */
export const SELECT_SAME_COMMAND_IDS = [
  SELECT_SAME_FILL_COMMAND_ID,
  SELECT_SAME_STROKE_COMMAND_ID,
  SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
];

/** The criterion a Select-same command matches on. */
export type SelectSameCriterion = "fill" | "stroke" | "strokeWeight";

/** The PropertyPath each criterion reads. */
export function pathForCriterion(c: SelectSameCriterion): PropertyPath {
  switch (c) {
    case "fill":
      return "frameFillColor";
    case "stroke":
      return "frameStrokeColor";
    case "strokeWeight":
      return "frameStrokeWeight";
  }
}

/** A criterion's comparable value read off a property snapshot — a
 *  colorRef string, a length number, or null when the element doesn't
 *  carry it. Exported so the conformance spec asserts the read shape. */
export async function valueForCriterion(
  host: BundleHost,
  id: ElementId,
  c: SelectSameCriterion,
): Promise<string | number | null> {
  const path = pathForCriterion(c);
  try {
    const props = await host.document.elementProperties(id);
    for (const e of props?.entries ?? []) {
      if (e.path !== path) continue;
      const v = e.value;
      if (!v) return null;
      if (v.type === "colorRef") return v.value; // string | null
      if (v.type === "length") return v.value; // number | null
      return null;
    }
  } catch {
    /* unreadable ⇒ no match contribution */
  }
  return null;
}

/** Flatten the scene tree to its selectable LEAF element ids (frames +
 *  paths — NOT groups/spreads/pages; we match on per-frame paint). A
 *  node with children is a container; a node with an id and no children
 *  is a leaf. Groups (id + children) are descended into, not matched. */
export function leafIdsOf(roots: SceneTreeNode[]): ElementId[] {
  const out: ElementId[] = [];
  const walk = (nodes: SceneTreeNode[]) => {
    for (const node of nodes) {
      const children = node.children ?? [];
      if (children.length > 0) {
        walk(children);
      } else if (node.id) {
        out.push(node.id);
      }
    }
  };
  walk(roots);
  return out;
}

/** Equality with a small tolerance for stroke-weight (pt) reads so a
 *  round-tripped 1.0 vs 0.9999 doesn't miss. Colors compare exactly. */
function sameValue(a: string | number | null, b: string | number | null): boolean {
  if (a === null || b === null) return false;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-3;
  }
  return a === b;
}

/** Compute the matching set (the pure core, exported for the conformance
 *  spec): every leaf whose criterion value equals the reference's. The
 *  reference is included. Returns `[]` when the reference value is null
 *  (nothing to match on). */
export async function selectSameMatches(
  host: BundleHost,
  reference: ElementId,
  c: SelectSameCriterion,
): Promise<ElementId[]> {
  const refValue = await valueForCriterion(host, reference, c);
  if (refValue === null) return [];
  const roots = await host.document.tree();
  const leaves = leafIdsOf(roots);
  const matches: ElementId[] = [];
  for (const id of leaves) {
    const v = await valueForCriterion(host, id, c);
    if (sameValue(v, refValue)) matches.push(id);
  }
  return matches;
}

async function applySelectSame(
  host: BundleHost,
  commandId: string,
  c: SelectSameCriterion,
): Promise<void> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${commandId}: no reference selected — no-op`);
    return;
  }
  const reference = selection[0];
  const matches = await selectSameMatches(host, reference, c);
  if (matches.length === 0) {
    host.log.debug(
      `${commandId}: reference exposes no ${c} (or no matches) — no-op`,
    );
    return;
  }
  await host.selection.set(matches);
}

/** Register the three Select-same commands (same fill / stroke / stroke
 *  weight). Pure selection — no document mutation. */
export function contributeSelectSameCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: SELECT_SAME_FILL_COMMAND_ID,
      title: "Select same: Fill",
      category: SELECT_SAME_COMMAND_CATEGORY,
      handler: () => applySelectSame(host, SELECT_SAME_FILL_COMMAND_ID, "fill"),
    }),
    host.contribute.command({
      id: SELECT_SAME_STROKE_COMMAND_ID,
      title: "Select same: Stroke",
      category: SELECT_SAME_COMMAND_CATEGORY,
      handler: () =>
        applySelectSame(host, SELECT_SAME_STROKE_COMMAND_ID, "stroke"),
    }),
    host.contribute.command({
      id: SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
      title: "Select same: Stroke weight",
      category: SELECT_SAME_COMMAND_CATEGORY,
      handler: () =>
        applySelectSame(
          host,
          SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
          "strokeWeight",
        ),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
