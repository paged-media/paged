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

// THE PLANAR-ARRANGEMENT SEAM (B-22, engine protocol v57) — one place
// that reads the engine's planar map, one place that caches it, one
// place that reports a refusal. Extracted when Live Paint became the
// arrangement's SECOND gesture consumer (`handlers/shape-builder.ts` was
// the first, and now imports from here): two tools resolving the same
// faces through two copies of the same round-trip is precisely the drift
// this repo's no-second-copy rule exists to prevent.
//
// ---------------------------------------------------------- the door
// ESCAPE HATCH, named rather than hidden: the installed
// `@paged-media/plugin-api` (0.2.25-canary.0, vendoring protocol 51) has
// no `document.planarRegions` facade, so the read goes wire-level through
// `host.editor.client.send({ kind: "requestPlanarRegions" })` — the
// DESIGN.md §4.9 / `measure.ts` precedent. The facade EXISTS in
// plugin-sdk HEAD (RFI K-11, `host.document.planarRegions(elementIds,
// point?)` returning the full `PlanarRegionsResult`) but is UNPUBLISHED,
// so it is unreachable from a repin-able contract. When K-11 publishes,
// `readPlanarRegions` below is the ONE function to rewrite and the local
// `PlanarFaceWire` / `PlanarRegionsWire` copies are the ONE pair to
// delete.
//
// THREE ANSWERS, NEVER FLATTENED (the shape K-11 also settled on):
//   · `found: false` + `reason`  — a REFUSAL. The caps are 12 inputs and
//     256 faces and the engine refuses past either; it never truncates.
//   · `found: true, complete: false` — the faces listed are real but do
//     not tile the union (the kernel's probe pass missed a sliver).
//   · `found: true, complete: true` — the whole arrangement.
// Collapsing any of these into "no regions" would be a lie, so a refusal
// goes to WARN *and* onto the shared pathfinder status binding.
//
// -------------------------------------------------------- the caching
// The arrangement is read ONCE PER GESTURE SCOPE, not once per
// pointermove: the full enumeration (no `point`) is cached keyed by the
// ORDERED input ids, and every later hover is a LOCAL point-in-path test
// against the cached outlines. The `point` form is still used for
// exactly two situations:
//   · COLD START — the first sample after the cache was dropped, so the
//     highlight appears immediately rather than one round trip late;
//   · FACE-CAP REFUSAL — the full enumeration refuses past 256 faces, but
//     `face_at_point` carries no face cap, so hover stays live there at
//     one round trip per move. The log says so once.
//
// -------------------------------------------------------- the space
// The engine's arrangement runs in RAW path space — per-element
// `ItemTransform`s are NOT composed in (the limitation `pathfinderBoolean`
// already ships with, named in core). So a page-space pointer is mapped
// through the inverse of the FRONTMOST input's itemTransform on the way
// in, and face outlines back through it on the way out. Exact when the
// inputs share a transform (the ordinary case, and identity for anything
// the editor authors); approximate — and named here — when they do not.

import type {
  BundleHost,
  ElementId,
  PlanarFace,
  PlanarRegionsResult,
} from "@paged-media/plugin-api";
import {
  applyAffine,
  inverseApplyAffine,
  type Affine,
} from "@paged-media/draw-geometry";
import type { RegionFace } from "@paged-media/draw-tools";

import { BIND_PATHFINDER_STATUS } from "../commands/pathfinder-region";

/** The engine's input cap (`paged_mutate::planar::MAX_PLANAR_INPUTS`).
 *  Mirrored here ONLY so a caller can say "12" before spending a round
 *  trip; the authority is still the engine's own refusal, which is what
 *  gets shown. */
export const MAX_PLANAR_INPUTS = 12;

/** The engine's face cap (`MAX_PLANAR_FACES`). Same rule: the engine's
 *  sentence is what a user sees, never this number. */
export const MAX_PLANAR_FACES = 256;

/** K-11 IS PUBLISHED — these are now ALIASES of the contract's own
 *  types, not local re-declarations. They are kept as names because the
 *  whole bundle refers to them (Shape Builder, Live Paint and the cache
 *  below), and because the "Wire" suffix records where the shape comes
 *  from: this is the engine's answer, not something this repo decides. */
export type PlanarFaceWire = PlanarFace;
export type PlanarRegionsWire = PlanarRegionsResult;

/** Stable cache/identity key for an ORDERED input set. Order matters: a
 *  face's signature indexes into the request list, so the same elements
 *  in a different order are a different arrangement. */
export function planarInputKey(ids: readonly ElementId[]): string {
  return ids
    .map((i) => `${i.kind}:${String((i as { id: unknown }).id)}`)
    .join("|");
}

/** The ONE planar-arrangement round trip in this bundle, now over the
 *  PUBLISHED `host.document.planarRegions` facade rather than a raw
 *  `client.send` (K-11 landed in `0.2.28-canary.0`).
 *
 *  `null` is NARROWER than it used to be, and that is an improvement:
 *  the facade answers a host that cannot serve the door as a REFUSAL
 *  carrying the engine's reason, so the only `null` left is the
 *  undeclared-capability gate throwing — the one case with nothing to
 *  report. A refusal still arrives as a well-formed `found: false`, and
 *  `reportPlanarRefusal` below is still what puts it in front of the
 *  user. */
export async function readPlanarRegions(
  host: BundleHost,
  ids: readonly ElementId[],
  point?: readonly [number, number],
): Promise<PlanarRegionsWire | null> {
  try {
    return await host.document.planarRegions(
      ids as ElementId[],
      point ? [point[0], point[1]] : undefined,
    );
  } catch {
    return null;
  }
}

/** Report a refusal the same way everywhere: the engine's own words, at
 *  WARN and on the shared pathfinder status binding. Never an empty face
 *  list presented as "these paths divide into nothing". Returns the
 *  sentence it published. */
export function reportPlanarRefusal(
  host: Pick<BundleHost, "log" | "bindings">,
  label: string,
  result: PlanarRegionsWire | null,
): string {
  const reason =
    result?.reason ??
    (result === null
      ? "this host did not answer requestPlanarRegions — its engine predates the region read door"
      : "the engine refused the region query (no reason given)");
  host.log.warn(`${label}: ${reason}`);
  host.bindings.publish(BIND_PATHFINDER_STATUS, reason);
  return reason;
}

/** Map a face's outline from the engine's RAW path space into PAGE
 *  space with `matrix` (the frontmost input's itemTransform) — the form
 *  the machines hit-test in, the overlay draws in, and `insertPath`
 *  accepts. */
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

/** What a cache hands back to its owner as answers land. */
export interface RegionCacheHooks {
  /** Prefix for every log line + the refusal binding (`"shapeBuilder"`,
   *  `"livePaintBucket"`, …). */
  label: string;
  /** The FULL enumeration landed: every face, in page space. */
  onFaces(faces: readonly RegionFace[]): void;
  /** A POINT query answered: the face under the sampled point, or null. */
  onPointFace(id: string | null): void;
}

/** What a sample's answer is FOR — which decides whether a point query
 *  may be skipped.
 *
 *  - `"every"`: a DRAG collects the face under each sample, so each one
 *    is asked and each answer delivered. One round trip per sample while
 *    the cache is cold or face-capped; that is what collection costs.
 *  - `"latest"`: a HOVER only highlights the face under the pointer NOW.
 *    One query in flight at a time; a sample arriving meanwhile replaces
 *    the pending one, and an answer is dropped once it is stale (a newer
 *    sample is waiting, or the full enumeration landed and the owner has
 *    already resolved its real last point locally). Measured before this
 *    existed: a 200-move burst asked for the same arrangement 201 times.
 */
export type SampleNeed = "every" | "latest";

/** The per-gesture arrangement cache (see the module header). */
export interface RegionCache {
  /** Every page-space face outline currently known — the full
   *  enumeration when warm, plus any single faces the point lane
   *  resolved while it was not. */
  faces(): readonly RegionFace[];
  /** The frontmost input's itemTransform (null = identity / unread). */
  matrix(): Affine | null;
  /** True when the FULL enumeration for `ids` is installed. */
  warm(ids: readonly ElementId[]): boolean;
  /** One pointer sample: a no-op while warm, an enumeration + a
   *  cold-start point query while not. Fire-and-forget by design — the
   *  hooks fire when the engine answers. `need` says what the owner
   *  does with the answer (default `"every"`). */
  sample(
    ids: readonly ElementId[],
    point: readonly [number, number],
    need?: SampleNeed,
  ): void;
  /** Invalidate everything (the selection changed, or the document
   *  mutated — either invalidates the geometry it was built from). */
  drop(): void;
}

/** Build a cache bound to `host`. One per gesture handler instance. */
export function createRegionCache(
  host: BundleHost,
  hooks: RegionCacheHooks,
): RegionCache {
  let cached: RegionFace[] = [];
  /** `planarInputKey(ids)` the full enumeration was built for; null = cold. */
  let key: string | null = null;
  let transform: Affine | null = null;
  /** In flight, so a burst of pointermoves issues ONE enumeration. */
  let enumerating = false;
  /** The full enumeration refused (face cap): stay on point queries. */
  let pointQueryOnly = false;
  /** Log the round-trip-per-move degradation once per gesture scope. */
  let warnedPointOnly = false;

  /** Fill the cache for `ids` (ONE full enumeration). */
  const ensure = (ids: readonly ElementId[]): void => {
    const next = planarInputKey(ids);
    if (key === next || enumerating || pointQueryOnly) return;
    enumerating = true;
    void (async () => {
      try {
        // The frontmost input's transform maps raw ↔ page space (module
        // header). Read it with the arrangement so both land together.
        const table = await host.document.pathAnchors(ids[0]).catch(() => null);
        const result = await readPlanarRegions(host, ids);
        if (!result) return;
        if (!result.found) {
          reportPlanarRefusal(host, hooks.label, result);
          // A face-cap refusal still leaves the POINT query answerable
          // (it has no face cap) — degrade to that rather than to
          // nothing, and say what it costs.
          pointQueryOnly = true;
          return;
        }
        if (!result.complete) {
          host.log.warn(
            `${hooks.label}: the arrangement is INCOMPLETE — the ${result.faces.length} ` +
              `face(s) listed are real, but they do not tile the union (a sliver was missed)`,
          );
        }
        transform = table?.itemTransform ?? null;
        cached = result.faces.map((f) => faceToPageSpace(f, transform));
        key = next;
        hooks.onFaces(cached);
      } finally {
        enumerating = false;
      }
    })();
  };

  const isWarm = (ids: readonly ElementId[]): boolean =>
    key === planarInputKey(ids) && !pointQueryOnly;

  /** COLD-START / face-cap path: ask the engine for the single face
   *  under `point`. Resolves to the face id (null = no face there), or
   *  to `undefined` when the engine gave no usable answer. */
  const askPoint = async (
    ids: readonly ElementId[],
    point: readonly [number, number],
  ): Promise<{ face: string | null } | undefined> => {
    const table = await host.document.pathAnchors(ids[0]).catch(() => null);
    const m = table?.itemTransform ?? transform;
    const local = inverseApplyAffine(m ?? null, point[0], point[1]);
    if (!local) return undefined;
    const result = await readPlanarRegions(host, ids, [local[0], local[1]]);
    if (!result) return undefined;
    if (!result.found) {
      reportPlanarRefusal(host, hooks.label, result);
      return undefined;
    }
    if (pointQueryOnly && !warnedPointOnly) {
      warnedPointOnly = true;
      host.log.warn(
        `${hooks.label}: the full arrangement exceeded the engine's face cap — ` +
          "hover stays live through the point query, at one round trip per move",
      );
    }
    const face = result.faces[0] ?? null;
    if (face) {
      // Keep the outline available to the overlay even without a full
      // enumeration (one face is still a legible highlight).
      const mapped = faceToPageSpace(face, m ?? null);
      if (!cached.some((f) => f.id === mapped.id))
        cached = [...cached, mapped];
    }
    return { face: face ? face.id : null };
  };

  /** `"every"`: ask for this sample and deliver its answer, always. */
  const pointQueryEvery = (
    ids: readonly ElementId[],
    point: readonly [number, number],
  ): void => {
    void (async () => {
      const answer = await askPoint(ids, point);
      if (answer) hooks.onPointFace(answer.face);
    })();
  };

  /** A `"latest"` query is in flight. */
  let latestInFlight = false;
  /** The newest `"latest"` sample that arrived while one was in flight. */
  let pendingLatest: {
    ids: readonly ElementId[];
    point: readonly [number, number];
  } | null = null;

  /** `"latest"`: one in flight, newest-wins, stale answers dropped. */
  const pointQueryLatest = (
    ids: readonly ElementId[],
    point: readonly [number, number],
  ): void => {
    if (latestInFlight) {
      pendingLatest = { ids, point };
      return;
    }
    latestInFlight = true;
    void (async () => {
      let answer: { face: string | null } | undefined;
      try {
        answer = await askPoint(ids, point);
      } finally {
        latestInFlight = false;
        const next = pendingLatest;
        pendingLatest = null;
        if (next) {
          // This answer is for an OLDER point. Delivering it would put a
          // stale face under the pointer — and when the enumeration has
          // landed meanwhile it would overwrite the owner's correct
          // local resolution. Ask about the newest sample instead,
          // unless the owner no longer needs the engine for it.
          if (!isWarm(next.ids)) pointQueryLatest(next.ids, next.point);
        } else if (answer && !isWarm(ids)) {
          hooks.onPointFace(answer.face);
        }
      }
    })();
  };

  return {
    faces: () => cached,
    matrix: () => transform,
    warm: isWarm,
    sample(ids, point, need = "every") {
      if (ids.length === 0) return;
      if (isWarm(ids)) return;
      ensure(ids);
      if (need === "latest") pointQueryLatest(ids, point);
      else pointQueryEvery(ids, point);
    },
    drop() {
      key = null;
      transform = null;
      cached = [];
      pointQueryOnly = false;
      warnedPointOnly = false;
      pendingLatest = null;
    },
  };
}
