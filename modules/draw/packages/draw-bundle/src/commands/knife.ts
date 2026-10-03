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

// THE KNIFE — Illustrator's freehand cut: every CLOSED path the cut
// crosses is split into separate closed pieces along it.
//
// WHICH ENGINE DOOR, AND WHY. The geometry is the engine's PLANAR
// ARRANGEMENT (B-22, `host.document.planarRegions`), queried over the
// target and a thin closed STRIP around the cut. The arrangement's faces
// whose containment signature is exactly "the target, not the strip" ARE
// the pieces — already split into connected components, holes already
// assigned to the piece that surrounds them — so nothing here has to
// intersect Béziers with a polyline or walk a planar graph. Every other
// candidate was measured against the engine (core `planar_ops.rs`) and
// fails on something a knife must keep:
//   · `pathfinderDivide` over [strip, target] makes EVERY face an object
//     — the strip's own faces (inside and outside the target) too. The
//     first lands on the strip element; the rest are fresh polygons no
//     batch can name (a region op mints at APPLY time, so a following
//     `bindCreated` has nothing to bind), so they could only be removed
//     by a SECOND mutation — a second undo step that brings the strip
//     artwork back on the first Cmd-Z.
//   · `pathfinderCrop` with a cutter of "everything but the strip" keeps
//     exactly the pieces and consumes the cutter — and DROPS EVERY
//     PIECE'S STROKE (Illustrator's Crop does; core sets each result's
//     stroke to `Swatch/None`), which a knife must not do.
//   · `pathfinderBoolean` subtract keeps the target whole as ONE compound
//     path of all the pieces: not "separate closed pieces".
// So the engine supplies the faces and this module builds the result:
// the target is REWRITTEN to piece 0 (`framePath` + `frameBounds`, the
// same two writes core's own Divide gives a carrier — so the target keeps
// its id, its stroke, its effects, its metadata, its slot) and every
// other piece is INSERTED, named by `bindCreated` and painted like the
// target in the same batch.
//
// THE STRIP HAS TO EXIST TO BE QUERIED, and that is the one unusual step.
// The arrangement door takes element ids, not geometry, so the strips are
// inserted (ONE batch for every target), queried, and then WITHDRAWN with
// `document.undo()` before the cut is written — so the user's history
// holds exactly ONE knife step and Cmd-Z restores the paths. The undo is
// GUARDED: if the strips are still there afterwards, something else
// landed between the insert and the undo and that is what was undone; it
// is re-done at once, the strips are deleted in the cut's own batch
// instead, and the log says that this cut cost two undo steps.
//
// THE STRIP IS `KNIFE_STRIP_WIDTH_PT` WIDE (1/16 pt). The arrangement
// snaps every input to its 1/64 pt grid (core C-21), so a narrower strip
// stops being a region at all — measured: at 0.02 pt the faces stop
// tiling the target. The pieces therefore come back 1/32 pt either side
// of the line that was drawn; `snapOntoPolyline` moves every anchor
// within reach of the cut back ONTO it, so neighbouring pieces meet
// again. Where the cut crosses an edge obliquely the two pieces' corners
// land up to `width · cot(angle)` apart along the cut — microscopic, and
// named rather than hidden.
//
// WHAT IS CUT. The selection, or — with nothing selected, as in
// Illustrator — every leaf on the page whose box the cut's box touches.
// Of those, only CLOSED path-bearing frames: polygons, rectangles and
// closed graphic lines. A path with an OPEN contour is skipped (Scissors
// cuts open paths); a TEXT FRAME is refused (its story cannot be split);
// a target the cut does not divide into at least two pieces — a cut that
// only nicks it — is left exactly as it was.
//
// WHAT A PIECE CARRIES. Piece 0 is the target itself, so it keeps
// everything. Every other piece is a fresh path with the target's fill,
// stroke colour and stroke weight — the same set core's own Divide gives
// the fresh polygons it mints — mapped through the target's transform
// into page space (the `insertPath` convention). It lands at the top of
// the page's z-order and outside any group the target was in: the insert
// lane's residual, the one Release Compound Path also names.
//
// ONE UNDO STEP: every target's rewrite, every inserted piece and its
// paint ride one batch (`knifeBatchFor`), measured in
// `test/conformance/knife.spec.ts`.

import type {
  BundleHost,
  ElementId,
  MutationInput,
  PlanarFace,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import {
  applyAffine,
  boundsOverlap,
  contourRanges,
  inverseApplyAffine,
  orientForNonZeroHoles,
  sliverAround,
  snapOntoPolyline,
  tableBounds,
  transformBounds,
  type Affine,
  type AnchorTable,
  type AnchorTriple,
  type Vec2,
} from "@paged-media/draw-geometry";

import {
  compoundPaintOf,
  framePathMutationFor,
  type CompoundPaint,
} from "./compound-path";
import { bindMinted, mutateMinting } from "./minted";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
} from "./v59-wire";

/** The strip's width in pt — the narrowest the arrangement's 1/64 pt
 *  grid reliably resolves as a region (module header). */
export const KNIFE_STRIP_WIDTH_PT = 1 / 16;

/** How far from the cut an anchor may lie and still be snapped onto it:
 *  half a strip, plus one grid cell for the arrangement's rounding. */
export const KNIFE_SNAP_TOLERANCE_PT = KNIFE_STRIP_WIDTH_PT / 2 + 1 / 64;

/** A face smaller than this (pt²) is not a piece: it is what a cut that
 *  doubles back on itself leaves where its strip overlaps itself. */
export const KNIFE_MIN_PIECE_AREA_PT2 = 4 * KNIFE_STRIP_WIDTH_PT * KNIFE_STRIP_WIDTH_PT;

/** The batch-local handle of target `i`'s strip in the PROBE batch. */
export const knifeStripHandle = (i: number): string => `knife_s${i}`;

/** The batch-local handle of target `i`'s inserted piece `k` (k ≥ 1). */
export const knifePieceHandle = (i: number, k: number): string => `knife_p${i}_${k}`;

/** One target, resolved: its table in its OWN (inner) space, its
 *  transform, and the cut mapped into that same space. */
export interface KnifeTarget {
  id: ElementId;
  pageId: string;
  inner: AnchorTable;
  transform: Affine | null;
  cutInner: Vec2[];
}

/** One target the cut divides: piece 0 is rewritten onto the target,
 *  the rest are inserted. Tables in the target's inner space. */
export interface KnifePlan {
  target: KnifeTarget;
  pieces: AnchorTable[];
  paint: CompoundPaint;
}

/** Why a candidate was not cut — logged, and returned for the spec. */
export interface KnifeSkip {
  id: ElementId;
  reason: string;
}

export interface KnifeResult {
  /** Targets the cut divided. */
  cut: ElementId[];
  /** Every resulting piece, the rewritten targets included. */
  pieces: ElementId[];
  skipped: KnifeSkip[];
  /** Undo steps the cut left: 1, or 2 when the probe could not be
   *  withdrawn (see the module header); 0 when nothing was cut. */
  undoSteps: number;
}

// ------------------------------------------------------------ the pure half

const isIdentity = (m: Affine | null): boolean =>
  !m ||
  (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

const triple = (a: { anchor: readonly number[]; left: readonly number[]; right: readonly number[] }): AnchorTriple => ({
  anchor: [a.anchor[0]!, a.anchor[1]!],
  left: [a.left[0]!, a.left[1]!],
  right: [a.right[0]!, a.right[1]!],
});

/** A planar face as a closed `AnchorTable`. */
export function faceTable(face: Pick<PlanarFace, "anchors" | "subpathStarts">): AnchorTable {
  const starts = face.subpathStarts.length > 0 ? [...face.subpathStarts] : [0];
  return {
    anchors: face.anchors.map(triple),
    subpathStarts: starts,
    subpathOpen: starts.map(() => false),
  };
}

/**
 * The pieces a target is cut into, from the arrangement of
 * `[target, strip]`: the faces covered by the target ALONE (signature
 * exactly `[0]`), big enough to be a piece, snapped back onto the cut,
 * and wound so a hole stays a hole under the engine's non-zero fill. The
 * largest piece comes first — it is the one the target keeps. Pure.
 */
export function knifePiecesFrom(
  faces: readonly Pick<PlanarFace, "signature" | "area" | "anchors" | "subpathStarts">[],
  cutInner: readonly Vec2[],
): AnchorTable[] {
  return faces
    .filter(
      (f) =>
        f.signature.length === 1 &&
        f.signature[0] === 0 &&
        f.area > KNIFE_MIN_PIECE_AREA_PT2 &&
        f.anchors.length >= 3,
    )
    .sort((a, b) => b.area - a.area)
    .map((f) => {
      const snapped = snapOntoPolyline(faceTable(f), cutInner, KNIFE_SNAP_TOLERANCE_PT);
      return contourRanges(snapped.anchors.length, snapped.subpathStarts).length > 1
        ? orientForNonZeroHoles(snapped)
        : snapped;
    });
}

/** The PROBE batch: one strip per target, inserted in the target's own
 *  inner coordinates and pinned there with `framePath` (the arrangement
 *  compares RAW anchors, so the strip has to share the target's raw
 *  frame, whatever `insertPath` does with a page origin). */
export function knifeStripBatchFor(
  targets: readonly Pick<KnifeTarget, "pageId" | "cutInner">[],
): MutationInput | null {
  const ops: MutationInput[] = [];
  for (let i = 0; i < targets.length; i++) {
    const strip = sliverAround(targets[i]!.cutInner, KNIFE_STRIP_WIDTH_PT);
    if (!strip) return null;
    const table: AnchorTable = { anchors: strip, subpathStarts: [0], subpathOpen: [false] };
    ops.push(
      {
        op: "insertPath",
        args: {
          pageId: targets[i]!.pageId,
          anchors: strip.map(triple),
          open: false,
        },
      },
      bindCreatedMutationFor(knifeStripHandle(i)),
      framePathMutationFor(handleElementId(knifeStripHandle(i)), table),
    );
  }
  return ops.length > 0 ? batchMutationFor(ops) : null;
}

/** `table` (inner space of a target with transform `m`) in PAGE space. */
function toPage(table: AnchorTable, m: Affine | null): AnchorTable {
  if (isIdentity(m)) return table;
  const map = (p: readonly [number, number] | Vec2): [number, number] => {
    const q = applyAffine(m, p[0], p[1]);
    return [q[0], q[1]];
  };
  return {
    anchors: table.anchors.map((a) => ({
      anchor: map(a.anchor),
      left: map(a.left),
      right: map(a.right),
    })),
    subpathStarts: [...table.subpathStarts],
    ...(table.subpathOpen ? { subpathOpen: [...table.subpathOpen] } : {}),
  };
}

/** The paint ops a piece inherits (fill, stroke colour, stroke weight). */
function paintOpsFor(id: ElementId, paint: CompoundPaint): MutationInput[] {
  const ops: MutationInput[] = [
    {
      op: "setElementProperty",
      args: { elementId: id, path: "frameFillColor", value: { type: "colorRef", value: paint.fill } },
    },
    {
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameStrokeColor",
        value: { type: "colorRef", value: paint.stroke },
      },
    },
  ];
  if (typeof paint.weight === "number") {
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: id,
        path: "frameStrokeWeight",
        value: { type: "length", value: paint.weight },
      },
    });
  }
  return ops;
}

/**
 * THE CUT — ONE batch for every divided target: per target, every extra
 * piece inserted (page space), named, re-tabled when it has holes and
 * painted like the target; then the target rewritten to piece 0 with its
 * frame box following. `deletes` are appended LAST (the engine refuses a
 * batch that deletes and then inserts) — only the guarded fallback of
 * the probe passes any.
 */
export function knifeBatchFor(
  plans: readonly KnifePlan[],
  deletes: readonly ElementId[] = [],
): MutationInput {
  const ops: MutationInput[] = [];
  plans.forEach((plan, i) => {
    const m = plan.target.transform;
    plan.pieces.slice(1).forEach((piece, j) => {
      const k = j + 1;
      const handle = knifePieceHandle(i, k);
      const page = toPage(piece, m);
      const ranges = contourRanges(page.anchors.length, page.subpathStarts);
      const [from, to] = ranges[0] ?? [0, page.anchors.length];
      ops.push(
        {
          op: "insertPath",
          args: {
            pageId: plan.target.pageId,
            anchors: page.anchors.slice(from, to).map(triple),
            open: false,
          },
        },
        bindCreatedMutationFor(handle),
      );
      if (ranges.length > 1) {
        ops.push(framePathMutationFor(handleElementId(handle), page));
      }
      ops.push(...paintOpsFor(handleElementId(handle), plan.paint));
    });
    const keep = plan.pieces[0]!;
    ops.push(framePathMutationFor(plan.target.id, keep));
    const box = tableBounds(keep);
    if (box) {
      ops.push({
        op: "setElementProperty",
        args: { elementId: plan.target.id, path: "frameBounds", value: { type: "bounds", value: box } },
      });
    }
  });
  for (const id of deletes) {
    ops.push({ op: "deleteFrame", args: { frameId: String(id.id) } });
  }
  return batchMutationFor(ops);
}

// ------------------------------------------------------------ the reads

/** The kinds a knife can cut. A text frame is REFUSED, not skipped
 *  silently: it is a path kind, and its story is what cannot be split. */
const CUTTABLE = new Set(["polygon", "rectangle", "graphicLine"]);

/** The cut's `[top, left, bottom, right]` box. */
function boxOf(points: readonly Vec2[]): [number, number, number, number] {
  let t = Infinity;
  let l = Infinity;
  let b = -Infinity;
  let r = -Infinity;
  for (const [x, y] of points) {
    if (y < t) t = y;
    if (y > b) b = y;
    if (x < l) l = x;
    if (x > r) r = x;
  }
  return [t, l, b, r];
}

function leavesOf(roots: readonly SceneTreeNode[]): ElementId[] {
  const out: ElementId[] = [];
  const walk = (nodes: readonly SceneTreeNode[]) => {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) walk(node.children);
      else if (node.id) out.push(node.id as ElementId);
    }
  };
  walk(roots);
  return out;
}

/** Who the cut may act on: the selection; with NOTHING selected, every
 *  leaf on `pageId` whose page box the cut's box touches (Illustrator's
 *  "cuts any object it crosses"). */
export async function knifeCandidates(
  host: BundleHost,
  pageId: string,
  cutPage: readonly Vec2[],
): Promise<ElementId[]> {
  const selection = host.selection.get();
  if (selection.length > 0) return selection;
  const leaves = leavesOf(await host.document.tree().catch(() => []));
  if (leaves.length === 0) return [];
  const cutBox = boxOf(cutPage);
  const geoms = await host.document.elementGeometry(leaves).catch(() => []);
  return geoms
    .filter((g) => {
      if (g.pageId !== pageId) return false;
      const m = (g.itemTransform ?? null) as Affine | null;
      const box = m ? transformBounds(g.bounds, m) : g.bounds;
      return boundsOverlap(box, cutBox);
    })
    .map((g) => g.id);
}

/** Resolve one candidate, or say why it cannot be cut (null reason =
 *  skipped silently: not a path kind, another page, nowhere near). */
export async function knifeTargetOf(
  host: BundleHost,
  id: ElementId,
  pageId: string,
  cutPage: readonly Vec2[],
): Promise<KnifeTarget | { skip: string | null }> {
  if (id.kind === "textFrame") {
    return { skip: "a text frame's story cannot be split — not cut" };
  }
  if (!CUTTABLE.has(id.kind)) return { skip: null };
  const read = await host.document.pathAnchors(id).catch(() => null);
  let inner: AnchorTable;
  let transform: Affine | null;
  let page: string | null | undefined;
  if (read && read.anchors.length >= 2) {
    if ((read.subpathOpen ?? []).some((open) => open)) {
      return { skip: "an open path is cut with Scissors, not the Knife — not cut" };
    }
    inner = {
      anchors: read.anchors.map(triple),
      subpathStarts: read.subpathStarts.length > 0 ? [...read.subpathStarts] : [0],
      subpathOpen: [],
    };
    transform = (read.itemTransform ?? null) as Affine | null;
    page = read.pageId;
  } else {
    // A bounds-only rectangle — the arrangement uses its four corners,
    // and so do we.
    const [g] = await host.document.elementGeometry([id]).catch(() => []);
    if (!g) return { skip: null };
    const [top, left, bottom, right] = g.bounds;
    inner = {
      anchors: [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ].map(([x, y]) => triple({ anchor: [x!, y!], left: [x!, y!], right: [x!, y!] })),
      subpathStarts: [0],
      subpathOpen: [false],
    };
    transform = (g.itemTransform ?? null) as Affine | null;
    page = g.pageId;
  }
  if (page !== pageId) return { skip: null };
  const cutInner: Vec2[] = [];
  for (const p of cutPage) {
    const q = inverseApplyAffine(transform, p[0], p[1]);
    if (!q) return { skip: "the path's transform cannot be inverted — not cut" };
    cutInner.push([q[0], q[1]]);
  }
  const own = tableBounds(inner);
  if (!own || !boundsOverlap(own, boxOf(cutInner))) return { skip: null };
  return { id, pageId, inner, transform, cutInner };
}

// ------------------------------------------------------------- the verb

const sameId = (a: ElementId, b: ElementId): boolean =>
  a.kind === b.kind && String(a.id) === String(b.id);

/**
 * Cut along `cutPage` (an open polyline, page-local pt on `pageId`).
 * Mutations: the PROBE batch (strips), one `undo` withdrawing it, then
 * ONE cut batch — so the history gains exactly one step. Nothing is
 * written when no target is divided.
 */
export async function applyKnife(
  host: BundleHost,
  pageId: string,
  cutPage: readonly Vec2[],
): Promise<KnifeResult> {
  const result: KnifeResult = { cut: [], pieces: [], skipped: [], undoSteps: 0 };
  if (cutPage.length < 2) return result;
  const targets: KnifeTarget[] = [];
  for (const id of await knifeCandidates(host, pageId, cutPage)) {
    const t = await knifeTargetOf(host, id, pageId, cutPage);
    if ("skip" in t) {
      if (t.skip) {
        result.skipped.push({ id, reason: t.skip });
        host.log.info(`knife: ${id.kind} ${String(id.id)}: ${t.skip}`);
      }
      continue;
    }
    targets.push(t);
  }
  if (targets.length === 0) return result;

  // 1. THE PROBE — the strips, so the arrangement can be asked.
  const probe = knifeStripBatchFor(targets);
  if (!probe) return result;
  const probed = await mutateMinting(host, probe);
  if (!probed.outcome.applied) {
    host.log.warn(`knife: the cut strips were refused: ${JSON.stringify(probed.outcome.error)}`);
    return result;
  }
  const strips = bindMinted(probed, probe);
  const stripIds = targets.map((_, i) => strips?.byHandle.get(knifeStripHandle(i)) ?? null);

  // 2. THE ARRANGEMENT — one query per target, against its own strip.
  const plans: KnifePlan[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const strip = stripIds[i];
    if (!strip) continue;
    const regions = await host.document.planarRegions([t.id, strip]).catch(() => null);
    if (!regions || !regions.found) {
      const reason = regions?.reason ?? "the planar arrangement did not answer";
      result.skipped.push({ id: t.id, reason });
      host.log.warn(`knife: ${t.id.kind} ${String(t.id.id)}: ${reason}`);
      continue;
    }
    const pieces = knifePiecesFrom(regions.faces, t.cutInner);
    if (pieces.length < 2) continue; // a nick, not a cut — left alone
    plans.push({ target: t, pieces, paint: await compoundPaintOf(host, t.id) });
  }

  // 3. WITHDRAW THE PROBE — guarded (module header).
  const live = stripIds.filter((s): s is ElementId => s !== null);
  await host.document.undo();
  const lingering: ElementId[] = [];
  for (const s of live) {
    if (await host.document.pathAnchors(s).catch(() => null)) lingering.push(s);
  }
  let deletes: ElementId[] = [];
  if (lingering.length > 0) {
    await host.document.redo();
    deletes = live;
    host.log.warn(
      "knife: another change landed while the cut was being measured — it was " +
        "kept, and the cut strips are removed in the cut itself (this cut is TWO undo steps)",
    );
  }
  if (plans.length === 0) {
    if (deletes.length > 0) {
      await host.document.mutate(batchMutationFor(deletes.map((d) => ({ op: "deleteFrame", args: { frameId: String(d.id) } }))));
    }
    return result;
  }

  // 4. THE CUT — one batch.
  const batch = knifeBatchFor(plans, deletes);
  const written = await mutateMinting(host, batch);
  if (!written.outcome.applied) {
    host.log.warn(`knife: the cut was refused: ${JSON.stringify(written.outcome.error)}`);
    return result;
  }
  const named = bindMinted(written, batch);
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]!;
    result.cut.push(plan.target.id);
    result.pieces.push(plan.target.id);
    for (let k = 1; k < plan.pieces.length; k++) {
      const id = named?.byHandle.get(knifePieceHandle(i, k));
      if (id && !deletes.some((d) => sameId(d, id))) result.pieces.push(id);
    }
  }
  result.undoSteps = deletes.length > 0 ? 2 : 1;
  await host.selection.set(result.pieces);
  return result;
}
