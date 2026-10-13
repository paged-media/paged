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

// Shape Builder — REGION level, live since engine protocol v57 (the
// consumer side of B-22). The Illustrator interaction, as built:
//
//   hover    the pointer moves over the SELECTED overlapping set; the
//            face under the cursor is resolved and HIGHLIGHTED through
//            the overlay tool-preview (a `ToolPreviewPath` of the face
//            outline, closed);
//   collect  a drag appends every distinct face it crosses, in
//            first-cross order (the pure machine owns that set);
//   commit   pointer-up builds the result from the arrangement —
//            `planShapeBuild` (draw-tools): a plain drag MERGES the
//            faces it crossed into one path, an Alt-drag deletes them,
//            and every other face of a shape the gesture touched STAYS,
//            in the paint of the shape on top of it there — and sends it
//            as ONE batch (`commands/shape-build.ts`). One undo step.
//            The engine's `pathfinderFaces { keep | remove }` alone
//            drops every face it was not given (keep) or unites all the
//            rest into one shape (remove): on a cross-shaped overlap a
//            drag over two arms left only those two arms. It is still
//            what is sent when it IS the result — a gesture that crossed
//            every face of every shape it touched.
//
// OVALS: the engine reads an oval as its bounding box (no path geometry
// for one at `pathAnchors`, the box in the arrangement), so a set with an
// oval in it is never asked while the pointer hovers; at release its
// faces are read through stand-ins of the real curve and the gesture is
// replayed over them (`handlers/oval-stand-ins.ts`). No face highlight
// over such a set until the engine answers for the curve.
//
// CACHING, THE DOOR AND THE COORDINATE SPACE all live in
// `handlers/planar-regions.ts` now — the shared arrangement seam, which
// Live Paint became the second consumer of. Read that module's header
// for the `host.document.planarRegions` facade it calls, the
// once-per-gesture-scope cache with its cold-start / face-cap point
// queries, and the raw↔page mapping through the frontmost input's
// itemTransform.
//
// WHAT A POINTER MOVE COSTS is pinned in `test/perf/perf-budgets.spec.ts`
// and may only go down: a hover makes NO engine round trip per move (it
// used to make one hit-test per move, and under a burst one arrangement
// query per move as well); a drag hit-tests only until it has collected
// its first face.
//
// HONEST SURFACES:
//   · The overlay channel is SINGLE-SLOT, so the preview shows the
//     hovered FACE while there is one and the gesture polyline
//     otherwise. Shading every collected face at once needs a
//     multi-shape preview (or a retained scene layer) the v0 overlay
//     does not have.
//   · A refusal (`found: false`) is never shown as "no regions": the
//     engine's `reason` goes to WARN and onto the pathfinder status
//     binding.
//   · `complete: false` means the face list is real but not exhaustive
//     (the kernel missed a sliver). Logged per read; the faces that ARE
//     listed stay usable.
//
// FALLBACK (documented, still reachable): an engine without the region
// ops. Detected by the op-vocabulary probe `commands/join-average.ts`
// owns — a rejected sentinel mutation whose error lists the engine's
// whole op vocabulary — never by version sniffing. There the tool
// behaves exactly as the honest B-22 subset shipped: the drag
// hit-tests at ELEMENT level and commits one `pathfinderBoolean` over
// the swept elements (unite / subtract). The element sweep runs in BOTH
// lanes so the fallback stays armed even when the probe was optimistic
// and the commit turns out to hit an unknown op.

import type {
  BundleHost,
  CanvasPointerEvent,
  Disposable,
  ElementId,
  GestureHandler,
  Mutation,
  MutationInput,
  PathfinderKind,
} from "@paged-media/plugin-api";
import type { Affine } from "@paged-media/draw-geometry";

import {
  ShapeBuilderMachine,
  planShapeBuild,
  type FaceMode,
  type RegionFace,
  type ShapeBuilderMode,
  type ShapeBuilderSnapshot,
} from "@paged-media/draw-tools";

import { engineOpVocabulary } from "../commands/join-average";
import {
  BIND_PATHFINDER_STATUS,
  pathfinderFacesMutationFor,
  regionRefusalReason,
  selectionTopToBottom,
} from "../commands/pathfinder-region";
import {
  planIsEngineKeep,
  shapeBuildBatchFor,
  shapeBuildPaints,
} from "../commands/shape-build";
import { pageOriginOf, SPREAD_ORIGIN, type PageOrigin } from "../page-origin";
import { hasOval, ovalStandIns } from "./oval-stand-ins";
import {
  createRegionCache,
  faceToPageSpace,
  planarInputKey,
  readPlanarRegions,
  reportPlanarRefusal,
  type PlanarFaceWire,
  type RegionCache,
} from "./planar-regions";

// The arrangement types + the raw↔page mapping moved to the shared seam
// when Live Paint became the second consumer; re-exported here so the
// bundle's public surface (and the conformance spec that imports from
// it) is unchanged.
export {
  faceToPageSpace,
  type PlanarFaceWire,
  type PlanarRegionsWire,
} from "./planar-regions";

/** The path-bearing kinds the Shape Builder operates on (the engine's
 *  pathfinder operands — the same closed-path family the Pathfinder
 *  commands accept). */
const BOOLEAN_KINDS = new Set(["polygon", "rectangle", "oval"]);

/** Map the gesture mode to the wire `PathfinderKind` (element lane).
 *  Unite = union; subtract = the engine's `subtract` (kept minus rest). */
export function pathfinderKindFor(mode: ShapeBuilderMode): PathfinderKind {
  return mode === "subtract" ? "subtract" : "union";
}

/** The ONE `pathfinderBoolean` a finished ELEMENT-lane gesture commits
 *  (the fallback): the FIRST swept element is kept, the rest are
 *  `others`. Exported so the conformance spec asserts the EXACT wire
 *  shape. Null when fewer than two distinct operands were swept. */
export function shapeBuilderMutationFor(
  swept: ElementId[],
  mode: ShapeBuilderMode,
): Mutation | null {
  if (swept.length < 2) return null;
  const [kept, ...others] = swept;
  return {
    op: "pathfinderBoolean",
    args: { kept, others, kind: pathfinderKindFor(mode) },
  };
}

/** The ONE `pathfinderFaces` a finished REGION-lane gesture commits.
 *  Null when the gesture crossed no face, or fewer than two inputs were
 *  selected (the honest no-ops). Exported for the conformance spec — no
 *  second copy to drift from. */
export function shapeBuilderFacesMutationFor(
  inputs: ElementId[],
  faces: readonly string[],
  mode: FaceMode,
): Mutation | null {
  if (inputs.length < 2 || faces.length === 0) return null;
  return pathfinderFacesMutationFor(inputs, [...faces], mode);
}

/** The faces a recorded gesture crosses over an arrangement (page space):
 *  the gesture REPLAYED through the same pure machine that collected it live
 *  — for the case where the faces were not known while it ran (an oval in
 *  the set, resolved at release). Same rule, same order. */
export function facesCrossedBy(
  faces: readonly RegionFace[],
  path: readonly (readonly [number, number])[],
  alt: boolean,
): string[] {
  if (path.length === 0) return [];
  const m = new ShapeBuilderMachine();
  m.setRegions(faces);
  m.handle({ type: "down", point: [path[0][0], path[0][1]], modifiers: { alt } });
  for (const p of path.slice(1, -1)) m.handle({ type: "move", point: [p[0], p[1]] });
  const last = path[path.length - 1];
  return [...m.handle({ type: "up", point: [last[0], last[1]] }).collected];
}

/** Build the Shape Builder gesture handler bound to `host` (the B-17
 *  factory shape — every engine touch is a `host.*` facade). */
export function createShapeBuilderHandler(host: BundleHost): GestureHandler {
  let machine: ShapeBuilderMachine | null = null;
  let pageId: string | null = null;
  // The element id resolved per crossed key — so pointer-up can rebuild
  // the typed ElementId operands the ELEMENT lane tracks by string key.
  const byKey = new Map<string, ElementId>();

  /** The ordered input set this gesture operates on (top-to-bottom). */
  let inputs: ElementId[] = [];
  /** Resolved once per handler: does this engine carry the region ops? */
  let regionLane: boolean | null = null;
  /** The engine's vocabulary was READ and it lists `pathfinderFaces` —
   *  as opposed to `regionLane` being true only because the vocabulary
   *  was unreadable and the probe answered optimistically. */
  let regionLaneProven = false;
  /** Live subscriptions — allocated on activate, released on the
   *  non-suspend deactivate (GestureHandler has no dispose hook). */
  let subs: Disposable[] = [];

  // The shared arrangement seam (handlers/planar-regions.ts) — one
  // enumeration per gesture scope, cold-start + face-cap point queries,
  // refusals surfaced with the engine's own words.
  const cache: RegionCache = createRegionCache(host, {
    label: "shapeBuilder",
    onFaces: (faces) => {
      if (machine) render(machine.setRegions(faces));
    },
    onPointFace: (id) => {
      if (machine) render(machine.handle({ type: "region", id }));
    },
    // The engine reads an oval as its bounding box: such a set is resolved
    // at release, through stand-ins of the real curve (oval-stand-ins.ts).
    unanswerable: hasOval,
  });

  const dropCache = () => {
    cache.drop();
    machine?.setRegions(null);
  };

  const render = (snapshot: ShapeBuilderSnapshot) => {
    if (!pageId) {
      host.overlay.setToolPreview(null);
      return;
    }
    // Single-slot channel: the hovered FACE outline wins (it is the cue
    // that makes the tool legible); the gesture polyline stands in when
    // the pointer is over no face.
    const face = snapshot.hovered
      ? cache.faces().find((f) => f.id === snapshot.hovered)
      : undefined;
    if (face && face.anchors.length >= 2) {
      host.overlay.setToolPreview({
        pageId,
        anchors: face.anchors.map((a) => ({
          anchor: [a.anchor[0], a.anchor[1]] as [number, number],
          left: [a.left[0], a.left[1]] as [number, number],
          right: [a.right[0], a.right[1]] as [number, number],
        })),
        close: true,
      });
      return;
    }
    if (!snapshot.path || snapshot.path.length < 2) {
      host.overlay.setToolPreview(null);
      return;
    }
    host.overlay.setToolPreview({
      pageId,
      points: snapshot.path.map((p) => [p[0], p[1]] as [number, number]),
    });
  };

  /** One pointer sample in the REGION lane: purely local while the
   *  cache is warm (the machine already resolved it), an engine point
   *  query only while it is not. The seam owns both. */
  const sampleRegion = (
    point: [number, number],
    snapshot: ShapeBuilderSnapshot,
  ): void => {
    if (inputs.length < 2 || !machine) return;
    // A drag collects the face under EVERY sample; a hover only needs
    // the one under the pointer now (see `SampleNeed`).
    cache.sample(inputs, point, snapshot.building ? "every" : "latest");
  };

  /** Can the ELEMENT lane still be the one that commits this gesture?
   *  It is the fallback `onPointerUp` reaches when the region lane has
   *  nothing to send, and its operands are the elements `sweep` crossed.
   *
   *  It cannot be reached once ALL of these hold, and then a hit-test is
   *  a round trip whose answer nothing reads: the engine PROVABLY has
   *  the region op (so the commit cannot bounce as an unknown variant),
   *  two or more inputs are selected, and the drag has already collected
   *  a face (so `pathfinderFaces` has something to send). */
  const elementLaneReachable = (snapshot: ShapeBuilderSnapshot): boolean =>
    !(regionLaneProven && inputs.length >= 2 && snapshot.collected.length > 0);

  /** Hit-test the engine at `point` and, when it resolves a boolean-
   *  capable element, feed the machine a `cross` event (de-duped there).
   *  Arms the ELEMENT-lane fallback; best-effort + async, a miss is
   *  silent. Runs in both lanes: the region probe is optimistic when the
   *  vocabulary is unreadable, and this is what makes the fall-through
   *  in `onPointerUp` real rather than theoretical.
   *
   *  Only DURING A DRAG, and only while the element lane can still
   *  commit (`elementLaneReachable`). The machine drops a `cross` that
   *  arrives outside a drag, so a hover used to pay one engine round
   *  trip per pointer move for an answer that was thrown away. */
  const sweep = (point: [number, number], snapshot: ShapeBuilderSnapshot) => {
    if (!machine || !pageId) return;
    if (!snapshot.building || !elementLaneReachable(snapshot)) return;
    void (async () => {
      try {
        const hit = await host.document.hitTest(pageId!, point, "frame");
        const el = hit?.element ?? null;
        if (!el || !BOOLEAN_KINDS.has(el.kind) || !machine) return;
        byKey.set(el.id as string, el);
        render(machine.handle({ type: "cross", key: el.id as string }));
      } catch {
        /* hit-test is best-effort — a miss just adds no operand */
      }
    })();
  };

  /** Does this engine carry `pathfinderFaces`? The op-vocabulary probe,
   *  not a version guess. An unreadable vocabulary answers TRUE — the
   *  commit below detects an unknown op honestly and falls back then. */
  const supportsRegions = async (): Promise<boolean> => {
    if (regionLane !== null) return regionLane;
    const vocab = await engineOpVocabulary(host);
    regionLane = vocab ? vocab.has("pathfinderFaces") : true;
    regionLaneProven = vocab !== null && regionLane;
    if (!regionLane) {
      host.log.debug(
        "shapeBuilder: this engine predates pathfinderFaces — running the " +
          "documented ELEMENT-level fallback (whole shapes unite/subtract)",
      );
    }
    return regionLane;
  };

  /** The arrangement a release builds from, and the faces the gesture
   *  crossed in it: the cache's when it is warm for `operands`; read now
   *  when it is not (the crossed ids came from point queries, which name
   *  the same faces); and — for a set holding an OVAL — read through
   *  stand-ins of the real curve, the crossed faces resolved by replaying
   *  the gesture over them. Null after a refusal (reported). */
  const releaseArrangement = async (
    operands: ElementId[],
    snap: ShapeBuilderSnapshot,
    alt: boolean,
  ): Promise<{
    faces: PlanarFaceWire[];
    matrix: Affine | null;
    pageOrigin: PageOrigin;
    crossed: string[];
  } | null> => {
    // The frontmost input's PAGE-space transform (raw → page, what the
    // gesture was drawn in) and its page's origin from the same read (the
    // pieces are written with the STORED transform — `../page-origin.ts`).
    const transformOf = (id: ElementId) =>
      host.document.pathAnchors(id).then(
        (t) => ({ matrix: (t?.itemTransform ?? null) as Affine | null, pageOrigin: pageOriginOf(t) }),
        () => ({ matrix: null, pageOrigin: SPREAD_ORIGIN }),
      );
    if (hasOval(operands)) {
      const probe = await ovalStandIns(host, operands, "shapeBuilder");
      if (!probe) return null;
      let front: Awaited<ReturnType<typeof transformOf>> = { matrix: null, pageOrigin: SPREAD_ORIGIN };
      let regions: Awaited<ReturnType<typeof readPlanarRegions>> = null;
      try {
        front = await transformOf(probe.ids[0]!);
        regions = await readPlanarRegions(host, probe.ids);
      } finally {
        await probe.release();
      }
      if (!regions || !regions.found) {
        reportPlanarRefusal(host, "shapeBuilder", regions);
        return null;
      }
      const page = regions.faces.map((f) => faceToPageSpace(f, front.matrix));
      return {
        faces: [...regions.faces],
        ...front,
        crossed: facesCrossedBy(page, snap.path ?? [], alt),
      };
    }
    if (cache.warm(operands)) {
      return {
        faces: [...cache.rawFaces()],
        matrix: cache.matrix(),
        pageOrigin: cache.pageOrigin(),
        crossed: [...snap.collected],
      };
    }
    const front = await transformOf(operands[0]!);
    const regions = await readPlanarRegions(host, operands);
    if (!regions || !regions.found) {
      reportPlanarRefusal(host, "shapeBuilder", regions);
      return null;
    }
    return { faces: [...regions.faces], ...front, crossed: [...snap.collected] };
  };

  /** The REGION-lane release: plan the result from the arrangement
   *  (`planShapeBuild` — the crossed faces merged or deleted, every other
   *  face of a touched shape kept) and send it as ONE batch
   *  (`commands/shape-build.ts`). A gesture that crossed everything of what
   *  it touched is the engine's own `pathfinderFaces { keep }`, sent as it
   *  always was. */
  const commitRegions = async (
    operands: ElementId[],
    snap: ShapeBuilderSnapshot,
    page: string,
  ): Promise<"done" | "nothing" | "refused" | "unknownOp"> => {
    const alt = snap.faceMode === "remove";
    const arrangement = await releaseArrangement(operands, snap, alt);
    if (!arrangement) return "refused";
    const plan = planShapeBuild(
      operands.length,
      arrangement.faces,
      arrangement.crossed,
      snap.faceMode,
      (i) => operands[i]?.kind !== "oval",
    );
    if (!plan) return "nothing";
    let mutation: MutationInput | null;
    if (planIsEngineKeep(plan) && !hasOval(operands)) {
      mutation = shapeBuilderFacesMutationFor(operands, arrangement.crossed, "keep");
    } else {
      mutation = shapeBuildBatchFor(plan, {
        inputs: operands,
        faces: new Map(arrangement.faces.map((f) => [f.id, f])),
        matrix: arrangement.matrix,
        pageOrigin: arrangement.pageOrigin,
        pageId: page,
        paints: await shapeBuildPaints(host, plan, operands),
      });
    }
    if (!mutation) {
      host.log.warn("shapeBuilder: the arrangement no longer holds a face the gesture crossed");
      return "refused";
    }
    const outcome = await host.document.mutate(mutation);
    if (outcome.applied) return "done";
    const text = (() => {
      try {
        return JSON.stringify(outcome.error) ?? "";
      } catch {
        return "";
      }
    })();
    if (text.includes("unknown variant")) return "unknownOp";
    const reason =
      regionRefusalReason(outcome.error) ?? "the engine refused the shape-builder commit";
    host.log.warn(`shapeBuilder refused: ${reason}`);
    host.bindings.publish(BIND_PATHFINDER_STATUS, reason);
    return "refused";
  };

  /** Refresh the ordered input set from the live selection. Costs one
   *  scene-tree read, so it runs on ACTIVATE and on selection change —
   *  never per pointermove. */
  const refreshInputs = async (): Promise<void> => {
    const ordered = await selectionTopToBottom(host);
    const next = ordered.filter((id) => BOOLEAN_KINDS.has(id.kind));
    if (planarInputKey(next) === planarInputKey(inputs)) return;
    inputs = next;
    dropCache();
  };

  return {
    onActivate() {
      machine = new ShapeBuilderMachine();
      byKey.clear();
      inputs = [];
      dropCache();
      subs = [
        host.selection.onDidChange(() => void refreshInputs()),
        host.document.onDidChange(() => dropCache()),
      ];
      void supportsRegions();
      void refreshInputs();
    },
    onDeactivate(reason) {
      if (reason === "suspend") return;
      for (const s of subs) s.dispose();
      subs = [];
      machine = null;
      pageId = null;
      byKey.clear();
      inputs = [];
      dropCache();
      host.overlay.setToolPreview(null);
    },
    onPointerDown(e: CanvasPointerEvent) {
      if (!machine || e.button !== 0 || !e.pageId || !e.pagePoint) return;
      pageId = e.pageId;
      byKey.clear();
      const snapshot = machine.handle({
        type: "down",
        point: e.pagePoint,
        modifiers: { alt: e.modifiers.alt },
      });
      render(snapshot);
      sampleRegion(e.pagePoint, snapshot);
      sweep(e.pagePoint, snapshot);
    },
    onPointerMove(e: CanvasPointerEvent) {
      // A hover BEFORE any drag still highlights — that is half the
      // interaction, so a move outside a gesture is not discarded.
      if (!machine || !e.pagePoint || !e.pageId) return;
      pageId = e.pageId;
      const snapshot = machine.handle({ type: "move", point: e.pagePoint });
      render(snapshot);
      sampleRegion(e.pagePoint, snapshot);
      sweep(e.pagePoint, snapshot);
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      const snap = machine.handle({ type: "up", point: e.pagePoint });
      host.overlay.setToolPreview(null);
      const operands = [...inputs];
      const page = pageId;
      void (async () => {
        // REGION lane first — the real interaction.
        if (await supportsRegions()) {
          // An oval set collected nothing live (its faces are resolved at
          // release), so it goes to the region commit on its gesture alone.
          if (operands.length >= 2 && page && (snap.collected.length > 0 || hasOval(operands))) {
            const result = await commitRegions(operands, snap, page);
            if (result === "done") {
              host.bindings.publish(BIND_PATHFINDER_STATUS, null);
              dropCache();
              await host.selection.set([]);
              return;
            }
            if (result === "refused") return;
            if (result === "unknownOp") {
              // An unknown op means the probe was optimistic — fall
              // through to the element lane, once and for this handler.
              regionLane = false;
            } else {
              host.log.debug(
                "shapeBuilder: the gesture crossed no face — trying the element lane",
              );
            }
          } else if (operands.length >= 2 && snap.collected.length === 0) {
            host.log.debug(
              "shapeBuilder: the gesture crossed no face — trying the element lane",
            );
          }
        }
        // ELEMENT lane (the documented fallback).
        const swept = snap.crossed
          .map((key) => byKey.get(key))
          .filter((el): el is ElementId => el != null);
        const mutation = shapeBuilderMutationFor(swept, snap.mode);
        if (!mutation) {
          host.log.debug(
            `shapeBuilder: ${swept.length} element(s) swept — needs ≥ 2; no-op`,
          );
          return;
        }
        const outcome = await host.document.mutate(mutation);
        if (!outcome.applied) {
          host.log.warn(
            `shapeBuilder rejected by engine: ${JSON.stringify(outcome.error)}`,
          );
          return;
        }
        await host.selection.set([swept[0]]);
      })();
    },
    onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && machine) {
        render(machine.handle({ type: "key", key: "Escape" }));
      }
    },
  };
}
