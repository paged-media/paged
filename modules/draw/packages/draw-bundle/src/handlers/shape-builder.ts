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
// CACHING — the decision, stated: the arrangement is read ONCE PER
// GESTURE SCOPE, not once per pointermove. `requestPlanarRegions`
// WITHOUT a point returns every face; the handler caches that set
// (keyed by the ordered input ids) and every later hover is a LOCAL
// point-in-path test against the cached outlines. A drag across three
// faces therefore costs ONE engine round trip, not one per sample. The
// cache is dropped when the selection changes or the document mutates —
// either invalidates the geometry it was built from.
//
// The `point` form of the same door is still used, for exactly two
// situations and only those:
//   · COLD START — the first sample after the cache was dropped. The
//     point query answers immediately (N point-in-path tests plus one
//     materialisation, the engine's own note) so the highlight appears
//     on the first move rather than one round trip late; the full
//     enumeration is kicked off in the same tick and takes over.
//   · FACE-CAP REFUSAL — the full enumeration refuses past 256 faces,
//     but `face_at_point` carries no face cap, so hover stays live
//     there. Every move then costs a round trip, and the log says so
//     once.
//
// SPACE: the engine's arrangement runs in RAW path space — per-element
// `ItemTransform`s are NOT composed in (the limitation
// `pathfinderBoolean` already ships with, named in core). So the
// handler maps the page-space pointer through the inverse of the
// FRONTMOST input's itemTransform on the way in, and the face outlines
// back through it on the way out. Exact when the inputs share a
// transform (the ordinary case, and identity for anything the editor
// authors); approximate — and named here — when they do not.
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
  PathAnchorTriple,
  PathfinderKind,
} from "@paged-media/plugin-api";

import {
  applyAffine,
  inverseApplyAffine,
  type Affine,
} from "@paged-media/draw-geometry";
import {
  ShapeBuilderMachine,
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

/** One face as `requestPlanarRegions` reports it. Typed locally: the
 *  protocol-v57 `PlanarFaceWire` is not in the vendored contract yet
 *  (the join-average.ts skew note applies verbatim). */
export interface PlanarFaceWire {
  id: string;
  signature: number[];
  anchors: PathAnchorTriple[];
  subpathStarts: number[];
  area: number;
  inside: [number, number];
}

/** The `requestPlanarRegions` reply, typed locally (same skew note). */
export interface PlanarRegionsWire {
  found: boolean;
  faces: PlanarFaceWire[];
  inputCount: number;
  complete: boolean;
  reason?: string | null;
}

/** Map a face's outline from the engine's RAW path space into PAGE
 *  space with `matrix` (the frontmost input's itemTransform) — the form
 *  the machine hit-tests in and the overlay draws in. Exported so the
 *  conformance spec pins the mapping the live tool uses. */
export function faceToPageSpace(
  face: PlanarFaceWire,
  matrix: Affine | null,
): RegionFace {
  const at = (p: readonly [number, number]): [number, number] => {
    const q = applyAffine(matrix, p[0], p[1]);
    return [q[0], q[1]];
  };
  return {
    id: face.id,
    anchors: face.anchors.map((a) => ({
      anchor: at(a.anchor),
      left: at(a.left),
      right: at(a.right),
    })),
    subpathStarts: face.subpathStarts,
  };
}

/** Stable cache key for an ordered input set. */
function inputKey(ids: readonly ElementId[]): string {
  return ids
    .map((i) => `${i.kind}:${String((i as { id: unknown }).id)}`)
    .join("|");
}

/** Build the Shape Builder gesture handler bound to `host` (the B-17
 *  factory shape — every engine touch is a `host.*` facade). */
export function createShapeBuilderHandler(host: BundleHost): GestureHandler {
  let machine: ShapeBuilderMachine | null = null;
  let pageId: string | null = null;
  // The element id resolved per crossed key — so pointer-up can rebuild
  // the typed ElementId operands the ELEMENT lane tracks by string key.
  const byKey = new Map<string, ElementId>();

  // ---- the per-gesture region cache (see the module header) --------
  /** The ordered input set this gesture operates on (top-to-bottom). */
  let inputs: ElementId[] = [];
  /** The page-space face outlines the overlay draws from — the same set
   *  installed in the machine (kept here because the machine hands back
   *  ids, not geometry). */
  let cachedFaces: RegionFace[] = [];
  /** `inputKey(inputs)` the cache was built for; null = cold. */
  let cacheKey: string | null = null;
  /** The frontmost input's itemTransform — the raw↔page mapping. */
  let matrix: Affine | null = null;
  /** In flight, so a burst of pointermoves issues ONE enumeration. */
  let enumerating = false;
  /** The full enumeration refused (face cap): stay on point queries. */
  let pointQueryOnly = false;
  /** Log the round-trip-per-move degradation once per gesture scope. */
  let warnedPointOnly = false;
  /** Resolved once per handler: does this engine carry the region ops? */
  let regionLane: boolean | null = null;
  /** Live subscriptions — allocated on activate, released on the
   *  non-suspend deactivate (GestureHandler has no dispose hook). */
  let subs: Disposable[] = [];

  const dropCache = () => {
    cacheKey = null;
    matrix = null;
    cachedFaces = [];
    pointQueryOnly = false;
    warnedPointOnly = false;
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
      ? cachedFaces.find((f) => f.id === snapshot.hovered)
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

  const readRegions = async (
    ids: ElementId[],
    point?: [number, number],
  ): Promise<PlanarRegionsWire | null> => {
    try {
      // ESCAPE HATCH (named): `host.document` has no planarRegions
      // facade door yet — wire-level `requestPlanarRegions` through
      // host.editor (DESIGN.md §4.9, the measure.ts precedent). A
      // `document.planarRegions` door is the RFI follow-up.
      //
      // The REPLY is cast once here for the same reason: `planarRegions`
      // is a v57 `WorkerToMainKind` the vendored union does not carry.
      const reply = (await host.editor.client.send({
        kind: "requestPlanarRegions",
        payload: point ? { elementIds: ids, point } : { elementIds: ids },
      } as never)) as unknown as {
        kind: string;
        payload?: { result?: PlanarRegionsWire };
      };
      if (reply.kind !== "planarRegions") return null;
      return reply.payload?.result ?? null;
    } catch {
      return null;
    }
  };

  /** Report a refusal the same way everywhere: the engine's own words,
   *  at WARN and on the status binding. Never an empty face list
   *  presented as "these paths divide into nothing". */
  const reportRefusal = (result: PlanarRegionsWire): void => {
    const reason =
      result.reason ?? "the engine refused the region query (no reason given)";
    host.log.warn(`shapeBuilder: ${reason}`);
    host.bindings.publish(BIND_PATHFINDER_STATUS, reason);
  };

  /** Fill the per-gesture cache for `ids` (ONE full enumeration). */
  const ensureCache = (ids: ElementId[]): void => {
    const key = inputKey(ids);
    if (cacheKey === key || enumerating || pointQueryOnly) return;
    enumerating = true;
    void (async () => {
      try {
        // The frontmost input's transform maps raw path space ↔ page
        // space (module header). Read it with the arrangement so both
        // land together.
        const table = await host.document.pathAnchors(ids[0]).catch(() => null);
        const result = await readRegions(ids);
        if (!result) return;
        if (!result.found) {
          reportRefusal(result);
          // A face-cap refusal still leaves the POINT query answerable
          // (it has no face cap) — degrade to that rather than to
          // nothing, and say what it costs.
          pointQueryOnly = true;
          return;
        }
        if (!result.complete) {
          host.log.warn(
            `shapeBuilder: the arrangement is INCOMPLETE — the ${result.faces.length} ` +
              `face(s) listed are real, but they do not tile the union (a sliver was missed)`,
          );
        }
        matrix = table?.itemTransform ?? null;
        cachedFaces = result.faces.map((f) => faceToPageSpace(f, matrix));
        cacheKey = key;
        if (machine) render(machine.setRegions(cachedFaces));
      } finally {
        enumerating = false;
      }
    })();
  };

  /** COLD-START / face-cap path: ask the engine for the single face
   *  under `point` and inject it into the machine. */
  const pointQuery = (ids: ElementId[], point: [number, number]): void => {
    void (async () => {
      const table = await host.document.pathAnchors(ids[0]).catch(() => null);
      const m = table?.itemTransform ?? matrix;
      const local = inverseApplyAffine(m ?? null, point[0], point[1]);
      if (!local) return;
      const result = await readRegions(ids, [local[0], local[1]]);
      if (!result || !machine) return;
      if (!result.found) {
        reportRefusal(result);
        return;
      }
      if (pointQueryOnly && !warnedPointOnly) {
        warnedPointOnly = true;
        host.log.warn(
          "shapeBuilder: the full arrangement exceeded the engine's face cap — " +
            "hover stays live through the point query, at one round trip per move",
        );
      }
      const face = result.faces[0] ?? null;
      if (face) {
        // Keep the outline available to the overlay even without a full
        // enumeration (one face is still a legible highlight).
        const mapped = faceToPageSpace(face, m ?? null);
        if (!cachedFaces.some((f) => f.id === mapped.id)) {
          cachedFaces = [...cachedFaces, mapped];
        }
      }
      render(machine.handle({ type: "region", id: face ? face.id : null }));
    })();
  };

  /** One pointer sample in the REGION lane: purely local while the
   *  cache is warm (the machine already resolved it on the point
   *  event), an engine point query only while it is not. */
  const sampleRegion = (point: [number, number]): void => {
    if (inputs.length < 2 || !machine) return;
    if (cacheKey === inputKey(inputs) && !pointQueryOnly) return;
    ensureCache(inputs);
    pointQuery(inputs, point);
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
    if (inputKey(next) === inputKey(inputs)) return;
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
