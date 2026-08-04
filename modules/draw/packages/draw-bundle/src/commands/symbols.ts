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

// SYMBOLS v0 (Illustrator catalog, Phase 2; §16.1 registration points) —
// a named, reusable DEFINITION plus INSTANCES that follow it.
//
// Read this header before believing the feature name: a symbol here is
// entirely a PLUGIN construct, and one instance verb is a rebuild rather
// than a live reference.
//
// -------------------------------------------------- why it is plugin-side
// THE ENGINE HAS NO SYMBOL/INSTANCE PRIMITIVE, and neither does IDML.
// `grep -rni "symbol|instance"` across `paged-model`, `paged-scene`,
// `paged-mutate` and `idml-import` finds exactly one hit —
// `TextVariableInstance`, an unrelated text field. There is no "place a
// reference to this artwork" node in the model, none in the format, and
// none on the wire. So a symbol library is a document-resident PLUGIN
// record and an instance is real page artwork stamped with a link, the
// same shape `commands/graphic-styles.ts` uses for a linked appearance
// and `commands/pattern.ts` uses for a baked field. No core op was
// invented for this.
//
// AN INSTANCE IS RE-EMITTED, NOT DUPLICATED. There is no
// `duplicateElement` op anywhere in the `Mutation` union (checked: the
// union's creating arms are `insertFrame` / `insertTextFrame` /
// `insertLine` / `insertPath` / `insertOval` / `insertTable` /
// `insertPage` / `duplicatePage` — no element-level duplicate). So
// placing an instance re-emits its geometry through `insertPath`, which
// mints POLYGONS. Two consequences, stated rather than hidden:
//   · a TEXT FRAME cannot be part of a symbol. Its story cannot be
//     copied by any op the contract exposes, so a selected text frame is
//     REFUSED at define time with a diagnostic — never silently dropped
//     into a shape that would lose its words.
//   · an instance carries GEOMETRY + FLAT PAINT only. A rectangle's live
//     corners, a placed image's content, a gradient's stops and the
//     `appearance` metadata stack do not ride along.
//
// A GROUP CANNOT CARRY THE LINK. `setPluginMetadata` resolves through
// core's `find_spread_for_leaf`, whose arms are TextFrame | Rectangle |
// Oval | GraphicLine | Polygon — a group id answers `notImplemented`.
// So the instance record lives on every LEAF of the instance (the
// `appearance-bake.ts` carrier-leaf technique), and the group is only a
// convenience wrapper. A one-piece symbol is NOT wrapped at all: a
// `createGroup` of one member would be a group that exists purely to
// hold nothing.
//
// ------------------------------------------------------ the two shapes
// THE LIBRARY (one container part, `paged/media.paged.draw/symbols.json`,
// declared in `contributes.partTypes` as
// `{ type: "symbolLibrary", role: "spec", format: "json" }`):
//
//   { "v": 1, "symbols": [ { "id": "sym-1", "name": "Bolt",
//       "registration": "center",
//       "origin": [x, y],            // where it was captured, page pt
//       "pieces": [ { "table": { anchors, subpathStarts, subpathOpen },
//                     "paint": { fill, stroke, weight } } ] } ] }
//
// Piece tables are in DEFINITION SPACE: the captured page-space contours
// translated so the REGISTRATION POINT sits at the origin. That is what
// makes "place at (x, y)" and "reset in place" both mean something
// exact. `host.storage` could not hold this (it is localStorage-backed
// and per-browser — it does not travel with the file) and element
// metadata could not either (it is per-element, and there is no
// document-level metadata slot), which is the same reasoning
// `graphic-styles.ts` records for its library.
//
// THE LINK (on each instance leaf's own `x-paged:media.paged.draw`
// envelope, alongside `appearance`):
//
//   data.symbolInstance = { symbol: "sym-1", instance: "si-1",
//                           piece: 0, origin: [x, y] }
//
// `instance` is stable ACROSS A REBUILD — redefine and reset destroy and
// re-emit an instance's leaves, and the instance keeps its identity
// because the id is carried forward, not re-minted.
//
// ------------------------------------------------ registration points
// The catalog's §16.1 registration point is the nine-point grid over the
// definition's bounds (`center` by default). It is the point an instance
// is PLACED at, and the point a RESET re-anchors to. Bounds are the hull
// of every control point (anchor + both handles) of every piece —
// deterministic, and computed from the stored tables rather than from a
// page-keyed door.
//
// ----------------------------------------------- what the verbs mean
// · DEFINE captures the selection (groups expanded to their leaves) and
//   writes the library. It does NOT touch the document — the selection
//   is not converted into an instance — so define costs ZERO undo steps.
// · PLACE re-emits the definition at an origin (payload `{x, y}`,
//   defaulting to the capture origin) on the active page.
// · REDEFINE re-captures from the selection under the SAME id and name,
//   then REBUILDS every instance in the document at its current position.
// · RESET TRANSFORM rebuilds ONE instance from the unchanged definition:
//   whatever scaling/rotation/edit its artwork picked up is discarded and
//   the definition's own shape is re-anchored at the instance's CURRENT
//   registration point (derived from its live bounds). Position survives,
//   shape does not — which is precisely Illustrator's meaning.
// · BREAK LINK drops the reference from every leaf and leaves the
//   artwork exactly where it is (the graphic-styles precedent).
//
// MUTATION / UNDO SHAPE (probed against the booted engine; the RFI C-15
// rule — assert the real count, never claim "one"):
//   · define            = 0 document mutations (library only).
//   · rename            = 0 document mutations (the leaf stores the id,
//                         so a rename never walks the document).
//   · place             = TWO batches ⇒ 2 undo steps.
//   · reset / rebuild   = TWO batches ⇒ 2 undo steps PER INSTANCE.
//   · redefine          = 2 × (instances) undo steps; the library write
//                         itself is not on the undo stack.
//   · break link        = ONE batch ⇒ 1 undo step for the whole selection.
//   · delete            = ONE batch ⇒ 1 undo step (every follower of the
//                         symbol is unlinked together).
//
// A REBUILD IS STILL TWO BATCHES, not three, and the reason is a measured
// engine constraint rather than a preference: a batch that DELETES and
// then INSERTS is refused — the insert's z-position resolves against the
// spread length the batch STARTED with, so the child fails with
// `notImplemented` / `position 4 out of range for parent Spread("us")
// (len 3)` and the whole atomic batch rolls back. So the teardown
// (dissolve + delete) rides BATCH 2, which contains no inserts, next to
// the deletes the compound re-merge already performs.
//
// WHY PLACE IS STILL TWO BATCHES, given RFI C-15 LANDED (core b8e2b6b,
// 2026-08-04). C-15 does let a batch address an id an earlier child
// minted — `bindCreated { handle }` plus `$h:` references — and the
// locally-synced engine wasm speaks it. It is NOT reachable from here:
// `@paged-media/plugin-api`'s `Mutation` union has no `bindCreated` arm
// (checked in the published 0.2.25-canary.0 AND in plugin-sdk's
// unpublished HEAD source), and this repo's rule is that the contract
// package is the only sanctioned import — emitting an op the union does
// not carry would be a cast around the §12.3 wire-compat alarm, and it
// would only work against a locally-overridden engine anyway. So the
// floor here is the same two batches `pattern.ts` and
// `appearance-bake.ts` record, and it stays two until the contract
// carries the op. Recorded rather than worked around.
//
// ------------------------------------------------------------- limits
// · THE LIBRARY IS NOT UNDOABLE. `host.parts.write` is a container
//   write, not an engine `Mutation` (probed in the graphic-styles spec:
//   an undo after a part write unwinds the mutation and leaves the part).
//   Define / rename / delete change the library outside the undo stack.
// · PAGE-KEYED GEOMETRY (RFI C-23). `pathAnchors` and `elementGeometry`
//   are page-keyed: an element positioned outside every page's bounds
//   belongs to no page and BOTH doors answer nothing. An instance placed
//   on the pasteboard is therefore a real element that cannot be
//   measured. Handled deliberately, not mutely: place WARNS when the
//   leaves it just made are unreadable, and reset/redefine fall back to
//   the instance's RECORDED origin (with a warn) instead of computing a
//   live one — so a pasteboard instance still rebuilds, in place.
// · REBUILD MINTS NEW ELEMENT IDS. A redefine or a reset replaces an
//   instance's leaves, so any OTHER plugin's metadata on those leaves,
//   and anything holding their ids, does not survive. The instance id
//   does.
// · Z-ORDER: inserted items land at the top of the page's z-order (the
//   insert-lane fact `appearance-bake.ts` also records), so a rebuilt
//   instance comes back on top of unrelated artwork.
//
// EXPLICITLY OUT OF v0 — named here so the command titles cannot imply
// them:
//   · the eight SYMBOL-SET tools (Sprayer / Shifter / Scruncher / Sizer /
//     Spinner / Stainer / Screener / Styler) are catalog P2. They need a
//     symbol-SET object — one page item holding many instances — plus,
//     in the catalog's own words, "stochastic placement",
//     "symbol-set deformation" and "density-field simulation". None of
//     that exists here and none of it is faked.
//   · NINE-SLICE SCALING (§16.1): there is no scale-grid on an instance
//     and no 9-slice in the format; an instance is re-emitted geometry.
//   · 3D MAPPING: there is no 3D lane in this engine at all.
//   · DYNAMIC symbols (per-instance appearance overrides that survive a
//     redefine) are not built — an instance is STATIC. Redefine
//     overwrites every instance's artwork; break the link to keep a
//     local deviation.
//   · Symbol LIBRARIES as files (open/save `.ai` symbol libraries) are
//     not built; the library is this document's part.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
  SceneTreeNode,
} from "@paged-media/plugin-api";
import { splitCompound, type AnchorTable } from "@paged-media/draw-geometry";

import { stampDrawMetadata } from "./appearance-bake";
import {
  compoundPaintOf,
  compoundSourceOf,
  framePathMutationFor,
  type CompoundPaint,
} from "./compound-path";
import { groupMutationFor } from "./group";
import { offsetTable } from "./pattern";
import { leafIdsOf } from "./select-same";
import { parentGroupOf } from "./select-parent-group";
import { insertPathMutationFor } from "../handlers/insert-path";
import { resolveTargetPage } from "../io/svg";

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

/** The contributed command ids, in registration order. */
export const SYMBOLS_COMMAND_IDS = [
  DEFINE_SYMBOL_COMMAND_ID,
  PLACE_SYMBOL_COMMAND_ID,
  REDEFINE_SYMBOL_COMMAND_ID,
  BREAK_SYMBOL_LINK_COMMAND_ID,
  RESET_SYMBOL_TRANSFORM_COMMAND_ID,
  RENAME_SYMBOL_COMMAND_ID,
  DELETE_SYMBOL_COMMAND_ID,
];

/** The container part this library lives in, RELATIVE to this plugin's
 *  `paged/media.paged.draw/` namespace (the host prepends it). */
export const SYMBOLS_PART = "symbols.json";

/** The library envelope version (an unknown version reads as an EMPTY
 *  library rather than a crash — the graphic-styles convention). */
export const SYMBOLS_LIBRARY_VERSION = 1;

/** The capability this whole feature rides. */
export const SYMBOLS_FEATURE = "storage.parts@1";

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
      pieces.push({ table, paint: parseSymbolPaint((p as SymbolPiece)?.paint) });
    }
    symbols.push({
      id: s.id,
      name: typeof s.name === "string" && s.name.length > 0 ? s.name : s.id,
      registration: registrationOf(s.registration),
      origin: point(s.origin) ?? [0, 0],
      pieces,
    });
  }
  return { v: SYMBOLS_LIBRARY_VERSION, symbols };
}

/** Serialize the library to the part's bytes — indented, because the
 *  `spec` role's whole point is that it stays small and DIFFABLE. */
export function serializeSymbolLibrary(library: SymbolLibrary): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(
      { v: SYMBOLS_LIBRARY_VERSION, symbols: library.symbols },
      null,
      2,
    )}\n`,
  );
}

// ------------------------------------------------- pure: library edits

/** The next free `sym-N` id. Deterministic (no randomness — the part is
 *  diffable and the tests are exact). */
export function mintSymbolId(library: SymbolLibrary): string {
  let max = 0;
  for (const s of library.symbols) {
    const m = /^sym-(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `sym-${max + 1}`;
}

/** The next free `si-N` instance id, above every id already in use. */
export function mintSymbolInstanceId(inUse: Iterable<string>): string {
  let max = 0;
  for (const id of inUse) {
    const m = /^si-(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `si-${max + 1}`;
}

export function findSymbol(
  library: SymbolLibrary,
  id: string,
): SymbolDefinition | null {
  return library.symbols.find((s) => s.id === id) ?? null;
}

/** Insert or replace a symbol (by id), preserving order. Pure. */
export function upsertSymbol(
  library: SymbolLibrary,
  symbol: SymbolDefinition,
): SymbolLibrary {
  const symbols = library.symbols.slice();
  const at = symbols.findIndex((s) => s.id === symbol.id);
  if (at >= 0) symbols[at] = symbol;
  else symbols.push(symbol);
  return { v: SYMBOLS_LIBRARY_VERSION, symbols };
}

/** Rename a symbol. An unknown id — or an empty name — is an honest
 *  no-op (a stale panel row never corrupts the library). Pure. */
export function renameSymbolIn(
  library: SymbolLibrary,
  id: string,
  name: string,
): SymbolLibrary {
  if (name.length === 0) return library;
  return {
    v: SYMBOLS_LIBRARY_VERSION,
    symbols: library.symbols.map((s) => (s.id === id ? { ...s, name } : s)),
  };
}

/** Drop a symbol. An unknown id is a no-op. Pure. */
export function removeSymbolFrom(
  library: SymbolLibrary,
  id: string,
): SymbolLibrary {
  return {
    v: SYMBOLS_LIBRARY_VERSION,
    symbols: library.symbols.filter((s) => s.id !== id),
  };
}

// --------------------------------------------- pure: bounds + anchoring

/** `[minX, minY, maxX, maxY]` over every CONTROL POINT (anchor + both
 *  handles) of every table — the hull the registration grid divides.
 *  Null for an empty set. Pure. */
export function symbolBoundsOf(
  tables: readonly AnchorTable[],
): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const table of tables) {
    for (const a of table.anchors) {
      for (const p of [a.anchor, a.left, a.right]) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [minX, minY, maxX, maxY];
}

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

/** Build a definition from PAGE-space sources: measure the hull, resolve
 *  the registration point, and translate every table into DEFINITION
 *  space (registration point at the origin). Pure — the whole capture
 *  step with no host in sight, so the conformance spec pins it exactly.
 *  Null when nothing measurable was handed in. */
export function symbolDefinitionFrom(args: {
  id: string;
  name: string;
  registration: SymbolRegistration;
  sources: readonly { table: AnchorTable; paint: CompoundPaint }[];
}): SymbolDefinition | null {
  if (args.sources.length === 0) return null;
  const bounds = symbolBoundsOf(args.sources.map((s) => s.table));
  if (!bounds) return null;
  const origin = registrationPointOf(bounds, args.registration);
  return {
    id: args.id,
    name: args.name,
    registration: args.registration,
    origin,
    pieces: args.sources.map((s) => ({
      table: offsetTable(s.table, -origin[0], -origin[1]),
      paint: { ...s.paint },
    })),
  };
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

/** Merge (or, with `null`, DROP) the instance link in an envelope,
 *  preserving every other draw metadata key — breaking a link must leave
 *  everything else exactly as it is. */
export function withSymbolInstance(
  prev: PluginMetadataEnvelope | null,
  ref: SymbolInstanceRef | null,
): PluginMetadataEnvelope | null {
  const data: Record<string, unknown> = { ...(prev?.data ?? {}) };
  if (ref === null) {
    delete data.symbolInstance;
    if (Object.keys(data).length === 0) return null;
  } else {
    data.symbolInstance = ref;
  }
  return {
    v: prev?.v ?? 1,
    data,
    ...(prev?.engine ? { engine: prev.engine } : {}),
  };
}

// ------------------------------------------------------- pure: the plan

/** Everything the two place/rebuild batches need, resolved once. Pure
 *  data — the conformance spec builds one by hand. */
export interface SymbolPlacePlan {
  pageId: string;
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
  instanceId: string;
  origin: readonly [number, number];
}): SymbolPlacePlan {
  return {
    pageId: args.pageId,
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

/** Chunk the ids minted by the insert batch back onto their pieces.
 *  Insertion order == tree order (the appearance-bake finding), so this
 *  is a walk, not a guess. Null when the count does not match — the
 *  caller then refuses rather than mis-binding. */
export function bindSymbolPieces(
  plan: SymbolPlacePlan,
  minted: readonly ElementId[],
): SymbolPieceBinding[] | null {
  const counts = symbolContourCounts(plan);
  const expected = counts.reduce((n, c) => n + c, 0);
  if (minted.length !== expected) return null;
  const bindings: SymbolPieceBinding[] = [];
  let at = 0;
  counts.forEach((count, pieceIndex) => {
    const ids = minted.slice(at, at + count);
    at += count;
    bindings.push({ pieceIndex, keep: ids[0], absorb: ids.slice(1) });
  });
  return bindings;
}

// ------------------------------------------------------- wire builders
// Exported so the conformance spec asserts the EXACT wire shapes the
// live commands emit (no second copy to drift from).

/** What a REBUILD replaces: the old instance's wrapper group (if any)
 *  and its leaves. Torn down in BATCH 2, never batch 1 — see
 *  {@link symbolFinishBatchFor}. */
export interface SymbolReplacement {
  group: ElementId | null;
  stale: readonly ElementId[];
}

/** BATCH 1 — one `insertPath` per piece per contour, in the order
 *  `symbolContourCounts` reports (which is how the minted ids are
 *  chunked back onto their pieces afterwards). Inserts ONLY: see
 *  {@link symbolFinishBatchFor} for why a rebuild's deletes cannot ride
 *  here. */
export function symbolInsertBatchFor(plan: SymbolPlacePlan): Mutation {
  const ops: Mutation[] = [];
  for (const piece of plan.pieces) {
    for (const contour of splitCompound(piece.table)) {
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

/** BATCH 2 — for a REBUILD, tear the old instance down FIRST (dissolve
 *  its group, delete its leaves); then re-merge every compound piece
 *  through the SAME `framePath` door Make Compound Path uses, paint each
 *  surviving leaf, stamp the instance link on it, and (for a multi-piece
 *  symbol only) wrap the leaves in one group. One batch ⇒ one undo step.
 *
 *  WHY THE TEARDOWN IS HERE AND NOT IN BATCH 1 — measured against the
 *  booted engine, not assumed. A batch that DELETES and then INSERTS is
 *  refused: the insert's z-position is resolved against the spread
 *  length the batch STARTED with, so the second child fails with
 *  `notImplemented` / "position 4 out of range for parent Spread(\"us\")
 *  (len 3)" and the whole atomic batch rolls back. Deletes alone in a
 *  batch that also groups are fine (the pattern bake proves it), so the
 *  teardown rides batch 2 and a rebuild stays TWO batches instead of
 *  three. */
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
      // back on the first one and drop the rest.
      ops.push(framePathMutationFor(binding.keep, piece.table));
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

/** The UNLINK batch — drop the instance reference from every leaf,
 *  keeping the artwork and every other metadata key. One batch ⇒ one
 *  undo step no matter how many leaves (or instances) it covers. */
export function symbolUnlinkBatchFor(
  leaves: readonly { id: ElementId; envelope: PluginMetadataEnvelope | null }[],
): Mutation {
  return {
    op: "batch",
    args: {
      ops: leaves.map((leaf) =>
        stampDrawMetadata(leaf.id, withSymbolInstance(leaf.envelope, null)),
      ),
    },
  };
}

// -------------------------------------------------------- host: the part

type PartsHost = Pick<BundleHost, "parts" | "supports" | "log">;

/** Read the library out of the container part. A host with no container
 *  writer (`supports("storage.parts@1")` false — an older editor) is not
 *  an error: it reads as an EMPTY library and WARNS, so the degrade is
 *  visible in the log instead of looking like "no symbols yet". */
export async function readSymbolLibrary(
  host: PartsHost,
): Promise<SymbolLibrary> {
  if (!host.supports(SYMBOLS_FEATURE)) {
    host.log.warn(
      "symbols: this host wires no `.paged` container writer " +
        `(supports("${SYMBOLS_FEATURE}") is false) — the symbol library ` +
        "cannot be read or saved here",
    );
    return emptyLibrary();
  }
  try {
    return parseSymbolLibrary(await host.parts.read(SYMBOLS_PART));
  } catch (e) {
    host.log.warn(`symbols: library read failed (${String(e)})`);
    return emptyLibrary();
  }
}

/** Write the library back. `false` = it did not persist (no container
 *  door, or the write was refused) — logged, never thrown. */
export async function writeSymbolLibrary(
  host: PartsHost,
  library: SymbolLibrary,
): Promise<boolean> {
  if (!host.supports(SYMBOLS_FEATURE)) {
    host.log.warn(
      "symbols: no `.paged` container writer — the symbol library was NOT " +
        "saved (nothing travels with this document)",
    );
    return false;
  }
  try {
    await host.parts.write(SYMBOLS_PART, serializeSymbolLibrary(library));
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

const leafKey = (id: ElementId): string => `${id.kind}:${String(id.id)}`;

/** Every symbol instance in the document (optionally only those of
 *  `symbolId`), in tree order. One scene walk + one metadata read per
 *  leaf — the `select-same` / `graphicStyleLinks` precedent. */
export async function symbolInstances(
  host: BundleHost,
  symbolId?: string,
): Promise<SymbolInstance[]> {
  const roots = await host.document.tree().catch(() => [] as SceneTreeNode[]);
  const byInstance = new Map<
    string,
    { instance: SymbolInstance; pieces: number[] }
  >();
  for (const id of leafIdsOf(roots)) {
    const env = await host.document.getMetadata(id).catch(() => null);
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

/** Expand the selection to LEAF ids: a selected group contributes its
 *  descendant leaves, anything else is its own leaf. Pure over the tree
 *  — exported so the conformance spec pins the expansion. */
export function expandToLeaves(
  roots: readonly SceneTreeNode[],
  selection: readonly ElementId[],
): ElementId[] {
  const out: ElementId[] = [];
  const seen = new Set<string>();
  const push = (id: ElementId) => {
    if (seen.has(leafKey(id))) return;
    seen.add(leafKey(id));
    out.push(id);
  };
  const subtreeLeaves = (node: SceneTreeNode): ElementId[] => {
    const children = node.children ?? [];
    if (children.length === 0) return node.id ? [node.id] : [];
    return children.flatMap(subtreeLeaves);
  };
  const findNode = (
    nodes: readonly SceneTreeNode[],
    target: ElementId,
  ): SceneTreeNode | null => {
    for (const node of nodes) {
      if (node.id && node.id.id === target.id) return node;
      const child = findNode(node.children ?? [], target);
      if (child) return child;
    }
    return null;
  };
  for (const id of selection) {
    if (id.kind === "group") {
      const node = findNode(roots, id);
      for (const leaf of node ? subtreeLeaves(node) : []) push(leaf);
    } else {
      push(id);
    }
  }
  return out;
}

/** The instances the current selection touches (a leaf, a whole group,
 *  or a mix). */
export async function selectedSymbolInstances(
  host: BundleHost,
): Promise<SymbolInstance[]> {
  const selection = host.selection.get();
  if (selection.length === 0) return [];
  const roots = await host.document.tree().catch(() => [] as SceneTreeNode[]);
  const wanted = new Set(
    expandToLeaves(roots, selection).map((id) => String(id.id)),
  );
  return (await symbolInstances(host)).filter((instance) =>
    instance.leaves.some((leaf) => wanted.has(String(leaf.id))),
  );
}

/** The instance's CURRENT registration point, measured with the SAME
 *  ruler a definition capture uses: the control-point hull of every
 *  leaf's live contours (`compoundSourceOf`, which falls back to a
 *  bounds-only element's four corners by itself).
 *
 *  It is NOT `elementGeometry.bounds`, and that is measured rather than
 *  assumed: an element's reported bounds are its declared
 *  `GeometricBounds` and do NOT follow a `pathPointSet` anchor edit, so
 *  a reset anchored on them would re-emit at a stale centre. The
 *  conformance spec drags an anchor and pins the difference.
 *
 *  Null when the page-keyed doors answer nothing — an instance outside
 *  every page's bounds (RFI C-23) — where the caller falls back to the
 *  recorded origin. */
export async function liveInstanceOrigin(
  host: BundleHost,
  instance: SymbolInstance,
  registration: SymbolRegistration,
): Promise<[number, number] | null> {
  const tables: AnchorTable[] = [];
  for (const leaf of instance.leaves) {
    const source = await compoundSourceOf(host, leaf);
    if (source) tables.push(source.table);
  }
  const bounds = symbolBoundsOf(tables);
  return bounds === null ? null : registrationPointOf(bounds, registration);
}

// ------------------------------------------------------------- appliers

/** Read one page-space source (geometry + paint) for a definition
 *  capture. Null = unreadable, already logged by the caller. */
async function captureSource(
  host: BundleHost,
  id: ElementId,
): Promise<{ table: AnchorTable; paint: CompoundPaint } | null> {
  const source = await compoundSourceOf(host, id);
  if (!source) return null;
  return { table: source.table, paint: await compoundPaintOf(host, id) };
}

/** Capture the current selection as definition SOURCES (page space).
 *  Groups are expanded to their leaves; a TEXT FRAME is refused with a
 *  diagnostic (its story cannot be copied — see the module header). */
export async function captureSymbolSources(
  host: BundleHost,
  label: string,
): Promise<{ table: AnchorTable; paint: CompoundPaint }[]> {
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${label}: no selection — no-op`);
    return [];
  }
  const roots = await host.document.tree().catch(() => [] as SceneTreeNode[]);
  const out: { table: AnchorTable; paint: CompoundPaint }[] = [];
  for (const id of expandToLeaves(roots, selection)) {
    if (id.kind === "textFrame") {
      host.log.warn(
        `${label}: REFUSING the text frame ${String(id.id)} — an instance is ` +
          "re-emitted through insertPath (which makes Polygons) and no " +
          "mutation can copy a story, so text cannot be part of a symbol",
      );
      continue;
    }
    const source = await captureSource(host, id);
    if (!source) {
      host.log.debug(
        `${label}: ${id.kind} ${String(id.id)} exposes no readable geometry — skipped`,
      );
      continue;
    }
    out.push(source);
  }
  return out;
}

/** Place ONE instance of `symbol` at `origin` — the shared engine flow
 *  behind place, redefine and reset. `replace` tears an existing
 *  instance down inside the FIRST batch (a rebuild). Returns the created
 *  leaves; empty on a refusal (always logged, never thrown — the
 *  dash-command convention).
 *
 *  TWO batches ⇒ 2 undo steps: `insertPath` mints the ids batch 2
 *  addresses, and this contract's `Mutation` union carries no C-15
 *  `bindCreated` arm to bind them inside one batch (module header). */
export async function emitSymbolInstance(
  host: BundleHost,
  args: {
    symbol: SymbolDefinition;
    pageId: string;
    instanceId: string;
    origin: readonly [number, number];
    replace?: SymbolReplacement;
    label: string;
  },
): Promise<ElementId[]> {
  const { label } = args;
  if (args.symbol.pieces.length === 0) {
    host.log.warn(`${label}: "${args.symbol.name}" has no pieces — no-op`);
    return [];
  }
  const plan = symbolPlacePlanFor({
    symbol: args.symbol,
    pageId: args.pageId,
    instanceId: args.instanceId,
    origin: args.origin,
  });

  const before = new Set(
    leafIdsOf(await host.document.tree().catch(() => [])).map((e) =>
      String(e.id),
    ),
  );
  const inserted = await host.document.mutate(symbolInsertBatchFor(plan));
  if (!inserted.applied) {
    host.log.warn(
      `${label}: instance insert rejected by engine: ${JSON.stringify(
        inserted.error,
      )}`,
    );
    return [];
  }
  const minted = leafIdsOf(await host.document.tree().catch(() => [])).filter(
    (e) => !before.has(String(e.id)),
  );
  const bindings = bindSymbolPieces(plan, minted);
  if (!bindings) {
    host.log.warn(
      `${label}: expected ${symbolContourCounts(plan).reduce(
        (n, c) => n + c,
        0,
      )} inserted contours, found ${minted.length} — leaving the insert in ` +
        "place, not linking it",
    );
    return minted;
  }
  const finished = await host.document.mutate(
    symbolFinishBatchFor({ plan, bindings, replace: args.replace }),
  );
  if (!finished.applied) {
    host.log.warn(
      `${label}: instance paint/link batch rejected by engine: ${JSON.stringify(
        finished.error,
      )}`,
    );
    return bindings.map((b) => b.keep);
  }
  const keeps = bindings.map((b) => b.keep);
  // RFI C-23, handled rather than left mute: an instance whose origin
  // falls outside every page's bounds belongs to no page, and BOTH
  // page-keyed geometry doors then answer nothing for it.
  const measured = await host.document.elementGeometry([...keeps]).catch(() => []);
  if (measured.length === 0) {
    host.log.warn(
      `${label}: the instance was created at [${plan.origin.join(", ")}] but ` +
        "no page claims it — `elementGeometry` / `pathAnchors` are PAGE-KEYED " +
        "and answer nothing for an element outside every page (RFI C-23). The " +
        "artwork is real; a later Reset falls back to the recorded origin " +
        "instead of measuring one",
    );
  }
  return keeps;
}

/** DEFINE — capture the selection into a NEW library symbol. The
 *  document is not touched (the selection is not converted), so this
 *  costs ZERO undo steps. Returns the symbol, or null on a refusal. */
export async function applyDefineSymbol(
  host: BundleHost,
  payload?: { name?: unknown; registration?: unknown },
): Promise<SymbolDefinition | null> {
  const label = DEFINE_SYMBOL_COMMAND_ID;
  const sources = await captureSymbolSources(host, label);
  if (sources.length === 0) {
    host.log.warn(`${label}: nothing capturable in the selection — no-op`);
    return null;
  }
  const library = await readSymbolLibrary(host);
  const name =
    typeof payload?.name === "string" && payload.name.trim().length > 0
      ? payload.name.trim()
      : `Symbol ${library.symbols.length + 1}`;
  const symbol = symbolDefinitionFrom({
    id: mintSymbolId(library),
    name,
    registration: registrationOf(payload?.registration),
    sources,
  });
  if (!symbol) {
    host.log.warn(`${label}: the selection has no measurable bounds — no-op`);
    return null;
  }
  if (!(await writeSymbolLibrary(host, upsertSymbol(library, symbol)))) {
    return null;
  }
  return symbol;
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
  const symbol = findSymbol(await readSymbolLibrary(host), symbolId);
  if (!symbol) {
    host.log.warn(`${label}: no symbol "${symbolId}" in the library — no-op`);
    return [];
  }
  const pageId =
    typeof payload?.pageId === "string" && payload.pageId.length > 0
      ? payload.pageId
      : await resolveTargetPage(host);
  if (!pageId) {
    host.log.warn(`${label}: no target page — nothing placed`);
    return [];
  }
  const origin: [number, number] = [
    num(payload?.x, symbol.origin[0]),
    num(payload?.y, symbol.origin[1]),
  ];
  const instanceId = mintSymbolInstanceId(
    (await symbolInstances(host)).map((i) => i.instance),
  );
  const created = await emitSymbolInstance(host, {
    symbol,
    pageId,
    instanceId,
    origin,
    label,
  });
  if (created.length > 0) await host.selection.set(created);
  return created;
}

/** Rebuild ONE instance from `symbol` at `origin` — the shared half of
 *  reset and redefine. */
async function rebuildInstance(
  host: BundleHost,
  args: {
    symbol: SymbolDefinition;
    instance: SymbolInstance;
    label: string;
  },
): Promise<ElementId[]> {
  const { instance, symbol, label } = args;
  const roots = await host.document.tree().catch(() => [] as SceneTreeNode[]);
  const first = instance.leaves[0];
  if (!first) return [];
  const group = parentGroupOf(roots, first);
  const pageId =
    (await compoundSourceOf(host, first))?.pageId ??
    (await resolveTargetPage(host));
  if (!pageId) {
    host.log.warn(`${label}: no target page for instance ${instance.instance}`);
    return [];
  }
  const live = await liveInstanceOrigin(host, instance, symbol.registration);
  if (!live) {
    host.log.warn(
      `${label}: instance ${instance.instance} cannot be measured — its ` +
        "artwork is outside every page's bounds and the geometry doors are " +
        `PAGE-KEYED (RFI C-23). Rebuilding at its RECORDED origin ` +
        `[${instance.origin.join(", ")}] instead`,
    );
  }
  return emitSymbolInstance(host, {
    symbol,
    pageId,
    instanceId: instance.instance,
    origin: live ?? instance.origin,
    replace: { group, stale: instance.leaves },
    label,
  });
}

/** RESET TRANSFORM — rebuild every selected instance from its unchanged
 *  definition, re-anchored at its CURRENT registration point. Whatever
 *  transform or edit the artwork picked up is discarded; the position
 *  survives. TWO undo steps per instance. */
export async function applyResetSymbolTransform(
  host: BundleHost,
): Promise<number> {
  const label = RESET_SYMBOL_TRANSFORM_COMMAND_ID;
  const instances = await selectedSymbolInstances(host);
  if (instances.length === 0) {
    host.log.debug(`${label}: no symbol instance in the selection — no-op`);
    return 0;
  }
  const library = await readSymbolLibrary(host);
  let done = 0;
  for (const instance of instances) {
    const symbol = findSymbol(library, instance.symbol);
    if (!symbol) {
      host.log.warn(
        `${label}: instance ${instance.instance} follows "${instance.symbol}", ` +
          "which is not in the library — no-op for it",
      );
      continue;
    }
    if ((await rebuildInstance(host, { symbol, instance, label })).length > 0) {
      done++;
    }
  }
  return done;
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
  const library = await readSymbolLibrary(host);
  const existing = findSymbol(library, symbolId);
  if (!existing) {
    host.log.warn(`${label}: no symbol "${symbolId}" in the library — no-op`);
    return null;
  }
  const sources = await captureSymbolSources(host, label);
  if (sources.length === 0) {
    host.log.warn(`${label}: nothing capturable in the selection — no-op`);
    return null;
  }
  const symbol = symbolDefinitionFrom({
    id: existing.id,
    name: existing.name,
    registration: existing.registration,
    sources,
  });
  if (!symbol) {
    host.log.warn(`${label}: the selection has no measurable bounds — no-op`);
    return null;
  }
  if (!(await writeSymbolLibrary(host, upsertSymbol(library, symbol)))) {
    return null;
  }
  const instances = await symbolInstances(host, symbolId);
  if (instances.length > 0) {
    host.log.info(
      `${label}: "${symbol.name}" rebuilds ${instances.length} instance(s) ` +
        "— an instance is STATIC, so any local edit to one is overwritten " +
        "(break its link first to keep a deviation)",
    );
  }
  for (const instance of instances) {
    await rebuildInstance(host, { symbol, instance, label });
  }
  return symbol;
}

/** Every leaf of `instances` paired with its current envelope. */
async function unlinkTargets(
  host: BundleHost,
  instances: readonly SymbolInstance[],
): Promise<{ id: ElementId; envelope: PluginMetadataEnvelope | null }[]> {
  const out: { id: ElementId; envelope: PluginMetadataEnvelope | null }[] = [];
  for (const instance of instances) {
    for (const id of instance.leaves) {
      out.push({
        id,
        envelope: await host.document.getMetadata(id).catch(() => null),
      });
    }
  }
  return out;
}

/** BREAK LINK — drop the reference from every selected instance, keeping
 *  the artwork (and its group) exactly as it is. ONE batch ⇒ ONE undo
 *  step for the whole selection. */
export async function applyBreakSymbolLink(host: BundleHost): Promise<number> {
  const label = BREAK_SYMBOL_LINK_COMMAND_ID;
  const instances = await selectedSymbolInstances(host);
  if (instances.length === 0) {
    host.log.debug(`${label}: no symbol instance in the selection — no-op`);
    return 0;
  }
  const targets = await unlinkTargets(host, instances);
  const outcome = await host.document.mutate(symbolUnlinkBatchFor(targets));
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return 0;
  }
  return instances.length;
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
  const library = await readSymbolLibrary(host);
  if (!findSymbol(library, symbolId)) {
    host.log.warn(`${label}: no symbol "${symbolId}" in the library — no-op`);
    return false;
  }
  return writeSymbolLibrary(host, renameSymbolIn(library, symbolId, next));
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
  const library = await readSymbolLibrary(host);
  if (!findSymbol(library, symbolId)) {
    host.log.warn(`${label}: no symbol "${symbolId}" in the library — no-op`);
    return false;
  }
  const instances = await symbolInstances(host, symbolId);
  if (instances.length > 0) {
    const outcome = await host.document.mutate(
      symbolUnlinkBatchFor(await unlinkTargets(host, instances)),
    );
    if (!outcome.applied) {
      host.log.warn(
        `${label}: unlink rejected by engine: ${JSON.stringify(outcome.error)}`,
      );
    }
  }
  return writeSymbolLibrary(host, removeSymbolFrom(library, symbolId));
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
export function contributeSymbolCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: DEFINE_SYMBOL_COMMAND_ID,
      title: "Symbols: Define symbol from selection",
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyDefineSymbol(host, payloadOf(payload)).then(() => undefined),
    }),
    host.contribute.command({
      id: PLACE_SYMBOL_COMMAND_ID,
      title: "Symbols: Place instance",
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) => {
        const p = payloadOf(payload);
        return applyPlaceSymbolInstance(host, p.symbolId, p).then(
          () => undefined,
        );
      },
    }),
    host.contribute.command({
      id: REDEFINE_SYMBOL_COMMAND_ID,
      title: "Symbols: Redefine from selection (rebuilds every instance)",
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyRedefineSymbol(host, payloadOf(payload).symbolId).then(
          () => undefined,
        ),
    }),
    host.contribute.command({
      id: BREAK_SYMBOL_LINK_COMMAND_ID,
      title: "Symbols: Break link (keep the artwork)",
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: () => applyBreakSymbolLink(host).then(() => undefined),
    }),
    host.contribute.command({
      id: RESET_SYMBOL_TRANSFORM_COMMAND_ID,
      title: "Symbols: Reset transform (re-emit the definition in place)",
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: () => applyResetSymbolTransform(host).then(() => undefined),
    }),
    host.contribute.command({
      id: RENAME_SYMBOL_COMMAND_ID,
      title: "Symbols: Rename symbol",
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) => {
        const p = payloadOf(payload);
        return applyRenameSymbol(host, p.symbolId, p.name).then(() => undefined);
      },
    }),
    host.contribute.command({
      id: DELETE_SYMBOL_COMMAND_ID,
      title: "Symbols: Delete symbol (the placed artwork stays)",
      category: SYMBOLS_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyDeleteSymbol(host, payloadOf(payload).symbolId).then(
          () => undefined,
        ),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
