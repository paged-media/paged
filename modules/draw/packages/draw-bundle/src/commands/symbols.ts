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

// SYMBOLS — the commands, and the v0 symbol library they replaced.
//
// The commands (define, place, redefine, rename, reset transform, break
// link, delete, replace, symbol options) run on the ENGINE's symbols
// (engine ADR 1039, draw ADR 361): `symbols-engine.ts` maps each verb onto
// one wire op, one undo step.
//
// What else lives here is the v0 shape (draw ADR 356), which a document
// made before engine ADR 1039 still carries and `symbols-migrate.ts`
// moves onto the engine on open (draw ADR 365):
//
// THE LIBRARY (one container part, `paged/media.paged.draw/symbols.json`,
// declared in `contributes.partTypes` as
// `{ type: "symbolLibrary", role: "spec", format: "json" }`):
//
//   { "v": 1, "symbols": [ { "id": "sym-1", "name": "Bolt",
//       "registration": "center",
//       "origin": [x, y],            // where it was captured, page pt
//       "pieces": [ { "table": { anchors, subpathStarts, subpathOpen },
//                     "paint": { fill, stroke, weight } } ] } ],
//     "migrated": { … } }
//
// Piece tables are in DEFINITION SPACE: the captured page-space contours
// translated so the REGISTRATION POINT (the §16.1 nine-point grid over
// the definition's bounds) sits at the origin.
//
// THE LINK (on each v0 instance leaf's own `x-paged:media.paged.draw`
// envelope): an instance was re-emitted artwork, one leaf per piece, each
// carrying
//
//   data.symbolInstance = { symbol: "sym-1", instance: "si-1",
//                           piece: 0, origin: [x, y] }
//
// The migration re-emits a definition's pieces through the place plan and
// the finish batch below (`symbolPlacePlanFor`, `symbolFinishBatchFor`,
// over the handles of `symbolHandleBindings`) and reads the v0 instances
// out of the shared link index (`symbolInstances`).

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
} from "@paged-media/plugin-api";
import { splitCompound, type AnchorTable } from "@paged-media/vector-geometry";

import { stampDrawMetadata } from "./draw-metadata";
import { framePathMutationFor, type CompoundPaint } from "./compound-path";
import { groupMutationFor } from "./group";
import { offsetTable } from "./pattern";
import { handleElementId } from "./batch-handles";
import { SPREAD_ORIGIN, spreadTableOf, type PageOrigin } from "../page-origin";
import { announceRecipeChange, linkIndex } from "../link-index";
import {
  engineBreakSymbolLinks,
  engineDefineSymbol,
  engineDeleteSymbol,
  enginePlaceSymbol,
  engineRedefineSymbol,
  engineRenameSymbol,
  engineReplaceSymbol,
  engineResetSymbolTransforms,
  engineSymbolOptions,
  chooseSymbol,
  currentSymbol,
  readEngineSymbols,
} from "./symbols-engine";

import { registerCommand } from "../command-registry";
import {
  readRecipeBytes,
  writeRecipeBytes,
  type RecipeHost,
} from "../recipe-store";
import { defineMessages } from "@paged-media/strings";

/** Command titles, message keys `registerCommand` reads in the editor's locale. */
const M = defineMessages("draw.symbols", {
  define: "Symbols: Define symbol from selection",
  place: "Symbols: Place instance",
  redefine: "Symbols: Redefine from selection (rebuilds every instance)",
  breakLink: "Symbols: Break link (keep the artwork)",
  resetTransform: "Symbols: Reset transform (re-emit the definition in place)",
  rename: "Symbols: Rename symbol",
  delete: "Symbols: Delete symbol (the placed artwork stays)",
  replace: "Symbols: Replace symbol of the selected instances",
  options: "Symbols: Symbol options…",
});
export const SYMBOLS_COMMAND_CATEGORY = "Symbols";

export const DEFINE_SYMBOL_COMMAND_ID = "media.paged.draw.command.defineSymbol";
export const PLACE_SYMBOL_COMMAND_ID =
  "media.paged.draw.command.placeSymbolInstance";
export const REDEFINE_SYMBOL_COMMAND_ID =
  "media.paged.draw.command.redefineSymbol";
export const BREAK_SYMBOL_LINK_COMMAND_ID =
  "media.paged.draw.command.breakSymbolLink";
export const RESET_SYMBOL_TRANSFORM_COMMAND_ID =
  "media.paged.draw.command.resetSymbolTransform";
export const RENAME_SYMBOL_COMMAND_ID = "media.paged.draw.command.renameSymbol";
export const DELETE_SYMBOL_COMMAND_ID = "media.paged.draw.command.deleteSymbol";
/** WP6.8 (draw ADR 365) — Replace Symbol and Symbol Options, engine lane. */
export const REPLACE_SYMBOL_COMMAND_ID =
  "media.paged.draw.command.replaceSymbol";
export const SYMBOL_OPTIONS_COMMAND_ID =
  "media.paged.draw.command.symbolOptions";

/** The published binding Symbol Options… raises the panel's options
 *  section through (`shell.openPanel` takes a panel id and nothing else). */
export const BIND_SYMBOL_OPTIONS_FOCUS = "media.paged.draw.symbols.options";

/** The contributed command ids, in registration order. */
export const SYMBOLS_COMMAND_IDS = [
  DEFINE_SYMBOL_COMMAND_ID,
  PLACE_SYMBOL_COMMAND_ID,
  REDEFINE_SYMBOL_COMMAND_ID,
  BREAK_SYMBOL_LINK_COMMAND_ID,
  RESET_SYMBOL_TRANSFORM_COMMAND_ID,
  RENAME_SYMBOL_COMMAND_ID,
  DELETE_SYMBOL_COMMAND_ID,
  REPLACE_SYMBOL_COMMAND_ID,
  SYMBOL_OPTIONS_COMMAND_ID,
];

/** The container part this library lives in, RELATIVE to this plugin's
 *  `paged/media.paged.draw/` namespace (the host prepends it). */
export const SYMBOLS_PART = "symbols.json";

/** The library envelope version (an unknown version reads as an EMPTY
 *  library rather than a crash — the graphic-styles convention). */
export const SYMBOLS_LIBRARY_VERSION = 1;

// ---------------------------------------------------------------- model

/** The nine-point registration grid (catalog §16.1), in reading order. */
export const SYMBOL_REGISTRATIONS = [
  "topLeft",
  "top",
  "topRight",
  "left",
  "center",
  "right",
  "bottomLeft",
  "bottom",
  "bottomRight",
] as const;

export type SymbolRegistration = (typeof SYMBOL_REGISTRATIONS)[number];

export const DEFAULT_SYMBOL_REGISTRATION: SymbolRegistration = "center";

/** One source element's contribution to a definition. */
export interface SymbolPiece {
  /** DEFINITION-space contours (registration point at the origin).
   *  Compound-aware: a ring keeps its hole. */
  table: AnchorTable;
  paint: CompoundPaint;
}

/** One named symbol in the library. */
export interface SymbolDefinition {
  /** Stable, library-local id (`sym-1`, `sym-2`, …). An instance leaf
   *  stores THIS and nothing else, so a rename is library-only. */
  id: string;
  name: string;
  registration: SymbolRegistration;
  /** The page-space registration point the definition was captured at —
   *  provenance, and the default placement origin. */
  origin: [number, number];
  pieces: SymbolPiece[];
}

/** The whole library — one container part. */
export interface SymbolLibrary {
  v: number;
  symbols: SymbolDefinition[];
  /** WP6.8 (draw ADR 365) — the symbols already moved onto the engine's
   *  store, library id → engine symbol id (`commands/symbols-migrate.ts`):
   *  a migrated library is kept, never migrated twice. */
  migrated?: Record<string, string>;
}

/** The link an instance LEAF carries. Every leaf of an instance carries
 *  one (a group cannot hold metadata — see the module header). */
export interface SymbolInstanceRef {
  symbol: string;
  instance: string;
  piece: number;
  /** The page-space registration point this instance was placed/rebuilt
   *  at — the fallback origin when the live geometry is unreadable
   *  (the C-23 pasteboard case). */
  origin: [number, number];
}

const emptyLibrary = (): SymbolLibrary => ({
  v: SYMBOLS_LIBRARY_VERSION,
  symbols: [],
});

// ------------------------------------------------------- pure: parsing

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const point = (v: unknown): [number, number] | null => {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [x, y] = v;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  return [x, y];
};

/** Read an anchor table out of any shape, tolerantly. Null when the
 *  shape carries no usable anchors (a definition with an unreadable
 *  piece is dropped rather than half-restored). */
export function parseAnchorTable(raw: unknown): AnchorTable | null {
  const t = (raw ?? {}) as Partial<AnchorTable>;
  if (!Array.isArray(t.anchors) || t.anchors.length < 2) return null;
  const anchors: {
    anchor: [number, number];
    left: [number, number];
    right: [number, number];
  }[] = [];
  for (const entry of t.anchors) {
    const a = (entry ?? {}) as Record<string, unknown>;
    const anchor = point(a.anchor);
    if (!anchor) return null;
    anchors.push({
      anchor,
      left: point(a.left) ?? [anchor[0], anchor[1]],
      right: point(a.right) ?? [anchor[0], anchor[1]],
    });
  }
  const starts = Array.isArray(t.subpathStarts)
    ? t.subpathStarts.filter((n): n is number => typeof n === "number")
    : [];
  const open = Array.isArray(t.subpathOpen)
    ? t.subpathOpen.filter((b): b is boolean => typeof b === "boolean")
    : undefined;
  return {
    anchors,
    subpathStarts: starts.length > 0 ? starts : [0],
    ...(open && open.length > 0 ? { subpathOpen: open } : {}),
  };
}

/** Read a paint out of any shape, tolerantly. */
export function parseSymbolPaint(raw: unknown): CompoundPaint {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    fill: strOrNull(p.fill),
    stroke: strOrNull(p.stroke),
    weight:
      typeof p.weight === "number" && Number.isFinite(p.weight)
        ? p.weight
        : null,
  };
}

const registrationOf = (raw: unknown): SymbolRegistration =>
  SYMBOL_REGISTRATIONS.includes(raw as SymbolRegistration)
    ? (raw as SymbolRegistration)
    : DEFAULT_SYMBOL_REGISTRATION;

/** Parse the library part's bytes. Anything unreadable — absent bytes,
 *  invalid JSON, a future `v` — reads as an EMPTY library: a symbol
 *  library that fails to parse must never take the document with it. */
export function parseSymbolLibrary(bytes: Uint8Array | null): SymbolLibrary {
  if (!bytes || bytes.byteLength === 0) return emptyLibrary();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return emptyLibrary();
  }
  const lib = raw as Partial<SymbolLibrary> | null;
  if (!lib || typeof lib !== "object") return emptyLibrary();
  if (lib.v !== SYMBOLS_LIBRARY_VERSION) return emptyLibrary();
  const symbols: SymbolDefinition[] = [];
  for (const entry of Array.isArray(lib.symbols) ? lib.symbols : []) {
    const s = (entry ?? {}) as Partial<SymbolDefinition>;
    if (typeof s.id !== "string" || s.id.length === 0) continue;
    const pieces: SymbolPiece[] = [];
    for (const p of Array.isArray(s.pieces) ? s.pieces : []) {
      const table = parseAnchorTable((p as Partial<SymbolPiece>)?.table);
      if (!table) continue;
      pieces.push({
        table,
        paint: parseSymbolPaint((p as SymbolPiece)?.paint),
      });
    }
    symbols.push({
      id: s.id,
      name: typeof s.name === "string" && s.name.length > 0 ? s.name : s.id,
      registration: registrationOf(s.registration),
      origin: point(s.origin) ?? [0, 0],
      pieces,
    });
  }
  const migrated: Record<string, string> = {};
  const m = (lib as { migrated?: unknown }).migrated;
  if (m && typeof m === "object" && !Array.isArray(m)) {
    for (const [k, v] of Object.entries(m as Record<string, unknown>))
      if (typeof v === "string" && v.length > 0) migrated[k] = v;
  }
  return Object.keys(migrated).length > 0
    ? { v: SYMBOLS_LIBRARY_VERSION, symbols, migrated }
    : { v: SYMBOLS_LIBRARY_VERSION, symbols };
}

/** Serialize the library to the part's bytes — indented, because the
 *  `spec` role's whole point is that it stays small and DIFFABLE. */
export function serializeSymbolLibrary(library: SymbolLibrary): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      {
        v: SYMBOLS_LIBRARY_VERSION,
        symbols: library.symbols,
        ...(library.migrated && Object.keys(library.migrated).length > 0
          ? { migrated: library.migrated }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
}

// ------------------------------------------------- pure: library edits

// --------------------------------------------- pure: bounds + anchoring

/** The nine-point registration grid resolved against `bounds`
 *  (`[minX, minY, maxX, maxY]`). Pure. */
export function registrationPointOf(
  bounds: readonly [number, number, number, number],
  registration: SymbolRegistration,
): [number, number] {
  const [minX, minY, maxX, maxY] = bounds;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const x =
    registration === "topLeft" ||
    registration === "left" ||
    registration === "bottomLeft"
      ? minX
      : registration === "topRight" ||
          registration === "right" ||
          registration === "bottomRight"
        ? maxX
        : midX;
  const y =
    registration === "topLeft" ||
    registration === "top" ||
    registration === "topRight"
      ? minY
      : registration === "bottomLeft" ||
          registration === "bottom" ||
          registration === "bottomRight"
        ? maxY
        : midY;
  return [x, y];
}

// ----------------------------------------------- pure: the element link

/** Read the instance link out of an envelope, or null. Tolerant of
 *  partial/foreign shapes (the `appearanceBakeOf` convention). */
export function symbolInstanceOf(
  env: PluginMetadataEnvelope | null,
): SymbolInstanceRef | null {
  const raw = (env?.data as { symbolInstance?: unknown } | undefined)
    ?.symbolInstance;
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<SymbolInstanceRef>;
  if (typeof r.symbol !== "string" || r.symbol.length === 0) return null;
  if (typeof r.instance !== "string" || r.instance.length === 0) return null;
  return {
    symbol: r.symbol,
    instance: r.instance,
    piece: num(r.piece, 0),
    origin: point(r.origin) ?? [0, 0],
  };
}

// ------------------------------------------------------- pure: the plan

/** Everything the two place/rebuild batches need, resolved once. Pure
 *  data — the conformance spec builds one by hand. */
export interface SymbolPlacePlan {
  pageId: string;
  /** That page's origin in its spread when a geometry read on it supplied
   *  one (a rebuild); absent = `[0, 0]`. A compound piece's `framePath`
   *  table is moved by it (`../page-origin.ts`). */
  pageOrigin?: PageOrigin;
  symbolId: string;
  instanceId: string;
  /** The page-space registration point the instance is anchored at. */
  origin: [number, number];
  /** PAGE-space pieces (definition space + origin). */
  pieces: SymbolPiece[];
}

/** Resolve a definition + an origin into a placement plan. Pure. */
export function symbolPlacePlanFor(args: {
  symbol: SymbolDefinition;
  pageId: string;
  pageOrigin?: PageOrigin;
  instanceId: string;
  origin: readonly [number, number];
}): SymbolPlacePlan {
  return {
    pageId: args.pageId,
    ...(args.pageOrigin ? { pageOrigin: args.pageOrigin } : {}),
    symbolId: args.symbol.id,
    instanceId: args.instanceId,
    origin: [args.origin[0], args.origin[1]],
    pieces: args.symbol.pieces.map((p) => ({
      table: offsetTable(p.table, args.origin[0], args.origin[1]),
      paint: { ...p.paint },
    })),
  };
}

/** How many contours each piece of a plan inserts (a compound piece
 *  inserts one path per contour and is re-merged afterwards). Pure. */
export function symbolContourCounts(plan: SymbolPlacePlan): number[] {
  return plan.pieces.map((p) => splitCompound(p.table).length);
}

/** What the finish batch resolved each piece to: the surviving element
 *  and the contour elements it absorbs. */
export interface SymbolPieceBinding {
  pieceIndex: number;
  keep: ElementId;
  absorb: ElementId[];
}

// ------------------------------------------------------- wire builders
// Exported so the specs assert the EXACT wire shapes the migration emits.

/** What a REBUILD replaces: the old instance's wrapper group (if any)
 *  and its leaves (see {@link symbolFinishBatchFor}). */
export interface SymbolReplacement {
  group: ElementId | null;
  stale: readonly ElementId[];
}

const colorRef = (
  elementId: ElementId,
  path: "frameFillColor" | "frameStrokeColor",
  value: string | null,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "colorRef", value } },
});

/** THE FINISH of one instance — for a REBUILD, tear the old instance
 *  down FIRST (dissolve its group, delete its leaves); then re-merge
 *  every compound piece through the SAME `framePath` door Make Compound
 *  Path uses, paint each surviving leaf, stamp the instance link on it,
 *  and (for a multi-piece symbol only) wrap the leaves in one group.
 *  The migration takes these ops over handle bindings
 *  ({@link symbolHandleBindings}). */
export function symbolFinishBatchFor(args: {
  plan: SymbolPlacePlan;
  bindings: readonly SymbolPieceBinding[];
  replace?: SymbolReplacement;
}): Mutation {
  const ops: Mutation[] = [];
  if (args.replace?.group && typeof args.replace.group.id === "string") {
    ops.push({ op: "dissolveGroup", args: { groupId: args.replace.group.id } });
  }
  for (const id of args.replace?.stale ?? []) {
    if (typeof id.id === "string") {
      ops.push({ op: "deleteFrame", args: { frameId: id.id } });
    }
  }
  for (const binding of args.bindings) {
    const piece = args.plan.pieces[binding.pieceIndex];
    if (!piece) continue;
    if (binding.absorb.length > 0) {
      // A compound piece came in as N separate paths; put the contours
      // back on the first one and drop the rest. `framePath` stores the
      // table as given, where `insertPath` added the page's origin: so the
      // page-space table gets that origin too.
      ops.push(
        framePathMutationFor(
          binding.keep,
          spreadTableOf(piece.table, args.plan.pageOrigin ?? SPREAD_ORIGIN),
        ),
      );
      for (const id of binding.absorb) {
        ops.push({ op: "deleteFrame", args: { frameId: id.id as string } });
      }
    }
    ops.push(colorRef(binding.keep, "frameFillColor", piece.paint.fill));
    ops.push(colorRef(binding.keep, "frameStrokeColor", piece.paint.stroke));
    if (typeof piece.paint.weight === "number") {
      ops.push({
        op: "setElementProperty",
        args: {
          elementId: binding.keep,
          path: "frameStrokeWeight",
          value: { type: "length", value: piece.paint.weight },
        },
      });
    }
    ops.push(
      stampDrawMetadata(binding.keep, {
        v: 1,
        data: {
          symbolInstance: {
            symbol: args.plan.symbolId,
            instance: args.plan.instanceId,
            piece: binding.pieceIndex,
            origin: args.plan.origin,
          } satisfies SymbolInstanceRef,
        },
      }),
    );
  }
  // A ONE-piece symbol is not wrapped: a `createGroup` of a single member
  // would be a group that exists to hold nothing, and the link already
  // lives on the leaf.
  if (args.bindings.length > 1) {
    ops.push(groupMutationFor(args.bindings.map((b) => b.keep)));
  }
  return { op: "batch", args: { ops } };
}

/** The batch-local handle of build `build`'s piece `piece`, contour
 *  `contour`. Deterministic, so the conformance spec asserts the exact
 *  wire. Pure. */
export const symbolHandle = (
  build: number,
  piece: number,
  contour: number,
): string => `sy${build}_${piece}_${contour}`;

/** What the one batch resolves each piece of build `build` to: its first
 *  contour's handle survives, the rest are absorbed into it. Pure. */
export function symbolHandleBindings(
  plan: SymbolPlacePlan,
  build: number,
): SymbolPieceBinding[] {
  return symbolContourCounts(plan).map((count, pieceIndex) => ({
    pieceIndex,
    keep: handleElementId(symbolHandle(build, pieceIndex, 0)),
    absorb: Array.from({ length: count - 1 }, (_, c) =>
      handleElementId(symbolHandle(build, pieceIndex, c + 1)),
    ),
  }));
}

// -------------------------------------------------------- host: the part

type PartsHost = RecipeHost;

/** Read the library out of the container part (a read failure reads as
 *  an EMPTY library and WARNS). */
export async function readSymbolLibrary(
  host: PartsHost,
): Promise<SymbolLibrary> {
  try {
    return parseSymbolLibrary(await readRecipeBytes(host, SYMBOLS_PART));
  } catch (e) {
    host.log.warn(`symbols: library read failed (${String(e)})`);
    return emptyLibrary();
  }
}

/** Write the library back. `false` = the write was refused — logged,
 *  never thrown. */
export async function writeSymbolLibrary(
  host: PartsHost,
  library: SymbolLibrary,
): Promise<boolean> {
  try {
    await writeRecipeBytes(host, SYMBOLS_PART, serializeSymbolLibrary(library));
    // A part write is not a document event — and Define and Rename write
    // NOTHING else, so without this an open panel hears nothing at all.
    announceRecipeChange(host);
    return true;
  } catch (e) {
    host.log.warn(`symbols: library write failed (${String(e)})`);
    return false;
  }
}

// -------------------------------------------------- host: instance reads

/** One live instance in the document. */
export interface SymbolInstance {
  symbol: string;
  instance: string;
  /** The origin RECORDED on its leaves (the C-23 fallback). */
  origin: [number, number];
  /** Its leaves, in piece order. */
  leaves: ElementId[];
}

/** Every symbol instance in the document (optionally only those of
 *  `symbolId`), in tree order — a parse of the shared link index
 *  (`../link-index`), which walks the document once per revision for
 *  every feature at once. */
export async function symbolInstances(
  host: BundleHost,
  symbolId?: string,
): Promise<SymbolInstance[]> {
  const { linked } = await linkIndex(host).snapshot();
  const byInstance = new Map<
    string,
    { instance: SymbolInstance; pieces: number[] }
  >();
  for (const { id, envelope: env } of linked) {
    const ref = symbolInstanceOf(env);
    if (!ref) continue;
    if (symbolId !== undefined && ref.symbol !== symbolId) continue;
    const found = byInstance.get(ref.instance);
    if (found) {
      found.instance.leaves.push(id);
      found.pieces.push(ref.piece);
    } else {
      byInstance.set(ref.instance, {
        instance: {
          symbol: ref.symbol,
          instance: ref.instance,
          origin: ref.origin,
          leaves: [id],
        },
        pieces: [ref.piece],
      });
    }
  }
  const out: SymbolInstance[] = [];
  for (const { instance, pieces } of byInstance.values()) {
    const order = instance.leaves
      .map((id, i) => ({ id, piece: pieces[i]! }))
      .sort((a, b) => a.piece - b.piece);
    out.push({ ...instance, leaves: order.map((o) => o.id) });
  }
  return out;
}

// ------------------------------------------------------------- appliers

/** DEFINE — capture the selection into a NEW library symbol. The
 *  document is not touched (the selection is not converted), so this
 *  costs ZERO undo steps. Returns the symbol, or null on a refusal. */
export async function applyDefineSymbol(
  host: BundleHost,
  payload?: { name?: unknown; registration?: unknown },
): Promise<SymbolDefinition | null> {
  const label = DEFINE_SYMBOL_COMMAND_ID;
  const name =
    typeof payload?.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim()
      : null;
  const id = await engineDefineSymbol(host, label, name);
  return id ? engineDefinition(host, id) : null;
}

/** An engine symbol in this module's definition shape: the engine keeps
 *  the artwork, so it has no pieces here, and its registration point is
 *  the centre (engine ADR 1039). */
async function engineDefinition(
  host: BundleHost,
  id: string,
): Promise<SymbolDefinition | null> {
  const found = (await readEngineSymbols(host)).find((s) => s.id === id);
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    registration: "center",
    origin: [0, 0],
    pieces: [],
  };
}

/** PLACE — emit one instance of `symbolId`. The payload may carry a page
 *  point `{ x, y }` (default: the definition's capture origin) and a
 *  `pageId` (default: the active page). Returns the created leaves. */
export async function applyPlaceSymbolInstance(
  host: BundleHost,
  symbolId: unknown,
  payload?: { x?: unknown; y?: unknown; pageId?: unknown },
): Promise<ElementId[]> {
  const label = PLACE_SYMBOL_COMMAND_ID;
  if (typeof symbolId !== "string" || symbolId.length === 0) {
    host.log.warn(`${label}: no symbolId in the payload — no-op`);
    return [];
  }
  return enginePlaceSymbol(host, label, symbolId, payload ?? {});
}

/** RESET TRANSFORM — rebuild every selected instance from its unchanged
 *  definition, re-anchored at its CURRENT registration point. Whatever
 *  transform or edit the artwork picked up is discarded; the position
 *  survives. ONE undo step for every selected instance together. */
export async function applyResetSymbolTransform(
  host: BundleHost,
): Promise<number> {
  const label = RESET_SYMBOL_TRANSFORM_COMMAND_ID;
  return engineResetSymbolTransforms(host, label);
}

/** REDEFINE — re-capture `symbolId` from the selection (same id, name and
 *  registration), then REBUILD every instance in the document at its
 *  current position. Returns the new definition, or null on a refusal. */
export async function applyRedefineSymbol(
  host: BundleHost,
  symbolId: unknown,
): Promise<SymbolDefinition | null> {
  const label = REDEFINE_SYMBOL_COMMAND_ID;
  if (typeof symbolId !== "string" || symbolId.length === 0) {
    host.log.warn(`${label}: no symbolId in the payload — no-op`);
    return null;
  }
  return (await engineRedefineSymbol(host, label, symbolId))
    ? engineDefinition(host, symbolId)
    : null;
}

/** BREAK LINK — drop the reference from every selected instance, keeping
 *  the artwork (and its group) exactly as it is. ONE batch ⇒ ONE undo
 *  step for the whole selection. */
export async function applyBreakSymbolLink(host: BundleHost): Promise<number> {
  const label = BREAK_SYMBOL_LINK_COMMAND_ID;
  return engineBreakSymbolLinks(host, label);
}

/** RENAME — library-only, because an instance leaf stores the id and
 *  nothing else. No document mutation, so NOTHING to undo. */
export async function applyRenameSymbol(
  host: BundleHost,
  symbolId: unknown,
  name: unknown,
): Promise<boolean> {
  const label = RENAME_SYMBOL_COMMAND_ID;
  if (typeof symbolId !== "string" || symbolId.length === 0) {
    host.log.warn(`${label}: no symbolId in the payload — no-op`);
    return false;
  }
  const next = typeof name === "string" ? name.trim() : "";
  if (next.length === 0) {
    host.log.warn(`${label}: no (non-empty) name in the payload — no-op`);
    return false;
  }
  return engineRenameSymbol(host, label, symbolId, next);
}

/** DELETE — unlink every instance FIRST (one batch, so no artwork is
 *  left pointing at a symbol that is gone), then drop it from the
 *  library. The artwork STAYS: deleting a symbol is not deleting a page. */
export async function applyDeleteSymbol(
  host: BundleHost,
  symbolId: unknown,
): Promise<boolean> {
  const label = DELETE_SYMBOL_COMMAND_ID;
  if (typeof symbolId !== "string" || symbolId.length === 0) {
    host.log.warn(`${label}: no symbolId in the payload — no-op`);
    return false;
  }
  return engineDeleteSymbol(host, label, symbolId);
}

// ------------------------------------------------------------- commands

const payloadOf = (payload: unknown): Record<string, unknown> =>
  payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};

/** Register the seven symbol commands. Payloads:
 *  define `{ name?, registration? }`, place `{ symbolId, x?, y?, pageId? }`,
 *  redefine/delete `{ symbolId }`, rename `{ symbolId, name }`,
 *  break link / reset transform — none. */
/** REPLACE SYMBOL (engine lane) — every selected instance draws
 *  `symbolId` (absent: the Symbols panel's chosen symbol) from now on,
 *  keeping its id, transform and overrides. One undo step. Answers how
 *  many instances changed. */
export async function applyReplaceSymbol(
  host: BundleHost,
  symbolId?: unknown,
): Promise<number> {
  const label = "replaceSymbol";
  const id =
    typeof symbolId === "string" && symbolId.length > 0
      ? symbolId
      : (await currentSymbol(host))?.id;
  if (!id) {
    host.log.warn(`${label}: the document has no symbol`);
    return 0;
  }
  return engineReplaceSymbol(host, label, id);
}

/** SYMBOL OPTIONS — with values (`{ symbolId?, name?, nineSlice? }`,
 *  `nineSlice` `[left, top, right, bottom]` insets, `null` or `[]` to
 *  remove)
 *  it applies them in one undo step; bare (a menu row) it raises the
 *  Symbols panel at its options for the current symbol. */
export async function applySymbolOptions(
  host: BundleHost,
  payload: unknown,
): Promise<boolean> {
  const label = "symbolOptions";
  const p = payloadOf(payload) as {
    symbolId?: unknown;
    name?: unknown;
    nineSlice?: unknown;
  };
  const symbol =
    typeof p.symbolId === "string" && p.symbolId.length > 0
      ? ((await readEngineSymbols(host)).find((s) => s.id === p.symbolId) ??
        null)
      : await currentSymbol(host);
  if (!symbol) {
    host.log.warn(`${label}: no such symbol`);
    return false;
  }
  // `[]` (the typed twin's "none") removes the guides, as `null` does.
  const nine =
    Array.isArray(p.nineSlice) && p.nineSlice.length === 0 ? null : p.nineSlice;
  const hasNine =
    nine === null ||
    (Array.isArray(nine) &&
      nine.length === 4 &&
      nine.every((v) => typeof v === "number" && Number.isFinite(v)));
  if (typeof p.name !== "string" && !hasNine) {
    chooseSymbol(host, symbol.id);
    if (!host.supports("shell.openPanel@1")) {
      host.log.info(
        `${label}: this host cannot raise a panel — pass { name, nineSlice } to apply options`,
      );
      return false;
    }
    const last = host.bindings.get(BIND_SYMBOL_OPTIONS_FOCUS) as
      { seq?: number } | undefined;
    host.bindings.publish(BIND_SYMBOL_OPTIONS_FOCUS, {
      symbolId: symbol.id,
      seq: (typeof last?.seq === "number" ? last.seq : 0) + 1,
    });
    host.shell.openPanel(SYMBOLS_PANEL_ID);
    return true;
  }
  return engineSymbolOptions(host, label, symbol.id, {
    ...(typeof p.name === "string" ? { name: p.name } : {}),
    ...(hasNine
      ? {
          nineSlice:
            nine === null ? null : (nine as [number, number, number, number]),
        }
      : {}),
  });
}

/** The Symbols panel's id (`../panels/symbols-panel.tsx` re-exports it). */
export const SYMBOLS_PANEL_ID = "media.paged.draw.panel.symbols";

export function contributeSymbolCommands(host: BundleHost): Disposable {
  const disposers = [
    registerCommand(host, {
      id: DEFINE_SYMBOL_COMMAND_ID,
      title: M.define,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyDefineSymbol(host, payloadOf(payload)).then(() => undefined),
    }),
    registerCommand(host, {
      id: PLACE_SYMBOL_COMMAND_ID,
      title: M.place,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) => {
        const p = payloadOf(payload);
        return applyPlaceSymbolInstance(host, p.symbolId, p).then(
          () => undefined,
        );
      },
    }),
    registerCommand(host, {
      id: REDEFINE_SYMBOL_COMMAND_ID,
      title: M.redefine,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyRedefineSymbol(host, payloadOf(payload).symbolId).then(
          () => undefined,
        ),
    }),
    registerCommand(host, {
      id: BREAK_SYMBOL_LINK_COMMAND_ID,
      title: M.breakLink,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: () => applyBreakSymbolLink(host).then(() => undefined),
    }),
    registerCommand(host, {
      id: RESET_SYMBOL_TRANSFORM_COMMAND_ID,
      title: M.resetTransform,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: () => applyResetSymbolTransform(host).then(() => undefined),
    }),
    registerCommand(host, {
      id: RENAME_SYMBOL_COMMAND_ID,
      title: M.rename,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) => {
        const p = payloadOf(payload);
        return applyRenameSymbol(host, p.symbolId, p.name).then(
          () => undefined,
        );
      },
    }),
    registerCommand(host, {
      id: DELETE_SYMBOL_COMMAND_ID,
      title: M.delete,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyDeleteSymbol(host, payloadOf(payload).symbolId).then(
          () => undefined,
        ),
    }),
    registerCommand(host, {
      id: REPLACE_SYMBOL_COMMAND_ID,
      title: M.replace,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyReplaceSymbol(host, payloadOf(payload).symbolId).then(
          () => undefined,
        ),
    }),
    registerCommand(host, {
      id: SYMBOL_OPTIONS_COMMAND_ID,
      title: M.options,
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applySymbolOptions(host, payload).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
