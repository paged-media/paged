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

// TYPED COMMANDS (ADR 323) — the typed twin of every paged.draw command
// a caller other than the editor can meaningfully run.
//
// A twin carries the SAME id as its untyped command (that is what
// plugin-cli counts as "typed"), a struct `args` schema the registry
// validates BEFORE anything runs, and a handler that lowers the args to
// the untyped payload and calls the untyped handler itself (looked up in
// src/command-registry.ts) — one implementation, no second copy to drift.
//
// CONVENTIONS, because ValueType structs have no optional fields (every
// field is required and non-null — contract issue, reported):
//   · `targets: [frame refs]` — the objects to act on. Most draw commands
//     act on the SELECTION, so a non-empty list SELECTS those objects
//     first (the Illustrator scripting model: select, then run); `[]` =
//     act on the current selection.
//   · a recipe / library id (`style`, `symbol`, `repeat`, …) takes the
//     bare id or the object address; `""` = resolve from the selection.
//   · parameter commands (insert shapes, path ops, image trace) take the
//     FULL parameter set — there is no "omit to default".
//   · `select*` commands answer the selection they made, as addresses.
//   · library-only verbs (rename / delete a graphic style or symbol) run
//     through `host.objects` instead, so they are ONE undo step — the
//     untyped versions are container writes nothing can undo.
// NOT twinned: the ten Path Options "…" commands. They raise a panel and
// mutate nothing — a typed caller sets the parameters in the args of the
// command the panel would run. They stay in the untyped baseline.

import type {
  BundleHost,
  ElementId,
  ObjectsSurface,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";
import { fromElementId, parseAddress, toElementId } from "@paged-media/plugin-sdk";

import { commandHandler } from "../command-registry";
import type {
  ArcParams,
  PolarGridParams,
  RectGridParams,
  SpiralParams,
} from "../commands/insert-shapes";
import { SYMBOL_REGISTRATIONS } from "../commands/symbols";
import { FLIP_PATH_EFFECTS, PATH_TYPE_ALIGNMENTS } from "../commands/v58-wire";
import type { TraceOptions } from "../trace-engine";
import { BOOL, COLOR, DEG, INT, LEN, NUM, REFS, TEXT, addressOf, bareIdOf, enumOf } from "./shared";

const C = "media.paged.draw.command";

type Fields = Record<string, ValueType>;

/** One twin, as data (the manifest view) plus how it lowers. */
export interface TwinSpec {
  id: string;
  title: string;
  fields: Fields;
  /** args → the untyped payload (default: every field but `targets`,
   *  `""` ids dropped, renamed by `rename`). */
  payload?: (args: Record<string, unknown>) => unknown;
  rename?: Record<string, string>;
  /** The id-valued fields and the object kind each names. */
  ids?: Record<string, string>;
  result?: ValueType;
  /** Run through `host.objects` instead of the untyped handler. */
  via?: (objects: ObjectsSurface, args: Record<string, unknown>) => Promise<unknown>;
}

const T: Fields = { targets: REFS };
const SELECTION_RESULT: ValueType = REFS;

const titleOf = (id: string): string => {
  const name = id.slice(C.length + 1);
  const words = name.replace(/([A-Z])/g, " $1").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Every field of a params interface, typed (exhaustive by construction). */
const ARC: Record<keyof ArcParams, ValueType> = {
  cx: LEN, cy: LEN, rx: LEN, ry: LEN, startAngleDeg: DEG, sweepDeg: DEG, closed: BOOL,
};
const SPIRAL: Record<keyof SpiralParams, ValueType> = {
  cx: LEN, cy: LEN, r0: LEN, decay: NUM, turns: NUM, segmentsPerTurn: INT,
};
const RECT_GRID: Record<keyof RectGridParams, ValueType> = {
  x: LEN, y: LEN, width: LEN, height: LEN, rows: INT, cols: INT,
};
const POLAR_GRID: Record<keyof PolarGridParams, ValueType> = {
  cx: LEN, cy: LEN, r: LEN, rings: INT, radials: INT,
};
const TRACE: Record<keyof TraceOptions, ValueType> = {
  mode: enumOf(["color", "bw"]),
  pathMode: enumOf(["spline", "polygon"]),
  colorPrecision: INT,
  filterSpeckle: INT,
  layerDifference: INT,
  bwThreshold: INT,
  ignoreWhite: BOOL,
  cornerThresholdDeg: DEG,
  segmentLength: NUM,
  spliceThresholdDeg: DEG,
  maxIterations: INT,
  maxRegions: INT,
  maxTracePixels: INT,
  stacked: BOOL,
};
const CAP = enumOf(["butt", "round", "square"]);
const JOIN = enumOf(["miter", "round", "bevel"]);

/** A selection-driven twin with no parameters. */
const sel = (name: string): TwinSpec => ({ id: `${C}.${name}`, title: titleOf(`${C}.${name}`), fields: T });
const twin = (name: string, fields: Fields, extra: Partial<TwinSpec> = {}): TwinSpec => ({
  id: `${C}.${name}`,
  title: titleOf(`${C}.${name}`),
  fields,
  ...extra,
});

/** Recipe verbs: `{ <field>: id }` → `{ <payloadKey>: id }`. */
const recipeVerb = (name: string, field: string, kind: string, key: string, more: Fields = {}, extra: Partial<TwinSpec> = {}) =>
  twin(name, { [field]: TEXT, ...more }, { ids: { [field]: kind }, rename: { [field]: key }, ...extra });

export const TWINS: readonly TwinSpec[] = [
  // Stroke dashes / gradient fills / live corners — presets on the selection.
  ...["strokeDashSolid", "strokeDashDashed", "strokeDashDotted", "strokeDashDashDot"].map(sel),
  ...["fillGradientLinear", "fillGradientRadial"].map(sel),
  ...["cornersRounded", "cornersInverseRounded", "cornersBevel", "cornersFancy", "cornersNone"].map(sel),
  // Path ops (the v30 kernels) — full parameters.
  twin("outlineStroke", { ...T, width: LEN, cap: CAP, join: JOIN, miterLimit: NUM }),
  twin("offsetPath", { ...T, delta: LEN, join: JOIN, miterLimit: NUM }),
  twin("simplifyPath", { ...T, tolerance: LEN }),
  // Endpoints / direction / outlines / transform.
  ...["joinEndpoints", "closePath", "averageEndpoints", "reversePathDirection", "createOutlines", "transformAgain"].map(sel),
  twin("reflectHorizontal", { ...T, copy: BOOL }),
  twin("reflectVertical", { ...T, copy: BOOL }),
  // Pathfinder (boolean + region) and compound paths.
  ...[
    "pathfinderUnite", "pathfinderSubtract", "pathfinderIntersect", "pathfinderExclude",
    "pathfinderDivide", "pathfinderTrim", "pathfinderMerge", "pathfinderCrop",
    "pathfinderOutline", "pathfinderMinusBack", "makeCompoundPath", "releaseCompoundPath",
  ].map(sel),
  // Appearance.
  ...["appearanceAddFill", "appearanceAddStroke", "appearanceClear", "bakeAppearance", "releaseAppearance"].map(sel),
  twin("appearanceRemoveLayer", { ...T, kind: enumOf(["fill", "stroke"]), index: INT }),
  twin("appearanceMoveLayer", { ...T, kind: enumOf(["fill", "stroke"]), index: INT, delta: INT }),
  // Graphic styles.
  twin("saveGraphicStyle", { ...T, name: TEXT }),
  recipeVerb("applyGraphicStyle", "style", "graphicStyle", "styleId", T),
  recipeVerb("redefineGraphicStyle", "style", "graphicStyle", "styleId", T),
  sel("breakGraphicStyleLink"),
  twin("renameGraphicStyle", { style: TEXT, name: TEXT }, {
    via: (o, a) => o.set(addressOf("graphicStyle", bareIdOf(String(a.style), "graphicStyle")), "name", a.name),
  }),
  twin("deleteGraphicStyle", { style: TEXT }, {
    via: (o, a) => o.batch([{ op: "delete", address: addressOf("graphicStyle", bareIdOf(String(a.style), "graphicStyle")) }]),
  }),
  // Symbols.
  twin("defineSymbol", { ...T, name: TEXT, registration: enumOf(SYMBOL_REGISTRATIONS) }),
  recipeVerb("placeSymbolInstance", "symbol", "symbol", "symbolId", { x: LEN, y: LEN }),
  recipeVerb("redefineSymbol", "symbol", "symbol", "symbolId", T),
  sel("breakSymbolLink"),
  sel("resetSymbolTransform"),
  twin("renameSymbol", { symbol: TEXT, name: TEXT }, {
    via: (o, a) => o.set(addressOf("symbol", bareIdOf(String(a.symbol), "symbol")), "name", a.name),
  }),
  twin("deleteSymbol", { symbol: TEXT }, {
    via: (o, a) => o.batch([{ op: "delete", address: addressOf("symbol", bareIdOf(String(a.symbol), "symbol")) }]),
  }),
  // Live paint.
  twin("makeLivePaintGroup", { ...T, name: TEXT }),
  recipeVerb("fillLivePaintFace", "group", "livePaint", "groupId", { faces: { kind: "list", of: TEXT }, fill: COLOR }),
  recipeVerb("regenerateLivePaint", "group", "livePaint", "groupId"),
  recipeVerb("selectLivePaintFaces", "group", "livePaint", "groupId", { faces: { kind: "list", of: TEXT } }, { result: SELECTION_RESULT }),
  recipeVerb("deleteLivePaintFace", "group", "livePaint", "groupId", { faces: { kind: "list", of: TEXT } }),
  recipeVerb("releaseLivePaint", "group", "livePaint", "groupId"),
  // Opacity masks and type on a path (protocol 58).
  twin("makeOpacityMask", { ...T, maskType: enumOf(["luminosity", "alpha"]), invert: BOOL }),
  sel("releaseOpacityMask"),
  twin(
    "attachTextToPath",
    { ...T, story: TEXT, pathTypeAlignment: enumOf(PATH_TYPE_ALIGNMENTS), flipPathEffect: enumOf(FLIP_PATH_EFFECTS) },
    { rename: { story: "storyId" }, ids: { story: "" } },
  ),
  sel("detachTextFromPath"),
  // Select same.
  { ...sel("selectSameFill"), result: SELECTION_RESULT },
  { ...sel("selectSameStroke"), result: SELECTION_RESULT },
  twin("selectSameStrokeWeight", { ...T, tolerance: LEN }, { result: SELECTION_RESULT }),
  // Insert shapes — the generators' full parameters.
  twin("insertArc", ARC),
  twin("insertSpiral", SPIRAL),
  twin("insertRectGrid", RECT_GRID),
  twin("insertPolarGrid", POLAR_GRID),
  // Pattern fields.
  twin("makePatternFromSelection", { ...T, name: TEXT }),
  recipeVerb("editPatternField", "pattern", "pattern", "patternId"),
  recipeVerb("selectPatternTiles", "pattern", "pattern", "patternId", { includeSources: BOOL }, { result: SELECTION_RESULT }),
  recipeVerb("deletePatternTiles", "pattern", "pattern", "patternId"),
  recipeVerb("releasePatternField", "pattern", "pattern", "patternId"),
  // Repeats.
  twin("makeRadialRepeat", { ...T, name: TEXT }),
  twin("makeGridRepeat", { ...T, name: TEXT }),
  twin("makeMirrorRepeat", { ...T, name: TEXT }),
  recipeVerb("updateRepeat", "repeat", "repeat", "repeatId"),
  recipeVerb("selectRepeatInstances", "repeat", "repeat", "repeatId", { includeSources: BOOL }, { result: SELECTION_RESULT }),
  recipeVerb("expandRepeat", "repeat", "repeat", "repeatId"),
  recipeVerb("releaseRepeat", "repeat", "repeat", "repeatId"),
  // Blends.
  twin("blendSelected", { ...T, name: TEXT }),
  recipeVerb("updateBlend", "blend", "blend", "blendId"),
  recipeVerb("replaceBlendSpine", "blend", "blend", "blendId", T),
  recipeVerb("reverseBlendSpine", "blend", "blend", "blendId"),
  recipeVerb("reverseBlendFrontToBack", "blend", "blend", "blendId"),
  recipeVerb("selectBlendObjects", "blend", "blend", "blendId", { which: enumOf(["keys", "steps", "spine", "all"]) }, { result: SELECTION_RESULT }),
  recipeVerb("expandBlend", "blend", "blend", "blendId"),
  recipeVerb("releaseBlend", "blend", "blend", "blendId"),
  // Objects on a path.
  twin("makeObjectsOnPath", { ...T, name: TEXT }),
  recipeVerb("updateObjectsOnPath", "onPath", "objectsOnPath", "onPathId"),
  recipeVerb("selectObjectsOnPath", "onPath", "objectsOnPath", "onPathId", { which: enumOf(["objects", "path", "all"]) }, { result: SELECTION_RESULT }),
  recipeVerb("expandObjectsOnPath", "onPath", "objectsOnPath", "onPathId"),
  recipeVerb("releaseObjectsOnPath", "onPath", "objectsOnPath", "onPathId"),
  // Image trace — the full option set.
  twin("imageTrace", { ...T, ...TRACE }),
];

/** The args schema of a twin. */
export const argsOf = (t: TwinSpec): ValueType => ({ kind: "struct", fields: t.fields });

/** The untyped payload a twin's args lower to (pure). */
export function payloadFor(t: TwinSpec, args: Record<string, unknown>): unknown {
  if (t.payload) return t.payload(args);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "targets") continue;
    const kind = t.ids?.[k];
    let value = v;
    if (kind !== undefined) {
      if (v === "") continue; // resolve from the selection
      value = kind ? bareIdOf(String(v), kind) : v;
    }
    out[t.rename?.[k] ?? k] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function elementIdsOf(targets: readonly string[]): ElementId[] {
  return targets.map((a) => {
    const p = parseAddress(a);
    const id = p ? toElementId(p) : null;
    if (!id || id.kind === "storyRange") throw new Error(`invalidValue: ${a} is not a page item`);
    return id;
  });
}

/** The typed command contributions, bound to `host`. */
export function typedCommands(host: BundleHost): TypedCommandContribution[] {
  return TWINS.map((t) => ({
    id: t.id,
    title: t.title,
    args: argsOf(t),
    ...(t.result ? { result: t.result } : {}),
    async handler(ctx, raw) {
      const args = raw as Record<string, unknown>;
      if (t.via) {
        const out = (await t.via(ctx.objects, args)) as { applied?: boolean; reason?: string } | undefined;
        if (out && out.applied === false) throw new Error(`failed: ${out.reason ?? t.id}`);
        return null;
      }
      const handler = commandHandler(host, t.id);
      if (!handler) throw new Error(`unknownCommand: ${t.id} is not registered on this host`);
      const targets = Array.isArray(args.targets) ? (args.targets as string[]) : [];
      if (targets.length > 0) await host.selection.set(elementIdsOf(targets));
      const result = await handler(undefined, payloadFor(t, args));
      if (t.result === SELECTION_RESULT) return host.selection.get().map(fromElementId);
      return result ?? null;
    },
  }));
}
