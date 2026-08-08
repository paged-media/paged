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

// COMPOUND PATHS — Illustrator's Object ▸ Compound Path ▸ Make / Release.
//
// NO NEW WIRE OP WAS NEEDED, and the code already said so before this
// command existed. The engine has carried compound geometry end to end
// for a long time:
//   · `idml-import` parses each `<GeometryPathType>` child into a
//     per-contour boundary (core's CLAUDE.md: without `subpath_starts`
//     "the renderer joins contours into one polyline and silently
//     mis-renders holes");
//   · `PathAnchorsResult` REPORTS `subpathStarts` / `subpathOpen`, which
//     is why draw-geometry's `AnchorTable` has been compound-aware since
//     the SVG importer landed (`io/svg.ts` already lowers multi-contour
//     shapes);
//   · `setElementProperty{ path: "framePath", value: { type: "framePath",
//     value: { anchors, subpathStarts } } }` REPLACES a path-bearing
//     item's whole anchor table INCLUDING its contour boundaries;
//   · `pathfinderBoolean` already uses exactly that door — core's
//     `apply_pathfinder` builds "an internal Batch (FramePath on kept +
//     RemoveNode for each other)", which is precisely the shape of Make
//     Compound Path. Subtract and Exclude therefore ALREADY produce
//     compound results, so the six pathfinder verbs' correctness on real
//     artwork rests on the same hole behaviour this command exercises.
// So Make is `framePath` on the survivor + `deleteFrame` per consumed
// element, in one batch; Release is `framePath` back to one contour +
// `insertPath` per remaining contour.
//
// WINDING, NOT EVEN-ODD (the part that actually decides whether a hole
// is a hole). Illustrator describes a compound path as even-odd filled.
// This engine fills NON-ZERO: `paged-compose`'s display list documents
// "Paths are filled with `FillRule::NonZero`, matching IDML's
// path-geometry convention", and `paged-export-pdf` emits `f`, never
// `f*`. Under non-zero, a contour inside another only carves a hole when
// it is wound the OTHER WAY; wound the same way it paints a solid island
// and the ring silently becomes a coin. draw-geometry's
// `makeCompoundTable` re-orients every contour by NESTING DEPTH before
// this module ever reaches the wire — the two rules agree on the region
// for any set of non-crossing contours, which is what a compound path is.
//
// MUTATION / UNDO SHAPE (probed against the booted engine, protocol 57 —
// the RFI C-15 rule: assert the real count, never claim "one undo"):
//   · make    = ONE batch ⇒ 1 undo step. Nothing is forward-referenced
//     (no id is minted inside the batch), so the appearance-bake floor
//     of two does not apply here. The ONE exception is named below: a
//     survivor whose own contour is OPEN needs a `closePath` first, and
//     that is a separate mutation ⇒ 2 undo steps in that case only.
//   · release = TWO batches ⇒ 2 undo steps. Batch 1 rewrites the
//     survivor to contour 0 and inserts the other contours; batch 2
//     paints the inserted pieces to match the source — and `insertPath`
//     mints the ids batch 2 addresses, which a batch cannot do to itself
//     (the appearance-bake / blend.ts finding).
//
// HONEST SCOPE — stated here, asserted in conformance:
//   · OPEN contours. `framePath` carries `anchors` + `subpathStarts` and
//     NOTHING ELSE — the wire value has no `subpathOpen` field (core's
//     `Value::FramePath` comment says as much: "`FramePath` cannot serve
//     as the inverse because it does not carry `subpath_open`"). Every
//     contour past the survivor's own therefore renders CLOSED (the
//     renderer's `subpath_open.get(i).unwrap_or(false)`), which is also
//     what a compound path means — it is a FILL boundary. Consumed open
//     paths are merged as closed contours and the log says so. The
//     survivor's OWN flag does survive the write, so an open survivor is
//     CLOSED FIRST with the v56 `closePath` op (a separate mutation, and
//     the table is re-read afterwards because a close may merge
//     coincident endpoints).
//   · A SINGLE selected element is a no-op for Make (there is nothing to
//     merge) — a compound path is made FROM several paths.
//   · MIXED KINDS. The survivor may be any path-bearing kind (polygon /
//     rectangle / textFrame / graphicLine): it keeps its identity, its
//     paint and — for a text frame — its story, and merely gains
//     contours. A CONSUMED element is DELETED, so a textFrame is refused
//     in that role: its story would go with it, which is data loss well
//     past geometry. Illustrator refuses text in a compound path
//     outright; this is the narrower, kinder version of the same rule.
//     A bounds-only element (an IDML `<Rectangle>` / `<Oval>` with no
//     `<PathGeometry>`) contributes its four corners as a closed
//     contour — the same fallback `bakeGeometryOf` uses.
//
// RESIDUAL, named not worked around: released pieces are INSERTED, so
// they land at the top of the page's z-order rather than in the
// survivor's slot (the same insert-lane fact the appearance bake
// records). The survivor itself keeps its slot.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PathAnchorSpec,
} from "@paged-media/plugin-api";
import {
  applyAffine,
  contourRanges,
  inverseApplyAffine,
  makeCompoundTable,
  splitCompound,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
} from "@paged-media/draw-geometry";

import { closePathMutationFor } from "./join-average";
import { supportsPathOps } from "./path-ops";

export const COMPOUND_PATH_COMMAND_CATEGORY = "Path";

export const MAKE_COMPOUND_PATH_COMMAND_ID =
  "media.paged.draw.command.makeCompoundPath";
export const RELEASE_COMPOUND_PATH_COMMAND_ID =
  "media.paged.draw.command.releaseCompoundPath";

/** The contributed command ids, in registration order. */
export const COMPOUND_PATH_COMMAND_IDS = [
  MAKE_COMPOUND_PATH_COMMAND_ID,
  RELEASE_COMPOUND_PATH_COMMAND_ID,
];

// ------------------------------------------------------- wire builders
// Exported so the conformance spec asserts the EXACT wire shape the live
// commands emit (no second copy to drift from).

const specOf = (a: AnchorTriple): PathAnchorSpec => ({
  anchor: [a.anchor[0], a.anchor[1]],
  left: [a.left[0], a.left[1]],
  right: [a.right[0], a.right[1]],
});

/** `setElementProperty{ framePath }` — the whole-anchor-table replace
 *  door, contour boundaries included. */
export function framePathMutationFor(
  elementId: ElementId,
  table: AnchorTable,
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId,
      path: "framePath",
      value: {
        type: "framePath",
        value: {
          anchors: table.anchors.map(specOf),
          subpathStarts: [...table.subpathStarts],
        },
      },
    },
  };
}

/** The ONE batch "Make compound path" commits: the merged table onto
 *  the survivor, then one `deleteFrame` per consumed element — the same
 *  shape core's own `apply_pathfinder` builds internally. */
export function makeCompoundBatchFor(
  kept: ElementId,
  others: readonly ElementId[],
  table: AnchorTable,
): Mutation {
  return {
    op: "batch",
    args: {
      ops: [
        framePathMutationFor(kept, table),
        ...others.map(
          (id) =>
            ({
              op: "deleteFrame",
              args: { frameId: id.id as string },
            }) as Mutation,
        ),
      ],
    },
  };
}

/** Batch 1 of "Release compound path": the survivor keeps contour 0,
 *  every other contour becomes a fresh `insertPath` (page-space
 *  anchors, the `insertPath` convention). */
export function releaseInsertBatchFor(
  kept: ElementId,
  pageId: string,
  keptTable: AnchorTable,
  rest: readonly AnchorTable[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: [
        framePathMutationFor(kept, keptTable),
        ...rest.map(
          (t) =>
            ({
              op: "insertPath",
              args: {
                pageId,
                anchors: t.anchors.map(specOf),
                open: t.subpathOpen?.[0] ?? false,
              },
            }) as Mutation,
        ),
      ],
    },
  };
}

/** The paint a released piece inherits from the element it came out of
 *  (Illustrator gives every released piece the compound's appearance). */
export interface CompoundPaint {
  fill: string | null;
  stroke: string | null;
  weight: number | null;
}

/** Batch 2 of "Release compound path": paint the inserted pieces like
 *  the source. Empty ops (nothing to inherit) still ride a batch so the
 *  caller's undo arithmetic stays honest. */
export function releasePaintBatchFor(
  created: readonly ElementId[],
  paint: CompoundPaint,
): Mutation {
  const ops: Mutation[] = [];
  for (const elementId of created) {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameFillColor",
        value: { type: "colorRef", value: paint.fill },
      },
    });
    ops.push({
      op: "setElementProperty",
      args: {
        elementId,
        path: "frameStrokeColor",
        value: { type: "colorRef", value: paint.stroke },
      },
    });
    if (typeof paint.weight === "number") {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId,
          path: "frameStrokeWeight",
          value: { type: "length", value: paint.weight },
        },
      });
    }
  }
  return { op: "batch", args: { ops } };
}

// ------------------------------------------------------ geometry reads

/** One selected element's contours, lifted into PAGE space (each
 *  element carries its own `ItemTransform`, so a merge has to agree on
 *  a space before it concatenates anything). */
export interface CompoundSource {
  id: ElementId;
  pageId: string;
  /** PAGE-space contours. */
  table: AnchorTable;
  /** The element's own transform (null = identity) — the survivor's is
   *  what page space is mapped BACK through on the write. */
  itemTransform: Affine | null;
}

const toPage = (
  m: Affine | null,
  p: readonly [number, number],
): [number, number] =>
  m ? (applyAffine(m, p[0], p[1]) as [number, number]) : [p[0], p[1]];

/** Map a PAGE-space table into `m`'s inner space. Returns the table
 *  unchanged for an identity/absent transform, and null when `m` is
 *  singular (nothing sane to write). */
export function tableInInnerSpace(
  table: AnchorTable,
  m: Affine | null,
): AnchorTable | null {
  if (!m) return table;
  const back = (p: readonly [number, number]): [number, number] | null => {
    const q = inverseApplyAffine(m, p[0], p[1]);
    return q ? [q[0], q[1]] : null;
  };
  const anchors: AnchorTriple[] = [];
  for (const a of table.anchors) {
    const anchor = back(a.anchor);
    const left = back(a.left);
    const right = back(a.right);
    if (!anchor || !left || !right) return null;
    anchors.push({ anchor, left, right });
  }
  return {
    anchors,
    subpathStarts: [...table.subpathStarts],
    subpathOpen: table.subpathOpen ? [...table.subpathOpen] : undefined,
  };
}

/** Read `id`'s contours in PAGE space. Path-bearing elements come
 *  through `pathAnchors`; a BOUNDS-ONLY element (an IDML `<Rectangle>` /
 *  `<Oval>` with no `<PathGeometry>`) falls back to its four
 *  `elementGeometry` corners as one closed contour — the same fallback
 *  the appearance bake uses. Null = no readable geometry. */
export async function compoundSourceOf(
  host: BundleHost,
  id: ElementId,
): Promise<CompoundSource | null> {
  const read = await host.document.pathAnchors(id).catch(() => null);
  if (read && read.anchors.length >= 2) {
    // C-23 — see appearance-bake: the combine inserts onto a page.
    if (!read.pageId) return null;
    const m = (read.itemTransform ?? null) as Affine | null;
    return {
      id,
      pageId: read.pageId,
      itemTransform: m,
      table: {
        anchors: read.anchors.map((a) => ({
          anchor: toPage(m, a.anchor),
          left: toPage(m, a.left),
          right: toPage(m, a.right),
        })),
        subpathStarts: [...read.subpathStarts],
        subpathOpen: read.subpathOpen ? [...read.subpathOpen] : undefined,
      },
    };
  }
  const items = await host.document.elementGeometry([id]).catch(() => []);
  const item = items[0];
  if (!item) return null;
  // C-23 — pasteboard source: this path inserts onto a page.
  if (!item.pageId) return null;
  const [top, left, bottom, right] = item.bounds;
  const m = (item.itemTransform ?? null) as Affine | null;
  const corners: [number, number][] = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ];
  return {
    id,
    pageId: item.pageId,
    itemTransform: m,
    table: {
      anchors: corners.map((c) => {
        const p = toPage(m, c);
        return { anchor: p, left: [...p] as [number, number], right: [...p] as [number, number] };
      }),
      subpathStarts: [0],
      subpathOpen: [false],
    },
  };
}

/** The element's frame paint — what a released piece inherits. */
export async function compoundPaintOf(
  host: BundleHost,
  id: ElementId,
): Promise<CompoundPaint> {
  const out: CompoundPaint = { fill: null, stroke: null, weight: null };
  try {
    const props = await host.document.elementProperties(id);
    for (const e of props?.entries ?? []) {
      const v = e.value;
      if (!v) continue;
      if (e.path === "frameFillColor" && v.type === "colorRef") out.fill = v.value;
      else if (e.path === "frameStrokeColor" && v.type === "colorRef") {
        out.stroke = v.value;
      } else if (e.path === "frameStrokeWeight" && v.type === "length") {
        out.weight = v.value;
      }
    }
  } catch {
    /* defaults stand */
  }
  return out;
}

/** How many contours a table carries. */
export const contourCountOf = (table: AnchorTable): number =>
  contourRanges(table.anchors.length, table.subpathStarts).length;

/** Every leaf element id in the scene tree — the honest enumeration of
 *  what a multi-insert batch created (a batch outcome reports ONE
 *  `createdId`; the blend.ts / appearance-bake precedent). */
async function leafElements(host: BundleHost): Promise<ElementId[]> {
  const out: ElementId[] = [];
  const walk = (nodes: readonly { id?: ElementId | null; children?: unknown }[]) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as {
        id?: ElementId | null;
        children?: unknown;
      }[];
      if (children.length > 0) walk(children);
      else if (node.id) out.push(node.id);
    }
  };
  walk(await host.document.tree().catch(() => []));
  return out;
}

const idSet = (list: readonly ElementId[]): Set<string> =>
  new Set(
    list
      .map((e) => (typeof e.id === "string" ? e.id : null))
      .filter((s): s is string => s !== null),
  );

// ---------------------------------------------------------- appliers

/**
 * **Make compound path** — merge the selected path elements' contours
 * into ONE element's anchor table, keeping the FIRST selected as the
 * survivor (the kept-is-top convention `commands/pathfinder.ts` uses)
 * and deleting the rest. Returns the survivor's new contour count, or
 * null on a refusal (always logged, never thrown — the dash-command
 * convention).
 */
export async function applyMakeCompoundPath(
  host: BundleHost,
): Promise<number | null> {
  const label = MAKE_COMPOUND_PATH_COMMAND_ID;
  const selection = host.selection.get().filter(supportsPathOps);
  if (selection.length < 2) {
    host.log.debug(
      `${label}: needs ≥ 2 selected path elements (have ${selection.length}) — no-op`,
    );
    return null;
  }
  const [kept, ...rest] = selection;
  const others = rest.filter((id) => {
    if (id.kind === "textFrame") {
      host.log.debug(
        `${label}: skipping the text frame ${String(id.id)} — a consumed ` +
          `element is DELETED and its story would go with it (make it a ` +
          `path first, or select it FIRST so it survives)`,
      );
      return false;
    }
    return true;
  });
  if (others.length === 0) {
    host.log.debug(`${label}: nothing left to merge into the survivor — no-op`);
    return null;
  }

  // An OPEN survivor is closed first: `framePath` cannot carry
  // `subpathOpen`, so the survivor's stale flag would leave contour 0
  // open in the merged compound. This is a SEPARATE mutation (a close
  // may merge coincident endpoints, so the table has to be re-read) —
  // hence 2 undo steps in this case, and only in this case.
  let keptSource = await compoundSourceOf(host, kept);
  if (!keptSource) {
    host.log.warn(`${label}: the survivor exposes no readable geometry — no-op`);
    return null;
  }
  if (keptSource.table.subpathOpen?.some((o) => o)) {
    host.log.debug(
      `${label}: the survivor has an OPEN contour — closing it first ` +
        `(a compound path is a FILL boundary; framePath carries no ` +
        `subpathOpen). This makes the operation TWO undo steps.`,
    );
    const closed = await host.document.mutate(closePathMutationFor(kept));
    if (closed.applied) {
      keptSource = await compoundSourceOf(host, kept);
      if (!keptSource) {
        host.log.warn(`${label}: the survivor became unreadable after close`);
        return null;
      }
    } else {
      host.log.debug(
        `${label}: the engine refused the close (${JSON.stringify(
          closed.error,
        )}) — merging anyway; contour 0 stays open`,
      );
    }
  }

  const sources: CompoundSource[] = [keptSource];
  for (const id of others) {
    const source = await compoundSourceOf(host, id);
    if (!source) {
      host.log.warn(
        `${label}: ${id.kind} ${String(id.id)} exposes no readable geometry — no-op`,
      );
      return null;
    }
    if (source.table.subpathOpen?.some((o) => o)) {
      host.log.debug(
        `${label}: ${String(id.id)} has an OPEN contour — it merges as a ` +
          `CLOSED contour (framePath carries no subpathOpen)`,
      );
    }
    sources.push(source);
  }

  // One space, then the winding re-orientation that makes a nested
  // contour a HOLE under the engine's non-zero fill.
  const merged = makeCompoundTable(sources.map((s) => s.table));
  const inner = tableInInnerSpace(merged, keptSource.itemTransform);
  if (!inner) {
    host.log.warn(
      `${label}: the survivor's ItemTransform is singular — no-op`,
    );
    return null;
  }
  const outcome = await host.document.mutate(
    makeCompoundBatchFor(kept, others, inner),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label} rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return null;
  }
  await host.selection.set([kept]);
  return contourCountOf(inner);
}

/**
 * **Release compound path** — split every selected multi-contour
 * element back into one element per contour: the source keeps contour
 * 0, the rest become fresh paths carrying the source's paint. Returns
 * the ids created (empty on a refusal, always logged).
 */
export async function applyReleaseCompoundPath(
  host: BundleHost,
): Promise<ElementId[]> {
  const label = RELEASE_COMPOUND_PATH_COMMAND_ID;
  const selection = host.selection.get().filter(supportsPathOps);
  if (selection.length === 0) {
    host.log.debug(`${label}: no path-bearing selection — no-op`);
    return [];
  }
  const created: ElementId[] = [];
  for (const id of selection) {
    created.push(...(await releaseOne(host, id)));
  }
  if (created.length > 0) {
    await host.selection.set([...selection, ...created]);
  }
  return created;
}

async function releaseOne(
  host: BundleHost,
  id: ElementId,
): Promise<ElementId[]> {
  const label = RELEASE_COMPOUND_PATH_COMMAND_ID;
  const source = await compoundSourceOf(host, id);
  if (!source) {
    host.log.debug(`${label}: ${id.kind} exposes no readable geometry — no-op`);
    return [];
  }
  const parts = splitCompound(source.table);
  if (parts.length < 2) {
    host.log.debug(
      `${label}: ${String(id.id)} is not a compound path (1 contour) — no-op`,
    );
    return [];
  }
  const keptInner = tableInInnerSpace(parts[0], source.itemTransform);
  if (!keptInner) {
    host.log.warn(`${label}: ${String(id.id)}'s ItemTransform is singular — no-op`);
    return [];
  }
  const paint = await compoundPaintOf(host, id);
  const before = idSet(await leafElements(host));
  const split = await host.document.mutate(
    releaseInsertBatchFor(id, source.pageId, keptInner, parts.slice(1)),
  );
  if (!split.applied) {
    host.log.warn(
      `${label} rejected by engine: ${JSON.stringify(split.error)}`,
    );
    return [];
  }
  const minted = (await leafElements(host)).filter(
    (e) => typeof e.id === "string" && !before.has(e.id),
  );
  if (minted.length !== parts.length - 1) {
    host.log.warn(
      `${label}: expected ${parts.length - 1} released pieces, found ` +
        `${minted.length} — leaving them unpainted`,
    );
    return minted;
  }
  const painted = await host.document.mutate(
    releasePaintBatchFor(minted, paint),
  );
  if (!painted.applied) {
    host.log.warn(
      `${label}: piece paint rejected by engine: ${JSON.stringify(
        painted.error,
      )}`,
    );
  }
  return minted;
}

/** Register Make / Release compound path (the dash-command pattern). */
export function contributeCompoundPathCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: MAKE_COMPOUND_PATH_COMMAND_ID,
      title: "Path: Make compound path",
      category: COMPOUND_PATH_COMMAND_CATEGORY,
      handler: () => applyMakeCompoundPath(host).then(() => undefined),
    }),
    host.contribute.command({
      id: RELEASE_COMPOUND_PATH_COMMAND_ID,
      title: "Path: Release compound path",
      category: COMPOUND_PATH_COMMAND_CATEGORY,
      handler: () => applyReleaseCompoundPath(host).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
