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

// PATTERNS v0 — A DESTRUCTIVE BAKE. Read this paragraph before reading
// the code, and before believing the feature name.
//
// Illustrator's pattern is a SWATCH: a live tile you fill any object
// with, edit in place, and re-apply everywhere at once. THIS IS NOT
// THAT, and it cannot be on this engine. IDML gives a page item a
// `FillColor` that resolves to a Color / Gradient / Mixed-Ink swatch —
// there is no pattern paint type in the format, none in
// `paged_model::Graphic`, and none on the wire (`SwatchSpec` /
// `GradientSpec` are the only two swatch shapes `createSwatch` /
// `createGradient` accept). Inventing one would render nothing and lie
// on save — the same wall `commands/group.ts` records for clipping
// masks.
//
// So v0 is the honest half: a STEP-AND-REPEAT BAKE. The selection is
// copied across a fixed grid of tiles, every copy is a real page item
// carrying the source's paint, and the whole field is wrapped in one
// group. What that means, stated plainly because the command name will
// not say it for you:
//   · editing the SOURCE afterwards does NOT update the tiles — they
//     are copies, made once, at bake time;
//   · the result is NOT a fill you can apply to another object — it is
//     artwork sitting on the page;
//   · undo is the only "un-bake"; there is no release command, because
//     a released pattern would just be the copies you already have.
// The command title carries the word BAKE for exactly this reason, and
// each source element is stamped with a `pattern` metadata record (the
// appearance-bake convention) so a reopened document can still tell
// baked tiles from hand-drawn artwork.
//
// V0 PARAMETERS ARE FIXED IN CODE (no UI, no payload — a v0 that
// pretends to be configurable is worse than one that is honestly not):
//   · TILE SIZE comes from the SELECTION BOUNDS — the union of every
//     selected element's `elementGeometry` bounds, in page space;
//   · SPACING is `PATTERN_SPACING_PT` (6 pt) of gutter between tiles,
//     so the step is `bounds + spacing` on each axis;
//   · REPEAT is `PATTERN_COLUMNS` × `PATTERN_ROWS` (3 × 3 = 9 tiles);
//     cell (0,0) IS the selection itself — it stays exactly where it
//     is — so 8 copies are inserted.
//
// MUTATION / UNDO SHAPE (probed against the booted engine, protocol 57;
// the RFI C-15 rule — assert the real count, never claim "one undo"):
// TWO batches ⇒ 2 undo steps. Batch 1 inserts every copy's contours;
// batch 2 paints them, re-merges the compound ones, stamps the records
// and wraps the group. Two is the FLOOR: `insertPath` mints the ids
// batch 2 addresses, and a batch cannot address an id minted inside
// itself (the appearance-bake / blend.ts finding).
//
// COMPOUND SOURCES ARE SUPPORTED, which is why this module sits next to
// `commands/compound-path.ts`: `insertPath` carries ONE contour, so a
// ring is inserted as its contours and re-merged in batch 2 through the
// very same `framePath` door Make Compound Path uses. A tiled ring
// keeps its hole.
//
// HONEST SCOPE — stated here, asserted in conformance:
//   · a source with no readable geometry is skipped with a diagnostic;
//   · a TEXT FRAME is skipped: copying one would need its story
//     duplicated too, which `insertPath` cannot do (it makes Polygons);
//   · every copy is a Polygon, so a source's non-path traits (a
//     rectangle's live corners, an image's content) do not ride along —
//     v0 tiles GEOMETRY + PAINT;
//   · inserted items land at the top of the page's z-order (the
//     insert-lane fact the appearance bake also records), so the tiles
//     paint above unrelated artwork until the group is re-ordered;
//   · TILES CAN STEP OFF THE PAGE. The grid is fixed, so a selection
//     wider than a third of the page runs past its edge. Those tiles
//     ARE created (they are in the scene tree, and they group), but
//     `pathAnchors` / `elementGeometry` answer NOTHING for them — both
//     doors are page-keyed and an item outside every page's bounds
//     belongs to no page. Measured, not assumed (the conformance spec
//     pins it), and named rather than papered over: the real fix is an
//     artboard-aware tile count, which v0 does not have.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import { splitCompound, type AnchorTable } from "@paged-media/draw-geometry";

import manifest from "../../manifest.json";

import { DRAW_METADATA_KEY } from "./appearance-bake";
import { groupMutationFor } from "./group";
import {
  compoundPaintOf,
  compoundSourceOf,
  framePathMutationFor,
  type CompoundPaint,
} from "./compound-path";
import { insertPathMutationFor } from "../handlers/insert-path";

export const PATTERN_COMMAND_CATEGORY = "Pattern";

export const MAKE_PATTERN_COMMAND_ID =
  "media.paged.draw.command.makePatternFromSelection";

/** The contributed command ids, in registration order. */
export const PATTERN_COMMAND_IDS = [MAKE_PATTERN_COMMAND_ID];

/** v0 fixed parameters — see the module header for why they are fixed. */
export const PATTERN_COLUMNS = 3;
export const PATTERN_ROWS = 3;
/** Gutter between tiles, pt. The step is `selection bounds + spacing`. */
export const PATTERN_SPACING_PT = 6;

// ---------------------------------------------------------------- model

/** The record stamped on every element the bake touches — the source
 *  elements get the whole plan, each inserted copy gets its cell. Its
 *  presence is what makes a baked pattern recognizable on reopen (the
 *  `appearanceBake` convention). */
export interface PatternBakeRecord {
  /** Tile step in pt, `[x, y]` — the selection bounds plus the spacing. */
  step: [number, number];
  spacing: number;
  columns: number;
  rows: number;
  /** The source element ids (cell 0,0 — they never move). */
  sources: string[];
  /** The inserted copies, in insertion order. */
  copies: string[];
  /** Always true, and always read as "these tiles do NOT track the
   *  source". Carried explicitly so the value says so on reopen. */
  destructive: true;
}

/** The marker stamped on ONE inserted tile. */
export interface PatternTileMarker {
  of: ElementId;
  col: number;
  row: number;
}

/** Read the pattern record out of an envelope, or null. Tolerant of
 *  partial/foreign shapes (the `appearanceBakeOf` convention). */
export function patternBakeOf(
  env: PluginMetadataEnvelope | null,
): PatternBakeRecord | null {
  const raw = (env?.data as { pattern?: unknown } | undefined)?.pattern;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PatternBakeRecord>;
  const step = Array.isArray(r.step) ? r.step : null;
  if (!step || step.length !== 2 || step.some((n) => typeof n !== "number")) {
    return null;
  }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  return {
    step: [step[0], step[1]],
    spacing: typeof r.spacing === "number" ? r.spacing : PATTERN_SPACING_PT,
    columns: typeof r.columns === "number" ? r.columns : PATTERN_COLUMNS,
    rows: typeof r.rows === "number" ? r.rows : PATTERN_ROWS,
    sources: strings(r.sources),
    copies: strings(r.copies),
    destructive: true,
  };
}

/** Read the per-tile marker out of an envelope, or null. */
export function patternTileOf(
  env: PluginMetadataEnvelope | null,
): PatternTileMarker | null {
  const raw = (env?.data as { patternTile?: unknown } | undefined)?.patternTile;
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<PatternTileMarker>;
  const of = m.of as ElementId | undefined;
  if (!of || typeof of.id !== "string") return null;
  return {
    of,
    col: typeof m.col === "number" ? m.col : 0,
    row: typeof m.row === "number" ? m.row : 0,
  };
}

/** Merge (or, with `null`, drop) the pattern record in an envelope,
 *  preserving every other draw metadata key. */
export function withPatternBake(
  prev: PluginMetadataEnvelope | null,
  record: PatternBakeRecord | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (record === null) {
    delete data.pattern;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.pattern = record;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

// ----------------------------------------------------------- the plan

/** One tile cell of the step-and-repeat. `(0, 0)` is the SELECTION
 *  itself and is never emitted — it is already on the page. */
export interface PatternTile {
  col: number;
  row: number;
  /** Page-space translation applied to the source geometry. */
  offset: [number, number];
}

/** One source element's contribution to the bake. */
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
  step: [number, number];
  sources: PatternSource[];
  tiles: PatternTile[];
}

/** One inserted copy: which tile, which source, and how many contours
 *  it took (a compound source inserts one path per contour, re-merged
 *  in batch 2). */
export interface PatternCopy {
  tile: PatternTile;
  sourceIndex: number;
  contours: number;
}

/** The `columns × rows` grid MINUS cell (0,0). Row-major, so insertion
 *  order is readable left-to-right, top-to-bottom. */
export function patternTilesFor(
  columns: number,
  rows: number,
  step: readonly [number, number],
): PatternTile[] {
  const tiles: PatternTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      if (col === 0 && row === 0) continue;
      tiles.push({ col, row, offset: [col * step[0], row * step[1]] });
    }
  }
  return tiles;
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

// ------------------------------------------------------- wire builders
// Exported so the conformance spec asserts the EXACT wire shapes the
// live command emits (no second copy to drift from).

/** BATCH 1 — one `insertPath` per copy per contour, in the order
 *  `patternCopiesFor` reports (which is how the minted ids are chunked
 *  back onto their copies afterwards). */
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

const stamp = (
  elementId: ElementId,
  envelope: PluginMetadataEnvelope | null,
): Mutation => ({
  op: "setPluginMetadata",
  args: {
    elementId,
    key: DRAW_METADATA_KEY,
    value: envelope === null ? null : JSON.stringify(envelope),
    caller: manifest.id,
  },
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
 *  then refuses rather than mis-binding. */
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

/** BATCH 2 — re-merge every compound copy through the SAME `framePath`
 *  door Make Compound Path uses, paint each surviving tile like its
 *  source, stamp the per-tile markers and the per-source record, and
 *  wrap the whole field in one group. One batch ⇒ one undo step. */
export function patternFinishBatchFor(args: {
  plan: PatternPlan;
  bindings: readonly PatternCopyBinding[];
  record: PatternBakeRecord;
  sourceEnvelopes: readonly (PluginMetadataEnvelope | null)[];
}): Mutation {
  const ops: Mutation[] = [];
  for (const binding of args.bindings) {
    const source = args.plan.sources[binding.copy.sourceIndex];
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
      ops.push({
        op: "setElementProperty",
        args: {
          elementId: binding.keep,
          path: "frameStrokeWeight",
          value: { type: "length", value: source.paint.weight },
        },
      });
    }
    ops.push(
      stamp(binding.keep, {
        v: 1,
        data: {
          patternTile: {
            of: source.id,
            col: binding.copy.tile.col,
            row: binding.copy.tile.row,
          },
        },
      }),
    );
  }
  args.plan.sources.forEach((source, i) => {
    ops.push(
      stamp(source.id, withPatternBake(args.sourceEnvelopes[i] ?? null, args.record)),
    );
  });
  ops.push(
    groupMutationFor([
      ...args.plan.sources.map((s) => s.id),
      ...args.bindings.map((b) => b.keep),
    ]),
  );
  return { op: "batch", args: { ops } };
}

// ------------------------------------------------------------ appliers

/** The union of every id's `elementGeometry` bounds, in page space, as
 *  `[width, height]`. Null when nothing was readable. */
export async function selectionTileSize(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<[number, number] | null> {
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
  return [right - left, bottom - top];
}

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

/** The group node holding `member`, or null — the batch outcome does
 *  not echo an inner `createGroup`'s id, so the tree is the source of
 *  truth. */
async function groupContaining(
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

/** Resolve the selection into a plan (v0 fixed parameters). Null =
 *  a refusal, already logged. */
export async function patternPlanFor(
  host: BundleHost,
): Promise<PatternPlan | null> {
  const label = MAKE_PATTERN_COMMAND_ID;
  const selection = host.selection.get().filter((id) => {
    if (id.kind === "textFrame") {
      host.log.debug(
        `${label}: skipping the text frame ${String(id.id)} — a tile is an ` +
          `insertPath Polygon and cannot carry a story`,
      );
      return false;
    }
    return true;
  });
  if (selection.length === 0) {
    host.log.debug(`${label}: nothing tileable selected — no-op`);
    return null;
  }
  const size = await selectionTileSize(host, selection);
  if (!size || size[0] <= 0 || size[1] <= 0) {
    host.log.warn(`${label}: the selection has no measurable bounds — no-op`);
    return null;
  }
  const sources: PatternSource[] = [];
  let pageId: string | null = null;
  for (const id of selection) {
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
  const step: [number, number] = [
    size[0] + PATTERN_SPACING_PT,
    size[1] + PATTERN_SPACING_PT,
  ];
  return {
    pageId,
    step,
    sources,
    tiles: patternTilesFor(PATTERN_COLUMNS, PATTERN_ROWS, step),
  };
}

/**
 * **Bake a step-and-repeat pattern from the selection.** DESTRUCTIVE by
 * design — see the module header: the tiles are COPIES, editing the
 * source afterwards does not update them, and the result is artwork,
 * not a fill you can apply elsewhere. Returns the inserted tile ids
 * (empty on a refusal, always logged, never thrown — the dash-command
 * convention).
 */
export async function applyMakePattern(
  host: BundleHost,
): Promise<ElementId[]> {
  const label = MAKE_PATTERN_COMMAND_ID;
  const plan = await patternPlanFor(host);
  if (!plan) return [];

  const before = new Set(
    (await leafElements(host))
      .map((e) => (typeof e.id === "string" ? e.id : null))
      .filter((s): s is string => s !== null),
  );
  const inserted = await host.document.mutate(patternInsertBatchFor(plan));
  if (!inserted.applied) {
    host.log.warn(
      `${label}: tile insert rejected by engine: ${JSON.stringify(inserted.error)}`,
    );
    return [];
  }
  const minted = (await leafElements(host)).filter(
    (e) => typeof e.id === "string" && !before.has(e.id),
  );
  const bindings = bindPatternCopies(plan, minted);
  if (!bindings) {
    host.log.warn(
      `${label}: expected ${patternCopiesFor(plan).reduce(
        (n, c) => n + c.contours,
        0,
      )} inserted paths, found ${minted.length} — leaving the insert in ` +
        `place, not grouping`,
    );
    return minted;
  }
  const sourceEnvelopes = await Promise.all(
    plan.sources.map((s) => host.document.getMetadata(s.id).catch(() => null)),
  );
  const record: PatternBakeRecord = {
    step: plan.step,
    spacing: PATTERN_SPACING_PT,
    columns: PATTERN_COLUMNS,
    rows: PATTERN_ROWS,
    sources: plan.sources.map((s) => s.id.id as string),
    copies: bindings.map((b) => b.keep.id as string),
    destructive: true,
  };
  const finished = await host.document.mutate(
    patternFinishBatchFor({ plan, bindings, record, sourceEnvelopes }),
  );
  if (!finished.applied) {
    host.log.warn(
      `${label}: tile paint/group batch rejected by engine: ${JSON.stringify(
        finished.error,
      )}`,
    );
    return bindings.map((b) => b.keep);
  }
  // Select the new group so a follow-up command (move, Ungroup)
  // addresses the field as one object. A BATCH outcome does not echo the
  // inner `createGroup`'s minted id (only a bare create does — the
  // `applyGroupSelection` precedent), so the group is found in the tree
  // by one of its members instead of guessed at.
  const group = await groupContaining(host, bindings[0].keep);
  await host.selection.set(
    group ? [group] : [...plan.sources.map((s) => s.id), ...bindings.map((b) => b.keep)],
  );
  return bindings.map((b) => b.keep);
}

/** Register the pattern command. The title carries the word BAKE
 *  because the contract has no description field and the behaviour is
 *  destructive — a name that only said "Make pattern" would promise
 *  Illustrator's live swatch, which this engine has no paint type for. */
export function contributePatternCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: MAKE_PATTERN_COMMAND_ID,
      title: "Pattern: Bake step-and-repeat from selection (copies, not a live fill)",
      category: PATTERN_COMMAND_CATEGORY,
      handler: () => applyMakePattern(host).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
