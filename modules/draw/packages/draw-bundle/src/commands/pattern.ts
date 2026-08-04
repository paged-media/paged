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

// PATTERN EDITING v1 — A RE-EDITABLE TILE FIELD. NOT A PATTERN SWATCH.
// Read this whole header before reading the code, and before believing
// the feature name.
//
// ------------------------------------------------ the hard boundary
// "SAVE AS A PATTERN SWATCH" IS NOT BUILDABLE ON THIS ENGINE, and v1
// does not fake it. IDML gives a page item a `FillColor` that resolves
// to a Color / Gradient / Mixed-Ink swatch. There is no pattern paint
// type in the FORMAT, none in `paged_model::Graphic`, and none on the
// WIRE — `SwatchSpec` and `GradientSpec` are the only two shapes
// `createSwatch` / `createGradient` accept. Inventing a third swatch
// kind would render nothing and lie on save, which is the same wall
// `commands/group.ts` records for clipping masks. Filed as RFI **C-31**:
// closing it is a new paint kind in the engine, renderer support for it,
// AND an IDML representation decision — core work, not a plugin gap.
//
// So v1 delivers the EDITING MODE, not the swatch. What it does deliver
// is everything the catalog row asks for EXCEPT the swatch: real
// parameters (grid / brick / hex layout, tile size, spacing, overlap
// order, copy counts, dimming), an artboard-aware tile count, and a
// field you can re-plan, release or un-bake without reaching for undo.
//
// ----------------------------------------------- what v1 fixes in v0
// v0 was a fixed 3 × 3 step-and-repeat with the parameters hard-coded
// (`PATTERN_SPACING_PT` / `PATTERN_COLUMNS` / `PATTERN_ROWS`), no
// payload, no release and no re-edit. Its four measured ceilings and
// their v1 answers:
//   1. FIXED GRID → `PatternParams`: `layout` (grid / brick / hex),
//      `tile` size, `spacing` (NEGATIVE = geometric overlap), `columns`
//      × `rows`, `offset` (the brick/hex row shift), `dim`, and
//      `overlap` (which copy paints in FRONT — see below). Every knob
//      arrives on the command payload and is persisted in the recipe.
//   2. NOT ARTBOARD-AWARE → `fitToArtboard` (default ON). The page
//      RECT is readable: `host.document.collection("pages")` reports
//      each page's `sizePt`, so the lattice is filtered to the tiles
//      that land fully inside the page and the dropped ones are
//      REPORTED. v0's residual — a tile stepping past the page is
//      created and grouped but answers NOTHING to `pathAnchors` /
//      `elementGeometry`, because both doors are page-keyed (RFI C-23)
//      — is now reachable only by asking for it (`fitToArtboard:
//      false`), and the conformance spec still pins it there.
//   3. NO RELEASE, NO RE-EDIT → four more commands: Re-plan (new
//      parameters, fresh source geometry), Release (drop the recipe,
//      keep the artwork), Delete tiles (un-bake: remove the copies,
//      keep the sources) and Select tiles.
//   4. TEXT FRAMES / POLYGON COPIES → unchanged and still stated: a
//      text frame is REFUSED with a diagnostic (no wire op copies a
//      story; `insertPath` mints Polygons), and every copy is a Polygon
//      carrying GEOMETRY + PAINT only.
//
// -------------------------------------------- what the parameters mean
// TILE SIZE defaults to the SELECTION BOUNDS. `spacing` is the gutter
// added to it on each axis; a NEGATIVE spacing is a real geometric
// overlap. `offset` is the fraction of the horizontal step that odd
// ROWS are shifted by (brick and hex; 0.5 = a half-drop). `hex`
// additionally scales the VERTICAL step by `HEX_ROW_FACTOR` (√3/2), so
// tile centres form a triangular lattice rather than a squashed grid.
//
// `overlap` is the OTHER thing Illustrator's Pattern Options means by
// that word: not "how much" (that is negative spacing) but WHICH COPY
// PAINTS IN FRONT. It is expressible here for exactly one reason —
// insertion order IS paint order, because `insertPath` lands an item at
// the TOP of the page's z-order and the `Mutation` union carries no
// reorder op at all (the same insert-lane wall RFI C-30 records). So
// `overlap` is implemented as the EMISSION ORDER of the tiles, and two
// facts follow that cannot be softened:
//   · the VERTICAL choice is the OUTER sort and therefore WINS wherever
//     the two disagree (rows are the outer loop);
//   · the SOURCE always sits BELOW every copy. It was there first and
//     nothing can move it up. Illustrator would let the source tile be
//     in front; here it cannot be.
//
// `dim` is the catalog's "dimming": a `frameOpacity` percentage written
// on every COPY (the sources keep their own opacity). It is a REAL
// document property, not an editor-mode overlay — Illustrator dims the
// copies only while the pattern editor is open, and this engine has no
// such mode, so v1 writes what it means and says so.
//
// ------------------------------------------------------ the two shapes
// THE RECIPE (one container part, `paged/media.paged.draw/pattern.json`,
// declared in `contributes.partTypes` as `{ type: "patternRecipe",
// role: "spec", format: "json" }` — the graphic-styles / symbols /
// live-paint convention):
//
//   { "v": 1, "fields": [ { "id": "pat-1", "name": "Pattern 1",
//       "params": { "layout": "brick", … },
//       "sources": [ { "kind": "polygon", "id": "uinner" } ] } ] }
//
// `sources` is ORDERED and the order is the one the copies are emitted
// in; `fields` is an ARRAY, not a map, so the part stays deterministic
// and diffable.
//
// THE LINKS (on each leaf's own `x-paged:media.paged.draw` envelope,
// alongside `appearance` / `graphicStyle` / `symbolInstance` /
// `livePaintMember`):
//   data.patternSource = { pattern: "pat-1", index: 0 }
//   data.patternTile   = { pattern: "pat-1", of: <ElementId>, col, row }
// The links are what Release / Re-plan / Delete tiles walk, so a field
// stays editable even on a host with no container writer — only its
// PARAMETERS are lost there, and that degrade is logged at WARN.
// A v0 `patternTile` stamp (which carried no `pattern` field) reads as
// the LEGACY field id `""` and is still releasable and un-bakeable.
//
// ------------------------------ MUTATION / UNDO SHAPE (all measured)
// Probed against the booted engine (protocol 58) — the RFI C-15 rule:
// assert the real count, never claim "one undo".
//   · Make        = TWO batches ⇒ 2 undo steps. Batch 1 inserts every
//                   copy's contours; batch 2 re-merges the compound
//                   ones, paints, dims, stamps and groups.
//   · Re-plan     = TWO batches ⇒ 2 undo steps. Same split; batch 2
//                   additionally dissolves the old group and deletes
//                   the old tiles FIRST.
//   · Release     = ONE batch ⇒ 1 undo step (every link dropped
//                   together; the recipe removal is not undoable).
//   · Delete tiles= ONE batch ⇒ 1 undo step.
//   · Select tiles= no mutation.
// TWO is the FLOOR for anything that inserts, and the floor is a
// CONTRACT floor rather than an engine one — measured, both halves:
//   (a) the booted engine DOES speak C-15. `bindCreated` is in its op
//       vocabulary AND resolves end-to-end: `{ op: "bindCreated", args:
//       { handle } }` placed AFTER a creating child makes `$h:<handle>`
//       address that child's minted id (placed BEFORE, the engine
//       refuses with "has nothing to name — no creating child ran
//       before it in this batch").
//   (b) `@paged-media/plugin-api`'s `Mutation` union carries NO
//       `bindCreated` arm, and neither does the protocol-ahead
//       `PendingMutation` delta plugin-sdk HEAD maintains (re-checked
//       at `f00d6dd`, and in the published `0.2.25-canary.0` this repo
//       installs).
// So the bundle stays at two batches by CONTRACT DISCIPLINE, not
// because the engine cannot do better. Re-check when the contract bumps
// — this is one file and one merge away from one undo step.
//
// TWO MORE ORDERING FACTS, both measured against the engine and both
// load-bearing for the re-plan path:
//   · A batch that DELETES and then INSERTS is REFUSED ("position N out
//     of range for parent Spread"): the insert's z-position resolves
//     against the spread length the batch STARTED with. So every insert
//     rides batch 1 and every delete rides batch 2 (the symbols.ts /
//     live-paint.ts finding, re-verified here).
//   · Inside batch 2 the group must be DISSOLVED BEFORE its members are
//     deleted. Deleting first leaves the group holding a hole and the
//     dissolve is refused with the engine's own sentence: "group has an
//     id-less member that cannot round-trip".
//
// ------------------------------------------------------------- limits
// · IT IS STILL A BAKE, not a live fill. The tiles are real page items;
//   the result cannot be applied to another object as a paint. Editing
//   a source does not update the tiles by itself — RE-PLAN does (it
//   re-reads the sources' geometry and paint), which is the honest
//   stand-in for "edit the tile in place".
// · Z-ORDER: everything inserted lands at the TOP of the page's
//   z-order. See `overlap` above for what that costs.
// · THE RECIPE IS NOT UNDOABLE. `host.parts.write` is a container
//   write, not an engine `Mutation` (probed in the graphic-styles spec).
// · RE-PLAN MINTS NEW ELEMENT IDS for every tile, so another plugin's
//   metadata on a tile does not survive one.
// · COMPOUND SOURCES ARE SUPPORTED: `insertPath` carries ONE contour,
//   so a ring is inserted as its contours and re-merged in batch 2
//   through the very same `framePath` door Make Compound Path uses.
// · The engine reports page SIZE, not a page ORIGIN (`PageSummary` has
//   `sizePt` and no origin), so page space is taken to start at (0, 0)
//   — measured: an item at negative coordinates belongs to no page, and
//   an item whose top-left is inside one does.
// · `PATTERN_MAX_TILES` REFUSES an oversized field rather than emitting
//   thousands of `insertPath` ops.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import { splitCompound, type AnchorTable } from "@paged-media/draw-geometry";

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

export const PATTERN_COMMAND_CATEGORY = "Pattern";

export const MAKE_PATTERN_COMMAND_ID =
  "media.paged.draw.command.makePatternFromSelection";
export const EDIT_PATTERN_COMMAND_ID =
  "media.paged.draw.command.editPatternField";
export const SELECT_PATTERN_TILES_COMMAND_ID =
  "media.paged.draw.command.selectPatternTiles";
export const DELETE_PATTERN_TILES_COMMAND_ID =
  "media.paged.draw.command.deletePatternTiles";
export const RELEASE_PATTERN_COMMAND_ID =
  "media.paged.draw.command.releasePatternField";

/** The contributed command ids, in registration order. */
export const PATTERN_COMMAND_IDS = [
  MAKE_PATTERN_COMMAND_ID,
  EDIT_PATTERN_COMMAND_ID,
  SELECT_PATTERN_TILES_COMMAND_ID,
  DELETE_PATTERN_TILES_COMMAND_ID,
  RELEASE_PATTERN_COMMAND_ID,
];

/** The container part the recipes live in, RELATIVE to this plugin's
 *  `paged/media.paged.draw/` namespace (the host prepends it). */
export const PATTERN_PART = "pattern.json";

/** The recipe envelope version (an unknown version reads as an EMPTY
 *  library rather than a crash — the graphic-styles convention). */
export const PATTERN_LIBRARY_VERSION = 1;

/** The capability the PARAMETER persistence rides. The links (and so
 *  Release / Delete tiles) do not need it. */
export const PATTERN_FEATURE = "storage.parts@1";

/** The field id a v0 `patternTile` stamp (which carried none) reads as.
 *  Releasable and un-bakeable; not re-plannable, because v0 stored no
 *  parameters anywhere a v1 reader can find. */
export const PATTERN_LEGACY_FIELD = "";

/** How many tiles one field may emit. The engine has no cap of its own
 *  here — this one exists so a fat-fingered `columns: 500` REFUSES
 *  instead of building a 250,000-op batch. */
export const PATTERN_MAX_TILES = 400;

/** Hex layout's vertical-step factor: √3/2, so tile CENTRES sit on a
 *  triangular lattice instead of a squashed grid. */
export const HEX_ROW_FACTOR = Math.sqrt(3) / 2;

/** v0's fixed parameters, kept as v1's DEFAULTS (a bake with no payload
 *  reproduces exactly what v0 produced, artboard fitting aside). */
export const PATTERN_COLUMNS = 3;
export const PATTERN_ROWS = 3;
/** Default gutter between tiles, pt. The step is `tile + spacing`. */
export const PATTERN_SPACING_PT = 6;

/** The sentence that states the hard boundary. Exported so the panel
 *  shows it and the conformance spec pins the WORDING — an honesty note
 *  that can be edited away silently is not a guarantee. */
export const PATTERN_SWATCH_NOTE =
  "THIS IS NOT A PATTERN SWATCH, and one cannot be built on this engine. " +
  "IDML gives a page item a FillColor that resolves to a Color, Gradient or " +
  "Mixed-Ink swatch; there is no pattern paint type in the format, none in " +
  "the engine's Graphic model, and none on the wire — SwatchSpec and " +
  "GradientSpec are the only two shapes createSwatch/createGradient accept. " +
  "Inventing a third kind would render nothing and lie on save. So what a " +
  "field here produces is ARTWORK: real page items you can re-plan, release " +
  "or delete, but NOT a fill you can apply to another object. Closing that " +
  "gap needs a new paint kind in the engine, renderer support for it and an " +
  "IDML representation decision — filed as RFI C-31.";

// ---------------------------------------------------------------- model

/** The tile lattice. `grid` is a plain step-and-repeat; `brick` shifts
 *  odd ROWS by `offset × stepX`; `hex` does the same AND scales the
 *  vertical step by {@link HEX_ROW_FACTOR}. */
export type PatternLayout = "grid" | "brick" | "hex";

/** Which copy paints in FRONT where tiles overlap — implemented as the
 *  EMISSION ORDER, because insertion order is the only z-control the
 *  wire offers (module header). `vertical` is the outer sort and wins. */
export interface PatternOverlapOrder {
  horizontal: "leftInFront" | "rightInFront";
  vertical: "topInFront" | "bottomInFront";
}

/** Everything the catalog row asks a pattern editor to expose, except
 *  the swatch (which is not buildable — module header). */
export interface PatternParams {
  layout: PatternLayout;
  /** Tile size in pt `[w, h]`, BEFORE spacing. `null` = the selection
   *  bounds, which is what v0 always used. */
  tile: [number, number] | null;
  /** Gutter in pt `[x, y]`. NEGATIVE values are a real overlap. */
  spacing: [number, number];
  columns: number;
  rows: number;
  /** Odd-row shift as a fraction of the horizontal step (brick + hex). */
  offset: number;
  /** Copy dimming, 0–100 % — written as `frameOpacity` on every COPY. */
  dim: number;
  overlap: PatternOverlapOrder;
  /** Drop tiles that would not land fully inside the page (RFI C-23). */
  fitToArtboard: boolean;
}

export const PATTERN_DEFAULTS: PatternParams = {
  layout: "grid",
  tile: null,
  spacing: [PATTERN_SPACING_PT, PATTERN_SPACING_PT],
  columns: PATTERN_COLUMNS,
  rows: PATTERN_ROWS,
  offset: 0.5,
  dim: 100,
  overlap: { horizontal: "rightInFront", vertical: "bottomInFront" },
  fitToArtboard: true,
};

/** One saved field — the RECIPE, not the artwork. */
export interface PatternField {
  /** Stable, library-local id (`pat-1`, `pat-2`, …). */
  id: string;
  name: string;
  params: PatternParams;
  /** The ORDERED source ids the copies are emitted from. */
  sources: { kind: string; id: string }[];
}

/** Every field — one container part. */
export interface PatternLibrary {
  v: number;
  fields: PatternField[];
}

/** The link a SOURCE leaf carries. */
export interface PatternSourceRef {
  pattern: string;
  index: number;
}

/** The link one materialised TILE carries. */
export interface PatternTileRef {
  pattern: string;
  of: ElementId;
  col: number;
  row: number;
}

const emptyLibrary = (): PatternLibrary => ({
  v: PATTERN_LIBRARY_VERSION,
  fields: [],
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

const LAYOUTS: readonly PatternLayout[] = ["grid", "brick", "hex"];

/** Merge a loose payload over a base (the defaults, or a saved field's
 *  params). Every value is clamped to something the plan can use, so a
 *  hostile payload degrades rather than producing a broken batch. Pure. */
export function patternParamsFrom(
  raw: unknown,
  base: PatternParams = PATTERN_DEFAULTS,
): PatternParams {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const layout = LAYOUTS.includes(p.layout as PatternLayout)
    ? (p.layout as PatternLayout)
    : base.layout;
  const tile =
    p.tile === null
      ? null
      : p.tile === undefined
        ? base.tile
        : pair(p.tile, base.tile ?? [0, 0]);
  const overlapRaw = (p.overlap ?? {}) as Record<string, unknown>;
  return {
    layout,
    tile: tile && tile[0] > 0 && tile[1] > 0 ? tile : null,
    spacing: pair(p.spacing, base.spacing),
    columns: Math.max(1, Math.round(num(p.columns, base.columns))),
    rows: Math.max(1, Math.round(num(p.rows, base.rows))),
    offset: Math.min(1, Math.max(0, num(p.offset, base.offset))),
    dim: Math.min(100, Math.max(0, num(p.dim, base.dim))),
    overlap: {
      horizontal:
        overlapRaw.horizontal === "leftInFront" ||
        overlapRaw.horizontal === "rightInFront"
          ? overlapRaw.horizontal
          : base.overlap.horizontal,
      vertical:
        overlapRaw.vertical === "topInFront" ||
        overlapRaw.vertical === "bottomInFront"
          ? overlapRaw.vertical
          : base.overlap.vertical,
    },
    fitToArtboard:
      typeof p.fitToArtboard === "boolean"
        ? p.fitToArtboard
        : base.fitToArtboard,
  };
}

// ------------------------------------------------------- pure: the plan

/** Page-space bounds, `[top, left, bottom, right]` as the engine reports
 *  them, kept named so the fitting rule reads like the sentence it is. */
export interface PatternBounds {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The page rectangle a field is fitted into. The engine reports SIZE
 *  only, so the origin is (0, 0) — see the module header. */
export interface PatternPageRect {
  pageId: string;
  width: number;
  height: number;
}

/** One tile cell. `(0, 0)` is the SELECTION itself and is never emitted
 *  — it is already on the page. */
export interface PatternTile {
  col: number;
  row: number;
  /** Page-space translation applied to the source geometry. */
  offset: [number, number];
}

/** One source element's contribution to the field. */
export interface PatternSource {
  id: ElementId;
  /** PAGE-space contours (compound sources keep all of theirs). */
  table: AnchorTable;
  paint: CompoundPaint;
}

/** Everything the two batches need, resolved once. Pure data — the
 *  conformance spec builds one by hand. */
export interface PatternPlan {
  pageId: string;
  field: string;
  params: PatternParams;
  step: [number, number];
  bounds: PatternBounds;
  sources: PatternSource[];
  /** The tiles that will be emitted, in PAINT (= insertion) order. */
  tiles: PatternTile[];
  /** The tiles the artboard fit removed — reported, never silent. */
  dropped: PatternTile[];
}

/** One inserted copy: which tile, which source, and how many contours
 *  it took (a compound source inserts one path per contour, re-merged
 *  in batch 2). */
export interface PatternCopy {
  tile: PatternTile;
  sourceIndex: number;
  contours: number;
}

/** The step between tile origins, `tile size + spacing`, with hex's
 *  vertical compression applied. Pure. */
export function patternStepFor(
  params: PatternParams,
  size: readonly [number, number],
): [number, number] {
  const tile = params.tile ?? [size[0], size[1]];
  const x = tile[0] + params.spacing[0];
  const y = tile[1] + params.spacing[1];
  return [x, params.layout === "hex" ? y * HEX_ROW_FACTOR : y];
}

/** Sort tiles into PAINT order: the last one emitted paints on top, so
 *  the "in front" choice is a sort direction. `vertical` is the OUTER
 *  key and therefore wins where the two disagree. Pure. */
export function orderPatternTiles(
  tiles: readonly PatternTile[],
  overlap: PatternOverlapOrder,
): PatternTile[] {
  const rowSign = overlap.vertical === "bottomInFront" ? 1 : -1;
  const colSign = overlap.horizontal === "rightInFront" ? 1 : -1;
  return [...tiles].sort(
    (a, b) => rowSign * (a.row - b.row) || colSign * (a.col - b.col),
  );
}

/** The `columns × rows` lattice MINUS cell (0,0), in PAINT order. Pure —
 *  no host, no page, no clamping (that is {@link fitTilesToPage}). */
export function patternTilesFor(
  params: PatternParams,
  step: readonly [number, number],
): PatternTile[] {
  const tiles: PatternTile[] = [];
  for (let row = 0; row < params.rows; row++) {
    const shift =
      params.layout === "grid" ? 0 : (row % 2) * params.offset * step[0];
    for (let col = 0; col < params.columns; col++) {
      if (col === 0 && row === 0) continue;
      tiles.push({
        col,
        row,
        offset: [col * step[0] + shift, row * step[1]],
      });
    }
  }
  return orderPatternTiles(tiles, params.overlap);
}

/** The ARTBOARD-AWARE tile count (v0's named residual, closed). A tile
 *  survives when the source bounds, translated by its offset, land
 *  FULLY inside the page rect. A `null` page (unreadable — the honest
 *  degrade) keeps every tile and the caller warns. Pure. */
export function fitTilesToPage(
  tiles: readonly PatternTile[],
  bounds: PatternBounds,
  page: PatternPageRect | null,
): { placed: PatternTile[]; dropped: PatternTile[] } {
  if (!page) return { placed: [...tiles], dropped: [] };
  const placed: PatternTile[] = [];
  const dropped: PatternTile[] = [];
  for (const tile of tiles) {
    const [dx, dy] = tile.offset;
    const fits =
      bounds.left + dx >= 0 &&
      bounds.top + dy >= 0 &&
      bounds.right + dx <= page.width &&
      bounds.bottom + dy <= page.height;
    (fits ? placed : dropped).push(tile);
  }
  return { placed, dropped };
}

/** The copies a plan produces, in INSERTION order (tile-major). */
export function patternCopiesFor(plan: PatternPlan): PatternCopy[] {
  const copies: PatternCopy[] = [];
  for (const tile of plan.tiles) {
    plan.sources.forEach((source, sourceIndex) => {
      copies.push({
        tile,
        sourceIndex,
        contours: splitCompound(source.table).length,
      });
    });
  }
  return copies;
}

/** Translate a page-space table. */
export function offsetTable(
  table: AnchorTable,
  dx: number,
  dy: number,
): AnchorTable {
  const shift = (p: readonly [number, number]): [number, number] => [
    p[0] + dx,
    p[1] + dy,
  ];
  return {
    anchors: table.anchors.map((a) => ({
      anchor: shift(a.anchor),
      left: shift(a.left),
      right: shift(a.right),
    })),
    subpathStarts: [...table.subpathStarts],
    subpathOpen: table.subpathOpen ? [...table.subpathOpen] : undefined,
  };
}

// ------------------------------------------------- pure: the container part

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** Parse the recipe part's bytes. Anything unreadable — absent bytes,
 *  invalid JSON, a future `v` — reads as an EMPTY library: a recipe that
 *  fails to parse must never take the document with it. Pure. */
export function parsePatternLibrary(bytes: Uint8Array | null): PatternLibrary {
  if (!bytes || bytes.byteLength === 0) return emptyLibrary();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return emptyLibrary();
  }
  const lib = raw as Partial<PatternLibrary> | null;
  if (!lib || typeof lib !== "object") return emptyLibrary();
  if (lib.v !== PATTERN_LIBRARY_VERSION) return emptyLibrary();
  const fields: PatternField[] = [];
  for (const entry of Array.isArray(lib.fields) ? lib.fields : []) {
    const f = (entry ?? {}) as Partial<PatternField>;
    if (typeof f.id !== "string" || f.id.length === 0) continue;
    const sources: { kind: string; id: string }[] = [];
    for (const rawSource of Array.isArray(f.sources) ? f.sources : []) {
      const s = (rawSource ?? {}) as { kind?: unknown; id?: unknown };
      const kind = strOrNull(s.kind);
      const id = strOrNull(s.id);
      if (kind && id) sources.push({ kind, id });
    }
    fields.push({
      id: f.id,
      name: typeof f.name === "string" && f.name.length > 0 ? f.name : f.id,
      params: patternParamsFrom(f.params),
      sources,
    });
  }
  return { v: PATTERN_LIBRARY_VERSION, fields };
}

/** Serialize the library — indented, because the `spec` role's whole
 *  point is that it stays small and DIFFABLE. */
export function serializePatternLibrary(library: PatternLibrary): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      { v: PATTERN_LIBRARY_VERSION, fields: library.fields },
      null,
      2,
    )}\n`,
  );
}

/** The next free `pat-N` id. Deterministic (no randomness — the part is
 *  diffable and the tests are exact). Pure. */
export function mintPatternId(library: PatternLibrary): string {
  let max = 0;
  for (const f of library.fields) {
    const m = /^pat-(\d+)$/.exec(f.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `pat-${max + 1}`;
}

export function findPatternField(
  library: PatternLibrary,
  id: string,
): PatternField | null {
  return library.fields.find((f) => f.id === id) ?? null;
}

/** Insert or replace a field (by id), preserving order. Pure. */
export function upsertPatternField(
  library: PatternLibrary,
  field: PatternField,
): PatternLibrary {
  const fields = library.fields.slice();
  const at = fields.findIndex((f) => f.id === field.id);
  if (at >= 0) fields[at] = field;
  else fields.push(field);
  return { v: PATTERN_LIBRARY_VERSION, fields };
}

/** Drop a field. An unknown id is a no-op. Pure. */
export function removePatternFieldFrom(
  library: PatternLibrary,
  id: string,
): PatternLibrary {
  return {
    v: PATTERN_LIBRARY_VERSION,
    fields: library.fields.filter((f) => f.id !== id),
  };
}

// ---------------------------------------------- pure: the element links

/** Read the source link out of an envelope, or null. Tolerant of
 *  partial/foreign shapes (the `appearanceBakeOf` convention). */
export function patternSourceOf(
  env: PluginMetadataEnvelope | null,
): PatternSourceRef | null {
  const raw = (env?.data as { patternSource?: unknown } | undefined)
    ?.patternSource;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PatternSourceRef>;
  if (typeof r.pattern !== "string") return null;
  return {
    pattern: r.pattern,
    index: typeof r.index === "number" && Number.isFinite(r.index) ? r.index : 0,
  };
}

/** Read the tile link out of an envelope, or null. A v0 stamp carried
 *  no `pattern` field; it reads as {@link PATTERN_LEGACY_FIELD} so an
 *  already-baked document is still releasable and un-bakeable. */
export function patternTileOf(
  env: PluginMetadataEnvelope | null,
): PatternTileRef | null {
  const raw = (env?.data as { patternTile?: unknown } | undefined)?.patternTile;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PatternTileRef>;
  const of = r.of as ElementId | undefined;
  if (!of || typeof of.id !== "string") return null;
  return {
    pattern: typeof r.pattern === "string" ? r.pattern : PATTERN_LEGACY_FIELD,
    of,
    col: typeof r.col === "number" ? r.col : 0,
    row: typeof r.row === "number" ? r.row : 0,
  };
}

/** Merge (or, with `null`, DROP) a pattern key in an envelope,
 *  preserving every other draw metadata key — releasing a field must
 *  leave appearance / graphic-style / symbol / live-paint records
 *  exactly as they are. Pure. */
export function withPatternKey(
  prev: PluginMetadataEnvelope | null,
  key: "patternSource" | "patternTile",
  ref: PatternSourceRef | PatternTileRef | null,
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

/** BATCH 1 — one `insertPath` per copy per contour, in the order
 *  `patternCopiesFor` reports (which is how the minted ids are chunked
 *  back onto their copies afterwards). INSERTS ONLY: a batch that
 *  deletes and then inserts is refused, because the insert's z-position
 *  resolves against the spread length the batch STARTED with. */
export function patternInsertBatchFor(plan: PatternPlan): Mutation {
  const ops: Mutation[] = [];
  for (const copy of patternCopiesFor(plan)) {
    const source = plan.sources[copy.sourceIndex];
    const moved = offsetTable(
      source.table,
      copy.tile.offset[0],
      copy.tile.offset[1],
    );
    for (const contour of splitCompound(moved)) {
      ops.push(
        insertPathMutationFor(
          plan.pageId,
          contour.anchors,
          contour.subpathOpen?.[0] ?? false,
        ),
      );
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

const lengthProp = (
  elementId: ElementId,
  path: "frameStrokeWeight" | "frameOpacity",
  value: number,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "length", value } },
});

/** What batch 2 resolved each copy to: the surviving element id (a
 *  compound copy's first contour absorbs the rest) and the contour ids
 *  that get deleted again. */
export interface PatternCopyBinding {
  copy: PatternCopy;
  keep: ElementId;
  absorb: ElementId[];
}

/** Chunk the ids minted by batch 1 back onto their copies. Insertion
 *  order == tree order (the appearance-bake finding), so this is a walk,
 *  not a guess. Returns null when the count does not match — the caller
 *  then refuses rather than mis-binding. Pure. */
export function bindPatternCopies(
  plan: PatternPlan,
  minted: readonly ElementId[],
): PatternCopyBinding[] | null {
  const copies = patternCopiesFor(plan);
  const expected = copies.reduce((n, c) => n + c.contours, 0);
  if (minted.length !== expected) return null;
  const bindings: PatternCopyBinding[] = [];
  let at = 0;
  for (const copy of copies) {
    const ids = minted.slice(at, at + copy.contours);
    at += copy.contours;
    bindings.push({ copy, keep: ids[0], absorb: ids.slice(1) });
  }
  return bindings;
}

/** BATCH 2 — the whole rest of a Make or a Re-plan, in the ONE order
 *  the engine accepts:
 *    1. DISSOLVE the previous field's group (re-plan only). It must come
 *       BEFORE its members are deleted: deleting first leaves the group
 *       holding a hole and the engine refuses the dissolve with "group
 *       has an id-less member that cannot round-trip". MEASURED.
 *    2. DELETE the previous field's tiles (re-plan only).
 *    3. Re-merge every compound copy through the SAME `framePath` door
 *       Make Compound Path uses, paint it like its source, DIM it, and
 *       stamp its tile link.
 *    4. Stamp the source links, then wrap the field in one group.
 *  One batch ⇒ one undo step, however many tiles. */
export function patternFinishBatchFor(args: {
  plan: PatternPlan;
  bindings: readonly PatternCopyBinding[];
  sourceEnvelopes: readonly (PluginMetadataEnvelope | null)[];
  /** A previous field's group, dissolved first (re-plan). */
  dissolve?: ElementId | null;
  /** A previous field's tiles, deleted after the dissolve (re-plan). */
  stale?: readonly ElementId[];
}): Mutation {
  const { plan } = args;
  const ops: Mutation[] = [];
  if (args.dissolve && typeof args.dissolve.id === "string") {
    ops.push(ungroupMutationFor(args.dissolve.id));
  }
  for (const id of args.stale ?? []) {
    if (typeof id.id === "string") {
      ops.push({ op: "deleteFrame", args: { frameId: id.id } });
    }
  }
  for (const binding of args.bindings) {
    const source = plan.sources[binding.copy.sourceIndex];
    if (binding.absorb.length > 0) {
      // A compound copy came in as N separate paths; put the contours
      // back on the first one and drop the rest.
      ops.push(
        framePathMutationFor(
          binding.keep,
          offsetTable(
            source.table,
            binding.copy.tile.offset[0],
            binding.copy.tile.offset[1],
          ),
        ),
      );
      for (const id of binding.absorb) {
        ops.push({ op: "deleteFrame", args: { frameId: id.id as string } });
      }
    }
    ops.push(colorRef(binding.keep, "frameFillColor", source.paint.fill));
    ops.push(colorRef(binding.keep, "frameStrokeColor", source.paint.stroke));
    if (typeof source.paint.weight === "number") {
      ops.push(lengthProp(binding.keep, "frameStrokeWeight", source.paint.weight));
    }
    if (plan.params.dim !== 100) {
      ops.push(lengthProp(binding.keep, "frameOpacity", plan.params.dim));
    }
    ops.push(
      stampDrawMetadata(binding.keep, {
        v: 1,
        data: {
          patternTile: {
            pattern: plan.field,
            of: source.id,
            col: binding.copy.tile.col,
            row: binding.copy.tile.row,
          } satisfies PatternTileRef,
        },
      }),
    );
  }
  plan.sources.forEach((source, index) => {
    ops.push(
      stampDrawMetadata(
        source.id,
        withPatternKey(args.sourceEnvelopes[index] ?? null, "patternSource", {
          pattern: plan.field,
          index,
        }),
      ),
    );
  });
  ops.push(
    groupMutationFor([
      ...plan.sources.map((s) => s.id),
      ...args.bindings.map((b) => b.keep),
    ]),
  );
  return { op: "batch", args: { ops } };
}

/** The RELEASE batch — drop every pattern key from every named leaf,
 *  keeping the artwork AND the group. One batch ⇒ one undo step no
 *  matter how many leaves. */
export function patternReleaseBatchFor(
  leaves: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: "patternSource" | "patternTile";
  }[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: leaves.map((leaf) =>
        stampDrawMetadata(leaf.id, withPatternKey(leaf.envelope, leaf.key, null)),
      ),
    },
  };
}

/** The DELETE-TILES batch — the un-bake v0 did not have. Dissolve the
 *  group FIRST (measured, see {@link patternFinishBatchFor}), then
 *  delete every tile, then unlink the sources. One batch ⇒ one undo
 *  step. */
export function patternDeleteBatchFor(args: {
  group?: ElementId | null;
  tiles: readonly ElementId[];
  sources: readonly {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
  }[];
}): Mutation {
  const ops: Mutation[] = [];
  if (args.group && typeof args.group.id === "string") {
    ops.push(ungroupMutationFor(args.group.id));
  }
  for (const id of args.tiles) {
    if (typeof id.id === "string") {
      ops.push({ op: "deleteFrame", args: { frameId: id.id } });
    }
  }
  for (const source of args.sources) {
    ops.push(
      stampDrawMetadata(
        source.id,
        withPatternKey(source.envelope, "patternSource", null),
      ),
    );
  }
  return { op: "batch", args: { ops } };
}

// -------------------------------------------------------- host: the part

type PartsHost = Pick<BundleHost, "parts" | "supports" | "log">;

/** Read the fields out of the container part. A host with no container
 *  writer (`supports("storage.parts@1")` false — an older editor) is not
 *  an error: it reads as an EMPTY library and WARNS, so the degrade is
 *  visible in the log instead of looking like "no fields yet". */
export async function readPatternLibrary(
  host: PartsHost,
): Promise<PatternLibrary> {
  if (!host.supports(PATTERN_FEATURE)) {
    host.log.warn(
      "pattern: this host wires no `.paged` container writer " +
        `(supports("${PATTERN_FEATURE}") is false) — a field's PARAMETERS ` +
        "cannot be saved here, so it can be released or un-baked but not " +
        "re-planned without naming the parameters again",
    );
    return emptyLibrary();
  }
  try {
    return parsePatternLibrary(await host.parts.read(PATTERN_PART));
  } catch (e) {
    host.log.warn(`pattern: recipe read failed (${String(e)})`);
    return emptyLibrary();
  }
}

/** Write the fields back. `false` = it did not persist (no container
 *  door, or the write was refused) — logged, never thrown. */
export async function writePatternLibrary(
  host: PartsHost,
  library: PatternLibrary,
): Promise<boolean> {
  if (!host.supports(PATTERN_FEATURE)) return false;
  try {
    await host.parts.write(PATTERN_PART, serializePatternLibrary(library));
    return true;
  } catch (e) {
    host.log.warn(`pattern: recipe write failed (${String(e)})`);
    return false;
  }
}

// -------------------------------------------------- host: document reads

/** One row of the `pages` collection, narrowed to what the fit needs.
 *  Declared LOCALLY because `@paged-media/plugin-api` re-exports
 *  `SwatchSummary` / `LayerSummary` but NOT `PageSummary`; the door
 *  itself (`document.collection<T>`) is generic and sanctioned, so this
 *  is a row type, not an escape hatch. */
interface PageRowWire {
  selfId: string;
  sizePt?: [number, number];
}

/** The page rect a field is fitted into, or null when the page is not
 *  readable (an older engine, or an unknown id) — the caller then warns
 *  and places every requested tile. */
export async function patternPageRect(
  host: BundleHost,
  pageId: string,
): Promise<PatternPageRect | null> {
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

/** The union of every id's `elementGeometry` bounds, in page space.
 *  Null when nothing was readable. */
export async function selectionBoundsOf(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<PatternBounds | null> {
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
  return { top, left, bottom, right };
}

/** The selection's `[width, height]` in pt — the default tile size. */
export async function selectionTileSize(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<[number, number] | null> {
  const bounds = await selectionBoundsOf(host, ids);
  if (!bounds) return null;
  return [bounds.right - bounds.left, bounds.bottom - bounds.top];
}

/** Every leaf carrying a pattern link, split by which one. One scene
 *  walk + one metadata read per leaf — the `select-same` / `livePaintLinks`
 *  precedent. `field` filters; omit it for every field. */
export async function patternLinks(
  host: BundleHost,
  field?: string,
): Promise<{
  sources: { id: ElementId; ref: PatternSourceRef }[];
  tiles: { id: ElementId; ref: PatternTileRef }[];
}> {
  const sources: { id: ElementId; ref: PatternSourceRef }[] = [];
  const tiles: { id: ElementId; ref: PatternTileRef }[] = [];
  const roots = await host.document.tree().catch(() => []);
  for (const id of leafIdsOf(roots)) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const source = patternSourceOf(env);
    if (source && (field === undefined || source.pattern === field)) {
      sources.push({ id, ref: source });
    }
    const tile = patternTileOf(env);
    if (tile && (field === undefined || tile.pattern === field)) {
      tiles.push({ id, ref: tile });
    }
  }
  sources.sort((a, b) => a.ref.index - b.ref.index);
  return { sources, tiles };
}

/** The group node holding `member`, or null — a BATCH outcome does not
 *  echo an inner `createGroup`'s id (only a bare create does, the
 *  `applyGroupSelection` precedent), so the tree is the source of truth. */
export async function patternGroupOf(
  host: BundleHost,
  member: ElementId,
): Promise<ElementId | null> {
  const roots = await host.document.tree().catch(() => []);
  let found: ElementId | null = null;
  const walk = (nodes: readonly { id?: ElementId | null; children?: unknown }[]) => {
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

/** Which field a command acts on: the payload's `patternId`, else the
 *  selection's own link, else the only field the document carries.
 *  Answers a field id (which may be {@link PATTERN_LEGACY_FIELD}) or
 *  null. */
export async function resolvePatternField(
  host: BundleHost,
  patternId: unknown,
): Promise<string | null> {
  if (typeof patternId === "string") return patternId;
  for (const id of host.selection.get()) {
    const env = await host.document.getMetadata(id).catch(() => null);
    const linked =
      patternSourceOf(env)?.pattern ?? patternTileOf(env)?.pattern ?? null;
    if (linked !== null) return linked;
  }
  const library = await readPatternLibrary(host);
  if (library.fields.length === 1) return library.fields[0]!.id;
  const links = await patternLinks(host);
  const distinct = new Set([
    ...links.sources.map((s) => s.ref.pattern),
    ...links.tiles.map((t) => t.ref.pattern),
  ]);
  return distinct.size === 1 ? [...distinct][0]! : null;
}

// ------------------------------------------------------------- planning

/** Resolve `sources` + `params` into a plan, or null (a refusal, already
 *  logged). Shared by Make and Re-plan, so both ride the same lane. */
export async function patternPlanFor(
  host: BundleHost,
  args: {
    field: string;
    params: PatternParams;
    ids: readonly ElementId[];
    label: string;
  },
): Promise<PatternPlan | null> {
  const { label } = args;
  const ids = args.ids.filter((id) => {
    if (id.kind === "textFrame") {
      host.log.debug(
        `${label}: skipping the text frame ${String(id.id)} — a tile is an ` +
          `insertPath Polygon and cannot carry a story`,
      );
      return false;
    }
    return true;
  });
  if (ids.length === 0) {
    host.log.debug(`${label}: nothing tileable to work from — no-op`);
    return null;
  }
  const bounds = await selectionBoundsOf(host, ids);
  if (!bounds || bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    host.log.warn(`${label}: the sources have no measurable bounds — no-op`);
    return null;
  }
  const sources: PatternSource[] = [];
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
    host.log.warn(`${label}: no source geometry to tile — no-op`);
    return null;
  }
  const size: [number, number] = [
    bounds.right - bounds.left,
    bounds.bottom - bounds.top,
  ];
  const step = patternStepFor(args.params, size);
  const requested = patternTilesFor(args.params, step);
  if (requested.length * sources.length > PATTERN_MAX_TILES) {
    host.log.warn(
      `${label}: ${args.params.columns} × ${args.params.rows} over ` +
        `${sources.length} source(s) is ${requested.length * sources.length} ` +
        `copies — past this plugin's ${PATTERN_MAX_TILES}-copy ceiling. ` +
        "Refused rather than truncated (the engine would accept the batch; " +
        "the ceiling is here so a typo cannot build one that large)",
    );
    return null;
  }
  let page: PatternPageRect | null = null;
  if (args.params.fitToArtboard) {
    page = await patternPageRect(host, pageId);
    if (!page) {
      host.log.warn(
        `${label}: the page rect for "${pageId}" is not readable, so the tile ` +
          "count could not be fitted to the artboard — placing every " +
          "requested tile. A tile past the page edge IS created, but " +
          "pathAnchors/elementGeometry answer nothing for it (RFI C-23)",
      );
    }
  }
  const fit = fitTilesToPage(requested, bounds, page);
  if (fit.dropped.length > 0) {
    host.log.info(
      `${label}: ${fit.dropped.length} of ${requested.length} tile(s) would ` +
        `land outside the ${page!.width} × ${page!.height} pt page and were ` +
        "dropped — an off-page item is real but page-keyed reads answer " +
        "nothing for it (RFI C-23). Pass fitToArtboard: false to place them " +
        "anyway",
    );
  }
  return {
    pageId,
    field: args.field,
    params: args.params,
    step,
    bounds,
    sources,
    tiles: fit.placed,
    dropped: fit.dropped,
  };
}

// ------------------------------------------------------------ the emitter

/** Emit a plan as artwork: batch 1 inserts, batch 2 finishes. TWO
 *  batches ⇒ 2 undo steps (the contract floor — module header). Returns
 *  the surviving tile ids, or an empty list on a refusal (always logged,
 *  never thrown — the dash-command convention). */
async function emitPatternField(
  host: BundleHost,
  args: {
    plan: PatternPlan;
    label: string;
    dissolve?: ElementId | null;
    stale?: readonly ElementId[];
  },
): Promise<ElementId[]> {
  const { plan, label } = args;
  if (plan.tiles.length === 0) {
    host.log.warn(
      `${label}: the plan places NO tiles (every requested one fell outside ` +
        "the page) — nothing to bake",
    );
    return [];
  }
  const before = new Set(
    leafIdsOf(await host.document.tree().catch(() => [])).map((e) =>
      String(e.id),
    ),
  );
  const inserted = await host.document.mutate(patternInsertBatchFor(plan));
  if (!inserted.applied) {
    host.log.warn(
      `${label}: tile insert rejected by engine: ${JSON.stringify(inserted.error)}`,
    );
    return [];
  }
  const minted = leafIdsOf(await host.document.tree().catch(() => [])).filter(
    (e) => !before.has(String(e.id)),
  );
  const bindings = bindPatternCopies(plan, minted);
  if (!bindings) {
    host.log.warn(
      `${label}: expected ${patternCopiesFor(plan).reduce(
        (n, c) => n + c.contours,
        0,
      )} inserted paths, found ${minted.length} — leaving the insert in ` +
        "place, not linking or grouping it",
    );
    return minted;
  }
  const sourceEnvelopes = await Promise.all(
    plan.sources.map((s) => host.document.getMetadata(s.id).catch(() => null)),
  );
  const finished = await host.document.mutate(
    patternFinishBatchFor({
      plan,
      bindings,
      sourceEnvelopes,
      dissolve: args.dissolve ?? null,
      stale: args.stale ?? [],
    }),
  );
  if (!finished.applied) {
    host.log.warn(
      `${label}: tile paint/link/group batch rejected by engine: ${JSON.stringify(
        finished.error,
      )}`,
    );
    return bindings.map((b) => b.keep);
  }
  const keep = bindings.map((b) => b.keep);
  const group = await patternGroupOf(host, keep[0]);
  await host.selection.set(
    group ? [group] : [...plan.sources.map((s) => s.id), ...keep],
  );
  return keep;
}

// ------------------------------------------------------------- appliers

/**
 * **MAKE** — bake a re-editable tile FIELD from the selection.
 *
 * Payload: any subset of {@link PatternParams} plus `{ name? }`. TWO
 * batches ⇒ 2 undo steps. The result is ARTWORK, not a swatch
 * ({@link PATTERN_SWATCH_NOTE}); the recipe that makes it re-plannable
 * is a container part and is NOT on the undo stack.
 */
export async function applyMakePattern(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = MAKE_PATTERN_COMMAND_ID;
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${label}: nothing selected — no-op`);
    return [];
  }
  const params = patternParamsFrom(payload);
  const library = await readPatternLibrary(host);
  const field = mintPatternId(library);
  const plan = await patternPlanFor(host, {
    field,
    params,
    ids: selection,
    label,
  });
  if (!plan) return [];

  const name =
    payload &&
    typeof payload === "object" &&
    typeof (payload as { name?: unknown }).name === "string" &&
    (payload as { name: string }).name.trim().length > 0
      ? (payload as { name: string }).name.trim()
      : `Pattern ${library.fields.length + 1}`;
  const saved = await writePatternLibrary(
    host,
    upsertPatternField(library, {
      id: field,
      name,
      params,
      sources: plan.sources.map((s) => ({ kind: s.id.kind, id: String(s.id.id) })),
    }),
  );
  const tiles = await emitPatternField(host, { plan, label });
  if (tiles.length === 0) return [];
  host.log.info(
    `${label}: "${name}" placed ${tiles.length} tile(s) in a ${params.layout} ` +
      `layout${plan.dropped.length > 0 ? ` (${plan.dropped.length} dropped off-page)` : ""}. ` +
      (saved
        ? "The parameters are saved, so the field can be re-planned."
        : "The parameters were NOT saved (no container writer) — the field " +
          "can be released or un-baked, but a re-plan must name them again.") +
      " This is ARTWORK, not a pattern swatch — the engine has no pattern " +
      "paint type (RFI C-31).",
  );
  return tiles;
}

/**
 * **RE-PLAN** — rebuild an existing field with new parameters and FRESH
 * source geometry. This is v1's answer to "no re-edit": editing a source
 * and re-planning is how a tile change reaches the copies.
 *
 * Payload: `{ patternId?, name?, …params }` — anything omitted keeps the
 * saved value. TWO batches ⇒ 2 undo steps. Every tile gets a NEW element
 * id, so another plugin's metadata on a tile does not survive.
 */
export async function applyEditPattern(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = EDIT_PATTERN_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const field = await resolvePatternField(host, p.patternId);
  if (field === null) {
    host.log.warn(
      `${label}: no pattern field resolved from the payload or the selection ` +
        "— bake one first",
    );
    return [];
  }
  const library = await readPatternLibrary(host);
  const saved = findPatternField(library, field);
  if (!saved && field === PATTERN_LEGACY_FIELD) {
    host.log.warn(
      `${label}: this field was baked by patterns v0, which stored no ` +
        "parameters anywhere a v1 reader can find — it can be released or " +
        "un-baked, but not re-planned. Delete its tiles and bake again",
    );
    return [];
  }
  const links = await patternLinks(host, field);
  const sourceIds =
    links.sources.length > 0
      ? links.sources.map((s) => s.id)
      : (saved?.sources.map((s) => ({ kind: s.kind, id: s.id }) as ElementId) ??
        []);
  if (sourceIds.length === 0) {
    host.log.warn(
      `${label}: "${field}" names no source elements any more — nothing to ` +
        "re-plan",
    );
    return [];
  }
  const params = patternParamsFrom(p, saved?.params ?? PATTERN_DEFAULTS);
  const plan = await patternPlanFor(host, {
    field,
    params,
    ids: sourceIds,
    label,
  });
  if (!plan) return [];

  const group = await patternGroupOf(host, sourceIds[0]!);
  const tiles = await emitPatternField(host, {
    plan,
    label,
    dissolve: group,
    stale: links.tiles.map((t) => t.id),
  });
  if (tiles.length === 0) return [];
  const name =
    typeof p.name === "string" && p.name.trim().length > 0
      ? p.name.trim()
      : (saved?.name ?? `Pattern ${library.fields.length + 1}`);
  await writePatternLibrary(
    host,
    upsertPatternField(library, {
      id: field,
      name,
      params,
      sources: plan.sources.map((s) => ({ kind: s.id.kind, id: String(s.id.id) })),
    }),
  );
  host.log.info(
    `${label}: "${name}" re-planned — ${links.tiles.length} old tile(s) ` +
      `replaced by ${tiles.length} in a ${params.layout} layout. The tiles ` +
      "carry NEW element ids",
  );
  return tiles;
}

/** **SELECT TILES** — put a field's tiles (or, with `includeSources`,
 *  its sources too) on the selection so the ordinary tools reach them.
 *  No mutation. */
export async function applySelectPatternTiles(
  host: BundleHost,
  payload?: unknown,
): Promise<ElementId[]> {
  const label = SELECT_PATTERN_TILES_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const field = await resolvePatternField(host, p.patternId);
  if (field === null) {
    host.log.warn(`${label}: no pattern field resolved — no-op`);
    return [];
  }
  const links = await patternLinks(host, field);
  const ids = [
    ...(p.includeSources === true ? links.sources.map((s) => s.id) : []),
    ...links.tiles.map((t) => t.id),
  ];
  if (ids.length === 0) {
    host.log.debug(`${label}: "${field}" has no tiles on the page — no-op`);
  }
  await host.selection.set(ids);
  return ids;
}

/** **DELETE TILES** — the un-bake v0 did not have: remove every copy,
 *  dissolve the group, unlink the sources and forget the recipe. The
 *  SOURCES keep their artwork untouched. ONE batch ⇒ 1 undo step (the
 *  recipe removal itself is not undoable). */
export async function applyDeletePatternTiles(
  host: BundleHost,
  payload?: unknown,
): Promise<number> {
  const label = DELETE_PATTERN_TILES_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const field = await resolvePatternField(host, p.patternId);
  if (field === null) {
    host.log.warn(`${label}: no pattern field resolved — no-op`);
    return 0;
  }
  const links = await patternLinks(host, field);
  if (links.tiles.length === 0 && links.sources.length === 0) {
    host.log.debug(`${label}: "${field}" has no linked artwork — no-op`);
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
  const anchor = links.sources[0]?.id ?? links.tiles[0]?.id ?? null;
  const group = anchor ? await patternGroupOf(host, anchor) : null;
  const outcome = await host.document.mutate(
    patternDeleteBatchFor({ group, tiles: links.tiles.map((t) => t.id), sources }),
  );
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return 0;
  }
  await writePatternLibrary(
    host,
    removePatternFieldFrom(await readPatternLibrary(host), field),
  );
  await host.selection.set(links.sources.map((s) => s.id));
  host.log.info(
    `${label}: "${field}" un-baked — ${links.tiles.length} tile(s) removed; ` +
      `${links.sources.length} source(s) kept exactly as they are`,
  );
  return links.tiles.length;
}

/** **RELEASE** — drop the recipe and every link, keeping ALL the artwork
 *  and the group: the tiles become ordinary paths nothing tracks. ONE
 *  batch ⇒ 1 undo step for every link together (the recipe removal is
 *  not undoable). */
export async function applyReleasePattern(
  host: BundleHost,
  payload?: unknown,
): Promise<boolean> {
  const label = RELEASE_PATTERN_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const field = await resolvePatternField(host, p.patternId);
  if (field === null) {
    host.log.warn(`${label}: no pattern field resolved — no-op`);
    return false;
  }
  const links = await patternLinks(host, field);
  const library = await readPatternLibrary(host);
  if (
    links.sources.length === 0 &&
    links.tiles.length === 0 &&
    !findPatternField(library, field)
  ) {
    host.log.warn(
      `${label}: "${field}" names neither a recipe nor any linked artwork — no-op`,
    );
    return false;
  }
  const leaves: {
    id: ElementId;
    envelope: PluginMetadataEnvelope | null;
    key: "patternSource" | "patternTile";
  }[] = [];
  for (const source of links.sources) {
    leaves.push({
      id: source.id,
      envelope: await host.document.getMetadata(source.id).catch(() => null),
      key: "patternSource",
    });
  }
  for (const tile of links.tiles) {
    leaves.push({
      id: tile.id,
      envelope: await host.document.getMetadata(tile.id).catch(() => null),
      key: "patternTile",
    });
  }
  if (leaves.length > 0) {
    const outcome = await host.document.mutate(patternReleaseBatchFor(leaves));
    if (!outcome.applied) {
      host.log.warn(
        `${label}: unlink rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
      return false;
    }
  }
  host.log.info(
    `${label}: "${field}" released — ${links.sources.length} source(s) and ` +
      `${links.tiles.length} tile(s) keep their artwork; nothing tracks them ` +
      "any more",
  );
  await writePatternLibrary(host, removePatternFieldFrom(library, field));
  return true;
}

// ------------------------------------------------------------- commands

/** Register the five pattern commands. Every title carries what the
 *  contract has no description field to say — and the FIRST one carries
 *  the hard boundary, because a name that only said "Make pattern" would
 *  promise Illustrator's live swatch, which this engine has no paint
 *  type for (RFI C-31, {@link PATTERN_SWATCH_NOTE}).
 *
 *  Payloads: make `{ name?, …params }`, re-plan `{ patternId?, name?,
 *  …params }`, select `{ patternId?, includeSources? }`, delete tiles /
 *  release `{ patternId? }`. */
export function contributePatternCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: MAKE_PATTERN_COMMAND_ID,
      title:
        "Pattern: Bake a re-editable tile field from selection (artwork — NOT a pattern swatch)",
      category: PATTERN_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyMakePattern(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: EDIT_PATTERN_COMMAND_ID,
      title:
        "Pattern: Re-plan the field (layout, tile size, spacing, overlap, copies, dimming)",
      category: PATTERN_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyEditPattern(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: SELECT_PATTERN_TILES_COMMAND_ID,
      title: "Pattern: Select the field's tiles",
      category: PATTERN_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applySelectPatternTiles(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: DELETE_PATTERN_TILES_COMMAND_ID,
      title: "Pattern: Delete the tiles (un-bake; the sources are kept)",
      category: PATTERN_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyDeletePatternTiles(host, payload).then(() => undefined),
    }),
    host.contribute.command({
      id: RELEASE_PATTERN_COMMAND_ID,
      title: "Pattern: Release the field (keep the artwork, drop the recipe)",
      category: PATTERN_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReleasePattern(host, payload).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
