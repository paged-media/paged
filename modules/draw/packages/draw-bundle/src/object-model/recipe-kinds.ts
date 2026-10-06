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

// The five GENERATOR recipes as object kinds — `pattern`, `repeat`,
// `blend`, `livePaint`, `objectsOnPath` (ADR 323).
//
// SCHEMAS ARE DERIVED FROM THE RECIPE TYPES. Each params table below is a
// `Record<keyof XParams, …>`: a new recipe parameter fails typecheck
// until it has a schema row, and the defaults come from the module's own
// `X_DEFAULTS`. A recipe's artwork lists (sources, instances, steps, …)
// are read-only rows: they are what the last Make / Update BUILT.
//
// WRITES are plugin state — the label-hash pattern (src/recipe-store.ts):
// a content-addressed part + the document label in the registry's ONE
// commit, so a parameter edit is ONE undo step and undo brings the old
// parameters back. A write changes the RECIPE, not the artwork: the
// artwork follows on the typed `update*` / `edit*` / `regenerate*`
// command. They cannot share one step: an update mints new element ids
// and the recipe records them, so the recipe can only be written once
// the artwork batch has answered (recorded as a gap / contract issue —
// an `ObjectWrite` with a post-commit continuation would close it).
// `create` and `delete` are the typed make / release commands, which
// build and remove artwork.

import type {
  BundleHost,
  ObjectKindContribution,
  ObjectOp,
  ObjectValue,
  ObjectWrite,
  PropertySchema,
  ValueType,
} from "@paged-media/plugin-api";

import { EASE_KINDS } from "@paged-media/draw-geometry";

import {
  BLEND_DEFAULTS,
  BLEND_MAX_STEPS,
  BLEND_PART,
  readBlendLibrary,
  serializeBlendLibrary,
  type BlendParams,
} from "../commands/blend";
import {
  LIVE_PAINT_PART,
  readLivePaintLibrary,
  serializeLivePaintLibrary,
} from "../commands/live-paint";
import {
  OBJECTS_ON_PATH_DEFAULTS,
  OBJECTS_ON_PATH_PART,
  readObjectsOnPathLibrary,
  serializeObjectsOnPathLibrary,
  type ObjectsOnPathParams,
} from "../commands/objects-on-path";
import {
  PATTERN_DEFAULTS,
  PATTERN_PART,
  readPatternLibrary,
  serializePatternLibrary,
  type PatternParams,
} from "../commands/pattern";
import {
  REPEAT_DEFAULTS,
  REPEAT_PART,
  readRepeatLibrary,
  serializeRepeatLibrary,
  type RepeatParams,
} from "../commands/repeat";
import { SYMBOL_REGISTRATIONS } from "../commands/symbols";
import { planRecipeWrite } from "../recipe-store";
import {
  BOOL,
  DEG,
  INT,
  LEN,
  NUM,
  PCT,
  POINT,
  REF_FRAME,
  REFS,
  TEXT,
  addressOf,
  coreAddressOf,
  derived,
  enumOf,
  localIdOf,
  refuse,
  ro,
  row,
  val,
} from "./shared";

/** One parameter's schema (the row minus its path). */
interface ParamRow {
  type: ValueType;
  nullable?: boolean;
  range?: PropertySchema["range"];
  summary?: string;
}

type ElementRef = { kind: string; id: string };
const refs = (list: readonly ElementRef[]) => list.map(coreAddressOf);

// ------------------------------------------------- params, per recipe

const REPEAT_PARAMS: Record<keyof RepeatParams, ParamRow> = {
  kind: { type: enumOf(["radial", "grid", "mirror"]), summary: "Which repeat: around a ring, on a grid, or mirrored." },
  count: { type: INT, range: { min: 1, max: 200 }, summary: "Radial: instances around the ring." },
  radiusPt: { type: LEN, range: { min: 0 }, summary: "Radial: ring radius." },
  startDeg: { type: DEG, summary: "Radial: angle of the first instance." },
  sweepDeg: { type: DEG, range: { min: -360, max: 360 }, summary: "Radial: the arc the instances span." },
  rotateInstances: { type: BOOL, summary: "Radial: turn each instance with the ring." },
  columns: { type: INT, range: { min: 1 }, summary: "Grid: columns." },
  rows: { type: INT, range: { min: 1 }, summary: "Grid: rows." },
  spacing: { type: POINT, summary: "Grid: [horizontal, vertical] gap in pt." },
  flipColumns: { type: BOOL, summary: "Grid: mirror every other column." },
  flipRows: { type: BOOL, summary: "Grid: mirror every other row." },
  angleDeg: { type: DEG, summary: "Mirror: the axis angle." },
  offsetPt: { type: LEN, nullable: true, summary: "Mirror: axis offset from the source (null = touching)." },
  clip: { type: BOOL, summary: "Clip the instances (to clipRect, or the page)." },
  clipRect: { type: { kind: "bounds" }, nullable: true, summary: "Clip rectangle [top, left, bottom, right]; null = the page." },
  fitToArtboard: { type: BOOL, summary: "Drop instances that would leave the page." },
};

const BLEND_PARAMS: Record<keyof BlendParams, ParamRow> = {
  spacing: { type: enumOf(["smoothColor", "steps", "distance"]), summary: "Spacing mode: smooth colour, specified steps, specified distance." },
  steps: { type: INT, range: { min: 1, max: BLEND_MAX_STEPS }, summary: "Specified steps: the intermediate count." },
  distancePt: { type: LEN, range: { min: 0 }, summary: "Specified distance: the gap along the spine." },
  orientation: { type: enumOf(["page", "path"]), summary: "Align intermediates to the page, or turn them with the spine." },
  easing: { type: enumOf(EASE_KINDS), summary: "Position easing curve." },
  easingStrength: { type: NUM, range: { min: 0, max: 1 }, summary: "Position easing strength (0 = linear)." },
  colorEasing: { type: enumOf(EASE_KINDS), nullable: true, summary: "Independent colour easing; null = follow position." },
  colorEasingStrength: { type: NUM, range: { min: 0, max: 1 }, summary: "Colour easing strength." },
  reverseSpine: { type: BOOL, summary: "Run along the spine the other way." },
  reverseFrontToBack: { type: BOOL, summary: "Reverse the paint order of the intermediates." },
  fitToArtboard: { type: BOOL, summary: "Drop intermediates that would leave the page." },
};

const PATTERN_PARAMS: Record<keyof PatternParams, ParamRow> = {
  layout: { type: enumOf(["grid", "brick", "hex"]), summary: "Tile lattice." },
  tile: { type: POINT, nullable: true, summary: "Tile size [width, height] in pt; null = the source's bounds." },
  spacing: { type: POINT, summary: "[horizontal, vertical] spacing in pt; negative overlaps." },
  columns: { type: INT, range: { min: 1 }, summary: "Copies across." },
  rows: { type: INT, range: { min: 1 }, summary: "Copies down." },
  offset: { type: NUM, range: { min: 0, max: 1 }, summary: "Brick / hex row offset, as a fraction of a tile." },
  dim: { type: PCT, range: { min: 0, max: 100 }, summary: "Copies' opacity (a real frameOpacity)." },
  overlap: {
    type: {
      kind: "struct",
      fields: {
        horizontal: enumOf(["leftInFront", "rightInFront"]),
        vertical: enumOf(["topInFront", "bottomInFront"]),
      },
    },
    summary: "Which copy paints in front, across and down.",
  },
  fitToArtboard: { type: BOOL, summary: "Only tiles that fit the page." },
};

const OBJECTS_ON_PATH_PARAMS: Record<keyof ObjectsOnPathParams, ParamRow> = {
  distribute: { type: enumOf(["count", "spacing"]), summary: "Spread the objects evenly, or at a fixed spacing." },
  spacingPt: { type: LEN, range: { min: 0 }, summary: "Spacing mode: the gap along the path." },
  startOffsetPt: { type: LEN, summary: "Where along the path the first object sits." },
  alignToPath: { type: BOOL, summary: "Turn each object with the path's tangent." },
  pivot: { type: enumOf(SYMBOL_REGISTRATIONS), summary: "The point of each object that rides the path." },
  reverseOrder: { type: BOOL, summary: "Place the objects in reverse order." },
  order: { type: { kind: "list", of: INT }, nullable: true, summary: "An explicit object order; null = selection order." },
  fitToArtboard: { type: BOOL, summary: "Skip slots that would leave the page." },
};

const paramRows = <P extends object>(table: Record<keyof P, ParamRow>, defaults: P): PropertySchema[] =>
  (Object.keys(table) as (keyof P & string)[]).map((k) =>
    row(k, table[k].type, {
      ...(table[k].nullable ? { nullable: true } : {}),
      ...(table[k].range ? { range: table[k].range } : {}),
      default: defaults[k],
      ...(table[k].summary ? { summary: table[k].summary } : {}),
    }),
  );

const NAME = row("name", TEXT, { title: "Name", summary: "The recipe's name — what a persisted reference selects by." });

// ----------------------------------------------------- the factory

interface RecipeRecord {
  id: string;
  name: string;
  params?: object;
}

interface RecipeSpec<L> {
  kind: string;
  title: string;
  part: string;
  schema: readonly PropertySchema[];
  read(host: BundleHost): Promise<L>;
  records(lib: L): RecipeRecord[];
  withRecords(lib: L, records: RecipeRecord[]): L;
  serialize(lib: L): Uint8Array;
  /** Read-only rows computed from a record. */
  extra(record: RecipeRecord): Record<string, unknown>;
  /** The typed verbs that build / remove the artwork (for refusals). */
  verbs: { make: string; release: string };
}

function makeRecipeKind<L>(host: BundleHost, spec: RecipeSpec<L>): ObjectKindContribution {
  const writable = new Set(
    spec.schema.filter((r) => (r.access ?? "readWrite") === "readWrite").map((r) => r.path),
  );
  const find = async (address: string) => {
    const id = localIdOf(address, spec.kind);
    if (!id) return null;
    return spec.records(await spec.read(host)).find((r) => r.id === id) ?? null;
  };
  return {
    kind: spec.kind,
    title: spec.title,
    schema: spec.schema,
    hostOf: () => "doc",
    async list() {
      return spec.records(await spec.read(host)).map((r) => addressOf(spec.kind, r.id));
    },
    async get(address, path): Promise<ObjectValue> {
      const rec = await find(address);
      if (!rec) return refuse("unknownAddress", `no ${spec.kind} ${address}`);
      if (path === "name") return val(rec.name);
      const params = rec.params as Record<string, unknown> | undefined;
      if (params && path in params) return val(params[path]);
      const extra = spec.extra(rec);
      if (path in extra) return val(extra[path]);
      return refuse("unknownPath", `${spec.kind} has no "${path}"`);
    },
    async batch(ops: readonly ObjectOp[]): Promise<ObjectWrite> {
      const lib = await spec.read(host);
      const records = spec.records(lib).map((r) => ({
        ...r,
        ...(r.params ? { params: { ...(r.params as Record<string, unknown>) } } : {}),
      }));
      for (const op of ops) {
        if (op.op === "create") {
          return { kind: "rejected", reason: `a ${spec.kind} is built from artwork — invoke ${spec.verbs.make}` };
        }
        if (op.op === "delete") {
          return { kind: "rejected", reason: `removing a ${spec.kind} removes artwork — invoke ${spec.verbs.release}` };
        }
        if (op.op !== "set") return { kind: "rejected", reason: `${spec.kind} cannot ${op.op}` };
        const id = localIdOf(op.address, spec.kind);
        const rec = records.find((r) => r.id === id);
        if (!rec) return { kind: "rejected", reason: `no ${spec.kind} ${op.address}` };
        if (!writable.has(op.path)) return { kind: "rejected", reason: `${spec.kind} has no writable "${op.path}"` };
        if (op.path === "name") rec.name = String(op.value);
        else (rec.params as Record<string, unknown>)[op.path] = op.value;
      }
      const plan = await planRecipeWrite(host, spec.part, spec.serialize(spec.withRecords(lib, records)));
      if (typeof plan === "string") return { kind: "rejected", reason: plan };
      return { kind: "mutations", mutations: [plan.mutation] };
    },
  };
}

// ------------------------------------------------------ the five kinds

const C = "media.paged.draw.command";

export const REPEAT_SCHEMA: readonly PropertySchema[] = [
  NAME,
  ...paramRows(REPEAT_PARAMS, REPEAT_DEFAULTS),
  ro("sources", REFS, "The source artwork."),
  ro("instances", REFS, "The instances the last Make / Update built."),
  row("clipFrame", REF_FRAME, { access: "readOnly", nullable: true, summary: "The clip frame of a clipped repeat (null = unclipped)." }),
];

export const BLEND_SCHEMA: readonly PropertySchema[] = [
  NAME,
  ...paramRows(BLEND_PARAMS, BLEND_DEFAULTS),
  ro("keys", REFS, "The two key objects."),
  row("spine", REF_FRAME, { access: "readOnly", nullable: true, summary: "The replaced spine path (null = the straight line between the keys)." }),
  ro("stepObjects", REFS, "The intermediates the last Make / Update built."),
];

export const PATTERN_SCHEMA: readonly PropertySchema[] = [
  NAME,
  ...paramRows(PATTERN_PARAMS, PATTERN_DEFAULTS),
  ro("sources", REFS, "The tile's source artwork."),
];

export const OBJECTS_ON_PATH_SCHEMA: readonly PropertySchema[] = [
  NAME,
  ...paramRows(OBJECTS_ON_PATH_PARAMS, OBJECTS_ON_PATH_DEFAULTS),
  row("path", REF_FRAME, { access: "readOnly", nullable: true, summary: "The path the objects ride." }),
  ro("objects", REFS, "The objects on the path (moved, never copied)."),
];

export const LIVE_PAINT_SCHEMA: readonly PropertySchema[] = [
  NAME,
  ro("inputs", REFS, "The ordered member paths the faces are computed from."),
  ro(
    "faces",
    { kind: "list", of: { kind: "struct", fields: { face: TEXT, fill: TEXT } } },
    "Each painted face id and its swatch (\"\" = unpainted). Paint through fillLivePaintFace.",
  ),
  derived("faceCount", INT, "How many faces carry a paint."),
];

/** The pure manifest view of the five kinds. */
export const RECIPE_KINDS: readonly { kind: string; title: string; schema: readonly PropertySchema[] }[] = [
  { kind: "pattern", title: "Pattern field", schema: PATTERN_SCHEMA },
  { kind: "repeat", title: "Repeat", schema: REPEAT_SCHEMA },
  { kind: "blend", title: "Blend", schema: BLEND_SCHEMA },
  { kind: "livePaint", title: "Live paint group", schema: LIVE_PAINT_SCHEMA },
  { kind: "objectsOnPath", title: "Objects on a path", schema: OBJECTS_ON_PATH_SCHEMA },
];

export function makeRecipeKinds(host: BundleHost): ObjectKindContribution[] {
  return [
    makeRecipeKind(host, {
      kind: "pattern",
      title: "Pattern field",
      part: PATTERN_PART,
      schema: PATTERN_SCHEMA,
      read: readPatternLibrary,
      records: (l) => l.fields,
      withRecords: (l, r) => ({ ...l, fields: r as typeof l.fields }),
      serialize: serializePatternLibrary,
      extra: (r) => ({ sources: refs((r as unknown as { sources: ElementRef[] }).sources) }),
      verbs: { make: `${C}.makePatternFromSelection`, release: `${C}.releasePatternField` },
    }),
    makeRecipeKind(host, {
      kind: "repeat",
      title: "Repeat",
      part: REPEAT_PART,
      schema: REPEAT_SCHEMA,
      read: readRepeatLibrary,
      records: (l) => l.repeats,
      withRecords: (l, r) => ({ ...l, repeats: r as typeof l.repeats }),
      serialize: serializeRepeatLibrary,
      extra: (r) => {
        const x = r as unknown as { sources: ElementRef[]; instances: ElementRef[]; clipFrame: ElementRef | null };
        return {
          sources: refs(x.sources),
          instances: refs(x.instances),
          clipFrame: x.clipFrame ? coreAddressOf(x.clipFrame) : null,
        };
      },
      verbs: { make: `${C}.makeRadialRepeat / makeGridRepeat / makeMirrorRepeat`, release: `${C}.releaseRepeat` },
    }),
    makeRecipeKind(host, {
      kind: "blend",
      title: "Blend",
      part: BLEND_PART,
      schema: BLEND_SCHEMA,
      read: readBlendLibrary,
      records: (l) => l.blends,
      withRecords: (l, r) => ({ ...l, blends: r as typeof l.blends }),
      serialize: serializeBlendLibrary,
      extra: (r) => {
        const x = r as unknown as { keys: ElementRef[]; spine: ElementRef | null; steps: ElementRef[] };
        return { keys: refs(x.keys), spine: x.spine ? coreAddressOf(x.spine) : null, stepObjects: refs(x.steps) };
      },
      verbs: { make: `${C}.blendSelected`, release: `${C}.releaseBlend` },
    }),
    makeRecipeKind(host, {
      kind: "livePaint",
      title: "Live paint group",
      part: LIVE_PAINT_PART,
      schema: LIVE_PAINT_SCHEMA,
      read: readLivePaintLibrary,
      records: (l) => l.groups,
      withRecords: (l, r) => ({ ...l, groups: r as typeof l.groups }),
      serialize: serializeLivePaintLibrary,
      extra: (r) => {
        const x = r as unknown as { inputs: ElementRef[]; faces: { face: string; fill: string | null }[] };
        return {
          inputs: refs(x.inputs),
          faces: x.faces.map((f) => ({ face: f.face, fill: f.fill ?? "" })),
          faceCount: x.faces.filter((f) => f.fill !== null).length,
        };
      },
      verbs: { make: `${C}.makeLivePaintGroup`, release: `${C}.releaseLivePaint` },
    }),
    makeRecipeKind(host, {
      kind: "objectsOnPath",
      title: "Objects on a path",
      part: OBJECTS_ON_PATH_PART,
      schema: OBJECTS_ON_PATH_SCHEMA,
      read: readObjectsOnPathLibrary,
      records: (l) => l.associations,
      withRecords: (l, r) => ({ ...l, associations: r as typeof l.associations }),
      serialize: serializeObjectsOnPathLibrary,
      extra: (r) => {
        const x = r as unknown as { path: ElementRef | null; objects: ElementRef[] };
        return { path: x.path ? coreAddressOf(x.path) : null, objects: refs(x.objects) };
      },
      verbs: { make: `${C}.makeObjectsOnPath`, release: `${C}.releaseObjectsOnPath` },
    }),
  ];
}
