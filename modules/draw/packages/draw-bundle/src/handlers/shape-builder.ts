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
//   commit   pointer-up sends ONE `pathfinderFaces { elementIds, faces,
//            mode }` — `keep` for a plain drag, `remove` for an
//            Alt-drag (Illustrator's erase). One undo step.
//
// CACHING, THE DOOR AND THE COORDINATE SPACE all live in
// `handlers/planar-regions.ts` now — the shared arrangement seam, which
// Live Paint became the second consumer of. Read that module's header
// for the escape hatch (`requestPlanarRegions` wire-level, because the
// vendored contract has no `document.planarRegions` facade yet), the
// once-per-gesture-scope cache with its cold-start / face-cap point
// queries, and the raw↔page mapping through the frontmost input's
// itemTransform.
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
  PathfinderKind,
} from "@paged-media/plugin-api";

import {
  ShapeBuilderMachine,
  type FaceMode,
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
  createRegionCache,
  planarInputKey,
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
  const sampleRegion = (point: [number, number]): void => {
    if (inputs.length < 2 || !machine) return;
    cache.sample(inputs, point);
  };

  /** Hit-test the engine at `point` and, when it resolves a boolean-
   *  capable element, feed the machine a `cross` event (de-duped there).
   *  Arms the ELEMENT-lane fallback; best-effort + async, a miss is
   *  silent. Runs in both lanes: the region probe is optimistic when the
   *  vocabulary is unreadable, and this is what makes the fall-through
   *  in `onPointerUp` real rather than theoretical. */
  const sweep = (point: [number, number]) => {
    if (!machine || !pageId) return;
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
    if (!regionLane) {
      host.log.debug(
        "shapeBuilder: this engine predates pathfinderFaces — running the " +
          "documented ELEMENT-level fallback (whole shapes unite/subtract)",
      );
    }
    return regionLane;
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
      render(
        machine.handle({
          type: "down",
          point: e.pagePoint,
          modifiers: { alt: e.modifiers.alt },
        }),
      );
      sampleRegion(e.pagePoint);
      sweep(e.pagePoint);
    },
    onPointerMove(e: CanvasPointerEvent) {
      // A hover BEFORE any drag still highlights — that is half the
      // interaction, so a move outside a gesture is not discarded.
      if (!machine || !e.pagePoint || !e.pageId) return;
      pageId = e.pageId;
      render(machine.handle({ type: "move", point: e.pagePoint }));
      sampleRegion(e.pagePoint);
      sweep(e.pagePoint);
    },
    onPointerUp(e: CanvasPointerEvent) {
      if (!machine || !e.pagePoint || e.pageId !== pageId) return;
      const snap = machine.handle({ type: "up", point: e.pagePoint });
      host.overlay.setToolPreview(null);
      const operands = [...inputs];
      void (async () => {
        // REGION lane first — the real interaction.
        if (await supportsRegions()) {
          const mutation = shapeBuilderFacesMutationFor(
            operands,
            snap.collected,
            snap.faceMode,
          );
          if (mutation) {
            const outcome = await host.document.mutate(mutation);
            if (outcome.applied) {
              host.bindings.publish(BIND_PATHFINDER_STATUS, null);
              dropCache();
              await host.selection.set([]);
              return;
            }
            const text = (() => {
              try {
                return JSON.stringify(outcome.error) ?? "";
              } catch {
                return "";
              }
            })();
            if (!text.includes("unknown variant")) {
              const reason =
                regionRefusalReason(outcome.error) ??
                "the engine refused the shape-builder commit";
              host.log.warn(`shapeBuilder refused: ${reason}`);
              host.bindings.publish(BIND_PATHFINDER_STATUS, reason);
              return;
            }
            // An unknown op means the probe was optimistic — fall
            // through to the element lane, once and for this handler.
            regionLane = false;
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
