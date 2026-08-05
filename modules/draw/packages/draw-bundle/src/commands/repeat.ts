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

// REPEATS v1 — the Illustrator §12.4 row: RADIAL, GRID and MIRROR
// repeat objects with instance counts, spacing, clipping and
// expand/release. Read the header before the code.
//
// ------------------------------- a repeat is NOT a pattern (§12.4 lists
// them on separate lines, and this bundle keeps them apart). A PATTERN
// is a swatch-shaped FILL — `commands/pattern.ts` records why that half
// is not buildable at all (RFI C-31) and ships the tile FIELD instead. A
// REPEAT is an object TRANSFORM: one source, N placements, and a pair of
// verbs that take it apart again. The two share a shape (a recipe in a
// container part, per-leaf links, real inserted artwork) and share
// nothing else: pattern translates tiles on a lattice, a repeat ROTATES
// and REFLECTS, which is why the placement algebra is a full AFFINE per
// instance and lives in `draw-geometry/src/repeat.ts`.
//
// ---------------------------------------------- ONE BATCH. ONE UNDO.
// Every other bake in this repo pays TWO undo steps because it predates
// RFI C-15. This one does not, and the reason is a contract bump, not a
// cleverness: plugin-sdk `bc52766` added `bindCreated` to
// `@paged-media/plugin-api`'s protocol-ahead delta. So a batch can now
// insert geometry and then ADDRESS it — `{ op: "bindCreated", args: {
// handle } }` after the creating child makes `"$h:<handle>"` name what
// it minted — and Make / Update collapse to a single mutation.
//
// MEASURED against the booted engine (protocol 59), because every one of
// these was a way to get it wrong:
//   · the bind must come AFTER its creating child (before it, the batch
//     is refused by name);
//   · it is its OWN op — a handle inside a creating op's `args` is
//     silently ignored;
//   · `"$h:"` resolves in EVERY id position this module uses: an
//     `ElementId.id`, a bare-string `deleteFrame.frameId`, a
//     `setElementProperty.elementId` (including `framePath`), a
//     `createGroup.memberIds` entry and BOTH ends of `pasteInto`;
//   · 200 instances in one batch apply in ~12 ms and ONE undo removes
//     all of them.
// The published contract this repo installs (`0.2.25-canary.0`) predates
// the arm, so the ops are cast in ONE place — `v59-wire.ts`, the
// `v58-wire.ts` precedent — and the repin is a pure deletion.
//
// A MEASURED C-15 EDGE, recorded because it is why this module never
// addresses a group it minted: with an EARLIER `bindCreated` in the same
// batch, a `bindCreated` placed after a `createGroup` resolves
// inconsistently — `deleteFrame { frameId: "$h:g" }` reaches the GROUP
// (and is refused, since deleteFrame refuses groups) while
// `dissolveGroup { groupId: "$h:g" }` refuses with "node not found:
// Group(<the earlier insert's id>)". With no earlier bind, the dissolve
// resolves correctly. Nothing here depends on it: Update reads the
// PREVIOUS group out of the scene tree BEFORE it builds the batch.
//
// -------------------------------------------------- EXPAND vs RELEASE
// Illustrator's two verbs mean different things and this module keeps
// the difference:
//   · EXPAND — stop tracking, keep EVERYTHING. The instances become
//     ordinary paths; the recipe and every link are dropped.
//   · RELEASE — remove the instances, keep the SOURCE exactly as it was.
// (Pattern v1's "Release" is this module's EXPAND and its "Delete tiles"
// is this module's RELEASE. The names follow Illustrator's menu, not
// pattern's, because §12.4 names these two verbs on the repeat row.)
//
// ------------------------------------------------------- CLIPPING
// The catalog names clipping, and B-18 makes it real: `pasteInto` nests
// a top-level item inside a container Rectangle / Oval / Polygon, where
// it renders CLIPPED by the container's outline, and `releaseFrom` pops
// it back. So a clipped repeat mints a clip FRAME (the page rect by
// default — "clip to artboard" — or a caller's `clipRect`) and pastes
// every instance into it, in the same single batch.
//
// FOUR MEASURED CONSEQUENCES, none of them optional:
//   1. A CLIPPED REPEAT HAS NO GROUP. `pasteInto` refuses a grouped
//      child with the engine's own sentence ("B-18: a grouped item
//      cannot be pasted into a frame (ungroup first)"), so clip and
//      group are mutually exclusive. An unclipped repeat still gets one.
//   2. A CLIPPED INSTANCE IS INVISIBLE TO `document.tree()`. The tree
//      door reports the container with NO children, while
//      `getMetadata` / `elementGeometry` / `pathAnchors` all still
//      answer for the child by id. So the link WALK cannot enumerate a
//      clipped repeat and the RECIPE is the only index — which is why
//      clipping DEGRADES OFF (with a warning) on a host that wires no
//      container writer, instead of producing artwork nothing can ever
//      find again.
//   3. `deleteFrame` ON A PASTED-IN CHILD IS REFUSED ("B-18: the item is
//      pasted into a container — release it before removing"). Release
//      therefore emits `releaseFrom` BEFORE `deleteFrame` for every
//      clipped instance.
//   4. DELETING THE CONTAINER DOES NOT DELETE ITS CHILDREN — it ORPHANS
//      them: they leave the tree and still answer `elementGeometry`.
//      So the clip frame is always deleted LAST, after its children are
//      released and removed.
//   Only the INSTANCES are clipped. The source stays an ordinary
//   top-level item, because it is the artwork the user keeps editing and
//   burying it in a container would hide it from the tree too.
//
// ---------------------------------------------------- LIVE, HONESTLY
// There IS an on-canvas control — `handlers/repeat.ts` + the Repeat tool
// — and here is exactly how live it is:
//   · The drag steers ONE parameter per kind (the ring's radius and
//     start angle, the grid's spacing, the mirror's axis) and the
//     overlay previews a GUIDE, because `overlay.setToolPreview` takes
//     ONE polyline and cannot draw N instance outlines.
//   · The instances are rebuilt ONCE, on pointer-up. A re-plan per
//     pointer-move would be one document mutation — and one undo step —
//     per sample.
//   · Editing a SOURCE does not move the instances by itself. Update
//     does (it re-reads the sources' geometry and paint). That is the
//     same honesty Live Paint's REGENERABLE carries.
// So: on-canvas steering, yes; a live linked object that re-renders as
// you drag its source, no — and the command titles say so.
//
// ----------------------------------------------- undo counts (MEASURED)
//   · Make (radial / grid / mirror) = ONE batch ⇒ 1 undo step
//                                     — TWO ⇒ 2 when CLIPPED.
//   · Update                        = ONE batch ⇒ 1 undo step
//                                     — TWO ⇒ 2 when CLIPPED.
//   · Expand                        = ONE batch ⇒ 1 undo step.
//   · Release                       = ONE batch ⇒ 1 undo step.
//   · Select instances              = no mutation.
// The clipped case is TWO for a reason that is NOT the contract skew:
// `pasteInto` is what makes an instance invisible to `document.tree()`,
// and a batch outcome reports ONE `createdId`, so the only honest
// enumeration of what the build minted has to be taken BEFORE the paste
// — see {@link repeatClipBatchFor}. Every OTHER two-batch flow in this
// repo (pattern, appearance bake, compound-path release, symbols, image
// trace, live paint, blend) is still two for the OLD reason and is one
// merge away from one.
// The recipe write is a CONTAINER write, not an engine `Mutation`, so it
// is not on the undo stack (the graphic-styles finding). Undoing a Make
// therefore removes the artwork and leaves a recipe naming ids that no
// longer exist; every reader tolerates a dangling id.
//
// -------------------------------------------------------------- limits
// · RFI C-23 — `pathAnchors` / `elementGeometry` are PAGE-KEYED. An
//   instance whose bounds leave the page rect is created and then
//   answers NOTHING to either door (re-measured here: `[]` and `null`).
//   A radial repeat throws instances off-page trivially, so
//   `fitToArtboard` is ON by default and reports what it dropped;
//   `fitToArtboard: false` still reaches the off-page case on purpose.
// · TEXT FRAMES ARE REFUSED. No wire op copies a story and `insertPath`
//   mints Polygons — the symbols/pattern refusal, unchanged.
// · AN INSTANCE IS ARTWORK, not a live link. Its element ids are new on
//   every Update, so another plugin's metadata on an instance does not
//   survive one.
// · Z-ORDER: everything inserted lands at the TOP of the page's z-order.
//   Protocol 59 DOES carry `reorderElement` (measured present in the
//   engine's op vocabulary) — the "no reorder op at all" sentence in
//   `pattern.ts` is now stale — but a repeat has no z-order question of
//   its own beyond emission order, so this module does not use it.
// · `REPEAT_MAX_INSTANCES` REFUSES an oversized repeat rather than
//   emitting thousands of `insertPath` ops.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
  MutationInput,
} from "@paged-media/plugin-api";
import {
  boundsCenter,
  fitPlacementsToPage,
  gridPlacements,
  mirrorOriginFor,
  mirrorPlacements,
  radialCenterFor,
  radialPlacements,
  rectAnchorTable,
  splitCompound,
  transformAnchorTable,
  type AnchorTable,
  type RepeatBounds,
  type RepeatKind,
  type RepeatPlacement,
  type Vec2,
} from "@paged-media/draw-geometry";

import { stampDrawMetadata } from "./appearance-bake";
import { groupMutationFor, ungroupMutationFor } from "./group";
import {
  compoundPaintOf,
  compoundSourceOf,
  framePathMutationFor,
  type CompoundPaint,
} from "./compound-path";
import { leafIdsOf } from "./select-same";
import { insertPathMutationFor } from "../handlers/insert-path";
import {
  batchMutationFor,
  bindCreatedMutationFor,
  handleElementId,
  pasteIntoMutationFor,
  releaseFromMutationFor,
} from "./v59-wire";

export const REPEAT_COMMAND_CATEGORY = "Repeat";

export const MAKE_RADIAL_REPEAT_COMMAND_ID =
  "media.paged.draw.command.makeRadialRepeat";
export const MAKE_GRID_REPEAT_COMMAND_ID =
  "media.paged.draw.command.makeGridRepeat";
export const MAKE_MIRROR_REPEAT_COMMAND_ID =
  "media.paged.draw.command.makeMirrorRepeat";
export const UPDATE_REPEAT_COMMAND_ID = "media.paged.draw.command.updateRepeat";
export const SELECT_REPEAT_INSTANCES_COMMAND_ID =
  "media.paged.draw.command.selectRepeatInstances";
export const EXPAND_REPEAT_COMMAND_ID = "media.paged.draw.command.expandRepeat";
export const RELEASE_REPEAT_COMMAND_ID =
  "media.paged.draw.command.releaseRepeat";

/** The contributed command ids, in registration order. */
export const REPEAT_COMMAND_IDS = [
  MAKE_RADIAL_REPEAT_COMMAND_ID,
  MAKE_GRID_REPEAT_COMMAND_ID,
  MAKE_MIRROR_REPEAT_COMMAND_ID,
  UPDATE_REPEAT_COMMAND_ID,
  SELECT_REPEAT_INSTANCES_COMMAND_ID,
  EXPAND_REPEAT_COMMAND_ID,
  RELEASE_REPEAT_COMMAND_ID,
];

/** The container part the recipes live in, RELATIVE to this plugin's
 *  `paged/media.paged.draw/` namespace (the host prepends it). The FIFTH
 *  in this repo, after graphic styles / symbols / live paint / pattern. */
export const REPEAT_PART = "repeat.json";

/** The recipe envelope version (an unknown version reads as an EMPTY
 *  library rather than a crash — the graphic-styles convention). */
export const REPEAT_LIBRARY_VERSION = 1;

/** The capability the recipe rides. CLIPPING needs it too — a clipped
 *  instance is invisible to `document.tree()`, so the recipe is its only
 *  index (module header, consequence 2). */
export const REPEAT_FEATURE = "storage.parts@1";

/** How many copies one repeat may emit. The engine has no cap here (200
 *  applied in ~12 ms); this one exists so a fat-fingered `count: 5000`
 *  REFUSES instead of building a five-thousand-op batch. */
export const REPEAT_MAX_INSTANCES = 200;

/** The sentence that states what "live" does and does not mean. Exported
 *  so the panel shows it and the conformance spec pins the WORDING — an
 *  honesty note that can be edited away silently is not a guarantee. */
export const REPEAT_LIVE_NOTE =
  "A REPEAT HERE IS NOT A LIVE LINKED OBJECT. The engine has no repeat " +
  "node: what a repeat produces is real artwork, one inserted path per " +
  "instance, plus a recipe that remembers how to rebuild it. Editing a " +
  "source does NOT move the instances — Update does, by re-reading the " +
  "sources' geometry and paint. The on-canvas control is real but " +
  "bounded: a drag steers ONE parameter and the overlay draws a GUIDE " +
  "(the ring, the lattice extent, the mirror axis), because the overlay " +
  "door takes ONE polyline and cannot draw every instance; the artwork " +
  "is rebuilt once, on release, so a drag costs ONE undo step instead of " +
  "one per pointer sample.";

/** What clipping is, and the four things it costs. Pinned by a test. */
export const REPEAT_CLIP_NOTE =
  "CLIPPING nests every instance inside a clip FRAME through the B-18 " +
  "pasteInto door, so the repeat renders clipped by that frame's " +
  "outline. Four measured consequences: a clipped repeat has NO GROUP " +
  "(pasteInto refuses a grouped child); a clipped instance is INVISIBLE " +
  "to the scene tree, though it still answers geometry and metadata by " +
  "id, so the recipe is the only index and clipping degrades OFF on a " +
  "host with no container writer; deleteFrame REFUSES a pasted-in child, " +
  "so Release releases before it removes; and deleting the container " +
  "ORPHANS its children rather than deleting them, so the clip frame " +
  "goes last. Only the INSTANCES are clipped — the source stays an " +
  "ordinary top-level item you can keep editing.";

// ---------------------------------------------------------------- model

/** Everything the §12.4 row asks a repeat to expose. One flat record for
 *  all three kinds: the panel shows the relevant subset, the recipe
 *  persists the whole thing, and switching kind keeps what you set. */
export interface RepeatParams {
  kind: RepeatKind;
  // ---- radial
  /** Instances INCLUDING the source, Illustrator's count. */
  count: number;
  radiusPt: number;
  /** Where the source sits on the ring, degrees (y-down, so -90 is the
   *  TOP of the ring). */
  startDeg: number;
  /** The arc the instances span; 360 closes the ring. */
  sweepDeg: number;
  /** Turn each instance to follow the arc. */
  rotateInstances: boolean;
  // ---- grid
  columns: number;
  rows: number;
  /** Gutter in pt `[x, y]`. NEGATIVE values are a real overlap (the
   *  pattern-v1 convention). */
  spacing: [number, number];
  flipColumns: boolean;
  flipRows: boolean;
  // ---- mirror
  /** Axis direction in degrees; 90 = a vertical axis (left↔right). */
  angleDeg: number;
  /** How far off the source centre the axis sits, along its normal.
   *  `null` = half the source's extent, which puts the axis on the
   *  source's edge. */
  offsetPt: number | null;
  // ---- shared
  /** Nest the instances in a clip frame (module header). */
  clip: boolean;
  /** The clip frame's rect `[top, left, bottom, right]`; `null` = the
   *  PAGE rect ("clip to artboard"). */
  clipRect: RepeatBounds | null;
  /** Drop instances that would not land fully inside the page (C-23). */
  fitToArtboard: boolean;
}

export const REPEAT_DEFAULTS: RepeatParams = {
  kind: "radial",
  count: 6,
  radiusPt: 120,
  startDeg: -90,
  sweepDeg: 360,
  rotateInstances: true,
  columns: 3,
  rows: 3,
  spacing: [12, 12],
  flipColumns: false,
  flipRows: false,
  angleDeg: 90,
  offsetPt: null,
  clip: false,
  clipRect: null,
  fitToArtboard: true,
};

/** One saved repeat — the RECIPE, not the artwork. */
export interface RepeatRecord {
  /** Stable, library-local id (`rep-1`, `rep-2`, …). */
  id: string;
  name: string;
  params: RepeatParams;
  /** The ORDERED source ids the instances are emitted from. */
  sources: { kind: string; id: string }[];
  /** The materialised instance ids, in emission order. This is not
   *  belt-and-braces: for a CLIPPED repeat it is the ONLY index, because
   *  `document.tree()` does not report a pasted-in child. */
  instances: { kind: string; id: string }[];
  /** The clip frame, when the repeat is clipped. */
  clipFrame: { kind: string; id: string } | null;
}

/** Every saved repeat — one container part. */
export interface RepeatLibrary {
  v: number;
  repeats: RepeatRecord[];
}

/** The link a SOURCE leaf carries. */
export interface RepeatSourceRef {
  repeat: string;
  index: number;
}

/** The link one materialised INSTANCE carries. */
export interface RepeatInstanceRef {
  repeat: string;
  /** Which source it was emitted from. */
  of: ElementId;
  /** Placement ordinal (1-based: 0 is the source itself). */
  index: number;
  col: number;
  row: number;
}

/** The link the CLIP FRAME carries. */
export interface RepeatClipRef {
  repeat: string;
}

const emptyLibrary = (): RepeatLibrary => ({
  v: REPEAT_LIBRARY_VERSION,
  repeats: [],
});

// -------------------------------------------------------- pure: params

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const pair = (
  v: unknown,
  fallback: readonly [number, number],
): [number, number] => {
  if (Array.isArray(v) && v.length === 2) {
    return [num(v[0], fallback[0]), num(v[1], fallback[1])];
  }
  if (typeof v === "number" && Number.isFinite(v)) return [v, v];
  return [fallback[0], fallback[1]];
};

const boundsOrNull = (v: unknown): RepeatBounds | null => {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const out = v.map((n) =>
    typeof n === "number" && Number.isFinite(n) ? n : NaN,
  );
  return out.some(Number.isNaN) ? null : (out as unknown as RepeatBounds);
};

export const REPEAT_KINDS: readonly RepeatKind[] = ["radial", "grid", "mirror"];

/** Merge a loose payload over a base (the defaults, or a saved record's
 *  params). Every value is clamped to something a plan can use, so a
 *  hostile payload degrades rather than producing a broken batch. Pure. */
export function repeatParamsFrom(
  raw: unknown,
  base: RepeatParams = REPEAT_DEFAULTS,
): RepeatParams {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof p[key] === "boolean" ? (p[key] as boolean) : fallback;
  return {
    kind: REPEAT_KINDS.includes(p.kind as RepeatKind)
      ? (p.kind as RepeatKind)
      : base.kind,
    count: Math.max(1, Math.round(num(p.count, base.count))),
    radiusPt: Math.max(0, num(p.radiusPt, base.radiusPt)),
    startDeg: num(p.startDeg, base.startDeg),
    // A zero/absurd sweep would put every instance on top of the source.
    sweepDeg: Math.min(360, Math.max(-360, num(p.sweepDeg, base.sweepDeg))),
    rotateInstances: bool("rotateInstances", base.rotateInstances),
    columns: Math.max(1, Math.round(num(p.columns, base.columns))),
    rows: Math.max(1, Math.round(num(p.rows, base.rows))),
    spacing: pair(p.spacing, base.spacing),
    flipColumns: bool("flipColumns", base.flipColumns),
    flipRows: bool("flipRows", base.flipRows),
    angleDeg: num(p.angleDeg, base.angleDeg),
    offsetPt:
      p.offsetPt === null
        ? null
        : p.offsetPt === undefined
          ? base.offsetPt
          : num(p.offsetPt, base.offsetPt ?? 0),
    clip: bool("clip", base.clip),
    clipRect:
      p.clipRect === null ? null : (boundsOrNull(p.clipRect) ?? base.clipRect),
    fitToArtboard: bool("fitToArtboard", base.fitToArtboard),
  };
}

// ------------------------------------------------------- pure: the plan

/** The page rectangle a repeat is fitted (and by default clipped) to.
 *  The engine reports a page SIZE and no ORIGIN (`PageSummary` has
 *  `sizePt` only), so page space starts at (0, 0) — the pattern-v1
 *  finding, re-measured: an item at negative coordinates belongs to no
 *  page, and one whose box is inside the rect does. */
export interface RepeatPageRect {
  pageId: string;
  width: number;
  height: number;
}

/** One source element's contribution. */
export interface RepeatSource {
  id: ElementId;
  /** PAGE-space contours (a compound source keeps all of them). */
  table: AnchorTable;
  paint: CompoundPaint;
}

/** Everything the ONE batch needs, resolved once. Pure data — the
 *  conformance spec builds one by hand. */
export interface RepeatPlan {
  pageId: string;
  repeat: string;
  params: RepeatParams;
  /** The union of the sources' page bounds, `[top, left, bottom, right]`. */
  bounds: RepeatBounds;
  sources: RepeatSource[];
  /** The placements that will be EMITTED (never index 0, the source). */
  placements: RepeatPlacement[];
  /** The placements the artboard fit removed — reported, never silent. */
  dropped: RepeatPlacement[];
  /** The clip frame's rect, or null when the repeat is not clipped. */
  clipRect: RepeatBounds | null;
}

/** One emitted copy: which placement, which source, how many contours. */
export interface RepeatCopy {
  placement: RepeatPlacement;
  sourceIndex: number;
  contours: number;
}

/** The full placement list for `params` over a source box — index 0 is
 *  the SOURCE and is never emitted. Pure: the one function that turns
 *  the three kinds into one list, so every caller (plan, panel, tool,
 *  spec) reads the same algebra. */
export function repeatPlacementsFor(
  params: RepeatParams,
  bounds: RepeatBounds,
): RepeatPlacement[] {
  const [top, left, bottom, right] = bounds;
  const center = boundsCenter(bounds);
  const size: Vec2 = [right - left, bottom - top];
  if (params.kind === "radial") {
    return radialPlacements({
      count: params.count,
      radiusPt: params.radiusPt,
      startDeg: params.startDeg,
      sweepDeg: params.sweepDeg,
      rotateInstances: params.rotateInstances,
      center: radialCenterFor(center, params.radiusPt, params.startDeg),
    });
  }
  if (params.kind === "grid") {
    return gridPlacements({
      columns: params.columns,
      rows: params.rows,
      stepX: size[0] + params.spacing[0],
      stepY: size[1] + params.spacing[1],
      flipColumns: params.flipColumns,
      flipRows: params.flipRows,
      cellCenter: center,
    });
  }
  const offset = params.offsetPt ?? mirrorDefaultOffset(params.angleDeg, size);
  return mirrorPlacements({
    angleDeg: params.angleDeg,
    origin: mirrorOriginFor(center, params.angleDeg, offset),
  });
}

/** The ring centre `params` implies for a source centred at
 *  `sourceCenter` — the SAME derivation {@link repeatPlacementsFor}
 *  uses, exposed so the on-canvas guide draws the ring the commit will
 *  actually build (one algebra, no second copy). Pure. */
export function radialCenterOfDraft(
  params: RepeatParams,
  sourceCenter: Vec2,
): Vec2 {
  return radialCenterFor(sourceCenter, params.radiusPt, params.startDeg);
}

/** Half the source's extent ALONG the mirror normal — the offset that
 *  puts the axis exactly on the source's edge, which is where
 *  Illustrator's mirror handle starts. Pure. */
export function mirrorDefaultOffset(angleDeg: number, size: Vec2): number {
  const r = (angleDeg * Math.PI) / 180;
  // |n| projected onto the box: |sin θ|·w/2 + |cos θ|·h/2.
  return (
    (Math.abs(Math.sin(r)) * size[0] + Math.abs(Math.cos(r)) * size[1]) / 2
  );
}

/** The copies a plan produces, in INSERTION order (placement-major, then
 *  source order) — which is how the handles are named and how the ids
 *  are read back. Pure. */
export function repeatCopiesFor(plan: RepeatPlan): RepeatCopy[] {
  const copies: RepeatCopy[] = [];
  for (const placement of plan.placements) {
    plan.sources.forEach((source, sourceIndex) => {
      copies.push({
        placement,
        sourceIndex,
        contours: splitCompound(
          transformAnchorTable(source.table, placement.matrix),
        ).length,
      });
    });
  }
  return copies;
}

/** The batch-local handle for copy `i`'s contour `c`. Deterministic, so
 *  the conformance spec asserts the exact emitted wire. Pure. */
export const repeatHandle = (copy: number, contour: number): string =>
  `ri${copy}_${contour}`;

/** The clip frame's batch-local handle. */
export const REPEAT_CLIP_HANDLE = "rclip";

/** A `"$h:<handle>"` reference as an `ElementId` — the v59 seam's helper,
 *  re-exported under this module's name so callers do not reach past it. */
export const handleRef = handleElementId;

// ------------------------------------------------- pure: the container part

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const idListFrom = (v: unknown): { kind: string; id: string }[] => {
  const out: { kind: string; id: string }[] = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const r = (raw ?? {}) as { kind?: unknown; id?: unknown };
    const kind = strOrNull(r.kind);
    const id = strOrNull(r.id);
    if (kind && id) out.push({ kind, id });
  }
  return out;
};

/** Parse the recipe part's bytes. Anything unreadable — absent bytes,
 *  invalid JSON, a future `v` — reads as an EMPTY library: a recipe that
 *  fails to parse must never take the document with it. Pure. */
export function parseRepeatLibrary(bytes: Uint8Array | null): RepeatLibrary {
  if (!bytes || bytes.byteLength === 0) return emptyLibrary();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return emptyLibrary();
  }
  const lib = raw as Partial<RepeatLibrary> | null;
  if (!lib || typeof lib !== "object") return emptyLibrary();
  if (lib.v !== REPEAT_LIBRARY_VERSION) return emptyLibrary();
  const repeats: RepeatRecord[] = [];
  for (const entry of Array.isArray(lib.repeats) ? lib.repeats : []) {
    const r = (entry ?? {}) as Partial<RepeatRecord>;
    if (typeof r.id !== "string" || r.id.length === 0) continue;
    const clip = (r.clipFrame ?? null) as {
      kind?: unknown;
      id?: unknown;
    } | null;
    const clipKind = clip ? strOrNull(clip.kind) : null;
    const clipId = clip ? strOrNull(clip.id) : null;
    repeats.push({
      id: r.id,
      name: typeof r.name === "string" && r.name.length > 0 ? r.name : r.id,
      params: repeatParamsFrom(r.params),
      sources: idListFrom(r.sources),
      instances: idListFrom(r.instances),
      clipFrame: clipKind && clipId ? { kind: clipKind, id: clipId } : null,
    });
  }
  return { v: REPEAT_LIBRARY_VERSION, repeats };
}

/** Serialize the library — indented, because the `spec` role's whole
 *  point is that it stays small and DIFFABLE. */
export function serializeRepeatLibrary(library: RepeatLibrary): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      { v: REPEAT_LIBRARY_VERSION, repeats: library.repeats },
      null,
      2,
    )}\n`,
  );
}

/** The next free `rep-N` id. Deterministic (no randomness — the part is
 *  diffable and the tests are exact). Pure. */
export function mintRepeatId(library: RepeatLibrary): string {
  let max = 0;
  for (const r of library.repeats) {
    const m = /^rep-(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `rep-${max + 1}`;
}

export function findRepeatRecord(
  library: RepeatLibrary,
  id: string,
): RepeatRecord | null {
  return library.repeats.find((r) => r.id === id) ?? null;
}

/** Insert or replace a record (by id), preserving order. Pure. */
export function upsertRepeatRecord(
  library: RepeatLibrary,
  record: RepeatRecord,
): RepeatLibrary {
  const repeats = library.repeats.slice();
  const at = repeats.findIndex((r) => r.id === record.id);
  if (at >= 0) repeats[at] = record;
  else repeats.push(record);
  return { v: REPEAT_LIBRARY_VERSION, repeats };
}

/** Drop a record. An unknown id is a no-op. Pure. */
export function removeRepeatRecordFrom(
  library: RepeatLibrary,
  id: string,
): RepeatLibrary {
  return {
    v: REPEAT_LIBRARY_VERSION,
    repeats: library.repeats.filter((r) => r.id !== id),
  };
}

// ---------------------------------------------- pure: the element links

/** Read the source link out of an envelope, or null. */
export function repeatSourceOf(
  env: PluginMetadataEnvelope | null,
): RepeatSourceRef | null {
  const raw = (env?.data as { repeatSource?: unknown } | undefined)
    ?.repeatSource;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RepeatSourceRef>;
  if (typeof r.repeat !== "string") return null;
  return {
    repeat: r.repeat,
    index:
      typeof r.index === "number" && Number.isFinite(r.index) ? r.index : 0,
  };
}

/** Read the instance link out of an envelope, or null. */
export function repeatInstanceOf(
  env: PluginMetadataEnvelope | null,
): RepeatInstanceRef | null {
  const raw = (env?.data as { repeatInstance?: unknown } | undefined)
    ?.repeatInstance;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RepeatInstanceRef>;
  if (typeof r.repeat !== "string") return null;
  const of = r.of as ElementId | undefined;
  if (!of || typeof of.id !== "string") return null;
  return {
    repeat: r.repeat,
    of,
    index: typeof r.index === "number" ? r.index : 0,
    col: typeof r.col === "number" ? r.col : 0,
    row: typeof r.row === "number" ? r.row : 0,
  };
}

/** Read the clip-frame link out of an envelope, or null. */
export function repeatClipOf(
  env: PluginMetadataEnvelope | null,
): RepeatClipRef | null {
  const raw = (env?.data as { repeatClip?: unknown } | undefined)?.repeatClip;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RepeatClipRef>;
  return typeof r.repeat === "string" ? { repeat: r.repeat } : null;
}

/** Which envelope keys this feature owns. */
export type RepeatKey = "repeatSource" | "repeatInstance" | "repeatClip";

/** Merge (or, with `null`, DROP) a repeat key in an envelope, preserving
 *  every OTHER draw metadata key — expanding a repeat must leave
 *  appearance / graphic-style / symbol / live-paint / pattern records
 *  exactly as they are. Pure. */
export function withRepeatKey(
  prev: PluginMetadataEnvelope | null,
  key: RepeatKey,
  ref: RepeatSourceRef | RepeatInstanceRef | RepeatClipRef | null,
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
// Exported so the conformance spec asserts the EXACT wire shapes the
// live commands emit (no second copy to drift from).

const colorRef = (
  elementId: ElementId,
  path: "frameFillColor" | "frameStrokeColor",
  value: string | null,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "colorRef", value } },
});

const lengthProp = (
  elementId: ElementId,
  path: "frameStrokeWeight",
  value: number,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "length", value } },
});

/** The previous generation a re-plan replaces. Read from the tree AND
 *  the recipe BEFORE the batch is built (a clipped instance is not in
 *  the tree; a group's id is not in the recipe). */
export interface RepeatGeneration {
  group: ElementId | null;
  instances: ElementId[];
  clipFrame: ElementId | null;
  /** Were the instances nested? Then they need `releaseFrom` before
   *  `deleteFrame` (measured refusal, module header consequence 3). */
  clipped: boolean;
}

/**
 * THE BUILD BATCH — Make and Update both ride it, in the ONE order the
 * engine accepts:
 *
 *   1. the CLIP FRAME (when clipping). Its stroke is cleared: an
 *      inserted path defaults to a 1 pt black stroke (measured), and a
 *      clip frame that paints its own outline is a bug, not a feature;
 *   2. every COPY — one `insertPath` + `bindCreated` per contour, the
 *      compound re-merge through the same `framePath` door Make Compound
 *      Path uses, the source's paint and the instance link, ALL
 *      addressing the freshly minted ids by handle;
 *   3. the PREVIOUS generation (Update only) — dissolve its group, then
 *      release-and-delete its instances, then delete its clip frame.
 *      INSERTS RIDE BEFORE DELETES because a batch that deletes and then
 *      inserts is refused ("position N out of range for parent Spread":
 *      the insert's z-position resolves against the spread length the
 *      batch STARTED with);
 *   4. the SOURCE links;
 *   5. the GROUP — only when NOT clipping, because `pasteInto` refuses a
 *      grouped child.
 *
 * ONE batch ⇒ ONE undo step, however many instances. The `pasteInto`
 * that DOES the clipping is deliberately NOT here — see
 * {@link repeatClipBatchFor}.
 */
export function repeatBatchFor(args: {
  plan: RepeatPlan;
  sourceEnvelopes: readonly (PluginMetadataEnvelope | null)[];
  previous?: RepeatGeneration | null;
}): MutationInput {
  const { plan } = args;
  const ops: MutationInput[] = [];
  const clipping = plan.clipRect !== null;

  if (plan.clipRect) {
    ops.push(
      insertPathMutationFor(
        plan.pageId,
        rectAnchorTable(plan.clipRect).anchors,
        false,
      ),
    );
    ops.push(bindCreatedMutationFor(REPEAT_CLIP_HANDLE));
    const clipId = handleRef(REPEAT_CLIP_HANDLE);
    ops.push(colorRef(clipId, "frameStrokeColor", null));
    ops.push(
      stampDrawMetadata(clipId, {
        v: 1,
        data: { repeatClip: { repeat: plan.repeat } satisfies RepeatClipRef },
      }),
    );
  }

  const copies = repeatCopiesFor(plan);
  copies.forEach((copy, copyIndex) => {
    const source = plan.sources[copy.sourceIndex];
    const moved = transformAnchorTable(source.table, copy.placement.matrix);
    const contours = splitCompound(moved);
    contours.forEach((contour, c) => {
      ops.push(
        insertPathMutationFor(
          plan.pageId,
          contour.anchors,
          contour.subpathOpen?.[0] ?? false,
        ),
      );
      ops.push(bindCreatedMutationFor(repeatHandle(copyIndex, c)));
    });
    const keep = handleRef(repeatHandle(copyIndex, 0));
    if (contours.length > 1) {
      // A compound copy came in as N separate paths; put the contours
      // back on the first one and drop the rest — the very same door
      // Make Compound Path uses, now reachable in the SAME batch.
      ops.push(framePathMutationFor(keep, moved));
      for (let c = 1; c < contours.length; c++) {
        ops.push({
          op: "deleteFrame",
          args: { frameId: `$h:${repeatHandle(copyIndex, c)}` },
        });
      }
    }
    ops.push(colorRef(keep, "frameFillColor", source.paint.fill));
    ops.push(colorRef(keep, "frameStrokeColor", source.paint.stroke));
    if (typeof source.paint.weight === "number") {
      ops.push(lengthProp(keep, "frameStrokeWeight", source.paint.weight));
    }
    ops.push(
      stampDrawMetadata(keep, {
        v: 1,
        data: {
          repeatInstance: {
            repeat: plan.repeat,
            of: source.id,
            index: copy.placement.index,
            col: copy.placement.col,
            row: copy.placement.row,
          } satisfies RepeatInstanceRef,
        },
      }),
    );
  });

  const previous = args.previous ?? null;
  if (previous) {
    if (previous.group && typeof previous.group.id === "string") {
      ops.push(ungroupMutationFor(previous.group.id));
    }
    for (const id of previous.instances) {
      if (typeof id.id !== "string") continue;
      if (previous.clipped) ops.push(releaseFromMutationFor(id));
      ops.push({ op: "deleteFrame", args: { frameId: id.id } });
    }
    if (previous.clipFrame && typeof previous.clipFrame.id === "string") {
      ops.push({
        op: "deleteFrame",
        args: { frameId: previous.clipFrame.id },
      });
    }
  }

  plan.sources.forEach((source, index) => {
    ops.push(
      stampDrawMetadata(
        source.id,
        withRepeatKey(args.sourceEnvelopes[index] ?? null, "repeatSource", {
          repeat: plan.repeat,
          index,
        }),
      ),
    );
  });

  if (!clipping && copies.length > 0) {
    ops.push(
      groupMutationFor([
        ...plan.sources.map((s) => s.id),
        ...copies.map((_, i) => handleRef(repeatHandle(i, 0))),
      ]),
    );
  }
  return batchMutationFor(ops);
}

/**
 * THE CLIP BATCH — one `pasteInto` per instance, and the ONE reason
 * this bundle's clipped repeats cost a SECOND undo step.
 *
 * It cannot ride the build batch, and the reason is not a contract skew
 * this time: `pasteInto` is exactly what HIDES an instance from
 * `document.tree()` (measured — the container reports NO children while
 * `getMetadata` / `elementGeometry` / `pathAnchors` all still answer for
 * the child by id). A batch outcome carries ONE `createdId`, so the only
 * honest enumeration of what a multi-insert batch minted is the tree
 * diff — which has to be taken BEFORE the paste. Deriving the ids
 * instead, from the engine's sequential `u<N>` minting, would be reading
 * an id FORMAT the wire never promised.
 *
 * So: an UNCLIPPED repeat is ONE batch and 1 undo step; a CLIPPED one is
 * TWO and 2. Closing that costs a door — anything that lists a
 * container's children, or a batch outcome that reports every created
 * id — and is filed with the C-23 / B-18 pair rather than papered over.
 */
export function repeatClipBatchFor(
  clipFrame: ElementId,
  instances: readonly ElementId[],
): MutationInput {
  return batchMutationFor(
    instances.map((id) => pasteIntoMutationFor(clipFrame, id)),
  );
}

/** The EXPAND batch — stop tracking, keep every piece of artwork. Drops
 *  the source / instance / clip links and nothing else. The clip frame
 *  and its nesting SURVIVE: the nesting IS the clip, and popping the
 *  children out would change what the page looks like, which is not what
 *  "expand" means. ONE batch ⇒ 1 undo step. */
export function repeatExpandBatchFor(
  leaves: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: RepeatKey;
  }[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: leaves.map((leaf) =>
        stampDrawMetadata(
          leaf.id,
          withRepeatKey(leaf.envelope, leaf.key, null),
        ),
      ),
    },
  };
}

/** The RELEASE batch — remove the instances, keep the SOURCE exactly as
 *  it was. In the ONE order the engine accepts (module header):
 *    1. dissolve the group (BEFORE its members are deleted — deleting
 *       first leaves the group holding a hole and the dissolve is
 *       refused with "group has an id-less member that cannot
 *       round-trip");
 *    2. `releaseFrom` every clipped instance (deleteFrame REFUSES a
 *       pasted-in child), then delete it;
 *    3. delete the clip frame LAST (deleting it first ORPHANS its
 *       children — they leave the tree and still answer geometry);
 *    4. unlink the sources.
 *  ONE batch ⇒ 1 undo step. */
export function repeatReleaseBatchFor(args: {
  group?: ElementId | null;
  instances: readonly ElementId[];
  clipped: boolean;
  clipFrame?: ElementId | null;
  sources: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
  }[];
}): MutationInput {
  const ops: MutationInput[] = [];
  if (args.group && typeof args.group.id === "string") {
    ops.push(ungroupMutationFor(args.group.id));
  }
  for (const id of args.instances) {
    if (typeof id.id !== "string") continue;
    if (args.clipped) ops.push(releaseFromMutationFor(id));
    ops.push({ op: "deleteFrame", args: { frameId: id.id } });
  }
  if (args.clipFrame && typeof args.clipFrame.id === "string") {
    ops.push({ op: "deleteFrame", args: { frameId: args.clipFrame.id } });
  }
  for (const source of args.sources) {
    ops.push(
      stampDrawMetadata(
        source.id,
        withRepeatKey(source.envelope, "repeatSource", null),
      ),
    );
  }
  return batchMutationFor(ops);
}

// -------------------------------------------------------- host: the part

type PartsHost = Pick<BundleHost, "parts" | "supports" | "log">;

/** Read the records out of the container part. A host with no container
 *  writer is not an error: it reads as an EMPTY library and WARNS. */
export async function readRepeatLibrary(
  host: PartsHost,
): Promise<RepeatLibrary> {
  if (!host.supports(REPEAT_FEATURE)) {
    host.log.warn(
      "repeat: this host wires no `.paged` container writer " +
        `(supports("${REPEAT_FEATURE}") is false) — a repeat's parameters ` +
        "cannot be saved here, so it can be expanded or released through " +
        "its links but not updated without naming them again, and CLIPPING " +
        "is refused (a clipped instance is invisible to the scene tree, so " +
        "the recipe is its only index)",
    );
    return emptyLibrary();
  }
  try {
    return parseRepeatLibrary(await host.parts.read(REPEAT_PART));
  } catch (e) {
    host.log.warn(`repeat: recipe read failed (${String(e)})`);
    return emptyLibrary();
  }
}

/** Write the records back. `false` = it did not persist (no container
 *  door, or the write was refused) — logged, never thrown. */
export async function writeRepeatLibrary(
  host: PartsHost,
  library: RepeatLibrary,
): Promise<boolean> {
  if (!host.supports(REPEAT_FEATURE)) return false;
  try {
    await host.parts.write(REPEAT_PART, serializeRepeatLibrary(library));
    return true;
  } catch (e) {
    host.log.warn(`repeat: recipe write failed (${String(e)})`);
    return false;
  }
}

// -------------------------------------------------- host: document reads

/** One row of the `pages` collection, narrowed to what the fit needs.
 *  Declared LOCALLY because `@paged-media/plugin-api` re-exports
 *  `SwatchSummary` / `LayerSummary` but NOT `PageSummary`; the door
 *  itself (`document.collection<T>`) is generic and sanctioned. */
interface PageRowWire {
  selfId: string;
  sizePt?: [number, number];
}

/** The page rect a repeat is fitted (and by default clipped) to, or null
 *  when the page is not readable. */
export async function repeatPageRect(
  host: BundleHost,
  pageId: string,
): Promise<RepeatPageRect | null> {
  try {
    const pages = await host.document.collection<PageRowWire>("pages");
    for (const page of pages) {
      if (page?.selfId !== pageId) continue;
      const size = page.sizePt;
      if (!Array.isArray(size) || size.length !== 2) return null;
      if (!(size[0] > 0) || !(size[1] > 0)) return null;
      return { pageId, width: size[0], height: size[1] };
    }
  } catch {
    /* fall through to the honest null */
  }
  return null;
}

/** The union of every id's `elementGeometry` bounds, in page space, as
 *  `[top, left, bottom, right]`. Null when nothing was readable. */
export async function repeatBoundsOf(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<RepeatBounds | null> {
  const items = await host.document.elementGeometry([...ids]).catch(() => []);
  if (items.length === 0) return null;
  let top = Infinity;
  let left = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;
  for (const item of items) {
    const [t, l, b, r] = item.bounds;
    top = Math.min(top, t);
    left = Math.min(left, l);
    bottom = Math.max(bottom, b);
    right = Math.max(right, r);
  }
  if (!Number.isFinite(top) || !Number.isFinite(left)) return null;
  return [top, left, bottom, right];
}

/** Every leaf carrying a repeat link, split by which one — PLUS the
 *  instances the RECIPE names, which is the only way to reach a CLIPPED
 *  one (`document.tree()` does not report a pasted-in child; measured).
 *  `repeat` filters; omit it for every repeat. */
export async function repeatLinks(
  host: BundleHost,
  repeat?: string,
): Promise<{
  sources: { id: ElementId; ref: RepeatSourceRef }[];
  instances: { id: ElementId; ref: RepeatInstanceRef | null }[];
  clipFrames: { id: ElementId; ref: RepeatClipRef }[];
}> {
  const sources: { id: ElementId; ref: RepeatSourceRef }[] = [];
  const instances: { id: ElementId; ref: RepeatInstanceRef | null }[] = [];
  const clipFrames: { id: ElementId; ref: RepeatClipRef }[] = [];
  const seen = new Set<string>();
  const roots = await host.document.tree().catch(() => []);
  for (const id of leafIdsOf(roots)) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const source = repeatSourceOf(env);
    if (source && (repeat === undefined || source.repeat === repeat)) {
      sources.push({ id, ref: source });
    }
    const instance = repeatInstanceOf(env);
    if (instance && (repeat === undefined || instance.repeat === repeat)) {
      instances.push({ id, ref: instance });
      seen.add(String(id.id));
    }
    const clip = repeatClipOf(env);
    if (clip && (repeat === undefined || clip.repeat === repeat)) {
      clipFrames.push({ id, ref: clip });
    }
  }
  // The clipped half: ids the tree cannot show. Read them out of the
  // recipe and keep whichever the engine still answers for.
  const library = await readRepeatLibrary(host);
  for (const record of library.repeats) {
    if (repeat !== undefined && record.id !== repeat) continue;
    for (const entry of record.instances) {
      if (seen.has(entry.id)) continue;
      const id = { kind: entry.kind, id: entry.id } as ElementId;
      const geo = await host.document.elementGeometry([id]).catch(() => []);
      if (geo.length === 0) continue;
      const env = await host.document.getMetadata(id).catch(() => null);
      instances.push({ id, ref: repeatInstanceOf(env) });
      seen.add(entry.id);
    }
  }
  sources.sort((a, b) => a.ref.index - b.ref.index);
  return { sources, instances, clipFrames };
}

/** The group node holding `member`, or null — a BATCH outcome does not
 *  echo an inner `createGroup`'s id, so the tree is the source of truth. */
export async function repeatGroupOf(
  host: BundleHost,
  member: ElementId,
): Promise<ElementId | null> {
  const roots = await host.document.tree().catch(() => []);
  let found: ElementId | null = null;
  const walk = (
    nodes: readonly { id?: ElementId | null; children?: unknown }[],
  ) => {
    for (const node of nodes) {
      const children = (node.children ?? []) as {
        id?: ElementId | null;
        children?: unknown;
      }[];
      if (
        node.id?.kind === "group" &&
        children.some((c) => c.id && c.id.id === member.id)
      ) {
        found = node.id;
        return;
      }
      if (children.length > 0) walk(children);
      if (found) return;
    }
  };
  walk(roots as never);
  return found;
}

/** Which repeat a command acts on: the payload's `repeatId`, else the
 *  selection's own link, else the only repeat the document carries. */
export async function resolveRepeat(
  host: BundleHost,
  repeatId: unknown,
): Promise<string | null> {
  if (typeof repeatId === "string") return repeatId;
  for (const id of host.selection.get()) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const linked =
      repeatSourceOf(env)?.repeat ??
      repeatInstanceOf(env)?.repeat ??
      repeatClipOf(env)?.repeat ??
      null;
    if (linked !== null) return linked;
  }
  const library = await readRepeatLibrary(host);
  if (library.repeats.length === 1) return library.repeats[0]!.id;
  const links = await repeatLinks(host);
  const distinct = new Set([
    ...links.sources.map((s) => s.ref.repeat),
    ...links.instances
      .map((i) => i.ref?.repeat)
      .filter((r): r is string => !!r),
  ]);
  return distinct.size === 1 ? [...distinct][0]! : null;
}

/** The previous generation of `repeat`, read BEFORE a re-plan builds its
 *  batch (the tree for the group, the links + recipe for the rest). */
export async function repeatGenerationOf(
  host: BundleHost,
  repeat: string,
): Promise<RepeatGeneration> {
  const links = await repeatLinks(host, repeat);
  const library = await readRepeatLibrary(host);
  const record = findRepeatRecord(library, repeat);
  const clipFrame =
    links.clipFrames[0]?.id ??
    (record?.clipFrame
      ? ({ kind: record.clipFrame.kind, id: record.clipFrame.id } as ElementId)
      : null);
  const anchor = links.sources[0]?.id ?? links.instances[0]?.id ?? null;
  return {
    group: anchor ? await repeatGroupOf(host, anchor) : null,
    instances: links.instances.map((i) => i.id),
    clipFrame,
    clipped: clipFrame !== null,
  };
}

// ------------------------------------------------------------- planning

/** Resolve sources + params into a plan, or null (a refusal, already
 *  logged). Shared by Make and Update, so both ride the same lane. */
export async function repeatPlanFor(
  host: BundleHost,
  args: {
    repeat: string;
    params: RepeatParams;
    ids: readonly ElementId[];
    label: string;
  },
): Promise<RepeatPlan | null> {
  const { label } = args;
  const ids = args.ids.filter((id) => {
    if (id.kind === "textFrame") {
      host.log.debug(
        `${label}: skipping the text frame ${String(id.id)} — an instance is ` +
          "an insertPath Polygon and cannot carry a story",
      );
      return false;
    }
    return true;
  });
  if (ids.length === 0) {
    host.log.debug(`${label}: nothing repeatable to work from — no-op`);
    return null;
  }
  const bounds = await repeatBoundsOf(host, ids);
  if (!bounds || bounds[3] <= bounds[1] || bounds[2] <= bounds[0]) {
    host.log.warn(`${label}: the sources have no measurable bounds — no-op`);
    return null;
  }
  const sources: RepeatSource[] = [];
  let pageId: string | null = null;
  for (const id of ids) {
    const source = await compoundSourceOf(host, id);
    if (!source) {
      host.log.debug(
        `${label}: ${id.kind} ${String(id.id)} exposes no readable geometry — skipped`,
      );
      continue;
    }
    pageId ??= source.pageId;
    sources.push({
      id,
      table: source.table,
      paint: await compoundPaintOf(host, id),
    });
  }
  if (sources.length === 0 || pageId === null) {
    host.log.warn(`${label}: no source geometry to repeat — no-op`);
    return null;
  }

  let params = args.params;
  if (params.clip && !host.supports(REPEAT_FEATURE)) {
    host.log.warn(
      `${label}: clipping needs the \`.paged\` container writer, because a ` +
        "clipped instance is INVISIBLE to document.tree() and the recipe is " +
        "the only index that could ever find it again. Building this repeat " +
        "UNCLIPPED instead",
    );
    params = { ...params, clip: false };
  }

  const all = repeatPlacementsFor(params, bounds);
  const requested = all.filter((p) => p.index !== 0);
  if (requested.length * sources.length > REPEAT_MAX_INSTANCES) {
    host.log.warn(
      `${label}: ${requested.length} placement(s) over ${sources.length} ` +
        `source(s) is ${requested.length * sources.length} copies — past this ` +
        `plugin's ${REPEAT_MAX_INSTANCES}-copy ceiling. Refused rather than ` +
        "truncated (the engine would accept the batch; the ceiling is here so " +
        "a typo cannot build one that large)",
    );
    return null;
  }

  let page: RepeatPageRect | null = null;
  if (params.fitToArtboard || params.clip) {
    page = await repeatPageRect(host, pageId);
    if (!page && params.fitToArtboard) {
      host.log.warn(
        `${label}: the page rect for "${pageId}" is not readable, so the ` +
          "instance count could not be fitted to the artboard — placing every " +
          "one. An off-page instance IS created, but pathAnchors/" +
          "elementGeometry answer nothing for it (RFI C-23)",
      );
    }
  }
  const fit = fitPlacementsToPage(
    requested,
    bounds,
    params.fitToArtboard ? page : null,
  );
  if (fit.dropped.length > 0) {
    host.log.info(
      `${label}: ${fit.dropped.length} of ${requested.length} instance(s) ` +
        `would land outside the ${page!.width} × ${page!.height} pt page and ` +
        "were dropped — an off-page item is real but page-keyed reads answer " +
        "nothing for it (RFI C-23). Pass fitToArtboard: false to place them " +
        "anyway",
    );
  }

  let clipRect: RepeatBounds | null = null;
  if (params.clip) {
    clipRect =
      params.clipRect ??
      (page ? ([0, 0, page.height, page.width] as RepeatBounds) : null);
    if (!clipRect) {
      host.log.warn(
        `${label}: clipping defaults to the PAGE rect and "${pageId}" is not ` +
          "readable — building this repeat unclipped",
      );
    }
  }

  return {
    pageId,
    repeat: args.repeat,
    params,
    bounds,
    sources,
    placements: fit.placed.filter((p) => p.index !== 0),
    dropped: fit.dropped,
    clipRect,
  };
}

// ------------------------------------------------------------ the emitter

/** What a build produced. `undoSteps` is MEASURED, not claimed: one for
 *  the build batch, plus one for the clip batch when the repeat is
 *  clipped ({@link repeatClipBatchFor} says why). */
export interface RepeatBuild {
  instances: ElementId[];
  clipFrame: ElementId | null;
  undoSteps: number;
}

/** Commit a plan as artwork. Answers the emitted ids, or an empty list
 *  on a refusal (always logged, never thrown — the dash-command
 *  convention). */
async function emitRepeat(
  host: BundleHost,
  args: {
    plan: RepeatPlan;
    label: string;
    previous?: RepeatGeneration | null;
  },
): Promise<RepeatBuild> {
  const { plan, label } = args;
  const empty: RepeatBuild = { instances: [], clipFrame: null, undoSteps: 0 };
  if (plan.placements.length === 0) {
    host.log.warn(
      `${label}: the plan places NO instances (every requested one fell ` +
        "outside the page) — nothing to build",
    );
    return empty;
  }
  const before = new Set(
    leafIdsOf(await host.document.tree().catch(() => [])).map((e) =>
      String(e.id),
    ),
  );
  const sourceEnvelopes = await Promise.all(
    plan.sources.map((s) => host.document.getMetadata(s.id).catch(() => null)),
  );
  const outcome = await host.document.mutate(
    repeatBatchFor({ plan, sourceEnvelopes, previous: args.previous ?? null }),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return empty;
  }
  // Which ids the batch minted. A batch outcome carries ONE `createdId`,
  // so the tree diff is the honest enumeration (the blend.ts /
  // appearance-bake precedent) — and it has to be taken BEFORE any
  // `pasteInto`, which is what makes a clipped instance invisible here.
  const minted = leafIdsOf(await host.document.tree().catch(() => [])).filter(
    (e) => !before.has(String(e.id)),
  );
  const instances: ElementId[] = [];
  let clipFrame: ElementId | null = null;
  for (const id of minted) {
    const env = await host.document.getMetadata(id).catch(() => null);
    if (repeatClipOf(env)?.repeat === plan.repeat) clipFrame = id;
    else if (repeatInstanceOf(env)?.repeat === plan.repeat) instances.push(id);
  }
  let undoSteps = 1;
  if (plan.clipRect && clipFrame && instances.length > 0) {
    const clipped = await host.document.mutate(
      repeatClipBatchFor(clipFrame, instances),
    );
    if (clipped.applied) {
      undoSteps = 2;
    } else {
      host.log.warn(
        `${label}: the instances were built but the clip (pasteInto) was ` +
          `rejected: ${JSON.stringify(clipped.error)} — the repeat stands ` +
          "UNCLIPPED",
      );
      clipFrame = null;
    }
  }
  const group =
    !plan.clipRect && instances.length > 0
      ? await repeatGroupOf(host, instances[0])
      : null;
  await host.selection.set(
    group
      ? [group]
      : clipFrame
        ? [...plan.sources.map((s) => s.id), clipFrame]
        : [...plan.sources.map((s) => s.id), ...instances],
  );
  return { instances, clipFrame, undoSteps };
}

// ------------------------------------------------------------- appliers

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

/**
 * **MAKE** — build a repeat of `kind` from the selection.
 *
 * Payload: any subset of {@link RepeatParams} plus `{ name? }`; `kind`
 * comes from the command, not the payload. ONE batch ⇒ 1 undo step.
 */
export async function applyMakeRepeat(
  host: BundleHost,
  kind: RepeatKind,
  payload?: unknown,
): Promise<ElementId[]> {
  const label =
    kind === "radial"
      ? MAKE_RADIAL_REPEAT_COMMAND_ID
      : kind === "grid"
        ? MAKE_GRID_REPEAT_COMMAND_ID
        : MAKE_MIRROR_REPEAT_COMMAND_ID;
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${label}: nothing selected — no-op`);
    return [];
  }
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const params = { ...repeatParamsFrom(p), kind };
  const library = await readRepeatLibrary(host);
  const repeat = mintRepeatId(library);
  const plan = await repeatPlanFor(host, {
    repeat,
    params,
    ids: selection,
    label,
  });
  if (!plan) return [];

  const built = await emitRepeat(host, { plan, label });
  if (built.instances.length === 0) return [];
  const name =
    nameFor(p, "") ??
    `${kind[0].toUpperCase()}${kind.slice(1)} repeat ${library.repeats.length + 1}`;
  const saved = await writeRepeatLibrary(
    host,
    upsertRepeatRecord(library, {
      id: repeat,
      name,
      params: plan.params,
      sources: plan.sources.map((s) => ({
        kind: s.id.kind,
        id: String(s.id.id),
      })),
      instances: built.instances.map((i) => ({
        kind: i.kind,
        id: String(i.id),
      })),
      clipFrame: built.clipFrame
        ? { kind: built.clipFrame.kind, id: String(built.clipFrame.id) }
        : null,
    }),
  );
  host.log.info(
    `${label}: "${name}" placed ${built.instances.length} instance(s)` +
      `${plan.dropped.length > 0 ? ` (${plan.dropped.length} dropped off-page)` : ""}` +
      `${built.clipFrame ? ", clipped to a frame (so it has NO group — pasteInto refuses a grouped child)" : ""}` +
      ` in ${built.undoSteps} undo step(s). ` +
      (saved
        ? "The parameters are saved, so the repeat can be updated."
        : "The parameters were NOT saved (no container writer) — the repeat " +
          "can be expanded or released, but an update must name them again.") +
      " Editing a source does not move the instances; Update does.",
  );
  return built.instances;
}

/**
 * **UPDATE** — rebuild an existing repeat with new parameters and FRESH
 * source geometry. This is the honest stand-in for "live": editing a
 * source and updating is how a change reaches the instances.
 *
 * Payload: `{ repeatId?, name?, …params }` — anything omitted keeps the
 * saved value. ONE batch ⇒ 1 undo step. Every instance gets a NEW
 * element id, so another plugin's metadata on one does not survive.
 */
export async function applyUpdateRepeat(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = UPDATE_REPEAT_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const repeat = await resolveRepeat(host, p.repeatId);
  if (repeat === null) {
    host.log.warn(
      `${label}: no repeat resolved from the payload or the selection — ` +
        "make one first",
    );
    return [];
  }
  const library = await readRepeatLibrary(host);
  const saved = findRepeatRecord(library, repeat);
  const links = await repeatLinks(host, repeat);
  const sourceIds =
    links.sources.length > 0
      ? links.sources.map((s) => s.id)
      : (saved?.sources.map((s) => ({ kind: s.kind, id: s.id }) as ElementId) ??
        []);
  if (sourceIds.length === 0) {
    host.log.warn(
      `${label}: "${repeat}" names no source elements any more — nothing to ` +
        "update",
    );
    return [];
  }
  const params = repeatParamsFrom(p, saved?.params ?? REPEAT_DEFAULTS);
  const previous = await repeatGenerationOf(host, repeat);
  const plan = await repeatPlanFor(host, {
    repeat,
    params,
    ids: sourceIds,
    label,
  });
  if (!plan) return [];

  const built = await emitRepeat(host, { plan, label, previous });
  if (built.instances.length === 0) return [];
  const name = nameFor(p, "") ?? saved?.name ?? repeat;
  await writeRepeatLibrary(
    host,
    upsertRepeatRecord(library, {
      id: repeat,
      name,
      params: plan.params,
      sources: plan.sources.map((s) => ({
        kind: s.id.kind,
        id: String(s.id.id),
      })),
      instances: built.instances.map((i) => ({
        kind: i.kind,
        id: String(i.id),
      })),
      clipFrame: built.clipFrame
        ? { kind: built.clipFrame.kind, id: String(built.clipFrame.id) }
        : null,
    }),
  );
  host.log.info(
    `${label}: "${name}" updated in ${built.undoSteps} undo step(s) — ` +
      `${previous.instances.length} old instance(s) replaced by ` +
      `${built.instances.length}. The instances carry NEW element ids`,
  );
  return built.instances;
}

/** **SELECT INSTANCES** — put a repeat's instances (or, with
 *  `includeSources`, its sources too) on the selection so the ordinary
 *  tools reach them. No mutation. */
export async function applySelectRepeatInstances(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = SELECT_REPEAT_INSTANCES_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const repeat = await resolveRepeat(host, p.repeatId);
  if (repeat === null) {
    host.log.warn(`${label}: no repeat resolved — no-op`);
    return [];
  }
  const links = await repeatLinks(host, repeat);
  const ids = [
    ...(p.includeSources === true ? links.sources.map((s) => s.id) : []),
    ...links.instances.map((i) => i.id),
  ];
  if (ids.length === 0) {
    host.log.debug(
      `${label}: "${repeat}" has no instances on the page — no-op`,
    );
  }
  await host.selection.set(ids);
  return ids;
}

/**
 * **EXPAND** — Illustrator's verb: stop tracking, keep EVERYTHING. The
 * instances become ordinary paths, the group (if any) stays a group and
 * a clip frame stays a clip frame. ONE batch ⇒ 1 undo step for every
 * link together (the recipe removal is not undoable).
 */
export async function applyExpandRepeat(
  host: BundleHost,
  payload?: unknown,
): Promise<boolean> {
  const label = EXPAND_REPEAT_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const repeat = await resolveRepeat(host, p.repeatId);
  if (repeat === null) {
    host.log.warn(`${label}: no repeat resolved — no-op`);
    return false;
  }
  const links = await repeatLinks(host, repeat);
  const library = await readRepeatLibrary(host);
  if (
    links.sources.length === 0 &&
    links.instances.length === 0 &&
    links.clipFrames.length === 0 &&
    !findRepeatRecord(library, repeat)
  ) {
    host.log.warn(
      `${label}: "${repeat}" names neither a recipe nor any linked artwork — no-op`,
    );
    return false;
  }
  const leaves: {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: RepeatKey;
  }[] = [];
  for (const source of links.sources) {
    leaves.push({
      id: source.id,
      envelope: await host.document.getMetadata(source.id).catch(() => null),
      key: "repeatSource",
    });
  }
  for (const instance of links.instances) {
    leaves.push({
      id: instance.id,
      envelope: await host.document.getMetadata(instance.id).catch(() => null),
      key: "repeatInstance",
    });
  }
  for (const clip of links.clipFrames) {
    leaves.push({
      id: clip.id,
      envelope: await host.document.getMetadata(clip.id).catch(() => null),
      key: "repeatClip",
    });
  }
  if (leaves.length > 0) {
    const outcome = await host.document.mutate(repeatExpandBatchFor(leaves));
    if (!outcome.applied) {
      host.log.warn(
        `${label}: unlink rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      return false;
    }
  }
  await writeRepeatLibrary(host, removeRepeatRecordFrom(library, repeat));
  host.log.info(
    `${label}: "${repeat}" expanded — ${links.sources.length} source(s), ` +
      `${links.instances.length} instance(s) and ${links.clipFrames.length} ` +
      "clip frame(s) keep their artwork; nothing tracks them any more",
  );
  return true;
}

/**
 * **RELEASE** — Illustrator's other verb: remove the instances and the
 * clip frame, keep the SOURCE exactly as it was. ONE batch ⇒ 1 undo step
 * (the recipe removal itself is not undoable).
 */
export async function applyReleaseRepeat(
  host: BundleHost,
  payload?: unknown,
): Promise<number> {
  const label = RELEASE_REPEAT_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const repeat = await resolveRepeat(host, p.repeatId);
  if (repeat === null) {
    host.log.warn(`${label}: no repeat resolved — no-op`);
    return 0;
  }
  const links = await repeatLinks(host, repeat);
  if (links.instances.length === 0 && links.sources.length === 0) {
    host.log.debug(`${label}: "${repeat}" has no linked artwork — no-op`);
    return 0;
  }
  const sources: { id: ElementId; envelope: PluginMetadataEnvelope | null }[] =
    [];
  for (const source of links.sources) {
    sources.push({
      id: source.id,
      envelope: await host.document.getMetadata(source.id).catch(() => null),
    });
  }
  const generation = await repeatGenerationOf(host, repeat);
  const outcome = await host.document.mutate(
    repeatReleaseBatchFor({
      group: generation.group,
      instances: generation.instances,
      clipped: generation.clipped,
      clipFrame: generation.clipFrame,
      sources,
    }),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return 0;
  }
  await writeRepeatLibrary(
    host,
    removeRepeatRecordFrom(await readRepeatLibrary(host), repeat),
  );
  await host.selection.set(links.sources.map((s) => s.id));
  host.log.info(
    `${label}: "${repeat}" released — ${generation.instances.length} ` +
      `instance(s) removed; ${links.sources.length} source(s) kept exactly ` +
      "as they are",
  );
  return generation.instances.length;
}

// ------------------------------------------------------------- commands

/** Register the seven repeat commands. Every title carries what the
 *  contract has no description field to say — in particular that an
 *  instance is ARTWORK rebuilt by Update, not a live link
 *  ({@link REPEAT_LIVE_NOTE}).
 *
 *  Payloads: make `{ name?, …params }`, update `{ repeatId?, name?,
 *  …params }`, select `{ repeatId?, includeSources? }`, expand /
 *  release `{ repeatId? }`. */
export function contributeRepeatCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: MAKE_RADIAL_REPEAT_COMMAND_ID,
      title:
        "Repeat: Radial from selection (instances around a ring — artwork rebuilt by Update, not a live link)",
      category: REPEAT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyMakeRepeat(host, "radial", payload).then(() => undefined),
    }),
    host.contribute.command({
      id: MAKE_GRID_REPEAT_COMMAND_ID,
      title:
        "Repeat: Grid from selection (rows × columns, spacing, flip — artwork rebuilt by Update, not a live link)",
      category: REPEAT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyMakeRepeat(host, "grid", payload).then(() => undefined),
    }),
    host.contribute.command({
      id: MAKE_MIRROR_REPEAT_COMMAND_ID,
      title:
        "Repeat: Mirror from selection (one reflection across an axis — artwork rebuilt by Update, not a live link)",
      category: REPEAT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyMakeRepeat(host, "mirror", payload).then(() => undefined),
    }),
    host.contribute.command({
      id: UPDATE_REPEAT_COMMAND_ID,
      title:
        "Repeat: Update (new parameters + the sources' CURRENT geometry; the instances get new ids)",
      category: REPEAT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyUpdateRepeat(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: SELECT_REPEAT_INSTANCES_COMMAND_ID,
      title: "Repeat: Select the instances",
      category: REPEAT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applySelectRepeatInstances(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: EXPAND_REPEAT_COMMAND_ID,
      title: "Repeat: Expand (keep every instance as ordinary artwork)",
      category: REPEAT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyExpandRepeat(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: RELEASE_REPEAT_COMMAND_ID,
      title: "Repeat: Release (remove the instances, keep the source)",
      category: REPEAT_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReleaseRepeat(host, payload).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
