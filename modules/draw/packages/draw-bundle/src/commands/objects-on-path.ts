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

// OBJECTS ON A PATH — the Illustrator §16.3 row: associate objects with
// a path, distribute them by spacing or count, align them to it, pivot,
// reorder, move them along it, edit them, release/expand.
//
// ------------------------------------ IT MOVES OBJECTS. IT CREATES NONE.
// Read that before anything else, because it is what makes this row
// different from every other one in this repo. Repeats, patterns,
// symbols, live paint and blends all INSERT artwork — new elements, new
// ids, and a "source" that stays behind. This one does not: the objects
// you select ARE the objects on the path. One property write moves each
// of them, and:
//   · ELEMENT IDS SURVIVE. Another plugin's metadata on an object is
//     still there afterwards, which is not true of a repeat instance or
//     a blend intermediate.
//   · TEXT IS NOT REFUSED. Every other row here refuses a text frame
//     because no wire op copies a story — but nothing is copied here, so
//     a text frame rides the path like anything else.
//   · RELEASE IS EXACT. Each object's ORIGINAL transform is remembered
//     (on the object's own link, so it survives a host with no container
//     writer) and written straight back.
//
// -------------------------------------------------------- THE DOOR
// `setElementProperty { path: "frameTransform", value: { type:
// "transform", … } }`. MEASURED against the booted engine, protocol 60,
// because each of these was a way to get it wrong:
//   · it REPLACES the element's item transform, it does not compose with
//     it. Writing the same rotation twice leaves the object at 30°, not
//     60° — which is what makes Update idempotent and Release exact;
//   · `elementGeometry.bounds` is the frame box in the element's OWN
//     space and is NOT recomputed by a transform (nor, separately, by a
//     `framePath` write). The transform comes back beside it, so the
//     PAGE-space box is `transformBounds(bounds, itemTransform)` — this
//     module never reads `bounds` as if it were page space;
//   · N writes in ONE batch is ONE undo step. Nothing here needs C-15's
//     `bindCreated` at all, because nothing is created.
//
// ------------------------------------------------ RFI C-23, MEASURED HERE
// C-23 says `pathAnchors` / `elementGeometry` are PAGE-KEYED, and on a
// transform (rather than an insert) that holds: an element moved far
// enough off the page rect answers `[]` and `null`.
//
// TWO PLAUSIBLE EXTENSIONS OF THAT ARE FALSE, and both were written into
// this file as fact and then deleted when they were measured:
//   · `getMetadata` is NOT page-keyed, and neither is `document.tree()`.
//     An off-page element still answers its own link and is still listed
//     in the tree. So a stranded object is FINDABLE — what is lost is
//     its GEOMETRY, which is exactly what a re-distribution needs in
//     order to place it, and a write BY ID reaches it either way.
//   · There is no simple "outside the rect" threshold. A 300 pt box
//     hanging 38 pt past the right edge AND 50 pt above the top still
//     answers everything; the same box moved so it starts 500 pt across
//     a 612 pt page does not. WHERE the engine draws that line is not
//     modelled here and no guess about it is recorded — the guard below
//     is simply stricter than it, so this module never needs to know.
//
// `fitToArtboard` is ON by default and applies the STRICTER rule —
// fully INSIDE the page — because an object half off the artboard is not
// what "distribute along a path" is asking for. An object it refuses is
// simply NOT MOVED: it stays home, readable, in the association, and the
// refusal is reported. "Dropped" is safe here in a way it is not for a
// feature that inserts, because leaving an object where it already is
// costs nothing.
//
// -------------------------------------------------- DISTRIBUTE: TWO MODES
// The catalog's two words, and the count mode's count is not a knob:
//   · COUNT — the path is divided by the NUMBER OF ASSOCIATED OBJECTS.
//     Adding an object re-divides the path. There is deliberately no way
//     to ask for more slots than objects, because nothing here
//     duplicates artwork — that is what a Repeat is (§12.4).
//   · SPACING — a fixed arc-length gap. Objects that run past the end of
//     an OPEN path are not moved (and are reported); a CLOSED path wraps
//     but stops after one lap.
// `startOffsetPt` slides every object along the path — that is the
// catalog's "move along path", as a parameter rather than a drag.
//
// ------------------------------------------------------ PIVOT AND ORDER
// PIVOT is §16.1's nine-point registration grid — the SAME one symbols
// uses, imported rather than re-derived. It is the point on the object
// that lands on the slot, and the point `alignToPath` rotates about.
// ORDER is the association order, with `reverseOrder` and an explicit
// `order` permutation; both are stored parameters, so reordering is an
// Update.
//
// ----------------------------------------------- undo counts (MEASURED)
//   · Make    = ONE batch ⇒ 1 undo step.
//   · Update  = ONE batch ⇒ 1 undo step.
//   · Expand  = ONE batch ⇒ 1 undo step.
//   · Release = ONE batch ⇒ 1 undo step.
//   · Select  = no mutation.
// There is no clipped case and no second batch anywhere on this lane.
// The recipe write is a CONTAINER write, not an engine `Mutation`, so it
// is not on the undo stack (the graphic-styles finding).
//
// -------------------------------------------------------------- limits
// · NOTHING IS GROUPED. Illustrator's version behaves like one object;
//   this one leaves the objects exactly where they were in the layer
//   tree, because grouping elements the user already owns would move
//   them in that tree and Release would then have to undo a structural
//   change it never made. The links are the index.
// · AN OBJECT IS NOT RESIZED OR SCALED to the path. `frameTransform`
//   could, and this deliberately does not: §16.3 asks for distribute /
//   align / pivot / reorder / move, and inventing a scale-to-fit would
//   be a different row.
// · EDITING AN OBJECT does not re-distribute by itself. Update does —
//   the same honesty Repeats' and Blends' Update carries.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import {
  affineRotate,
  affineTranslate,
  composeAffine,
  distributeAlongPath,
  IDENTITY_AFFINE,
  measureAnchorRun,
  transformBounds,
  type Affine,
  type PathMetric,
  type PathSlot,
  type RepeatBounds,
} from "@paged-media/draw-geometry";

import { stampDrawMetadata } from "./appearance-bake";
import { blendSourceFrom } from "./blend";
import { leafIdsOf } from "./select-same";
import {
  registrationPointOf,
  SYMBOL_REGISTRATIONS,
  type SymbolRegistration,
} from "./symbols";
import { repeatPageRect } from "./repeat";

export const OBJECTS_ON_PATH_COMMAND_CATEGORY = "Objects on Path";

export const MAKE_OBJECTS_ON_PATH_COMMAND_ID =
  "media.paged.draw.command.makeObjectsOnPath";
export const UPDATE_OBJECTS_ON_PATH_COMMAND_ID =
  "media.paged.draw.command.updateObjectsOnPath";
export const SELECT_OBJECTS_ON_PATH_COMMAND_ID =
  "media.paged.draw.command.selectObjectsOnPath";
export const EXPAND_OBJECTS_ON_PATH_COMMAND_ID =
  "media.paged.draw.command.expandObjectsOnPath";
export const RELEASE_OBJECTS_ON_PATH_COMMAND_ID =
  "media.paged.draw.command.releaseObjectsOnPath";

/** The contributed command ids, in registration order. */
export const OBJECTS_ON_PATH_COMMAND_IDS = [
  MAKE_OBJECTS_ON_PATH_COMMAND_ID,
  UPDATE_OBJECTS_ON_PATH_COMMAND_ID,
  SELECT_OBJECTS_ON_PATH_COMMAND_ID,
  EXPAND_OBJECTS_ON_PATH_COMMAND_ID,
  RELEASE_OBJECTS_ON_PATH_COMMAND_ID,
];

/** The container part the recipes live in, relative to this plugin's
 *  namespace. The SEVENTH in this repo. */
export const OBJECTS_ON_PATH_PART = "objects-on-path.json";

export const OBJECTS_ON_PATH_LIBRARY_VERSION = 1;

/** The capability the recipe rides. NOTE what it is NOT needed for: the
 *  HOME transform lives on each object's own link, so Release and Update
 *  work on a host that wires no container writer — only the PARAMETERS
 *  are lost there. */
export const OBJECTS_ON_PATH_FEATURE = "storage.parts@1";

/** How many objects one path may carry. The ceiling exists so a hostile
 *  selection refuses rather than building a thousand-op batch. */
export const OBJECTS_ON_PATH_MAX = 200;

/** What this row does that no other row here does — and the C-23 trap it
 *  guards. Exported so the panel shows it and a conformance test pins
 *  the WORDING. */
export const OBJECTS_ON_PATH_NOTE =
  "THIS MOVES YOUR OBJECTS. IT CREATES NONE. Every other feature in " +
  "paged.draw that arranges artwork — repeats, patterns, symbols, blends " +
  "— INSERTS new elements and leaves a source behind. This one writes one " +
  "transform per object instead, so the objects on the path ARE the " +
  "objects you selected: their element ids survive, another plugin's " +
  "metadata on them survives, and TEXT FRAMES are not refused (nothing " +
  "copies a story, because nothing is copied). Release writes each " +
  "object's original transform straight back, and that original is " +
  "remembered on the object's own link, so it works even on a host with " +
  "no .paged container writer. One thing it will NOT do: move an object " +
  "off the artboard. An element moved far enough past the page rect " +
  "stops answering for its geometry and its anchors (RFI C-23) — it " +
  "keeps its metadata and its place in the scene tree, so it is not " +
  "lost, but nothing can measure it to place it again. The artboard fit " +
  "applies a STRICTER rule than the engine's, keeping objects fully " +
  "inside rather than merely overlapping, and an object it refuses is " +
  "left exactly where it is, still in the association, with the refusal " +
  "reported. Editing an object does not re-distribute by itself; Update " +
  "does.";

// ---------------------------------------------------------------- model

/** The catalog's two distribution words. */
export type OnPathDistribute = "count" | "spacing";

export const ON_PATH_DISTRIBUTIONS: readonly OnPathDistribute[] = [
  "count",
  "spacing",
];

/** The pivot grid is §16.1's — the same nine points symbols registers
 *  against, imported rather than re-derived. */
export type OnPathPivot = SymbolRegistration;

export const ON_PATH_PIVOTS = SYMBOL_REGISTRATIONS;

export interface ObjectsOnPathParams {
  distribute: OnPathDistribute;
  /** `spacing` mode: the arc-length gap between consecutive objects. */
  spacingPt: number;
  /** Slide every object along the path — the catalog's "move along
   *  path", as a parameter. */
  startOffsetPt: number;
  /** Turn each object to follow the path's direction at its slot. */
  alignToPath: boolean;
  /** Which point of the object lands on the slot (and what
   *  `alignToPath` rotates about). */
  pivot: OnPathPivot;
  /** Walk the association order backwards. */
  reverseOrder: boolean;
  /** An explicit permutation of the association order, or null. Entries
   *  that are not valid indices are ignored; missing ones are appended
   *  in their original order, so a partial permutation is usable. */
  order: number[] | null;
  /** Refuse to move an object off the page (see the module header — this
   *  one is load-bearing). */
  fitToArtboard: boolean;
}

export const OBJECTS_ON_PATH_DEFAULTS: ObjectsOnPathParams = {
  distribute: "count",
  spacingPt: 48,
  startOffsetPt: 0,
  alignToPath: true,
  pivot: "center",
  reverseOrder: false,
  order: null,
  fitToArtboard: true,
};

/** One associated object, as the recipe remembers it. */
export interface OnPathObjectRecord {
  kind: string;
  id: string;
  /** The transform the object had BEFORE it was put on the path. */
  home: Affine;
}

/** One saved association — the RECIPE, not the artwork. */
export interface ObjectsOnPathRecord {
  id: string;
  name: string;
  params: ObjectsOnPathParams;
  path: { kind: string; id: string } | null;
  objects: OnPathObjectRecord[];
}

export interface ObjectsOnPathLibrary {
  v: number;
  associations: ObjectsOnPathRecord[];
}

/** The link an associated OBJECT carries — including the transform it
 *  goes home to, so Release needs no container part. */
export interface OnPathObjectRef {
  onPath: string;
  index: number;
  home: Affine;
}

/** The link the PATH carries. */
export interface OnPathSpineRef {
  onPath: string;
}

const emptyLibrary = (): ObjectsOnPathLibrary => ({
  v: OBJECTS_ON_PATH_LIBRARY_VERSION,
  associations: [],
});

// -------------------------------------------------------- pure: params

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** A 6-number affine, or null. */
export function affineFrom(v: unknown): Affine | null {
  if (!Array.isArray(v) || v.length !== 6) return null;
  const out = v.map((n) => (typeof n === "number" && Number.isFinite(n) ? n : NaN));
  return out.some(Number.isNaN) ? null : (out as unknown as Affine);
}

/** Merge a loose payload over a base, clamping everything into something
 *  a plan can use. Pure. */
export function objectsOnPathParamsFrom(
  raw: unknown,
  base: ObjectsOnPathParams = OBJECTS_ON_PATH_DEFAULTS,
): ObjectsOnPathParams {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof p[key] === "boolean" ? (p[key] as boolean) : fallback;
  return {
    distribute: ON_PATH_DISTRIBUTIONS.includes(p.distribute as OnPathDistribute)
      ? (p.distribute as OnPathDistribute)
      : base.distribute,
    spacingPt: Math.max(0.01, num(p.spacingPt, base.spacingPt)),
    startOffsetPt: num(p.startOffsetPt, base.startOffsetPt),
    alignToPath: bool("alignToPath", base.alignToPath),
    pivot: ON_PATH_PIVOTS.includes(p.pivot as OnPathPivot)
      ? (p.pivot as OnPathPivot)
      : base.pivot,
    reverseOrder: bool("reverseOrder", base.reverseOrder),
    order:
      p.order === null
        ? null
        : Array.isArray(p.order)
          ? p.order
              .map((n) => (typeof n === "number" && Number.isFinite(n) ? n : -1))
              .filter((n) => n >= 0)
          : base.order,
    fitToArtboard: bool("fitToArtboard", base.fitToArtboard),
  };
}

/** Apply `order` + `reverseOrder` to `count` indices. A partial or
 *  hostile permutation degrades: valid entries come first in the order
 *  given, everything unnamed follows in its original order. Pure. */
export function orderedIndices(
  count: number,
  params: ObjectsOnPathParams,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of params.order ?? []) {
    if (i >= 0 && i < count && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  for (let i = 0; i < count; i++) {
    if (!seen.has(i)) out.push(i);
  }
  return params.reverseOrder ? out.reverse() : out;
}

// ------------------------------------------------------- pure: the plan

/** One object, resolved: what it looks like and where it currently
 *  belongs. */
export interface OnPathObject {
  id: ElementId;
  /** The frame box in the element's OWN space, `[top, left, bottom,
   *  right]` — NOT page space (see the module header). */
  innerBounds: RepeatBounds;
  /** The transform it goes home to. */
  home: Affine;
}

/** One placement decision. */
export interface OnPathPlacement {
  object: OnPathObject;
  /** Position in the ORDERED association, 0-based. */
  slot: number;
  /** The transform that will be written, or null when the object is left
   *  where it is. */
  matrix: Affine | null;
  /** Why it was left alone, when it was. `unreadable` is the C-23 one:
   *  the object answers no geometry at all, which on this lane means it
   *  is already off the page rect. It keeps its slot in the association
   *  (and its home) so Release can still reach it. */
  skipped: "offPage" | "noSlot" | "unreadable" | null;
  point: [number, number] | null;
  tangentDeg: number;
}

export interface ObjectsOnPathPlan {
  pageId: string;
  onPath: string;
  params: ObjectsOnPathParams;
  pathId: ElementId;
  pathLength: number;
  placements: OnPathPlacement[];
  /** How many objects were left home because their slot ran off the
   *  path, or off the page. */
  dropped: number;
}

/** The PAGE-space hull of an object under a transform, as
 *  `[minX, minY, maxX, maxY]` — the convention §16.1's registration grid
 *  reads. Pure. */
export function onPathHullOf(
  object: OnPathObject,
  m: Affine,
): [number, number, number, number] {
  const [top, left, bottom, right] = transformBounds(object.innerBounds, m);
  return [left, top, right, bottom];
}

/**
 * THE PLACEMENT — the pure half of this row. Objects (already in their
 * ordered association) plus a measured path plus params in, one absolute
 * `frameTransform` per object out.
 *
 * The maths, once, because it is the only subtle part: `frameTransform`
 * REPLACES an element's transform, so the value written is
 *
 *     M = D · home,   D = T(Q − P₀) · R(θ, P₀)
 *
 * where `home` is the transform the object had before any of this, P₀ is
 * its PIVOT in page space under `home`, Q is the slot point and θ the
 * turn. `D` maps the object's original page-space appearance: it rotates
 * about the pivot, then slides the pivot onto the slot. Because `home`
 * is the input every time (never the object's CURRENT transform), Update
 * is idempotent and Release is `home` written back verbatim.
 *
 * The SHARED kernel supplies the slots (both modes, with their tangents)
 * — see `draw-geometry/src/along-path.ts` for why that much is shared
 * with §16.2's blend spine and no more.
 */
export function placeObjectsOnPath(args: {
  objects: readonly OnPathObject[];
  metric: PathMetric;
  params: ObjectsOnPathParams;
  page: { width: number; height: number } | null;
}): OnPathPlacement[] {
  const { params } = args;
  const slots: PathSlot[] =
    args.objects.length === 0
      ? []
      : distributeAlongPath({
          metric: args.metric,
          mode: params.distribute,
          // COUNT mode's count IS the object count — the module header
          // says why there is no knob for it.
          count: args.objects.length,
          spacingPt: params.spacingPt,
          startOffsetPt: params.startOffsetPt,
          endpoints: "inclusive",
          maxSlots: OBJECTS_ON_PATH_MAX,
        });
  return args.objects.map((object, slot) => {
    const at = slots[slot];
    if (!at) {
      return {
        object,
        slot,
        matrix: null,
        skipped: "noSlot",
        point: null,
        tangentDeg: 0,
      };
    }
    const hull = onPathHullOf(object, object.home);
    const pivot = registrationPointOf(hull, params.pivot);
    const turn = params.alignToPath ? at.tangentDeg : 0;
    const d = composeAffine(
      affineTranslate(at.point[0] - pivot[0], at.point[1] - pivot[1]),
      affineRotate(turn, pivot),
    );
    if (params.fitToArtboard && args.page) {
      const homeTlbr = transformBounds(object.innerBounds, object.home);
      const [top, left, bottom, right] = transformBounds(homeTlbr, d);
      const fits =
        left >= 0 &&
        top >= 0 &&
        right <= args.page.width &&
        bottom <= args.page.height;
      if (!fits) {
        return {
          object,
          slot,
          matrix: null,
          skipped: "offPage",
          point: [at.point[0], at.point[1]],
          tangentDeg: at.tangentDeg,
        };
      }
    }
    return {
      object,
      slot,
      matrix: composeAffine(d, object.home),
      skipped: null,
      point: [at.point[0], at.point[1]],
      tangentDeg: at.tangentDeg,
    };
  });
}

// ------------------------------------------------- pure: the container part

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export function parseObjectsOnPathLibrary(
  bytes: Uint8Array | null,
): ObjectsOnPathLibrary {
  if (!bytes || bytes.byteLength === 0) return emptyLibrary();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return emptyLibrary();
  }
  const lib = raw as Partial<ObjectsOnPathLibrary> | null;
  if (!lib || typeof lib !== "object") return emptyLibrary();
  if (lib.v !== OBJECTS_ON_PATH_LIBRARY_VERSION) return emptyLibrary();
  const associations: ObjectsOnPathRecord[] = [];
  for (const entry of Array.isArray(lib.associations) ? lib.associations : []) {
    const r = (entry ?? {}) as Partial<ObjectsOnPathRecord>;
    if (typeof r.id !== "string" || r.id.length === 0) continue;
    const path = (r.path ?? null) as { kind?: unknown; id?: unknown } | null;
    const pk = path ? strOrNull(path.kind) : null;
    const pi = path ? strOrNull(path.id) : null;
    const objects: OnPathObjectRecord[] = [];
    for (const o of Array.isArray(r.objects) ? r.objects : []) {
      const row = (o ?? {}) as Partial<OnPathObjectRecord>;
      const kind = strOrNull(row.kind);
      const id = strOrNull(row.id);
      if (!kind || !id) continue;
      objects.push({ kind, id, home: affineFrom(row.home) ?? IDENTITY_AFFINE });
    }
    associations.push({
      id: r.id,
      name: typeof r.name === "string" && r.name.length > 0 ? r.name : r.id,
      params: objectsOnPathParamsFrom(r.params),
      path: pk && pi ? { kind: pk, id: pi } : null,
      objects,
    });
  }
  return { v: OBJECTS_ON_PATH_LIBRARY_VERSION, associations };
}

export function serializeObjectsOnPathLibrary(
  library: ObjectsOnPathLibrary,
): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      {
        v: OBJECTS_ON_PATH_LIBRARY_VERSION,
        associations: library.associations,
      },
      null,
      2,
    )}\n`,
  );
}

/** The next free `op-N` id. Deterministic. Pure. */
export function mintObjectsOnPathId(library: ObjectsOnPathLibrary): string {
  let max = 0;
  for (const r of library.associations) {
    const m = /^op-(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `op-${max + 1}`;
}

export function findObjectsOnPathRecord(
  library: ObjectsOnPathLibrary,
  id: string,
): ObjectsOnPathRecord | null {
  return library.associations.find((r) => r.id === id) ?? null;
}

export function upsertObjectsOnPathRecord(
  library: ObjectsOnPathLibrary,
  record: ObjectsOnPathRecord,
): ObjectsOnPathLibrary {
  const associations = library.associations.slice();
  const at = associations.findIndex((r) => r.id === record.id);
  if (at >= 0) associations[at] = record;
  else associations.push(record);
  return { v: OBJECTS_ON_PATH_LIBRARY_VERSION, associations };
}

export function removeObjectsOnPathRecordFrom(
  library: ObjectsOnPathLibrary,
  id: string,
): ObjectsOnPathLibrary {
  return {
    v: OBJECTS_ON_PATH_LIBRARY_VERSION,
    associations: library.associations.filter((r) => r.id !== id),
  };
}

// ---------------------------------------------- pure: the element links

export function onPathObjectOf(
  env: PluginMetadataEnvelope | null,
): OnPathObjectRef | null {
  const raw = (env?.data as { onPathObject?: unknown } | undefined)
    ?.onPathObject;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<OnPathObjectRef>;
  if (typeof r.onPath !== "string") return null;
  return {
    onPath: r.onPath,
    index: num(r.index, 0),
    home: affineFrom(r.home) ?? IDENTITY_AFFINE,
  };
}

export function onPathSpineOf(
  env: PluginMetadataEnvelope | null,
): OnPathSpineRef | null {
  const raw = (env?.data as { onPathSpine?: unknown } | undefined)?.onPathSpine;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<OnPathSpineRef>;
  return typeof r.onPath === "string" ? { onPath: r.onPath } : null;
}

export type OnPathKey = "onPathObject" | "onPathSpine";

/** Merge (or, with `null`, DROP) an on-path key in an envelope,
 *  preserving every OTHER draw metadata key. Pure. */
export function withOnPathKey(
  prev: PluginMetadataEnvelope | null,
  key: OnPathKey,
  ref: OnPathObjectRef | OnPathSpineRef | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (ref === null) {
    delete data[key];
    if (Object.keys(data).length === 0) return null;
  } else {
    data[key] = ref;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

// ------------------------------------------------------- wire builders

/** `setElementProperty { frameTransform }` — the ONE door this row
 *  rides. Exported so the conformance spec asserts the exact wire shape
 *  the live commands emit. */
export function frameTransformMutationFor(
  elementId: ElementId,
  matrix: Affine,
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId,
      path: "frameTransform",
      value: { type: "transform", value: [...matrix] },
    },
  };
}

/**
 * THE BUILD BATCH — Make and Update both ride it: one transform write
 * per PLACED object, then one link per object (placed or not, so a
 * skipped object is still part of the association and still knows its
 * way home), then the path's link. ONE batch ⇒ ONE undo step. No
 * `bindCreated`, no inserts, no deletes, no ordering rules — because
 * nothing is created.
 */
export function objectsOnPathBatchFor(args: {
  plan: ObjectsOnPathPlan;
  envelopes: ReadonlyMap<string, PluginMetadataEnvelope | null>;
  pathEnvelope?: PluginMetadataEnvelope | null;
}): Mutation {
  const { plan } = args;
  const ops: Mutation[] = [];
  for (const placement of plan.placements) {
    if (placement.matrix) {
      ops.push(frameTransformMutationFor(placement.object.id, placement.matrix));
    }
  }
  plan.placements.forEach((placement) => {
    const id = placement.object.id;
    ops.push(
      stampDrawMetadata(
        id,
        withOnPathKey(
          args.envelopes.get(String(id.id)) ?? null,
          "onPathObject",
          {
            onPath: plan.onPath,
            index: placement.slot,
            home: [...placement.object.home] as Affine,
          },
        ),
      ),
    );
  });
  ops.push(
    stampDrawMetadata(
      plan.pathId,
      withOnPathKey(args.pathEnvelope ?? null, "onPathSpine", {
        onPath: plan.onPath,
      }),
    ),
  );
  return { op: "batch", args: { ops } };
}

/** The RELEASE batch — every object's HOME transform written back
 *  verbatim (`frameTransform` REPLACES, so this is exact, not an
 *  inverse), then every link dropped. ONE batch ⇒ 1 undo step. */
export function objectsOnPathReleaseBatchFor(
  leaves: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: OnPathKey;
    home?: Affine | null;
  }[],
): Mutation {
  const ops: Mutation[] = [];
  for (const leaf of leaves) {
    if (leaf.home) ops.push(frameTransformMutationFor(leaf.id, leaf.home));
  }
  for (const leaf of leaves) {
    ops.push(
      stampDrawMetadata(leaf.id, withOnPathKey(leaf.envelope, leaf.key, null)),
    );
  }
  return { op: "batch", args: { ops } };
}

/** The EXPAND batch — stop tracking, leave every object exactly where it
 *  is. Drops the links and nothing else. ONE batch ⇒ 1 undo step. */
export function objectsOnPathExpandBatchFor(
  leaves: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: OnPathKey;
  }[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: leaves.map((leaf) =>
        stampDrawMetadata(leaf.id, withOnPathKey(leaf.envelope, leaf.key, null)),
      ),
    },
  };
}

// -------------------------------------------------------- host: the part

type PartsHost = Pick<BundleHost, "parts" | "supports" | "log">;

export async function readObjectsOnPathLibrary(
  host: PartsHost,
): Promise<ObjectsOnPathLibrary> {
  if (!host.supports(OBJECTS_ON_PATH_FEATURE)) {
    host.log.warn(
      "objects-on-path: this host wires no `.paged` container writer " +
        `(supports("${OBJECTS_ON_PATH_FEATURE}") is false) — the ` +
        "distribution PARAMETERS cannot be saved here. Everything else " +
        "still works: each object's home transform rides its own link, so " +
        "release and update reach it either way",
    );
    return emptyLibrary();
  }
  try {
    return parseObjectsOnPathLibrary(await host.parts.read(OBJECTS_ON_PATH_PART));
  } catch (e) {
    host.log.warn(`objects-on-path: recipe read failed (${String(e)})`);
    return emptyLibrary();
  }
}

export async function writeObjectsOnPathLibrary(
  host: PartsHost,
  library: ObjectsOnPathLibrary,
): Promise<boolean> {
  if (!host.supports(OBJECTS_ON_PATH_FEATURE)) return false;
  try {
    await host.parts.write(
      OBJECTS_ON_PATH_PART,
      serializeObjectsOnPathLibrary(library),
    );
    return true;
  } catch (e) {
    host.log.warn(`objects-on-path: recipe write failed (${String(e)})`);
    return false;
  }
}

// -------------------------------------------------- host: document reads

/** Read one object's frame box (in its OWN space) and its current
 *  transform. Null = not readable — which, on this lane, most often
 *  means it is already off the page (RFI C-23). */
export async function readOnPathObject(
  host: BundleHost,
  id: ElementId,
  home?: Affine | null,
): Promise<{ object: OnPathObject; pageId: string } | null> {
  const items = await host.document.elementGeometry([id]).catch(() => []);
  const item = items[0];
  if (!item) return null;
  return {
    pageId: item.pageId,
    object: {
      id,
      innerBounds: item.bounds as RepeatBounds,
      home: home ?? ((item.itemTransform as Affine | null) ?? IDENTITY_AFFINE),
    },
  };
}

/** Measure the path in PAGE space. Null = it exposes no usable run. */
export async function readOnPathSpine(
  host: BundleHost,
  id: ElementId,
): Promise<{ metric: PathMetric; pageId: string } | null> {
  const table = await host.document.pathAnchors(id).catch(() => null);
  if (!table || table.anchors.length < 2) return null;
  const source = blendSourceFrom(table);
  const run = source.subpaths[0];
  if (!run || run.length < 2) return null;
  const metric = measureAnchorRun(run, { close: !(source.open[0] ?? false) });
  if (!(metric.length > 0)) return null;
  return { metric, pageId: table.pageId };
}

/** Every leaf carrying an on-path link, split by which one. */
export async function objectsOnPathLinks(
  host: BundleHost,
  onPath?: string,
): Promise<{
  objects: { id: ElementId; ref: OnPathObjectRef }[];
  paths: { id: ElementId; ref: OnPathSpineRef }[];
}> {
  const objects: { id: ElementId; ref: OnPathObjectRef }[] = [];
  const paths: { id: ElementId; ref: OnPathSpineRef }[] = [];
  const roots = await host.document.tree().catch(() => []);
  for (const id of leafIdsOf(roots)) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const obj = onPathObjectOf(env);
    if (obj && (onPath === undefined || obj.onPath === onPath)) {
      objects.push({ id, ref: obj });
    }
    const spine = onPathSpineOf(env);
    if (spine && (onPath === undefined || spine.onPath === onPath)) {
      paths.push({ id, ref: spine });
    }
  }
  objects.sort((a, b) => a.ref.index - b.ref.index);
  return { objects, paths };
}

/** Which association a command acts on. */
export async function resolveObjectsOnPath(
  host: BundleHost,
  onPathId: unknown,
): Promise<string | null> {
  if (typeof onPathId === "string") return onPathId;
  for (const id of host.selection.get()) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const linked =
      onPathObjectOf(env)?.onPath ?? onPathSpineOf(env)?.onPath ?? null;
    if (linked !== null) return linked;
  }
  const library = await readObjectsOnPathLibrary(host);
  if (library.associations.length === 1) return library.associations[0]!.id;
  const links = await objectsOnPathLinks(host);
  const distinct = new Set([
    ...links.objects.map((o) => o.ref.onPath),
    ...links.paths.map((p) => p.ref.onPath),
  ]);
  return distinct.size === 1 ? [...distinct][0]! : null;
}

// ------------------------------------------------------------- planning

/** Resolve objects + path + params into a plan, or null (a refusal,
 *  already logged). Shared by Make and Update. */
export async function objectsOnPathPlanFor(
  host: BundleHost,
  args: {
    onPath: string;
    params: ObjectsOnPathParams;
    pathId: ElementId;
    /** In ASSOCIATION order, with their home transforms when known. */
    objects: readonly { id: ElementId; home?: Affine | null }[];
    label: string;
  },
): Promise<ObjectsOnPathPlan | null> {
  const { label } = args;
  const spine = await readOnPathSpine(host, args.pathId);
  if (!spine) {
    host.log.warn(
      `${label}: ${args.pathId.kind} ${String(args.pathId.id)} exposes no ` +
        "measurable path to distribute along — a path needs at least two " +
        "readable anchors and a non-zero length; no-op",
    );
    return null;
  }
  if (args.objects.length === 0) {
    host.log.warn(`${label}: no objects to associate — no-op`);
    return null;
  }
  if (args.objects.length > OBJECTS_ON_PATH_MAX) {
    host.log.warn(
      `${label}: ${args.objects.length} objects is past this plugin's ` +
        `${OBJECTS_ON_PATH_MAX}-object ceiling — refused rather than ` +
        "truncated",
    );
    return null;
  }
  const resolved: OnPathObject[] = [];
  const stranded: { object: OnPathObject; index: number }[] = [];
  let seat = 0;
  for (const entry of args.objects) {
    if (String(entry.id.id) === String(args.pathId.id)) continue;
    const index = seat++;
    const read = await readOnPathObject(host, entry.id, entry.home);
    if (!read) {
      // C-23: an element off the page rect answers no geometry, no
      // anchors and no metadata. It is NOT dropped from the association
      // — it keeps its seat and its home transform, so Release can still
      // bring it back through the recipe. Silently forgetting it would
      // strand it permanently.
      host.log.warn(
        `${label}: ${entry.id.kind} ${String(entry.id.id)} answers no ` +
          "geometry — it sits far enough off the page rect that the " +
          "geometry doors go silent (RFI C-23; its metadata and its place " +
          "in the tree survive, so it is not lost, it is just not " +
          "measurable). It keeps its seat in the association and its way " +
          "home, but it cannot be placed until it is back on the page",
      );
      stranded.push({
        object: {
          id: entry.id,
          innerBounds: [0, 0, 0, 0],
          home: entry.home ?? IDENTITY_AFFINE,
        },
        index,
      });
      continue;
    }
    resolved.push(read.object);
  }
  if (resolved.length === 0) {
    host.log.warn(`${label}: no readable objects to associate — no-op`);
    return null;
  }

  const ordered = orderedIndices(resolved.length, args.params).map(
    (i) => resolved[i],
  );
  const page = args.params.fitToArtboard
    ? await repeatPageRect(host, spine.pageId)
    : null;
  if (args.params.fitToArtboard && !page) {
    host.log.warn(
      `${label}: the page rect for "${spine.pageId}" is not readable, so ` +
        "objects could not be kept on the artboard — placing every one. An " +
        "object moved off the page answers NOTHING, not even its own " +
        "metadata (RFI C-23)",
    );
  }
  const placements = placeObjectsOnPath({
    objects: ordered,
    metric: spine.metric,
    params: args.params,
    page,
  });
  for (const ghost of stranded) {
    placements.push({
      object: ghost.object,
      slot: ghost.index,
      matrix: null,
      skipped: "unreadable",
      point: null,
      tangentDeg: 0,
    });
  }
  const dropped = placements.filter((p) => p.skipped !== null).length;
  if (dropped > 0) {
    const offPage = placements.filter((p) => p.skipped === "offPage").length;
    const noSlot = placements.filter((p) => p.skipped === "noSlot").length;
    const blind = placements.filter((p) => p.skipped === "unreadable").length;
    host.log.info(
      `${label}: ${dropped} of ${placements.length} object(s) were LEFT WHERE ` +
        `THEY ARE — ${offPage} would have landed off the page (an off-page ` +
        "element answers no geometry, no anchors and no metadata, RFI C-23; " +
        `pass fitToArtboard: false to move them anyway), ${noSlot} ran past ` +
        `the end of the path at this spacing, and ${blind} are already off ` +
        "the page and cannot be measured. They are all still part of the " +
        "association and still know their way home",
    );
  }
  return {
    pageId: spine.pageId,
    onPath: args.onPath,
    params: args.params,
    pathId: args.pathId,
    pathLength: spine.metric.length,
    placements,
    dropped,
  };
}

// ------------------------------------------------------------- appliers

const payloadOf = (payload: unknown): Record<string, unknown> =>
  (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;

const nameFor = (
  payload: Record<string, unknown>,
  fallback: string,
): string | null => {
  const raw = payload.name;
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : fallback === ""
      ? null
      : fallback;
};

const isElementId = (v: unknown): boolean =>
  !!v &&
  typeof v === "object" &&
  typeof (v as ElementId).id === "string" &&
  typeof (v as ElementId).kind === "string";

async function envelopesFor(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<Map<string, PluginMetadataEnvelope | null>> {
  const out = new Map<string, PluginMetadataEnvelope | null>();
  for (const id of ids) {
    out.set(
      String(id.id),
      await host.document.getMetadata(id).catch(() => null),
    );
  }
  return out;
}

async function commitPlan(
  host: BundleHost,
  plan: ObjectsOnPathPlan,
  label: string,
): Promise<boolean> {
  const envelopes = await envelopesFor(
    host,
    plan.placements.map((p) => p.object.id),
  );
  const pathEnvelope = await host.document
    .getMetadata(plan.pathId)
    .catch(() => null);
  const outcome = await host.document.mutate(
    objectsOnPathBatchFor({ plan, envelopes, pathEnvelope }),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return false;
  }
  return true;
}

async function saveAssociation(
  host: BundleHost,
  args: {
    library: ObjectsOnPathLibrary;
    plan: ObjectsOnPathPlan;
    name: string;
  },
): Promise<boolean> {
  return writeObjectsOnPathLibrary(
    host,
    upsertObjectsOnPathRecord(args.library, {
      id: args.plan.onPath,
      name: args.name,
      params: args.plan.params,
      path: {
        kind: args.plan.pathId.kind,
        id: String(args.plan.pathId.id),
      },
      objects: args.plan.placements.map((p) => ({
        kind: p.object.id.kind,
        id: String(p.object.id.id),
        home: [...p.object.home] as Affine,
      })),
    }),
  );
}

/**
 * **MAKE** — associate the selected objects with a path and distribute
 * them along it.
 *
 * THE PATH is the payload's `pathId`, else the LAST entry of the
 * selection; everything else in the selection becomes an object, in
 * selection order. ONE batch ⇒ 1 undo step.
 */
export async function applyMakeObjectsOnPath(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = MAKE_OBJECTS_ON_PATH_COMMAND_ID;
  const p = payloadOf(payload);
  const selection = host.selection.get();
  const pathId = isElementId(p.pathId)
    ? (p.pathId as ElementId)
    : (selection[selection.length - 1] ?? null);
  if (!pathId) {
    host.log.warn(
      `${label}: select the objects AND the path they go on (the path is ` +
        "the LAST selected item, or the payload's pathId) — no-op",
    );
    return [];
  }
  const objects = selection.filter(
    (id) => String(id.id) !== String(pathId.id),
  );
  if (objects.length === 0) {
    host.log.warn(
      `${label}: the selection carries the path (${String(pathId.id)}) and ` +
        "nothing else to put on it — no-op",
    );
    return [];
  }
  host.log.debug(
    `${label}: using ${pathId.kind} ${String(pathId.id)} as the path and ` +
      `${objects.length} object(s) from the selection`,
  );
  const params = objectsOnPathParamsFrom(p);
  const library = await readObjectsOnPathLibrary(host);
  const onPath = mintObjectsOnPathId(library);
  const plan = await objectsOnPathPlanFor(host, {
    onPath,
    params,
    pathId,
    objects: objects.map((id) => ({ id })),
    label,
  });
  if (!plan) return [];
  if (!(await commitPlan(host, plan, label))) return [];
  const name = nameFor(p, "") ?? `On path ${library.associations.length + 1}`;
  const saved = await saveAssociation(host, { library, plan, name });
  const moved = plan.placements.filter((x) => x.matrix !== null);
  await host.selection.set([...moved.map((x) => x.object.id), plan.pathId]);
  host.log.info(
    `${label}: "${name}" put ${moved.length} of ${plan.placements.length} ` +
      `object(s) on a ${plan.pathLength.toFixed(1)} pt path in 1 undo step. ` +
      (saved
        ? "The parameters are saved, so the distribution can be updated."
        : "The parameters were NOT saved (no container writer) — release and " +
          "update still work, because each object's home transform rides its " +
          "own link.") +
      " Nothing was created: these ARE your objects, ids and all.",
  );
  return moved.map((x) => x.object.id);
}

/**
 * **UPDATE** — re-distribute an existing association with new
 * parameters. Every object is placed from its HOME transform, never from
 * where it currently sits, so this is idempotent. ONE batch ⇒ 1 undo
 * step.
 */
export async function applyUpdateObjectsOnPath(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = UPDATE_OBJECTS_ON_PATH_COMMAND_ID;
  const p = payloadOf(payload);
  const onPath = await resolveObjectsOnPath(host, p.onPathId);
  if (onPath === null) {
    host.log.warn(
      `${label}: no association resolved from the payload or the selection ` +
        "— make one first",
    );
    return [];
  }
  const library = await readObjectsOnPathLibrary(host);
  const saved = findObjectsOnPathRecord(library, onPath);
  const links = await objectsOnPathLinks(host, onPath);
  const pathId =
    links.paths[0]?.id ??
    (saved?.path
      ? ({ kind: saved.path.kind, id: saved.path.id } as ElementId)
      : null);
  if (!pathId) {
    host.log.warn(`${label}: "${onPath}" no longer names a path — no-op`);
    return [];
  }
  // HOME comes from the links first (they survive with no container
  // writer), then from the recipe.
  const homes = new Map<string, Affine>();
  for (const link of links.objects) homes.set(String(link.id.id), link.ref.home);
  for (const row of saved?.objects ?? []) {
    if (!homes.has(row.id)) homes.set(row.id, row.home);
  }
  // The UNION of what the links can see and what the recipe remembers:
  // an object stranded off the page answers no metadata, so the links
  // alone would silently forget it (see `linkLeavesOf`).
  const objectIds: ElementId[] = links.objects.map((o) => o.id);
  const known = new Set(objectIds.map((o) => String(o.id)));
  for (const row of saved?.objects ?? []) {
    if (known.has(row.id)) continue;
    known.add(row.id);
    objectIds.push({ kind: row.kind, id: row.id } as ElementId);
  }
  if (objectIds.length === 0) {
    host.log.warn(
      `${label}: "${onPath}" names no objects any more — nothing to update`,
    );
    return [];
  }
  const params = objectsOnPathParamsFrom(
    p,
    saved?.params ?? OBJECTS_ON_PATH_DEFAULTS,
  );
  const plan = await objectsOnPathPlanFor(host, {
    onPath,
    params,
    pathId,
    objects: objectIds.map((id) => ({ id, home: homes.get(String(id.id)) })),
    label,
  });
  if (!plan) return [];
  if (!(await commitPlan(host, plan, label))) return [];
  const name = nameFor(p, "") ?? saved?.name ?? onPath;
  await saveAssociation(host, { library, plan, name });
  const moved = plan.placements.filter((x) => x.matrix !== null);
  host.log.info(
    `${label}: "${name}" re-distributed ${moved.length} of ` +
      `${plan.placements.length} object(s) in 1 undo step. Every one was ` +
      "placed from its HOME transform, not from where it happened to be, so " +
      "running this twice changes nothing the second time",
  );
  return moved.map((x) => x.object.id);
}

/** **SELECT** — put an association's objects (the default), or its path,
 *  or both, on the selection. No mutation. */
export async function applySelectObjectsOnPath(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = SELECT_OBJECTS_ON_PATH_COMMAND_ID;
  const p = payloadOf(payload);
  const onPath = await resolveObjectsOnPath(host, p.onPathId);
  if (onPath === null) {
    host.log.warn(`${label}: no association resolved — no-op`);
    return [];
  }
  const links = await objectsOnPathLinks(host, onPath);
  const which = typeof p.which === "string" ? p.which : "objects";
  const ids =
    which === "path"
      ? links.paths.map((x) => x.id)
      : which === "all"
        ? [...links.objects.map((x) => x.id), ...links.paths.map((x) => x.id)]
        : links.objects.map((x) => x.id);
  if (ids.length === 0) {
    host.log.debug(`${label}: "${onPath}" has no ${which} on the page — no-op`);
  }
  await host.selection.set(ids);
  return ids;
}

/** Every leaf this association owns, ready for a release/expand batch —
 *  the LINKS first, then whatever the RECIPE names that the links did
 *  not reach.
 *
 *  The second half is a genuine belt-and-braces and is named as one: the
 *  link walk DOES see an off-page object (`getMetadata` and
 *  `document.tree()` are not page-keyed — measured, see the module
 *  header), so the common case needs no fallback. What it covers is a
 *  recipe that has drifted from the links — an object no longer in the
 *  tree at all, or one whose metadata another plugin cleared — where the
 *  recipe still remembers the way home. */
async function linkLeavesOf(
  host: BundleHost,
  onPath: string,
): Promise<
  {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: OnPathKey;
    home?: Affine | null;
  }[]
> {
  const links = await objectsOnPathLinks(host, onPath);
  const out: {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: OnPathKey;
    home?: Affine | null;
  }[] = [];
  const seen = new Set<string>();
  for (const entry of links.objects) {
    seen.add(String(entry.id.id));
    out.push({
      id: entry.id,
      envelope: await host.document.getMetadata(entry.id).catch(() => null),
      key: "onPathObject",
      home: entry.ref.home,
    });
  }
  const record = findObjectsOnPathRecord(
    await readObjectsOnPathLibrary(host),
    onPath,
  );
  for (const row of record?.objects ?? []) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      id: { kind: row.kind, id: row.id } as ElementId,
      // An unreachable object has no readable envelope by definition;
      // the batch writes its transform BEFORE it touches its metadata,
      // so by the time the clear runs the element is back on the page.
      envelope: null,
      key: "onPathObject",
      home: row.home,
    });
  }
  for (const entry of links.paths) {
    seen.add(String(entry.id.id));
    out.push({
      id: entry.id,
      envelope: await host.document.getMetadata(entry.id).catch(() => null),
      key: "onPathSpine",
      home: null,
    });
  }
  if (record?.path && !seen.has(record.path.id)) {
    out.push({
      id: { kind: record.path.kind, id: record.path.id } as ElementId,
      envelope: null,
      key: "onPathSpine",
      home: null,
    });
  }
  return out;
}

/** **EXPAND** — stop tracking, leave every object exactly where it is on
 *  the path. ONE batch ⇒ 1 undo step (the recipe removal is a container
 *  write and is not undoable). */
export async function applyExpandObjectsOnPath(
  host: BundleHost,
  payload?: unknown,
): Promise<boolean> {
  const label = EXPAND_OBJECTS_ON_PATH_COMMAND_ID;
  const p = payloadOf(payload);
  const onPath = await resolveObjectsOnPath(host, p.onPathId);
  if (onPath === null) {
    host.log.warn(`${label}: no association resolved — no-op`);
    return false;
  }
  const library = await readObjectsOnPathLibrary(host);
  const leaves = await linkLeavesOf(host, onPath);
  if (leaves.length === 0 && !findObjectsOnPathRecord(library, onPath)) {
    host.log.warn(
      `${label}: "${onPath}" names neither a recipe nor any linked artwork — no-op`,
    );
    return false;
  }
  if (leaves.length > 0) {
    const outcome = await host.document.mutate(
      objectsOnPathExpandBatchFor(leaves),
    );
    if (!outcome.applied) {
      host.log.warn(
        `${label}: unlink rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      return false;
    }
  }
  await writeObjectsOnPathLibrary(
    host,
    removeObjectsOnPathRecordFrom(library, onPath),
  );
  host.log.info(
    `${label}: "${onPath}" expanded — every object stays exactly where it is ` +
      "on the path, and nothing tracks it any more (so nothing can put it " +
      "back either)",
  );
  return true;
}

/** **RELEASE** — put every object back where it came from, keep the
 *  path. Exact, because `frameTransform` REPLACES and the home transform
 *  was remembered. ONE batch ⇒ 1 undo step. */
export async function applyReleaseObjectsOnPath(
  host: BundleHost,
  payload?: unknown,
): Promise<number> {
  const label = RELEASE_OBJECTS_ON_PATH_COMMAND_ID;
  const p = payloadOf(payload);
  const onPath = await resolveObjectsOnPath(host, p.onPathId);
  if (onPath === null) {
    host.log.warn(`${label}: no association resolved — no-op`);
    return 0;
  }
  const leaves = await linkLeavesOf(host, onPath);
  if (leaves.length === 0) {
    host.log.debug(`${label}: "${onPath}" has no linked artwork — no-op`);
    return 0;
  }
  const outcome = await host.document.mutate(
    objectsOnPathReleaseBatchFor(leaves),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return 0;
  }
  await writeObjectsOnPathLibrary(
    host,
    removeObjectsOnPathRecordFrom(await readObjectsOnPathLibrary(host), onPath),
  );
  const objects = leaves.filter((l) => l.key === "onPathObject");
  await host.selection.set(objects.map((l) => l.id));
  host.log.info(
    `${label}: "${onPath}" released — ${objects.length} object(s) are back at ` +
      "the transform they had before, exactly (frameTransform replaces, so " +
      "this is a restore and not an inverse). The path is untouched",
  );
  return objects.length;
}

// ------------------------------------------------------------- commands

/** Register the five objects-on-path commands.
 *
 *  Payloads: make `{ name?, pathId?, …params }`, update `{ onPathId?,
 *  name?, …params }`, select `{ onPathId?, which?: "objects" | "path" |
 *  "all" }`, expand / release `{ onPathId? }`. */
export function contributeObjectsOnPathCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: MAKE_OBJECTS_ON_PATH_COMMAND_ID,
      title:
        "Objects on Path: Make (the LAST selected item is the path — your objects MOVE onto it, nothing is copied)",
      category: OBJECTS_ON_PATH_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyMakeObjectsOnPath(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: UPDATE_OBJECTS_ON_PATH_COMMAND_ID,
      title:
        "Objects on Path: Update (re-distribute — spacing, count, offset, align, pivot, order)",
      category: OBJECTS_ON_PATH_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyUpdateObjectsOnPath(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: SELECT_OBJECTS_ON_PATH_COMMAND_ID,
      title: "Objects on Path: Select the objects",
      category: OBJECTS_ON_PATH_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applySelectObjectsOnPath(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: EXPAND_OBJECTS_ON_PATH_COMMAND_ID,
      title:
        "Objects on Path: Expand (stop tracking, leave the objects on the path)",
      category: OBJECTS_ON_PATH_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyExpandObjectsOnPath(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: RELEASE_OBJECTS_ON_PATH_COMMAND_ID,
      title:
        "Objects on Path: Release (put every object back exactly where it was)",
      category: OBJECTS_ON_PATH_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReleaseObjectsOnPath(host, payload).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
