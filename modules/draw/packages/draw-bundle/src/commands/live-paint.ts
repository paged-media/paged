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

// LIVE PAINT v0 — REGENERABLE, NOT LIVE. Read this paragraph before
// reading the code, and before believing the feature name.
//
// Illustrator's Live Paint is a document-resident OBJECT: a
// `LivePaintGroup` node holding a persistent face/edge graph, with a
// paint stored per FACE and per EDGE, ids that survive editing a member
// path, and a configurable GAP TOLERANCE that lets two strokes that do
// not quite meet still bound a region. THIS IS NOT THAT, and it cannot
// be on this engine today. What exists is a per-call QUERY:
// `requestPlanarRegions` re-runs the arrangement on every call and hands
// back faces whose ids are `"<signature>#<component>"`, where the
// signature is a list of indices INTO THE REQUEST'S OWN `elementIds` and
// the component index is assigned by sorting the components of that
// signature by their top-left-most anchor. So an id means something only
// against the same ordered input list that produced it, and MOVING a
// member can renumber components under an unchanged id. Nothing is
// stored in the document. The gap is filed as RFI C-30.
//
// So v0 takes this repo's established posture (appearance stacks,
// patterns, image trace all did the same): MATERIALISE, REMEMBER THE
// RECIPE, AND OFFER REGENERATION — while saying loudly that it is
// regenerable, not live. Concretely:
//   · a "Live Paint group" is a RECIPE in a document container part: the
//     ORDERED member ids plus a paint per face id. The members are
//     stamped so a reopened document can still recognise them.
//   · filling a face INSERTS a real page item carrying that face's
//     outline and the chosen fill, stamped with the face id it came
//     from. It is artwork, not a face object.
//   · editing a member does NOT update the fills. REGENERATE re-derives
//     the arrangement, rebuilds every face id that still resolves, and
//     REPORTS the ones that do not (their stale artwork is removed
//     rather than left bounded by geometry that no longer exists).
//
// ------------------------------------------------------- what is real
// FACES ARE REACHABLE, EDGES ARE NOT. `PlanarFace` carries an outline,
// an area and an interior point; there is no edge id anywhere in the
// v57 wire and no `pathfinderEdges` op, so the catalog's "or stroke
// edges" half is NOT BUILT. Stroking an edge would need the arrangement
// to expose its half-edges — the same document-resident object C-30
// asks for. Named here, and in the panel, rather than approximated by
// stroking a face outline (which is a different shape: a face's outline
// is a closed loop through several members, not one edge).
//
// GAP OPTIONS ARE NOT REACHABLE — checked, not assumed. The wire door is
// `RequestPlanarRegions { elementIds, point? }`; the kernel entry points
// are `build_arrangement(inputs)` and `face_at_point(inputs, point)`.
// Neither carries a tolerance argument, and `paged_mutate::planar`'s own
// header lists Live Paint's "persistent face/edge graph WITH GAP
// DETECTION" as explicitly out of its scope. The private
// `PLANAR_ACCURACY` constant is a numerical-robustness grid (the C-21
// driftsort mitigation), not a gap-closing tolerance — raising it would
// change boolean output everywhere, not bridge gaps. Worse for the
// catalog claim: every input SUBPATH is converted to a CLOSED
// `SimpleBezierPath` (`idml_path_to_flo` takes anchors + subpath starts
// and no `subpathOpen`), so an OPEN member is implicitly closed by a
// straight chord from its last anchor to its first — that is a different
// arrangement, not gap bridging. v0 therefore says plainly: THERE IS NO
// GAP HANDLING. Two paths that do not meet do not bound a face.
//
// ---------------------------------------------------------- the caps
// 12 inputs, 256 faces, and the engine REFUSES past either — it never
// truncates. Twelve is low for real Live Paint artwork, so the refusal
// is put in front of the user with the engine's own sentence rather than
// swallowed: Make group probes the arrangement BEFORE writing anything
// and refuses with that sentence on the shared pathfinder status
// binding, so a 13-path selection never becomes a group that cannot
// paint. `complete: false` (the faces are real but do not tile the
// union) is a WARNING, not a refusal — the listed faces stay paintable.
//
// ------------------------------------------------------ the two shapes
// THE RECIPE (one container part, `paged/media.paged.draw/live-paint.json`,
// declared in `contributes.partTypes` as `{ type: "livePaintRecipe",
// role: "spec", format: "json" }`):
//
//   { "v": 1, "groups": [ { "id": "lp-1", "name": "Live Paint 1",
//       "inputs": [ { "kind": "polygon", "id": "ua" }, … ],
//       "faces":  [ { "face": "0-1#0", "fill": "Color/Black" }, … ] } ] }
//
// `inputs` is ORDERED and the order is load-bearing: it IS the signature
// basis, so re-deriving with the members in a different order would
// re-point every recorded face id at a different region. `faces` is an
// ARRAY, not a map, so the part stays deterministic and diffable.
//
// THE LINKS (on each leaf's own `x-paged:media.paged.draw` envelope,
// alongside `appearance` / `graphicStyle` / `symbolInstance`):
//   data.livePaintMember = { group: "lp-1", index: 0 }
//   data.livePaintFill   = { group: "lp-1", face: "0-1#0" }
//
// MUTATION / UNDO SHAPE (probed against the booted engine; the RFI C-15
// rule — assert the real count, never claim "one"):
//   · make group      = ONE batch ⇒ 1 undo step (the member stamps). The
//                       recipe part itself is not on the undo stack.
//   · fill face(s)    = TWO batches ⇒ 2 undo steps, however many faces
//                       the gesture painted (they share one plan).
//   · regenerate      = TWO batches ⇒ 2 undo steps for the whole group —
//                       or ONE when nothing still resolves and the batch
//                       is deletes only.
//   · delete a face   = ONE batch ⇒ 1 undo step.
//   · release         = ONE batch ⇒ 1 undo step (every member and fill
//                       unlinked together).
// Two is the FLOOR for anything that inserts: `insertPath` mints the ids
// batch 2 addresses, and this contract's `Mutation` union carries no
// C-15 `bindCreated` arm (the repo-wide note in CLAUDE.md).
//
// ------------------------------------------------------------- limits
// · Z-ORDER: an inserted item lands at the TOP of the page's z-order —
//   `insertPath` carries no position argument and the vendored
//   `Mutation` union has no reorder op at all (`layerMove` moves LAYERS
//   and nothing assigns an element to one). So a face fill paints ABOVE
//   the members that bound it, covering the inner half of their strokes,
//   where Illustrator paints faces BELOW edges. Measured, pinned by a
//   test, and folded into C-30 — an insert-at-z door is what closes it.
// · THE RECIPE IS NOT UNDOABLE. `host.parts.write` is a container write,
//   not an engine `Mutation` (probed in the graphic-styles spec).
// · REGENERATE MINTS NEW ELEMENT IDS for every fill it rebuilds, so any
//   other plugin's metadata on a fill does not survive one.
// · RAW PATH SPACE: the arrangement does not compose per-element
//   `ItemTransform`s (the `pathfinderBoolean` residual). Face outlines
//   are mapped through the FRONTMOST member's transform on the way out —
//   exact when the members share one, approximate when they do not.
// · A member edit does not notify anything. There is no "this group is
//   out of date" detector, because detecting it would mean re-running
//   the arrangement on every document change; Regenerate is manual.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import {
  inverseApplyAffine,
  splitCompound,
  type Affine,
  type AnchorTable,
} from "@paged-media/draw-geometry";
import type { RegionFace } from "@paged-media/draw-tools";

import { stampDrawMetadata } from "./appearance-bake";
import { framePathMutationFor } from "./compound-path";
import {
  BIND_PATHFINDER_STATUS,
  selectionTopToBottom,
} from "./pathfinder-region";
import { leafIdsOf } from "./select-same";
import { insertPathMutationFor } from "../handlers/insert-path";
import {
  faceToPageSpace,
  readPlanarRegions,
  reportPlanarRefusal,
  MAX_PLANAR_INPUTS,
  type PlanarRegionsWire,
} from "../handlers/planar-regions";
import { resolveTargetPage } from "../io/svg";

export const LIVE_PAINT_COMMAND_CATEGORY = "Live Paint";

export const MAKE_LIVE_PAINT_GROUP_COMMAND_ID =
  "media.paged.draw.command.makeLivePaintGroup";
export const FILL_LIVE_PAINT_FACE_COMMAND_ID =
  "media.paged.draw.command.fillLivePaintFace";
export const REGENERATE_LIVE_PAINT_COMMAND_ID =
  "media.paged.draw.command.regenerateLivePaint";
export const SELECT_LIVE_PAINT_FACES_COMMAND_ID =
  "media.paged.draw.command.selectLivePaintFaces";
export const DELETE_LIVE_PAINT_FACE_COMMAND_ID =
  "media.paged.draw.command.deleteLivePaintFace";
export const RELEASE_LIVE_PAINT_COMMAND_ID =
  "media.paged.draw.command.releaseLivePaint";

/** The contributed command ids, in registration order. */
export const LIVE_PAINT_COMMAND_IDS = [
  MAKE_LIVE_PAINT_GROUP_COMMAND_ID,
  FILL_LIVE_PAINT_FACE_COMMAND_ID,
  REGENERATE_LIVE_PAINT_COMMAND_ID,
  SELECT_LIVE_PAINT_FACES_COMMAND_ID,
  DELETE_LIVE_PAINT_FACE_COMMAND_ID,
  RELEASE_LIVE_PAINT_COMMAND_ID,
];

/** The container part the recipes live in, RELATIVE to this plugin's
 *  `paged/media.paged.draw/` namespace (the host prepends it). */
export const LIVE_PAINT_PART = "live-paint.json";

/** The recipe envelope version (an unknown version reads as an EMPTY
 *  library rather than a crash — the graphic-styles convention). */
export const LIVE_PAINT_LIBRARY_VERSION = 1;

/** The capability this whole feature rides. */
export const LIVE_PAINT_FEATURE = "storage.parts@1";

/** The binding the last RESOLVED face id is published on, so the panel
 *  (and the face-selection tool) can name what the pointer is over —
 *  including a face that carries no paint and therefore no element. */
export const BIND_LIVE_PAINT_FACE = "media.paged.draw.livePaintFace";

/** The element kinds a member may be. The kernel reads geometry through
 *  `element_path`, so a BOUNDS-ONLY rectangle/oval (no `<PathGeometry>`)
 *  is refused by the engine with its own sentence rather than filtered
 *  out here — a silent drop would change the signature basis. */
export const LIVE_PAINT_KINDS = new Set([
  "polygon",
  "rectangle",
  "oval",
  "graphicLine",
]);

/** The fill a bucket click uses when no payload names one. */
export const LIVE_PAINT_DEFAULT_FILL = "Color/Black";

// ---------------------------------------------------------------- model

/** One painted face of a recipe. */
export interface LivePaintFaceRecord {
  /** The engine's face id (`"<signature>#<component>"`). */
  face: string;
  /** A swatch reference (`colorRef`), or null for "no fill". */
  fill: string | null;
}

/** One Live Paint group — a RECIPE, not an object. */
export interface LivePaintRecipe {
  /** Stable, library-local id (`lp-1`, `lp-2`, …). */
  id: string;
  name: string;
  /** The ORDERED member ids, top-to-bottom. THE ORDER IS THE SIGNATURE
   *  BASIS — see the module header. */
  inputs: { kind: string; id: string }[];
  /** The painted faces, in paint order. */
  faces: LivePaintFaceRecord[];
}

/** Every recipe — one container part. */
export interface LivePaintLibrary {
  v: number;
  groups: LivePaintRecipe[];
}

/** The link a MEMBER leaf carries. */
export interface LivePaintMemberRef {
  group: string;
  /** Its position in `inputs` — recorded so a reopened document can
   *  rebuild the ordered basis from the leaves alone. */
  index: number;
}

/** The link a materialised FACE FILL leaf carries. */
export interface LivePaintFillRef {
  group: string;
  face: string;
}

const emptyLibrary = (): LivePaintLibrary => ({
  v: LIVE_PAINT_LIBRARY_VERSION,
  groups: [],
});

// ------------------------------------------------------- pure: parsing

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** Parse the recipe part's bytes. Anything unreadable — absent bytes,
 *  invalid JSON, a future `v` — reads as an EMPTY library: a recipe that
 *  fails to parse must never take the document with it. */
export function parseLivePaintLibrary(
  bytes: Uint8Array | null,
): LivePaintLibrary {
  if (!bytes || bytes.byteLength === 0) return emptyLibrary();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return emptyLibrary();
  }
  const lib = raw as Partial<LivePaintLibrary> | null;
  if (!lib || typeof lib !== "object") return emptyLibrary();
  if (lib.v !== LIVE_PAINT_LIBRARY_VERSION) return emptyLibrary();
  const groups: LivePaintRecipe[] = [];
  for (const entry of Array.isArray(lib.groups) ? lib.groups : []) {
    const g = (entry ?? {}) as Partial<LivePaintRecipe>;
    if (typeof g.id !== "string" || g.id.length === 0) continue;
    const inputs: { kind: string; id: string }[] = [];
    for (const raw of Array.isArray(g.inputs) ? g.inputs : []) {
      const i = (raw ?? {}) as { kind?: unknown; id?: unknown };
      const kind = strOrNull(i.kind);
      const id = strOrNull(i.id);
      if (kind && id) inputs.push({ kind, id });
    }
    const faces: LivePaintFaceRecord[] = [];
    for (const raw of Array.isArray(g.faces) ? g.faces : []) {
      const f = (raw ?? {}) as { face?: unknown; fill?: unknown };
      const face = strOrNull(f.face);
      if (face) faces.push({ face, fill: strOrNull(f.fill) });
    }
    groups.push({
      id: g.id,
      name: typeof g.name === "string" && g.name.length > 0 ? g.name : g.id,
      inputs,
      faces,
    });
  }
  return { v: LIVE_PAINT_LIBRARY_VERSION, groups };
}

/** Serialize the library — indented, because the `spec` role's whole
 *  point is that it stays small and DIFFABLE. */
export function serializeLivePaintLibrary(
  library: LivePaintLibrary,
): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      { v: LIVE_PAINT_LIBRARY_VERSION, groups: library.groups },
      null,
      2,
    )}\n`,
  );
}

// ------------------------------------------------- pure: library edits

/** The next free `lp-N` id. Deterministic (no randomness — the part is
 *  diffable and the tests are exact). */
export function mintLivePaintId(library: LivePaintLibrary): string {
  let max = 0;
  for (const g of library.groups) {
    const m = /^lp-(\d+)$/.exec(g.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `lp-${max + 1}`;
}

export function findLivePaintGroup(
  library: LivePaintLibrary,
  id: string,
): LivePaintRecipe | null {
  return library.groups.find((g) => g.id === id) ?? null;
}

/** Insert or replace a recipe (by id), preserving order. Pure. */
export function upsertLivePaintGroup(
  library: LivePaintLibrary,
  group: LivePaintRecipe,
): LivePaintLibrary {
  const groups = library.groups.slice();
  const at = groups.findIndex((g) => g.id === group.id);
  if (at >= 0) groups[at] = group;
  else groups.push(group);
  return { v: LIVE_PAINT_LIBRARY_VERSION, groups };
}

/** Drop a recipe. An unknown id is a no-op. Pure. */
export function removeLivePaintGroupFrom(
  library: LivePaintLibrary,
  id: string,
): LivePaintLibrary {
  return {
    v: LIVE_PAINT_LIBRARY_VERSION,
    groups: library.groups.filter((g) => g.id !== id),
  };
}

/** Record a face's paint (upsert by face id, order-stable). Pure. */
export function withLivePaintFace(
  group: LivePaintRecipe,
  face: string,
  fill: string | null,
): LivePaintRecipe {
  const faces = group.faces.slice();
  const at = faces.findIndex((f) => f.face === face);
  if (at >= 0) faces[at] = { face, fill };
  else faces.push({ face, fill });
  return { ...group, faces };
}

/** Forget a face's paint. An unknown id is a no-op. Pure. */
export function withoutLivePaintFace(
  group: LivePaintRecipe,
  face: string,
): LivePaintRecipe {
  return { ...group, faces: group.faces.filter((f) => f.face !== face) };
}

// ----------------------------------------------- pure: the element links

/** Read the member link out of an envelope, or null. Tolerant of
 *  partial/foreign shapes (the `appearanceBakeOf` convention). */
export function livePaintMemberOf(
  env: PluginMetadataEnvelope | null,
): LivePaintMemberRef | null {
  const raw = (env?.data as { livePaintMember?: unknown } | undefined)
    ?.livePaintMember;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<LivePaintMemberRef>;
  if (typeof r.group !== "string" || r.group.length === 0) return null;
  return {
    group: r.group,
    index: typeof r.index === "number" && Number.isFinite(r.index) ? r.index : 0,
  };
}

/** Read the fill link out of an envelope, or null. */
export function livePaintFillOf(
  env: PluginMetadataEnvelope | null,
): LivePaintFillRef | null {
  const raw = (env?.data as { livePaintFill?: unknown } | undefined)
    ?.livePaintFill;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<LivePaintFillRef>;
  if (typeof r.group !== "string" || r.group.length === 0) return null;
  if (typeof r.face !== "string" || r.face.length === 0) return null;
  return { group: r.group, face: r.face };
}

/** Merge (or, with `null`, DROP) a live-paint key in an envelope,
 *  preserving every other draw metadata key — releasing a group must
 *  leave appearance / graphic-style / symbol records exactly as they
 *  are. */
export function withLivePaintKey(
  prev: PluginMetadataEnvelope | null,
  key: "livePaintMember" | "livePaintFill",
  ref: LivePaintMemberRef | LivePaintFillRef | null,
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

// ------------------------------------------------------- pure: the plan

/** One face this plan materialises. */
export interface LivePaintFacePlan {
  face: string;
  fill: string | null;
  /** PAGE-space contours of the face outline (holes included). */
  table: AnchorTable;
}

/** Everything the two batches need, resolved once. Pure data — the
 *  conformance spec builds one by hand. */
export interface LivePaintFillPlan {
  pageId: string;
  groupId: string;
  /** The faces to (re)materialise, in paint order. */
  faces: LivePaintFacePlan[];
  /** Fill elements this plan REPLACES — deleted in batch 2 (never batch
   *  1, see {@link livePaintFinishBatchFor}). */
  stale: ElementId[];
}

/** A face outline as the engine reported it (already mapped to page
 *  space) → the anchor table `insertPath` / `framePath` accept. Faces are
 *  always CLOSED. Pure. */
export function faceTableOf(face: RegionFace): AnchorTable {
  const starts = [...(face.subpathStarts ?? [0])];
  return {
    anchors: face.anchors.map((a) => ({
      anchor: [a.anchor[0], a.anchor[1]] as [number, number],
      left: [a.left[0], a.left[1]] as [number, number],
      right: [a.right[0], a.right[1]] as [number, number],
    })),
    subpathStarts: starts.length > 0 ? starts : [0],
    subpathOpen: (starts.length > 0 ? starts : [0]).map(() => false),
  };
}

/** How many contours each planned face inserts (a face WITH HOLES
 *  inserts one path per contour and is re-merged afterwards). Pure. */
export function livePaintContourCounts(plan: LivePaintFillPlan): number[] {
  return plan.faces.map((f) => splitCompound(f.table).length);
}

/** What the finish batch resolved each face to: the surviving element
 *  and the extra contour elements it absorbs. */
export interface LivePaintFaceBinding {
  faceIndex: number;
  keep: ElementId;
  absorb: ElementId[];
}

/** Chunk the ids minted by the insert batch back onto their faces.
 *  Insertion order == tree order (the appearance-bake finding), so this
 *  is a walk, not a guess. Null when the count does not match — the
 *  caller then refuses rather than mis-binding. Pure. */
export function bindLivePaintFaces(
  plan: LivePaintFillPlan,
  minted: readonly ElementId[],
): LivePaintFaceBinding[] | null {
  const counts = livePaintContourCounts(plan);
  const expected = counts.reduce((n, c) => n + c, 0);
  if (minted.length !== expected) return null;
  const bindings: LivePaintFaceBinding[] = [];
  let at = 0;
  counts.forEach((count, faceIndex) => {
    const ids = minted.slice(at, at + count);
    at += count;
    bindings.push({ faceIndex, keep: ids[0], absorb: ids.slice(1) });
  });
  return bindings;
}

// ------------------------------------------------------- wire builders
// Exported so the conformance spec asserts the EXACT wire shapes the
// live commands emit (no second copy to drift from).

/** BATCH 1 — one `insertPath` per face per contour, in the order
 *  `livePaintContourCounts` reports. Inserts ONLY: a batch that DELETES
 *  and then INSERTS is refused by the engine (the symbols.ts finding —
 *  the insert's z-position resolves against the spread length the batch
 *  STARTED with), so a rebuild's tear-down rides batch 2. */
export function livePaintInsertBatchFor(plan: LivePaintFillPlan): Mutation {
  const ops: Mutation[] = [];
  for (const face of plan.faces) {
    for (const contour of splitCompound(face.table)) {
      ops.push(insertPathMutationFor(plan.pageId, contour.anchors, false));
    }
  }
  return { op: "batch", args: { ops } };
}

const colorRef = (
  elementId: ElementId,
  path: "frameFillColor" | "frameStrokeColor",
  value: string | null,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "colorRef", value } },
});

/** BATCH 2 — delete the fills this plan replaces, re-merge every
 *  multi-contour face through the SAME `framePath` door Make Compound
 *  Path uses, paint each survivor, and stamp the face link on it. One
 *  batch ⇒ one undo step, however many faces. The fill carries NO
 *  stroke: an edge belongs to the member path that bounds it, and v0
 *  cannot stroke edges at all (module header). */
export function livePaintFinishBatchFor(args: {
  plan: LivePaintFillPlan;
  bindings: readonly LivePaintFaceBinding[];
}): Mutation {
  const ops: Mutation[] = [];
  for (const id of args.plan.stale) {
    if (typeof id.id === "string") {
      ops.push({ op: "deleteFrame", args: { frameId: id.id } });
    }
  }
  for (const binding of args.bindings) {
    const face = args.plan.faces[binding.faceIndex];
    if (!face) continue;
    if (binding.absorb.length > 0) {
      // A holed face came in as N separate paths; put the contours back
      // on the first one and drop the rest.
      ops.push(framePathMutationFor(binding.keep, face.table));
      for (const id of binding.absorb) {
        ops.push({ op: "deleteFrame", args: { frameId: id.id as string } });
      }
    }
    ops.push(colorRef(binding.keep, "frameFillColor", face.fill));
    ops.push(colorRef(binding.keep, "frameStrokeColor", null));
    ops.push(
      stampDrawMetadata(binding.keep, {
        v: 1,
        data: {
          livePaintFill: {
            group: args.plan.groupId,
            face: face.face,
          } satisfies LivePaintFillRef,
        },
      }),
    );
  }
  return { op: "batch", args: { ops } };
}

/** The MEMBER-stamp batch — one `setPluginMetadata` per member,
 *  carrying its index in the ordered basis. One batch ⇒ one undo step. */
export function livePaintMemberBatchFor(
  groupId: string,
  members: readonly { id: ElementId; envelope: PluginMetadataEnvelope | null }[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: members.map((m, index) =>
        stampDrawMetadata(
          m.id,
          withLivePaintKey(m.envelope, "livePaintMember", {
            group: groupId,
            index,
          }),
        ),
      ),
    },
  };
}

/** The RELEASE batch — drop every live-paint key from every named leaf,
 *  keeping the artwork and every other metadata key. One batch ⇒ one
 *  undo step no matter how many leaves. */
export function livePaintReleaseBatchFor(
  leaves: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: "livePaintMember" | "livePaintFill";
  }[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: leaves.map((leaf) =>
        stampDrawMetadata(
          leaf.id,
          withLivePaintKey(leaf.envelope, leaf.key, null),
        ),
      ),
    },
  };
}

/** The DELETE batch — remove materialised face fills. One batch ⇒ one
 *  undo step. */
export function livePaintDeleteBatchFor(ids: readonly ElementId[]): Mutation {
  return {
    op: "batch",
    args: {
      ops: ids
        .filter((id) => typeof id.id === "string")
        .map((id) => ({
          op: "deleteFrame" as const,
          args: { frameId: id.id as string },
        })),
    },
  };
}

// -------------------------------------------------------- host: the part

type PartsHost = Pick<BundleHost, "parts" | "supports" | "log">;

/** Read the recipes out of the container part. A host with no container
 *  writer (`supports("storage.parts@1")` false — an older editor) is not
 *  an error: it reads as an EMPTY library and WARNS, so the degrade is
 *  visible in the log instead of looking like "no groups yet". */
export async function readLivePaintLibrary(
  host: PartsHost,
): Promise<LivePaintLibrary> {
  if (!host.supports(LIVE_PAINT_FEATURE)) {
    host.log.warn(
      "live paint: this host wires no `.paged` container writer " +
        `(supports("${LIVE_PAINT_FEATURE}") is false) — the recipe cannot be ` +
        "read or saved here, so nothing can be regenerated later",
    );
    return emptyLibrary();
  }
  try {
    return parseLivePaintLibrary(await host.parts.read(LIVE_PAINT_PART));
  } catch (e) {
    host.log.warn(`live paint: recipe read failed (${String(e)})`);
    return emptyLibrary();
  }
}

/** Write the recipes back. `false` = it did not persist (no container
 *  door, or the write was refused) — logged, never thrown. */
export async function writeLivePaintLibrary(
  host: PartsHost,
  library: LivePaintLibrary,
): Promise<boolean> {
  if (!host.supports(LIVE_PAINT_FEATURE)) {
    host.log.warn(
      "live paint: no `.paged` container writer — the recipe was NOT saved " +
        "(the fills are real artwork, but nothing can regenerate them)",
    );
    return false;
  }
  try {
    await host.parts.write(
      LIVE_PAINT_PART,
      serializeLivePaintLibrary(library),
    );
    return true;
  } catch (e) {
    host.log.warn(`live paint: recipe write failed (${String(e)})`);
    return false;
  }
}

// -------------------------------------------------- host: document reads

/** The recipe's members as typed `ElementId`s, in the recorded order. */
export function livePaintInputs(group: LivePaintRecipe): ElementId[] {
  return group.inputs.map((i) => ({ kind: i.kind, id: i.id }) as ElementId);
}

/** Every leaf carrying a live-paint link, split by which one. One scene
 *  walk + one metadata read per leaf — the `select-same` /
 *  `symbolInstances` precedent. */
export async function livePaintLinks(
  host: BundleHost,
  groupId?: string,
): Promise<{
  members: { id: ElementId; ref: LivePaintMemberRef }[];
  fills: { id: ElementId; ref: LivePaintFillRef }[];
}> {
  const members: { id: ElementId; ref: LivePaintMemberRef }[] = [];
  const fills: { id: ElementId; ref: LivePaintFillRef }[] = [];
  const roots = await host.document.tree().catch(() => []);
  for (const id of leafIdsOf(roots)) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const member = livePaintMemberOf(env);
    if (member && (groupId === undefined || member.group === groupId)) {
      members.push({ id, ref: member });
    }
    const fill = livePaintFillOf(env);
    if (fill && (groupId === undefined || fill.group === groupId)) {
      fills.push({ id, ref: fill });
    }
  }
  members.sort((a, b) => a.ref.index - b.ref.index);
  return { members, fills };
}

/** The recipe the current selection belongs to — a member, a fill, or
 *  (when the selection carries no link) the ONLY recipe in the library.
 *  Null when there is nothing to act on. */
export async function selectedLivePaintGroup(
  host: BundleHost,
): Promise<LivePaintRecipe | null> {
  const library = await readLivePaintLibrary(host);
  if (library.groups.length === 0) return null;
  for (const id of host.selection.get()) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const group =
      livePaintMemberOf(env)?.group ?? livePaintFillOf(env)?.group ?? null;
    if (group) {
      const found = findLivePaintGroup(library, group);
      if (found) return found;
    }
  }
  return library.groups.length === 1 ? library.groups[0]! : null;
}

/** The recipe named by `groupId`, or the selection's, or null. */
export async function resolveLivePaintGroup(
  host: BundleHost,
  groupId: unknown,
): Promise<LivePaintRecipe | null> {
  if (typeof groupId === "string" && groupId.length > 0) {
    return findLivePaintGroup(await readLivePaintLibrary(host), groupId);
  }
  return selectedLivePaintGroup(host);
}

/** The live arrangement of a recipe's members, in PAGE space. Returns
 *  the faces plus the page they live on. A refusal is surfaced (the
 *  engine's own sentence, at WARN + on the status binding) and answers
 *  `null` — never an empty face list posing as "no regions". */
export async function livePaintArrangement(
  host: BundleHost,
  group: LivePaintRecipe,
  label: string,
): Promise<{ faces: RegionFace[]; pageId: string; complete: boolean } | null> {
  const inputs = livePaintInputs(group);
  if (inputs.length < 2) {
    host.log.warn(
      `${label}: "${group.name}" records ${inputs.length} member(s) — a planar ` +
        "arrangement needs at least two paths",
    );
    return null;
  }
  const read = await host.document.pathAnchors(inputs[0]!).catch(() => null);
  const result = await readPlanarRegions(host, inputs);
  if (!result || !result.found) {
    reportPlanarRefusal(host, label, result);
    return null;
  }
  if (!result.complete) {
    host.log.warn(
      `${label}: the arrangement is INCOMPLETE — the ${result.faces.length} ` +
        "face(s) listed are real, but they do not tile the union (a sliver " +
        "was missed), so some region has no id to paint",
    );
  }
  const pageId = read?.pageId ?? (await resolveTargetPage(host));
  if (!pageId) {
    host.log.warn(`${label}: no target page for "${group.name}" — no-op`);
    return null;
  }
  const matrix = read?.itemTransform ?? null;
  host.bindings.publish(BIND_PATHFINDER_STATUS, null);
  return {
    faces: result.faces.map((f) => faceToPageSpace(f, matrix)),
    pageId,
    complete: result.complete,
  };
}

/** Resolve the face under a PAGE-space point through the engine's point
 *  query (the door the bucket's cold start uses). Null = no face, or a
 *  refusal (already reported). */
export async function livePaintFaceAt(
  host: BundleHost,
  group: LivePaintRecipe,
  point: readonly [number, number],
  label: string,
): Promise<string | null> {
  const inputs = livePaintInputs(group);
  if (inputs.length < 2) return null;
  const read = await host.document.pathAnchors(inputs[0]!).catch(() => null);
  const matrix = (read?.itemTransform ?? null) as Affine | null;
  // PAGE → RAW path space: the arrangement runs in raw space (module
  // header), so the pointer goes back through the frontmost member's
  // transform, the same inverse the shared cache's cold-start uses.
  const local = inverseApplyAffine(matrix, point[0], point[1]);
  if (!local) return null;
  const result: PlanarRegionsWire | null = await readPlanarRegions(
    host,
    inputs,
    [local[0], local[1]],
  );
  if (!result || !result.found) {
    reportPlanarRefusal(host, label, result);
    return null;
  }
  return result.faces[0]?.id ?? null;
}

// ------------------------------------------------------------- appliers

/** Emit (or re-emit) `faces` as real artwork for `group`. TWO batches ⇒
 *  2 undo steps — or ONE when there is nothing to insert and the batch
 *  is deletes only. Returns the face ids actually materialised. */
export async function emitLivePaintFills(
  host: BundleHost,
  args: {
    group: LivePaintRecipe;
    /** The faces to paint, in order. */
    wanted: readonly LivePaintFaceRecord[];
    /** Existing fill elements to replace (deleted in batch 2). */
    stale: readonly ElementId[];
    label: string;
  },
): Promise<{ painted: string[]; unresolved: string[]; created: ElementId[] }> {
  const { group, label } = args;
  const arrangement = await livePaintArrangement(host, group, label);
  if (!arrangement) return { painted: [], unresolved: [], created: [] };

  const byId = new Map(arrangement.faces.map((f) => [f.id, f]));
  const faces: LivePaintFacePlan[] = [];
  const unresolved: string[] = [];
  for (const want of args.wanted) {
    const face = byId.get(want.face);
    if (!face) {
      unresolved.push(want.face);
      continue;
    }
    faces.push({ face: want.face, fill: want.fill, table: faceTableOf(face) });
  }
  if (unresolved.length > 0) {
    host.log.warn(
      `${label}: ${unresolved.length} recorded face id(s) no longer resolve ` +
        `against the current members (${unresolved.join(", ")}). A face id is ` +
        "the signature of the ORDERED member list plus a component index, so " +
        "editing a member can retire or renumber one — this is regenerable " +
        "paint, not a live face object (RFI C-30). Their artwork is removed " +
        "rather than left bounded by geometry that no longer exists",
    );
  }

  const plan: LivePaintFillPlan = {
    pageId: arrangement.pageId,
    groupId: group.id,
    faces,
    stale: [...args.stale],
  };

  const before = new Set(
    leafIdsOf(await host.document.tree().catch(() => [])).map((e) =>
      String(e.id),
    ),
  );
  let bindings: LivePaintFaceBinding[] = [];
  if (faces.length > 0) {
    const inserted = await host.document.mutate(livePaintInsertBatchFor(plan));
    if (!inserted.applied) {
      host.log.warn(
        `${label}: face insert rejected by engine: ${JSON.stringify(
          inserted.error,
        )}`,
      );
      return { painted: [], unresolved, created: [] };
    }
    const minted = leafIdsOf(await host.document.tree().catch(() => [])).filter(
      (e) => !before.has(String(e.id)),
    );
    const bound = bindLivePaintFaces(plan, minted);
    if (!bound) {
      host.log.warn(
        `${label}: expected ${livePaintContourCounts(plan).reduce(
          (n, c) => n + c,
          0,
        )} inserted contours, found ${minted.length} — leaving the insert in ` +
          "place, not linking it",
      );
      return { painted: [], unresolved, created: minted };
    }
    bindings = bound;
  }
  const finished = await host.document.mutate(
    livePaintFinishBatchFor({ plan, bindings }),
  );
  if (!finished.applied) {
    host.log.warn(
      `${label}: face paint/link batch rejected by engine: ${JSON.stringify(
        finished.error,
      )}`,
    );
    return {
      painted: [],
      unresolved,
      created: bindings.map((b) => b.keep),
    };
  }
  return {
    painted: faces.map((f) => f.face),
    unresolved,
    created: bindings.map((b) => b.keep),
  };
}

/** MAKE GROUP — record the selection as a Live Paint recipe.
 *
 *  The arrangement is PROBED first, so a selection the engine will not
 *  arrange (past the 12-input cap, or carrying an element with no path
 *  geometry) is refused with the engine's own sentence BEFORE a recipe
 *  exists — rather than becoming a group that can never paint. ONE batch
 *  ⇒ 1 undo step for the member stamps; the recipe part is not on the
 *  undo stack. */
export async function applyMakeLivePaintGroup(
  host: BundleHost,
  payload?: { name?: unknown },
): Promise<LivePaintRecipe | null> {
  const label = MAKE_LIVE_PAINT_GROUP_COMMAND_ID;
  const ordered = (await selectionTopToBottom(host)).filter((id) =>
    LIVE_PAINT_KINDS.has(id.kind),
  );
  if (ordered.length < 2) {
    host.log.warn(
      `${label}: needs at least 2 path-bearing elements selected (have ` +
        `${ordered.length}) — a Live Paint group is the planar arrangement of ` +
        "its members, and one path divides nothing",
    );
    return null;
  }
  if (ordered.length > MAX_PLANAR_INPUTS) {
    host.log.warn(
      `${label}: ${ordered.length} members selected — the engine's planar ` +
        `arrangement takes at most ${MAX_PLANAR_INPUTS}. Asking anyway so the ` +
        "engine's own refusal is what the user sees",
    );
  }
  const probe = await readPlanarRegions(host, ordered);
  if (!probe || !probe.found) {
    reportPlanarRefusal(host, label, probe);
    return null;
  }
  host.bindings.publish(BIND_PATHFINDER_STATUS, null);
  if (!probe.complete) {
    host.log.warn(
      `${label}: the arrangement is INCOMPLETE — ${probe.faces.length} face(s) ` +
        "resolved, but they do not tile the union, so at least one region " +
        "cannot be painted",
    );
  }

  const library = await readLivePaintLibrary(host);
  const id = mintLivePaintId(library);
  const name =
    typeof payload?.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim()
      : `Live Paint ${library.groups.length + 1}`;
  const group: LivePaintRecipe = {
    id,
    name,
    inputs: ordered.map((e) => ({ kind: e.kind, id: String(e.id) })),
    faces: [],
  };
  if (!(await writeLivePaintLibrary(host, upsertLivePaintGroup(library, group)))) {
    return null;
  }

  const members: { id: ElementId; envelope: PluginMetadataEnvelope | null }[] =
    [];
  for (const element of ordered) {
    members.push({
      id: element,
      envelope: await host.document.getMetadata(element).catch(() => null),
    });
  }
  const outcome = await host.document.mutate(
    livePaintMemberBatchFor(id, members),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: member stamp rejected by engine: ${JSON.stringify(
        outcome.error,
      )} — the recipe is written, but the members carry no link`,
    );
  }
  host.log.info(
    `${label}: "${name}" records ${ordered.length} member(s) and resolves ` +
      `${probe.faces.length} face(s). This is a REGENERABLE recipe, not a live ` +
      "object: editing a member does not repaint anything — run Regenerate",
  );
  return group;
}

/** FILL FACE(S) — paint the named faces (or the face under a page
 *  point). TWO batches ⇒ 2 undo steps, however many faces. */
export async function applyFillLivePaintFace(
  host: BundleHost,
  payload?: {
    groupId?: unknown;
    face?: unknown;
    faces?: unknown;
    fill?: unknown;
    x?: unknown;
    y?: unknown;
  },
): Promise<string[]> {
  const label = FILL_LIVE_PAINT_FACE_COMMAND_ID;
  const group = await resolveLivePaintGroup(host, payload?.groupId);
  if (!group) {
    host.log.warn(
      `${label}: no Live Paint group resolved from the payload or the ` +
        "selection — make one first",
    );
    return [];
  }
  const fill =
    typeof payload?.fill === "string" && payload.fill.length > 0
      ? payload.fill
      : payload?.fill === null
        ? null
        : LIVE_PAINT_DEFAULT_FILL;

  let ids: string[] = [];
  if (Array.isArray(payload?.faces)) {
    ids = payload.faces.filter((f): f is string => typeof f === "string");
  } else if (typeof payload?.face === "string") {
    ids = [payload.face];
  } else if (
    typeof payload?.x === "number" &&
    typeof payload?.y === "number"
  ) {
    const at = await livePaintFaceAt(host, group, [payload.x, payload.y], label);
    if (at) ids = [at];
  }
  if (ids.length === 0) {
    host.log.debug(`${label}: no face named or resolved — no-op`);
    return [];
  }
  return fillLivePaintFaces(host, group, ids, fill, label);
}

/** The shared fill path — used by the command and by the bucket tool, so
 *  there is one write lane and one recipe update. */
export async function fillLivePaintFaces(
  host: BundleHost,
  group: LivePaintRecipe,
  faces: readonly string[],
  fill: string | null,
  label: string,
): Promise<string[]> {
  const links = await livePaintLinks(host, group.id);
  const stale = links.fills
    .filter((f) => faces.includes(f.ref.face))
    .map((f) => f.id);
  const result = await emitLivePaintFills(host, {
    group,
    wanted: faces.map((face) => ({ face, fill })),
    stale,
    label,
  });
  if (result.painted.length === 0) return [];
  let next = group;
  for (const face of result.painted) next = withLivePaintFace(next, face, fill);
  const library = await readLivePaintLibrary(host);
  await writeLivePaintLibrary(host, upsertLivePaintGroup(library, next));
  return result.painted;
}

/** REGENERATE — re-derive the arrangement and rebuild every recorded
 *  face. Every existing fill of the group is replaced, so a face id that
 *  no longer resolves loses its stale artwork (and is reported, and is
 *  dropped from the recipe). TWO batches ⇒ 2 undo steps for the whole
 *  group — ONE when nothing still resolves and the batch is deletes
 *  only. */
export async function applyRegenerateLivePaint(
  host: BundleHost,
  payload?: { groupId?: unknown },
): Promise<{ rebuilt: number; dropped: string[] }> {
  const label = REGENERATE_LIVE_PAINT_COMMAND_ID;
  const group = await resolveLivePaintGroup(host, payload?.groupId);
  if (!group) {
    host.log.warn(`${label}: no Live Paint group resolved — no-op`);
    return { rebuilt: 0, dropped: [] };
  }
  if (group.faces.length === 0) {
    host.log.debug(`${label}: "${group.name}" has no painted faces — no-op`);
    return { rebuilt: 0, dropped: [] };
  }
  const links = await livePaintLinks(host, group.id);
  const result = await emitLivePaintFills(host, {
    group,
    wanted: group.faces,
    stale: links.fills.map((f) => f.id),
    label,
  });
  if (result.painted.length === 0 && result.unresolved.length === 0) {
    return { rebuilt: 0, dropped: [] };
  }
  let next = group;
  for (const face of result.unresolved) next = withoutLivePaintFace(next, face);
  const library = await readLivePaintLibrary(host);
  await writeLivePaintLibrary(host, upsertLivePaintGroup(library, next));
  return { rebuilt: result.painted.length, dropped: result.unresolved };
}

/** SELECT FACES — put the materialised fills of the named faces (or of
 *  every painted face) on the selection, so they can be restyled or
 *  deleted with the ordinary tools. A face with NO paint has no element
 *  to select; that is the persistent-object gap, and it is reported
 *  rather than silently returning nothing. */
export async function applySelectLivePaintFaces(
  host: BundleHost,
  payload?: { groupId?: unknown; faces?: unknown; face?: unknown },
): Promise<ElementId[]> {
  const label = SELECT_LIVE_PAINT_FACES_COMMAND_ID;
  const group = await resolveLivePaintGroup(host, payload?.groupId);
  if (!group) {
    host.log.warn(`${label}: no Live Paint group resolved — no-op`);
    return [];
  }
  let wanted: string[] | null = null;
  if (Array.isArray(payload?.faces)) {
    wanted = payload.faces.filter((f): f is string => typeof f === "string");
  } else if (typeof payload?.face === "string") {
    wanted = [payload.face];
  }
  const links = await livePaintLinks(host, group.id);
  const chosen = links.fills.filter(
    (f) => wanted === null || wanted.includes(f.ref.face),
  );
  const missing = (wanted ?? []).filter(
    (face) => !links.fills.some((f) => f.ref.face === face),
  );
  if (missing.length > 0) {
    host.log.warn(
      `${label}: face(s) ${missing.join(", ")} carry no paint, so there is ` +
        "NOTHING TO SELECT — v0 materialises a painted face as artwork and has " +
        "no face object for an unpainted one (RFI C-30). Fill it first",
    );
  }
  const ids = chosen.map((f) => f.id);
  await host.selection.set(ids);
  return ids;
}

/** DELETE FACE — remove a painted face's artwork and forget its paint.
 *  ONE batch ⇒ 1 undo step. */
export async function applyDeleteLivePaintFace(
  host: BundleHost,
  payload?: { groupId?: unknown; face?: unknown; faces?: unknown },
): Promise<string[]> {
  const label = DELETE_LIVE_PAINT_FACE_COMMAND_ID;
  const group = await resolveLivePaintGroup(host, payload?.groupId);
  if (!group) {
    host.log.warn(`${label}: no Live Paint group resolved — no-op`);
    return [];
  }
  const wanted = Array.isArray(payload?.faces)
    ? payload.faces.filter((f): f is string => typeof f === "string")
    : typeof payload?.face === "string"
      ? [payload.face]
      : [];
  if (wanted.length === 0) {
    host.log.warn(`${label}: no face named in the payload — no-op`);
    return [];
  }
  const links = await livePaintLinks(host, group.id);
  const doomed = links.fills.filter((f) => wanted.includes(f.ref.face));
  if (doomed.length > 0) {
    const outcome = await host.document.mutate(
      livePaintDeleteBatchFor(doomed.map((f) => f.id)),
    );
    if (!outcome.applied) {
      host.log.warn(
        `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      return [];
    }
  }
  let next = group;
  for (const face of wanted) next = withoutLivePaintFace(next, face);
  const library = await readLivePaintLibrary(host);
  await writeLivePaintLibrary(host, upsertLivePaintGroup(library, next));
  return wanted;
}

/** RELEASE — drop the recipe and every link, keeping ALL the artwork:
 *  the members stay members and the painted faces stay as ordinary
 *  filled paths. ONE batch ⇒ 1 undo step for every link together (the
 *  recipe removal itself is not undoable). */
export async function applyReleaseLivePaint(
  host: BundleHost,
  payload?: { groupId?: unknown },
): Promise<boolean> {
  const label = RELEASE_LIVE_PAINT_COMMAND_ID;
  const group = await resolveLivePaintGroup(host, payload?.groupId);
  if (!group) {
    host.log.warn(`${label}: no Live Paint group resolved — no-op`);
    return false;
  }
  const links = await livePaintLinks(host, group.id);
  const leaves: {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: "livePaintMember" | "livePaintFill";
  }[] = [];
  for (const m of links.members) {
    leaves.push({
      id: m.id,
      envelope: await host.document.getMetadata(m.id).catch(() => null),
      key: "livePaintMember",
    });
  }
  for (const f of links.fills) {
    leaves.push({
      id: f.id,
      envelope: await host.document.getMetadata(f.id).catch(() => null),
      key: "livePaintFill",
    });
  }
  if (leaves.length > 0) {
    const outcome = await host.document.mutate(
      livePaintReleaseBatchFor(leaves),
    );
    if (!outcome.applied) {
      host.log.warn(
        `${label}: unlink rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      return false;
    }
  }
  const library = await readLivePaintLibrary(host);
  host.log.info(
    `${label}: "${group.name}" released — ${links.members.length} member(s) ` +
      `and ${links.fills.length} painted face(s) keep their artwork; nothing ` +
      "can be regenerated from it any more",
  );
  return writeLivePaintLibrary(host, removeLivePaintGroupFrom(library, group.id));
}

// ------------------------------------------------------------- commands

const payloadOf = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};

/** Register the six Live Paint commands. Payloads:
 *  make `{ name? }`, fill `{ groupId?, face? | faces? | x,y, fill? }`,
 *  regenerate / release `{ groupId? }`, select `{ groupId?, face? |
 *  faces? }`, delete `{ groupId?, face? | faces? }`. */
export function contributeLivePaintCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: MAKE_LIVE_PAINT_GROUP_COMMAND_ID,
      title:
        "Live Paint: Make group from selection (a REGENERABLE recipe — not a live object)",
      category: LIVE_PAINT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyMakeLivePaintGroup(host, payloadOf(payload)).then(() => undefined),
    }),
    host.contribute.command({
      id: FILL_LIVE_PAINT_FACE_COMMAND_ID,
      title: "Live Paint: Fill face (inserts artwork over the region)",
      category: LIVE_PAINT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyFillLivePaintFace(host, payloadOf(payload)).then(() => undefined),
    }),
    host.contribute.command({
      id: REGENERATE_LIVE_PAINT_COMMAND_ID,
      title:
        "Live Paint: Regenerate faces (re-derive after a member edit; ids may not survive)",
      category: LIVE_PAINT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyRegenerateLivePaint(host, payloadOf(payload)).then(() => undefined),
    }),
    host.contribute.command({
      id: SELECT_LIVE_PAINT_FACES_COMMAND_ID,
      title: "Live Paint: Select painted faces",
      category: LIVE_PAINT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applySelectLivePaintFaces(host, payloadOf(payload)).then(
          () => undefined,
        ),
    }),
    host.contribute.command({
      id: DELETE_LIVE_PAINT_FACE_COMMAND_ID,
      title: "Live Paint: Delete painted face",
      category: LIVE_PAINT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyDeleteLivePaintFace(host, payloadOf(payload)).then(() => undefined),
    }),
    host.contribute.command({
      id: RELEASE_LIVE_PAINT_COMMAND_ID,
      title: "Live Paint: Release group (keep the artwork, drop the recipe)",
      category: LIVE_PAINT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReleaseLivePaint(host, payloadOf(payload)).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
