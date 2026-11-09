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

// BRUSHES AND WIDTH PROFILES as live stroke styles (WP6.4, engine ADR
// 1053, draw ADR 366). The engine draws a page item's stroke as a
// brush's artwork along its path, or as a variable-width band, from two
// entries of the item's object effect stack (`frameEffectStack`):
//
//   brush         { brushType: art | scatter | pattern | bristle,
//                   artNodes / artStarts / artClosed, scalePct, … }
//   widthProfile  { widthPoints: [[t, width × weight], …] }
//
// Nothing here draws: these commands write those entries, one batch for
// the whole selection (one undo step), leaving every other entry of the
// stack in its place. The path stays editable; Expand Appearance keeps
// the artwork for good; IDML export writes it baked and says so.
//
// BRUSH LIBRARIES. The built-in libraries are data (below). The
// document's own brushes (New brush from the selection) live in a
// container part, `brushes/library.json`, declared as the
// `brushLibrary` part type — like the graphic-style library, a container
// write that is not an undo step.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  Value,
} from "@paged-media/plugin-api";
import {
  normalizeWidthPoints,
  WIDTH_PROFILE_PRESETS,
  type WidthPoint,
} from "@paged-media/vector-geometry";
import { defineMessages } from "@paged-media/strings";

import { oneBatchFor } from "./batch-handles";
import { registerCommand } from "../command-registry";

const M = defineMessages("draw.brushes", {
  applyBrush: "Apply a brush to the selection's stroke",
  removeBrush: "Remove the brush from the selection's stroke",
  brushOptions: "Brush options",
  brushes: "Brushes",
  newBrush: "New brush from the selection",
  applyWidthProfile: "Apply a width profile to the selection's stroke",
  basic: "Basic",
  artistic: "Artistic",
  decorative: "Decorative",
  document: "Document brushes",
  tapered: "Tapered",
  taperedThin: "Tapered, thin",
  swash: "Swash",
  diamonds: "Diamonds",
  dashes: "Dashes",
  beads: "Beads",
  dots: "Dots",
  confetti: "Confetti",
  roundBristle: "Round bristle",
  flatFan: "Flat fan",
});

export const BRUSH_MESSAGES = M;

export const BRUSHES_PANEL_ID = "media.paged.draw.panel.brushes";
export const APPLY_BRUSH_COMMAND_ID = "media.paged.draw.command.applyBrush";
export const REMOVE_BRUSH_COMMAND_ID = "media.paged.draw.command.removeBrush";
export const BRUSH_OPTIONS_COMMAND_ID = "media.paged.draw.command.brushOptions";
export const BRUSHES_COMMAND_ID = "media.paged.draw.command.brushes";
export const NEW_BRUSH_COMMAND_ID = "media.paged.draw.command.newBrush";
export const APPLY_WIDTH_PROFILE_COMMAND_ID =
  "media.paged.draw.command.applyWidthProfile";
export const BRUSH_COMMAND_IDS = [
  APPLY_BRUSH_COMMAND_ID,
  REMOVE_BRUSH_COMMAND_ID,
  BRUSH_OPTIONS_COMMAND_ID,
  BRUSHES_COMMAND_ID,
  NEW_BRUSH_COMMAND_ID,
  APPLY_WIDTH_PROFILE_COMMAND_ID,
] as const;
export const BRUSH_COMMAND_CATEGORY = "Path";

/** The library part (relative to this plugin's container namespace). */
export const BRUSH_LIBRARY_PART = "brushes/library.json";

export const BRUSH_TYPES = ["art", "scatter", "pattern", "bristle"] as const;
export type BrushType = (typeof BRUSH_TYPES)[number];

/** A brush's settings: the `brush` entry's fields besides its type and
 *  artwork (engine `BrushParams`). */
export interface BrushOptions {
  scalePct: number;
  spacingPct: number;
  scatterPct: number;
  rotateDeg: number;
  rotateVariationDeg: number;
  sizeMinPct: number;
  flipAlong: boolean;
  flipAcross: boolean;
  tileAspect: number;
  bristles: number;
  bristleThicknessPct: number;
  seed: number;
}

export const DEFAULT_BRUSH_OPTIONS: BrushOptions = {
  scalePct: 100,
  spacingPct: 100,
  scatterPct: 0,
  rotateDeg: 0,
  rotateVariationDeg: 0,
  sizeMinPct: 100,
  flipAlong: false,
  flipAcross: false,
  tileAspect: 1,
  bristles: 24,
  bristleThicknessPct: 12,
  seed: 0,
};

/** The options' ranges — the engine's (it clamps the same). */
export const BRUSH_OPTION_RANGES: Record<
  keyof Omit<BrushOptions, "flipAlong" | "flipAcross">,
  readonly [number, number]
> = {
  scalePct: [1, 10_000],
  spacingPct: [1, 10_000],
  scatterPct: [0, 10_000],
  rotateDeg: [-360, 360],
  rotateVariationDeg: [0, 180],
  sizeMinPct: [0, 100],
  tileAspect: [0.01, 100],
  bristles: [1, 200],
  bristleThicknessPct: [0.1, 100],
  seed: [0, 4_294_967_295],
};

/** A brush's artwork in the brush frame (x along 0..1, y across ±0.5):
 *  nodes `[x, y, inX, inY, outX, outY]`, contour starts, closed flags.
 *  Absent: the type's built-in artwork. */
export interface BrushArt {
  nodes: [number, number, number, number, number, number][];
  starts: number[];
  closed: boolean[];
}

export interface BrushDef {
  id: string;
  /** A message key for a built-in brush, the user's name otherwise. */
  name: string;
  library: string;
  type: BrushType;
  options: Partial<BrushOptions>;
  art?: BrushArt;
}

const corner = (
  x: number,
  y: number,
): [number, number, number, number, number, number] => [x, y, x, y, x, y];

/** The built-in libraries, by id, in panel order. */
export const BRUSH_LIBRARIES: readonly { id: string; name: string }[] = [
  { id: "basic", name: M.basic },
  { id: "artistic", name: M.artistic },
  { id: "decorative", name: M.decorative },
];

/** The built-in brushes. */
export const BUILTIN_BRUSHES: readonly BrushDef[] = [
  {
    id: "tapered",
    name: M.tapered,
    library: "basic",
    type: "art",
    options: {},
  },
  {
    id: "taperedThin",
    name: M.taperedThin,
    library: "basic",
    type: "art",
    options: { scalePct: 50 },
  },
  {
    id: "dots",
    name: M.dots,
    library: "basic",
    type: "scatter",
    options: { spacingPct: 150 },
  },
  {
    id: "diamonds",
    name: M.diamonds,
    library: "basic",
    type: "pattern",
    options: {},
  },
  {
    id: "roundBristle",
    name: M.roundBristle,
    library: "artistic",
    type: "bristle",
    options: { bristles: 32, bristleThicknessPct: 10 },
  },
  {
    id: "flatFan",
    name: M.flatFan,
    library: "artistic",
    type: "bristle",
    options: { bristles: 12, bristleThicknessPct: 20, scalePct: 140 },
  },
  {
    id: "swash",
    name: M.swash,
    library: "artistic",
    type: "art",
    options: {},
    // A blade that swells near its start and thins to a point.
    art: {
      nodes: [
        [0, 0, 0, 0, 0.05, -0.3],
        [0.25, -0.5, 0.12, -0.5, 0.5, -0.5],
        [1, 0, 0.8, -0.15, 0.8, 0.1],
        [0.25, 0.3, 0.5, 0.3, 0.1, 0.3],
      ],
      starts: [0],
      closed: [true],
    },
  },
  {
    id: "confetti",
    name: M.confetti,
    library: "decorative",
    type: "scatter",
    options: {
      spacingPct: 120,
      scatterPct: 120,
      rotateVariationDeg: 180,
      sizeMinPct: 40,
      seed: 7,
    },
    art: {
      nodes: [corner(0, -0.5), corner(1, -0.5), corner(1, 0.5), corner(0, 0.5)],
      starts: [0],
      closed: [true],
    },
  },
  {
    id: "dashes",
    name: M.dashes,
    library: "decorative",
    type: "pattern",
    options: { tileAspect: 3 },
    art: {
      nodes: [
        corner(0.1, -0.3),
        corner(0.9, -0.3),
        corner(0.9, 0.3),
        corner(0.1, 0.3),
      ],
      starts: [0],
      closed: [true],
    },
  },
  {
    id: "beads",
    name: M.beads,
    library: "decorative",
    type: "pattern",
    options: { tileAspect: 1 },
  },
];

const failed = (why: string): never => {
  throw new Error(`failed: ${why}`);
};

/** The page items a stroke style takes (the engine's object stacks). */
export function takesStrokeStyle(id: ElementId): boolean {
  return (
    id.kind === "polygon" ||
    id.kind === "rectangle" ||
    id.kind === "oval" ||
    id.kind === "textFrame"
  );
}

/** One wire entry of an effect stack (`EffectEntrySpec`), as far as this
 *  module reads and writes it. */
export type StackEntry = { kind: string; enabled?: boolean } & Record<
  string,
  unknown
>;

/** The `brush` entry a brush definition writes, `options` over the
 *  definition's own. */
export function brushEntryFor(
  def: Pick<BrushDef, "type" | "options" | "art">,
  options: Partial<BrushOptions> = {},
): StackEntry {
  const o = { ...DEFAULT_BRUSH_OPTIONS, ...def.options, ...options };
  const entry: StackEntry = {
    kind: "brush",
    enabled: true,
    brushType: def.type,
    ...o,
  };
  if (def.art && def.art.nodes.length > 0) {
    entry.artNodes = def.art.nodes;
    entry.artStarts = def.art.starts;
    entry.artClosed = def.art.closed;
  }
  return entry;
}

/** The `widthProfile` entry of `points` (`[t, width × weight]`). */
export function widthProfileEntryFor(
  points: readonly WidthPoint[],
): StackEntry {
  return {
    kind: "widthProfile",
    enabled: true,
    widthPoints: normalizeWidthPoints(points),
  };
}

/** `stack` with every entry of `kind` replaced by `entry` (in the first
 *  one's place), or `entry` appended when there was none; `entry` null
 *  removes them. A width profile goes before a brush, which reads it. */
export function withStrokeStyle(
  stack: readonly StackEntry[],
  kind: "brush" | "widthProfile",
  entry: StackEntry | null,
): StackEntry[] {
  const at = stack.findIndex((e) => e.kind === kind);
  const rest = stack.filter((e) => e.kind !== kind);
  if (!entry) return rest;
  if (at >= 0) {
    const out = [...rest];
    out.splice(Math.min(at, out.length), 0, entry);
    return out;
  }
  if (kind === "widthProfile") {
    const brush = rest.findIndex((e) => e.kind === "brush");
    if (brush >= 0) {
      const out = [...rest];
      out.splice(brush, 0, entry);
      return out;
    }
  }
  return [...rest, entry];
}

/** The `setElementProperty` that writes `id`'s object stack. */
export function stackMutationFor(
  id: ElementId,
  entries: readonly StackEntry[],
): Mutation {
  return {
    op: "setElementProperty",
    args: {
      elementId: id,
      path: "frameEffectStack",
      value: {
        type: "effectStack",
        value: { entries: entries as never },
      } as Value,
    },
  };
}

/** What a stroke-style command reads of an item. */
export interface StrokeRead {
  stack: StackEntry[];
  weight: number;
  strokes: boolean;
}

/** `id`'s object stack, stroke weight and whether it strokes at all. */
export async function readStroke(
  host: BundleHost,
  id: ElementId,
): Promise<StrokeRead> {
  const out: StrokeRead = { stack: [], weight: 1, strokes: false };
  const props = await host.document.elementProperties(id).catch(() => null);
  for (const e of props?.entries ?? []) {
    const v = e.value as { type?: string; value?: unknown } | null | undefined;
    if (!v) continue;
    if (e.path === "frameEffectStack" && v.type === "effectStack") {
      const entries = (v.value as { entries?: unknown } | null)?.entries;
      if (Array.isArray(entries)) out.stack = entries as StackEntry[];
    } else if (e.path === "frameStrokeWeight" && v.type === "length") {
      if (typeof v.value === "number" && v.value > 0) out.weight = v.value;
    } else if (e.path === "frameStrokeColor" && v.type === "colorRef") {
      out.strokes =
        typeof v.value === "string" &&
        v.value !== "Swatch/None" &&
        v.value !== "n";
    }
  }
  return out;
}

/** The selection's items that take a stroke style; refuses an empty one. */
function targets(host: BundleHost): ElementId[] {
  const ids = host.selection.get().filter(takesStrokeStyle);
  if (ids.length === 0)
    failed("select a path, rectangle, ellipse or text frame with a stroke");
  return ids;
}

/** Rewrite each target's stack with `edit`, in one batch. */
async function rewriteStacks(
  host: BundleHost,
  ids: readonly ElementId[],
  edit: (read: StrokeRead) => StackEntry[] | null,
): Promise<number> {
  const mutations: Mutation[] = [];
  for (const id of ids) {
    const read = await readStroke(host, id);
    const next = edit(read);
    if (next) mutations.push(stackMutationFor(id, next));
  }
  if (mutations.length === 0) return 0;
  const outcome = await host.document.mutate(
    mutations.length === 1 ? mutations[0]! : oneBatchFor(mutations),
  );
  if (!outcome.applied)
    failed(
      `the engine refused the stroke style: ${JSON.stringify(outcome.error)}`,
    );
  return mutations.length;
}

// ------------------------------------------------------------- library

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The document's own brushes (the container part), `[]` without any or
 *  on a host with no container. */
export async function documentBrushes(host: BundleHost): Promise<BrushDef[]> {
  const bytes = await host.parts.read(BRUSH_LIBRARY_PART).catch(() => null);
  if (!bytes) return [];
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as { brushes?: unknown };
    return Array.isArray(parsed.brushes)
      ? (parsed.brushes as BrushDef[]).filter(
          (b) =>
            typeof b?.id === "string" &&
            (BRUSH_TYPES as readonly string[]).includes(b.type),
        )
      : [];
  } catch {
    return [];
  }
}

async function writeDocumentBrushes(
  host: BundleHost,
  brushes: readonly BrushDef[],
): Promise<void> {
  await host.parts.write(
    BRUSH_LIBRARY_PART,
    encoder.encode(JSON.stringify({ version: 1, brushes }, null, 2)),
  );
}

/** Every brush a command may name: the built-ins, then the document's. */
export async function allBrushes(host: BundleHost): Promise<BrushDef[]> {
  return [...BUILTIN_BRUSHES, ...(await documentBrushes(host))];
}

/** The brush `id` names, or the refusal. */
export async function brushById(
  host: BundleHost,
  id: unknown,
): Promise<BrushDef> {
  if (typeof id !== "string" || !id) return failed("name a brush (`brush`)");
  const found = (await allBrushes(host)).find((b) => b.id === id);
  return found ?? failed(`there is no brush \`${id}\``);
}

/** The options a payload sets, validated against the ranges. */
export function brushOptionsOf(payload: unknown): Partial<BrushOptions> {
  const raw =
    payload && typeof payload === "object"
      ? ((payload as { options?: unknown }).options ?? payload)
      : {};
  const out: Partial<BrushOptions> = {};
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(BRUSH_OPTION_RANGES) as Array<
    keyof typeof BRUSH_OPTION_RANGES
  >) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v))
      failed(`\`${key}\` is a number`);
    const [lo, hi] = BRUSH_OPTION_RANGES[key];
    if ((v as number) < lo || (v as number) > hi)
      failed(`\`${key}\` is between ${lo} and ${hi}`);
    (out as Record<string, number>)[key] = v as number;
  }
  for (const key of ["flipAlong", "flipAcross"] as const) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") failed(`\`${key}\` is true or false`);
    out[key] = v as boolean;
  }
  return out;
}

// ------------------------------------------------------------ commands

/** Apply brush `payload.brush` (with `payload.options` over its own) to
 *  the selection's stroke, one batch. */
export async function applyBrush(
  host: BundleHost,
  payload: unknown,
): Promise<{ applied: number }> {
  const p = (payload ?? {}) as { brush?: unknown; options?: unknown };
  const def = await brushById(host, p.brush);
  const options = brushOptionsOf(p.options ?? {});
  const ids = targets(host);
  const entry = brushEntryFor(def, options);
  const applied = await rewriteStacks(host, ids, (r) =>
    withStrokeStyle(r.stack, "brush", entry),
  );
  return { applied };
}

/** Take the brush off the selection's stroke (Illustrator's Remove Brush
 *  Stroke): the stroke is drawn plain again. */
export async function removeBrush(
  host: BundleHost,
): Promise<{ removed: number }> {
  const ids = targets(host);
  const removed = await rewriteStacks(host, ids, (r) =>
    r.stack.some((e) => e.kind === "brush")
      ? withStrokeStyle(r.stack, "brush", null)
      : null,
  );
  if (removed === 0) failed("nothing selected has a brush");
  return { removed };
}

/** Change the options of the brush each selected item carries (Brush
 *  Options), one batch; items without a brush are left alone. */
export async function setBrushOptions(
  host: BundleHost,
  payload: unknown,
): Promise<{ changed: number }> {
  const options = brushOptionsOf(payload);
  const ids = targets(host);
  const changed = await rewriteStacks(host, ids, (r) => {
    const at = r.stack.findIndex((e) => e.kind === "brush");
    if (at < 0) return null;
    const next = [...r.stack];
    next[at] = { ...next[at]!, ...options };
    return next;
  });
  if (changed === 0) failed("nothing selected has a brush");
  return { changed };
}

/** The width profile a payload names: `profile` (a library id) or
 *  `points` (`[[t, width], …]`). */
export function widthPointsOf(payload: unknown): [number, number][] {
  const p = (payload ?? {}) as { profile?: unknown; points?: unknown };
  if (typeof p.profile === "string" && p.profile) {
    const preset = WIDTH_PROFILE_PRESETS.find((w) => w.id === p.profile);
    if (!preset) failed(`there is no width profile \`${p.profile}\``);
    return normalizeWidthPoints(preset!.points);
  }
  if (Array.isArray(p.points)) {
    const pts = p.points as unknown[];
    if (
      !pts.every(
        (x) =>
          Array.isArray(x) &&
          x.length === 2 &&
          x.every((n) => typeof n === "number" && Number.isFinite(n)),
      )
    )
      failed("width points are `[t, width]` pairs of numbers");
    if ((pts as number[][]).some((x) => x[1]! < 0))
      failed("a width point's width is never negative");
    return normalizeWidthPoints(pts as [number, number][]);
  }
  return failed("name a width profile (`profile`) or give its `points`");
}

/** Give the selection's stroke a live width profile, one batch; the
 *  uniform profile takes the profile off. */
export async function applyWidthProfileStyle(
  host: BundleHost,
  payload: unknown,
): Promise<{ applied: number }> {
  const points = widthPointsOf(payload);
  const ids = targets(host);
  const entry = points.length > 0 ? widthProfileEntryFor(points) : null;
  const applied = await rewriteStacks(host, ids, (r) =>
    !entry && !r.stack.some((e) => e.kind === "widthProfile")
      ? null
      : withStrokeStyle(r.stack, "widthProfile", entry),
  );
  return { applied };
}

/** Make a brush of `type` from the first selected item's outline: its
 *  box becomes the brush frame (x along its width, y across its height,
 *  centred), stored in the document's library. */
export async function newBrushFromSelection(
  host: BundleHost,
  payload: unknown,
): Promise<{ brush: string }> {
  const p = (payload ?? {}) as { type?: unknown; name?: unknown };
  const type = (p.type ?? "art") as BrushType;
  if (!(BRUSH_TYPES as readonly string[]).includes(type))
    failed("a brush type is `art`, `scatter`, `pattern` or `bristle`");
  if (type === "bristle")
    failed("a bristle brush has no artwork — apply one from the library");
  const id = host.selection.get().find(takesStrokeStyle);
  if (!id) return failed("select the artwork the brush is made of");
  const table = await host.document.pathAnchors(id).catch(() => null);
  // A plain rectangle keeps no anchors (its box is its outline): the
  // artwork is the whole frame.
  const box: BrushArt = {
    nodes: [corner(0, 0.5), corner(1, 0.5), corner(1, -0.5), corner(0, -0.5)],
    starts: [0],
    closed: [true],
  };
  const art =
    table && table.anchors.length >= 2
      ? brushArtOf(table)
      : id.kind === "rectangle"
        ? box
        : failed("the selection has no outline to make a brush of");
  if (!art) return failed("the artwork has no width or no height");
  const existing = await documentBrushes(host);
  const brushId = `doc-${existing.length + 1}-${Date.now().toString(36)}`;
  const name =
    typeof p.name === "string" && p.name.trim()
      ? p.name.trim()
      : `${type[0]!.toUpperCase()}${type.slice(1)} ${existing.length + 1}`;
  await writeDocumentBrushes(host, [
    ...existing,
    { id: brushId, name, library: "document", type, options: {}, art },
  ]);
  return { brush: brushId };
}

/** An outline's anchors mapped into the brush frame. Pure. */
export function brushArtOf(table: {
  anchors: readonly {
    anchor: readonly [number, number];
    left: readonly [number, number];
    right: readonly [number, number];
  }[];
  subpathStarts: readonly number[];
  subpathOpen?: readonly boolean[] | null;
}): BrushArt | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of table.anchors)
    for (const q of [a.anchor, a.left, a.right]) {
      x0 = Math.min(x0, q[0]);
      y0 = Math.min(y0, q[1]);
      x1 = Math.max(x1, q[0]);
      y1 = Math.max(y1, q[1]);
    }
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(w > 1e-6) || !(h > 1e-6)) return null;
  // y down the page → the frame's y is positive to the LEFT of the path
  // (up, when the path runs to the right), so it flips.
  const map = (q: readonly [number, number]): [number, number] => [
    (q[0] - x0) / w,
    0.5 - (q[1] - y0) / h,
  ];
  const nodes = table.anchors.map((a) => {
    const p = map(a.anchor);
    const l = map(a.left);
    const r = map(a.right);
    return [p[0], p[1], l[0], l[1], r[0], r[1]] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
  });
  const starts =
    table.subpathStarts.length > 0 ? [...table.subpathStarts] : [0];
  const closed = starts.map((_, i) => table.subpathOpen?.[i] !== true);
  return { nodes, starts, closed };
}

/** Register the brush commands. `raise` opens the Brushes panel (the
 *  bare Brush Options and Brushes rows); without it those rows say so. */
export function contributeBrushCommands(host: BundleHost): Disposable {
  const raise = async (): Promise<boolean> => {
    if (!host.supports("shell.openPanel@1")) return false;
    await host.shell.openPanel(BRUSHES_PANEL_ID);
    return true;
  };
  const disposers = [
    registerCommand(host, {
      id: APPLY_BRUSH_COMMAND_ID,
      title: M.applyBrush,
      category: BRUSH_COMMAND_CATEGORY,
      // Run bare (a palette row, a payload-free invoke) it names no brush
      // and says so; the Brushes panel is where a brush is picked.
      handler: async (_paged, payload) => {
        if (payload === undefined) {
          host.log.info(
            `${APPLY_BRUSH_COMMAND_ID}: name a brush (\`brush\`) — the Brushes panel picks one`,
          );
          return undefined;
        }
        return applyBrush(host, payload);
      },
    }),
    registerCommand(host, {
      id: REMOVE_BRUSH_COMMAND_ID,
      title: M.removeBrush,
      category: BRUSH_COMMAND_CATEGORY,
      // Run bare (the menu row) on a selection without a brush it says so
      // and changes nothing; a payload (a script, the typed twin) gets
      // the refusal.
      handler: async (_paged, payload) => {
        try {
          return await removeBrush(host);
        } catch (err) {
          if (payload !== undefined) throw err;
          host.log.info(`${REMOVE_BRUSH_COMMAND_ID}: ${String(err)}`);
          return undefined;
        }
      },
    }),
    registerCommand(host, {
      id: BRUSH_OPTIONS_COMMAND_ID,
      title: M.brushOptions,
      category: BRUSH_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        if (payload !== undefined) return setBrushOptions(host, payload);
        if (await raise()) return undefined;
        return failed(
          "this host cannot raise the Brushes panel; pass the options",
        );
      },
    }),
    registerCommand(host, {
      id: BRUSHES_COMMAND_ID,
      title: M.brushes,
      category: BRUSH_COMMAND_CATEGORY,
      handler: async () => {
        if (await raise()) return undefined;
        host.log.info(
          `${BRUSHES_COMMAND_ID}: this host cannot raise the Brushes panel`,
        );
        return undefined;
      },
    }),
    registerCommand(host, {
      id: NEW_BRUSH_COMMAND_ID,
      title: M.newBrush,
      category: BRUSH_COMMAND_CATEGORY,
      // Run bare (the menu row) an Art brush of the selection; what it
      // cannot make a brush of is said, not thrown.
      handler: async (_paged, payload) => {
        try {
          return await newBrushFromSelection(host, payload);
        } catch (err) {
          if (payload !== undefined) throw err;
          host.log.info(`${NEW_BRUSH_COMMAND_ID}: ${String(err)}`);
          return undefined;
        }
      },
    }),
    registerCommand(host, {
      id: APPLY_WIDTH_PROFILE_COMMAND_ID,
      title: M.applyWidthProfile,
      category: BRUSH_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        if (payload === undefined) {
          host.log.info(
            `${APPLY_WIDTH_PROFILE_COMMAND_ID}: name a width profile (\`profile\`) or give its \`points\``,
          );
          return undefined;
        }
        return applyWidthProfileStyle(host, payload);
      },
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
