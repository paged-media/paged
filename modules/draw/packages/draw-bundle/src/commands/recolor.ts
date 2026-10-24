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

// RECOLOR ARTWORK and the COLOR GUIDE's apply (WP6.5, Illustrator §18).
//
// THE COLOUR GROUP is read off the selection, every paint slot that
// carries a swatch: each leaf's FILL and STROKE, every STOP of a gradient
// a fill or stroke uses, and every layer of a draw APPEARANCE stack (the
// metadata stacks, ADR 354). A group is walked to its leaves. One entry
// per distinct swatch, with its display colour (`swatchDisplay`, so a
// CMYK, spot or Lab swatch shows as the canvas shows it), its colour
// model and its WEIGHT — how many slots use it, which is what "the
// heaviest colour" means to the reduction and the harmony assignment.
// `None`, `Registration` and an unreadable ref are not colours to change.
//
// FOUR WAYS TO CHOOSE THE NEW COLOURS, all pure (`draw-geometry`'s
// `color-harmony.ts`) and all deterministic:
//   · HARMONY — a rule (complementary … tints) on the base colour (the
//     payload's, else the group's heaviest chromatic colour), turned by
//     `rotate` degrees (the wheel's drag), the artwork's colours assigned
//     to it by weight with their light/dark offsets kept. Neutrals stay
//     unless `recolorNeutrals`;
//   · REDUCE — Lab k-means to `count` colours; every colour becomes the
//     heaviest EXISTING colour of its cluster (so no swatch is minted);
//   · LIBRARY — every colour becomes the nearest (ΔE) swatch of a colour
//     group, or of all the document's swatches;
//   · MAP — an explicit `{ from swatch: to hex | to swatch }` table (what
//     the panel's per-row edit sends).
//
// APPLY IS ONE BATCH, ONE UNDO STEP: the new swatches are created, a
// gradient whose stops change is created anew with the new stops (the
// original gradient may be used by artwork outside the selection, so it
// is not edited), and the selection's refs are re-pointed. Nothing is
// edited in place, so artwork outside the selection keeps its colours.
//
// TINTS OF A SPOT COLOUR STAY TINTS. A tint is the element's own
// `frameFillTint` over the swatch it references; the recolour re-points
// the reference and never touches the tint, so 40 % of a spot becomes
// 40 % of its replacement. A replacement minted for a SPOT swatch is
// minted as a spot (`model: "Spot"`), so it still separates as one plate.
// A `Tint/…` SWATCH (a named tint) is a colour of its own here: it is
// replaced by a plain colour at its displayed value — named, not hidden.

import type {
  BundleHost,
  Disposable,
  ElementId,
  Mutation,
  PluginMetadataEnvelope,
  SceneTreeNode,
  SwatchSummary,
} from "@paged-media/plugin-api";
import {
  harmonyOf,
  isNeutral,
  nearestColorIndex,
  parseCssColor,
  recolorToHarmony,
  reduceColors,
  rgbToHex,
  rotateHues,
  sameRgb,
  HARMONY_RULES,
  type HarmonyRule,
  type Rgb,
  type WeightedColor,
} from "@paged-media/draw-geometry";
import { defineMessages } from "@paged-media/strings";

import { registerCommand } from "../command-registry";
import { leafIdsOf, linkIndex } from "../link-index";
import { rawGradientDetail, type GradientDetailWire } from "../raw-wire";
import {
  appearanceOf,
  withAppearance,
  type AppearanceStack,
} from "./appearance";
import { stampDrawMetadata } from "./appearance-bake";
import { batchMutationFor } from "./batch-handles";

const M = defineMessages("draw.recolor", {
  recolor:
    "Color: Recolor artwork (harmony, reduce to N colours, library or a colour map — one undo step)",
  recolorOptions: "Color: Recolor artwork…",
  applyGuide: "Color: Apply a Color Guide colour to the selection's fill",
});

export const RECOLOR_COMMAND_CATEGORY = "Color";
export const RECOLOR_ARTWORK_COMMAND_ID =
  "media.paged.draw.command.recolorArtwork";
export const RECOLOR_ARTWORK_OPTIONS_COMMAND_ID =
  "media.paged.draw.command.recolorArtworkOptions";
export const APPLY_GUIDE_COLOR_COMMAND_ID =
  "media.paged.draw.command.applyGuideColor";
export const RECOLOR_COMMAND_IDS = [
  RECOLOR_ARTWORK_COMMAND_ID,
  RECOLOR_ARTWORK_OPTIONS_COMMAND_ID,
  APPLY_GUIDE_COLOR_COMMAND_ID,
] as const;

/** The panels (ids here so the commands raise them without React). */
export const RECOLOR_PANEL_ID = "media.paged.draw.panel.recolorArtwork";
export const COLOR_GUIDE_PANEL_ID = "media.paged.draw.panel.colorGuide";

/** Refs that are not colours to change. */
const NOT_A_COLOR = new Set([
  "Swatch/None",
  "Color/None",
  "Color/Registration",
  "n",
]);

export const isRecolorable = (ref: string | null | undefined): ref is string =>
  typeof ref === "string" && ref.length > 0 && !NOT_A_COLOR.has(ref);

const isGradientRef = (ref: string): boolean => ref.startsWith("Gradient/");

// ---------------------------------------------------------------- reading

/** One colour of the selection's artwork. */
export interface ArtworkColor {
  /** The swatch id the artwork references. */
  ref: string;
  name: string;
  /** Display colour (after colour management). */
  rgb: Rgb;
  /** IDML colour model, lower-case (`process`, `spot`, `black`, …). */
  model: string;
  /** How many paint slots use it. */
  weight: number;
}

/** One paint slot that carries a ref. */
export type PaintSlot =
  | { element: ElementId; kind: "fill" | "stroke"; ref: string }
  | {
      element: ElementId;
      kind: "appearanceFill" | "appearanceStroke";
      layer: number;
      ref: string;
    };

/** Everything a recolour reads, in one place. */
export interface ArtworkRead {
  /** The colours, heaviest first (ties: first seen). */
  colors: ArtworkColor[];
  slots: PaintSlot[];
  /** The gradients a slot references, by id. */
  gradients: Map<string, GradientDetailWire>;
  /** The draw envelope of every leaf that carries an appearance stack. */
  envelopes: Map<string, PluginMetadataEnvelope | null>;
  /** The document's swatches (for a library and for name reuse). */
  swatches: { ref: string; name: string; rgb: Rgb; model: string }[];
  /** The leaves read. */
  leaves: ElementId[];
}

const keyOf = (id: ElementId): string => `${id.kind}:${String(id.id)}`;

function findNode(
  nodes: readonly SceneTreeNode[],
  id: ElementId,
): SceneTreeNode | null {
  for (const node of nodes) {
    if (node.id?.kind === id.kind && node.id?.id === id.id) return node;
    const inner = findNode(node.children ?? [], id);
    if (inner) return inner;
  }
  return null;
}

/** The selection walked to its leaves (a group's members, recursively). */
export async function selectionLeaves(
  host: BundleHost,
  ids: readonly ElementId[],
): Promise<ElementId[]> {
  const out: ElementId[] = [];
  const seen = new Set<string>();
  let tree: SceneTreeNode[] | null = null;
  for (const id of ids) {
    if (id.kind === "group") {
      if (tree === null) tree = await linkIndex(host).tree();
      const node = findNode(tree, id);
      for (const leaf of node ? leafIdsOf(node.children ?? []) : []) {
        if (!seen.has(keyOf(leaf))) {
          seen.add(keyOf(leaf));
          out.push(leaf);
        }
      }
    } else if (!seen.has(keyOf(id))) {
      seen.add(keyOf(id));
      out.push(id);
    }
  }
  return out;
}

const hexRgb = (hex: string): Rgb | null => parseCssColor(hex);

/** Display colours for `refs`: `swatchDisplay` where the host has it,
 *  else the swatch NAME read as a CSS colour (the io/svg convention). */
async function displayOf(
  host: BundleHost,
  refs: readonly string[],
  swatches: readonly SwatchSummary[],
): Promise<Map<string, { rgb: Rgb; model: string }>> {
  const out = new Map<string, { rgb: Rgb; model: string }>();
  if (refs.length === 0) return out;
  if (host.supports("document.swatchDisplay@1")) {
    try {
      for (const d of await host.document.swatchDisplay(refs)) {
        const rgb = hexRgb(d.rgbHex);
        if (rgb) out.set(d.id, { rgb, model: String(d.model).toLowerCase() });
      }
    } catch {
      /* fall through to the names */
    }
  }
  for (const ref of refs) {
    if (out.has(ref)) continue;
    const sw = swatches.find((s) => s.selfId === ref);
    const rgb = sw ? parseCssColor(sw.name) : null;
    if (rgb && sw) out.set(ref, { rgb, model: String(sw.kind).toLowerCase() });
  }
  return out;
}

/** Read the selection's colour group (module header). */
export async function readArtworkColors(
  host: BundleHost,
  ids: readonly ElementId[] = host.selection.get(),
): Promise<ArtworkRead> {
  const leaves = await selectionLeaves(host, ids);
  const slots: PaintSlot[] = [];
  const envelopes = new Map<string, PluginMetadataEnvelope | null>();
  const index = linkIndex(host);
  for (const leaf of leaves) {
    const props = await host.document.elementProperties(leaf).catch(() => null);
    for (const e of props?.entries ?? []) {
      const v = e.value;
      if (!v || v.type !== "colorRef" || !isRecolorable(v.value)) continue;
      if (e.path === "frameFillColor")
        slots.push({ element: leaf, kind: "fill", ref: v.value });
      else if (e.path === "frameStrokeColor")
        slots.push({ element: leaf, kind: "stroke", ref: v.value });
    }
    const env = await index.envelopeOf(leaf).catch(() => null);
    const stack = appearanceOf(env);
    if (stack.fills.length > 0 || stack.strokes.length > 0) {
      envelopes.set(keyOf(leaf), env);
      stack.fills.forEach((l, layer) => {
        if (isRecolorable(l.color))
          slots.push({
            element: leaf,
            kind: "appearanceFill",
            layer,
            ref: l.color,
          });
      });
      stack.strokes.forEach((l, layer) => {
        if (isRecolorable(l.color))
          slots.push({
            element: leaf,
            kind: "appearanceStroke",
            layer,
            ref: l.color,
          });
      });
    }
  }
  // Gradients: their stops are colours of the group too.
  const gradients = new Map<string, GradientDetailWire>();
  const weights = new Map<string, number>();
  const order: string[] = [];
  const count = (ref: string, n = 1) => {
    if (!weights.has(ref)) order.push(ref);
    weights.set(ref, (weights.get(ref) ?? 0) + n);
  };
  for (const slot of slots) {
    if (isGradientRef(slot.ref)) {
      let detail = gradients.get(slot.ref);
      if (!detail) {
        const read = await rawGradientDetail(host, slot.ref);
        if (!read) continue;
        detail = read;
        gradients.set(slot.ref, detail);
      }
      for (const stop of detail.stops) {
        if (isRecolorable(stop.stopColorRef)) count(stop.stopColorRef);
      }
    } else {
      count(slot.ref);
    }
  }
  const swatchRows = await index
    .cached("collection:swatches", async () =>
      (await host.document.collection<SwatchSummary>("swatches")).slice(),
    )
    .catch(() => [] as SwatchSummary[]);
  const allRefs = [...new Set([...order, ...swatchRows.map((s) => s.selfId)])];
  const display = await displayOf(host, allRefs, swatchRows);
  const colors: ArtworkColor[] = [];
  for (const ref of order) {
    const d = display.get(ref);
    if (!d) continue;
    colors.push({
      ref,
      name: swatchRows.find((s) => s.selfId === ref)?.name ?? ref,
      rgb: d.rgb,
      model: d.model,
      weight: weights.get(ref) ?? 1,
    });
  }
  // Heaviest first; a stable sort keeps first-seen order on ties.
  colors.sort((a, b) => b.weight - a.weight);
  const swatches = swatchRows
    .filter((s) => isRecolorable(s.selfId) && !isGradientRef(s.selfId))
    .flatMap((s) => {
      const d = display.get(s.selfId);
      return d
        ? [{ ref: s.selfId, name: s.name, rgb: d.rgb, model: d.model }]
        : [];
    });
  return { colors, slots, gradients, envelopes, swatches, leaves };
}

// ------------------------------------------------- pure: choosing colours

/** What one artwork colour becomes: an existing swatch, or a new colour. */
export type RecolorTarget =
  { kind: "swatch"; ref: string } | { kind: "rgb"; rgb: Rgb };

export type RecolorMode = "harmony" | "reduce" | "library" | "map";

export const RECOLOR_MODES: readonly RecolorMode[] = [
  "harmony",
  "reduce",
  "library",
  "map",
];

/** A recolour request (the command payload, parsed). */
export interface RecolorRequest {
  mode: RecolorMode;
  rule: HarmonyRule;
  /** Hex of the harmony's base; null = the heaviest chromatic colour. */
  base: string | null;
  /** Wheel rotation in degrees. */
  rotate: number;
  recolorNeutrals: boolean;
  count: number;
  /** A colour group's id for `library`; null = all document swatches. */
  colorGroup: string | null;
  /** `map`: swatch ref → hex or swatch ref. */
  map: Record<string, string>;
}

export const RECOLOR_DEFAULTS: RecolorRequest = {
  mode: "harmony",
  rule: "complementary",
  base: null,
  rotate: 0,
  recolorNeutrals: false,
  count: 3,
  colorGroup: null,
  map: {},
};

/** Parse a payload over {@link RECOLOR_DEFAULTS}. Pure. */
export function recolorRequestFrom(payload: unknown): RecolorRequest {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<
    string,
    unknown
  >;
  const out: RecolorRequest = { ...RECOLOR_DEFAULTS, map: {} };
  if (RECOLOR_MODES.includes(p.mode as RecolorMode))
    out.mode = p.mode as RecolorMode;
  if (HARMONY_RULES.includes(p.rule as HarmonyRule))
    out.rule = p.rule as HarmonyRule;
  if (typeof p.base === "string" && parseCssColor(p.base)) out.base = p.base;
  if (typeof p.rotate === "number" && Number.isFinite(p.rotate))
    out.rotate = p.rotate;
  if (typeof p.recolorNeutrals === "boolean")
    out.recolorNeutrals = p.recolorNeutrals;
  if (typeof p.count === "number" && Number.isFinite(p.count))
    out.count = Math.max(1, Math.floor(p.count));
  if (typeof p.colorGroup === "string" && p.colorGroup.length > 0)
    out.colorGroup = p.colorGroup;
  // `map` as a record, or as the typed twin's list of { from, to }.
  if (Array.isArray(p.map)) {
    for (const row of p.map as { from?: unknown; to?: unknown }[]) {
      if (typeof row?.from === "string" && typeof row?.to === "string")
        out.map[row.from] = row.to;
    }
  } else if (p.map && typeof p.map === "object") {
    for (const [from, to] of Object.entries(p.map as Record<string, unknown>))
      if (typeof to === "string") out.map[from] = to;
  }
  if (Object.keys(out.map).length > 0 && p.mode === undefined) out.mode = "map";
  return out;
}

/** The harmony base a request resolves to: its own, else the heaviest
 *  chromatic colour, else the heaviest colour. Null for no colours. */
export function harmonyBaseOf(
  colors: readonly ArtworkColor[],
  base: string | null,
): Rgb | null {
  const own = base ? parseCssColor(base) : null;
  if (own) return own;
  const chromatic = colors.find((c) => !isNeutral(c.rgb));
  return (chromatic ?? colors[0])?.rgb ?? null;
}

/** The harmony a request shows on the wheel (base first, rotated). */
export function requestHarmony(
  colors: readonly ArtworkColor[],
  request: RecolorRequest,
): Rgb[] {
  const base = harmonyBaseOf(colors, request.base);
  return base ? rotateHues(harmonyOf(base, request.rule), request.rotate) : [];
}

/**
 * What each artwork colour becomes under `request` — only the colours
 * that CHANGE are in the map. Pure, deterministic.
 */
export function recolorTargetsFor(
  colors: readonly ArtworkColor[],
  request: RecolorRequest,
  library: readonly { ref: string; rgb: Rgb }[] = [],
): Map<string, RecolorTarget> {
  const out = new Map<string, RecolorTarget>();
  const weighted: WeightedColor[] = colors.map((c) => ({
    rgb: c.rgb,
    weight: c.weight,
  }));
  if (colors.length === 0) return out;
  if (request.mode === "harmony") {
    const harmony = requestHarmony(colors, request);
    const mapped = recolorToHarmony(weighted, harmony, {
      recolorNeutrals: request.recolorNeutrals,
    });
    colors.forEach((c, i) => {
      if (!sameRgb(mapped[i], c.rgb))
        out.set(c.ref, { kind: "rgb", rgb: mapped[i] });
    });
  } else if (request.mode === "reduce") {
    const reps = reduceColors(weighted, request.count);
    colors.forEach((c, i) => {
      // The representative IS an artwork colour: the heaviest with that
      // value (colours are heaviest first, so the first match).
      const j = colors.findIndex((o) => sameRgb(o.rgb, reps[i]));
      if (j >= 0 && colors[j].ref !== c.ref)
        out.set(c.ref, { kind: "swatch", ref: colors[j].ref });
    });
  } else if (request.mode === "library") {
    const rgbs = library.map((l) => l.rgb);
    for (const c of colors) {
      const k = nearestColorIndex(c.rgb, rgbs);
      if (k >= 0 && library[k].ref !== c.ref)
        out.set(c.ref, { kind: "swatch", ref: library[k].ref });
    }
  } else {
    for (const c of colors) {
      const to = request.map[c.ref];
      if (typeof to !== "string") continue;
      const rgb = parseCssColor(to);
      if (rgb) {
        if (!sameRgb(rgb, c.rgb)) out.set(c.ref, { kind: "rgb", rgb });
      } else if (to !== c.ref) {
        out.set(c.ref, { kind: "swatch", ref: to });
      }
    }
  }
  return out;
}

// --------------------------------------------------- pure: the apply batch

/** Ids the batch mints — injected so a spec can pin the exact wire. */
export interface RecolorMint {
  swatch(): string;
  gradient(): string;
}

let seq = 0;
const nonce = (): string => `${Date.now().toString(16)}${(seq++).toString(16)}`;

export const defaultRecolorMint: RecolorMint = {
  swatch: () => `Color/udrawrecolor${nonce()}`,
  gradient: () => `Gradient/udrawrecolor${nonce()}`,
};

/** What a recolour batch does, for the log and the specs. */
export interface RecolorPlan {
  batch: Mutation;
  /** Swatches created. */
  created: { ref: string; name: string; rgb: Rgb; model: string }[];
  /** Gradients created (old id → new id). */
  gradients: Map<string, string>;
  /** Paint slots re-pointed. */
  rewritten: number;
}

const colorRef = (
  elementId: ElementId,
  path: "frameFillColor" | "frameStrokeColor",
  value: string,
): Mutation => ({
  op: "setElementProperty",
  args: { elementId, path, value: { type: "colorRef", value } },
});

/**
 * The ONE batch that applies `targets` to the slots `read` found
 * (module header: create, re-create changed gradients, re-point). Pure.
 */
export function recolorBatchFor(
  read: ArtworkRead,
  targets: ReadonlyMap<string, RecolorTarget>,
  mint: RecolorMint = defaultRecolorMint,
): RecolorPlan {
  const ops: Mutation[] = [];
  const created: RecolorPlan["created"] = [];
  const minted = new Map<string, string>(); // `${model}|${hex}` → ref
  const modelOf = (ref: string): string =>
    read.colors.find((c) => c.ref === ref)?.model ?? "process";
  const newRefFor = (ref: string): string | null => {
    const target = targets.get(ref);
    if (!target) return null;
    if (target.kind === "swatch") return target.ref;
    const hex = rgbToHex(target.rgb);
    const spot = modelOf(ref) === "spot";
    const key = `${spot ? "spot" : "process"}|${hex}`;
    const seen = minted.get(key);
    if (seen) return seen;
    // A process swatch already named for this colour is reused (the
    // io/svg naming convention), so a second recolour does not pile up
    // copies of one colour.
    const existing = spot
      ? undefined
      : read.swatches.find(
          (s) =>
            s.name === hex && s.model !== "spot" && sameRgb(s.rgb, target.rgb),
        );
    if (existing) {
      minted.set(key, existing.ref);
      return existing.ref;
    }
    const id = mint.swatch();
    ops.push({
      op: "createSwatch",
      args: {
        spec: {
          selfId: id,
          name: hex,
          space: "RGB",
          value: [target.rgb[0], target.rgb[1], target.rgb[2]],
          ...(spot ? { model: "Spot" } : {}),
        },
      },
    });
    created.push({
      ref: id,
      name: hex,
      rgb: target.rgb,
      model: spot ? "spot" : "process",
    });
    minted.set(key, id);
    return id;
  };
  // Gradients whose stops change are created anew.
  const gradients = new Map<string, string>();
  for (const [gid, detail] of read.gradients) {
    const stops = detail.stops.map((s) => ({
      stopColor: newRefFor(s.stopColorRef) ?? s.stopColorRef,
      locationPct: s.locationPct,
      midpointPct: s.midpointPct,
      changed: targets.has(s.stopColorRef),
    }));
    if (!stops.some((s) => s.changed)) continue;
    const id = mint.gradient();
    const kind = detail.kind.toLowerCase() === "radial" ? "Radial" : "Linear";
    ops.push({
      op: "createGradient",
      args: {
        spec: {
          selfId: id,
          name: `${detail.name} (recolored)`,
          kind,
          stops: stops.map((s) => ({
            stopColor: s.stopColor,
            locationPct: s.locationPct,
            midpointPct: s.midpointPct,
          })),
        },
      },
    });
    gradients.set(gid, id);
  }
  const replaced = (ref: string): string | null =>
    isGradientRef(ref) ? (gradients.get(ref) ?? null) : newRefFor(ref);
  let rewritten = 0;
  const stacks = new Map<string, { id: ElementId; stack: AppearanceStack }>();
  for (const slot of read.slots) {
    const next = replaced(slot.ref);
    if (next === null || next === slot.ref) continue;
    rewritten++;
    if (slot.kind === "fill" || slot.kind === "stroke") {
      ops.push(
        colorRef(
          slot.element,
          slot.kind === "fill" ? "frameFillColor" : "frameStrokeColor",
          next,
        ),
      );
      continue;
    }
    if (!("layer" in slot)) continue;
    const key = keyOf(slot.element);
    let entry = stacks.get(key);
    if (!entry) {
      const stack = appearanceOf(read.envelopes.get(key) ?? null);
      entry = { id: slot.element, stack };
      stacks.set(key, entry);
    }
    const list =
      slot.kind === "appearanceFill" ? entry.stack.fills : entry.stack.strokes;
    const layer = list[slot.layer];
    if (layer) list[slot.layer] = { ...layer, color: next } as never;
  }
  for (const [key, { id, stack }] of stacks) {
    ops.push(
      stampDrawMetadata(
        id,
        withAppearance(read.envelopes.get(key) ?? null, stack),
      ),
    );
  }
  return { batch: batchMutationFor(ops), created, gradients, rewritten };
}

// ------------------------------------------------------------ appliers

/** The library a `library` request maps onto: a colour group's member
 *  swatches, or every document swatch. */
export async function recolorLibraryOf(
  host: BundleHost,
  read: ArtworkRead,
  colorGroup: string | null,
): Promise<{ ref: string; rgb: Rgb }[]> {
  if (!colorGroup) return read.swatches;
  const groups = await host.document
    .collection<{ selfId: string; name: string; members?: string[] }>(
      "colorGroups",
    )
    .catch(() => []);
  const group = groups.find(
    (g) => g.selfId === colorGroup || g.name === colorGroup,
  );
  const members = new Set(group?.members ?? []);
  return read.swatches.filter((s) => members.has(s.ref));
}

/** What a recolour did (the panel reads it; the command logs it). */
export interface RecolorOutcome {
  applied: boolean;
  changed: number;
  created: number;
  rewritten: number;
}

/**
 * **RECOLOR ARTWORK** — recolour the selection (module header). ONE
 * batch ⇒ one undo step. Payload: {@link RecolorRequest} fields; run
 * BARE (a menu row, the palette) it raises the panel instead, where the
 * request is set up.
 */
export async function applyRecolorArtwork(
  host: BundleHost,
  payload?: unknown,
): Promise<RecolorOutcome> {
  const label = RECOLOR_ARTWORK_COMMAND_ID;
  const none: RecolorOutcome = {
    applied: false,
    changed: 0,
    created: 0,
    rewritten: 0,
  };
  const request = recolorRequestFrom(payload);
  const read = await readArtworkColors(host);
  if (read.colors.length === 0) {
    host.log.warn(
      `${label}: the selection carries no colour to recolour (fills, ` +
        "strokes, gradient stops and appearance layers were read) — no-op",
    );
    return none;
  }
  const library =
    request.mode === "library"
      ? await recolorLibraryOf(host, read, request.colorGroup)
      : [];
  if (request.mode === "library" && library.length === 0) {
    host.log.warn(
      `${label}: the library is empty${
        request.colorGroup ? ` (colour group "${request.colorGroup}")` : ""
      } — no-op`,
    );
    return none;
  }
  const targets = recolorTargetsFor(read.colors, request, library);
  if (targets.size === 0) {
    host.log.info(`${label}: every colour already is its target — no-op`);
    return none;
  }
  const plan = recolorBatchFor(read, targets);
  const outcome = await host.document.mutate(plan.batch);
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return none;
  }
  host.log.info(
    `${label}: ${targets.size} of ${read.colors.length} colour(s) changed ` +
      `(${request.mode}), ${plan.created.length} swatch(es) and ` +
      `${plan.gradients.size} gradient(s) created, ${plan.rewritten} paint ` +
      "slot(s) re-pointed, in 1 undo step; element tints are kept",
  );
  return {
    applied: true,
    changed: targets.size,
    created: plan.created.length,
    rewritten: plan.rewritten,
  };
}

/** **APPLY GUIDE COLOUR** — paint the selection's fill (or, with
 *  `stroke: true`, its stroke) with `hex`: a swatch is created (or one
 *  already named for the colour reused) and referenced. ONE batch. */
export async function applyGuideColor(
  host: BundleHost,
  payload?: unknown,
): Promise<boolean> {
  const label = APPLY_GUIDE_COLOR_COMMAND_ID;
  const p = (payload && typeof payload === "object" ? payload : {}) as {
    hex?: unknown;
    stroke?: unknown;
  };
  const rgb = typeof p.hex === "string" ? parseCssColor(p.hex) : null;
  if (!rgb) {
    host.log.warn(`${label}: needs a colour ({ hex: "#rrggbb" }) — no-op`);
    return false;
  }
  const leaves = await selectionLeaves(host, host.selection.get());
  if (leaves.length === 0) {
    host.log.warn(`${label}: nothing selected — no-op`);
    return false;
  }
  const hex = rgbToHex(rgb);
  const swatches = await host.document
    .collection<SwatchSummary>("swatches")
    .catch(() => [] as SwatchSummary[]);
  const reuse = swatches.find((s) => s.name === hex);
  const ops: Mutation[] = [];
  let ref = reuse?.selfId ?? null;
  if (!ref) {
    ref = defaultRecolorMint.swatch();
    ops.push({
      op: "createSwatch",
      args: {
        spec: {
          selfId: ref,
          name: hex,
          space: "RGB",
          value: [rgb[0], rgb[1], rgb[2]],
        },
      },
    });
  }
  const path = p.stroke === true ? "frameStrokeColor" : "frameFillColor";
  for (const leaf of leaves) ops.push(colorRef(leaf, path, ref));
  const outcome = await host.document.mutate(batchMutationFor(ops));
  if (!outcome.applied) {
    host.log.warn(
      `${label}: rejected by engine: ${JSON.stringify(outcome.error)}`,
    );
    return false;
  }
  return true;
}

/** The selection's current fill colour as the Color Guide's base, or
 *  null (nothing selected, or no readable fill). */
export async function guideBaseOf(host: BundleHost): Promise<Rgb | null> {
  const read = await readArtworkColors(host);
  const fill = read.slots.find(
    (s) => s.kind === "fill" && !isGradientRef(s.ref),
  );
  const color = fill
    ? read.colors.find((c) => c.ref === fill.ref)
    : read.colors[0];
  return color?.rgb ?? null;
}

export function contributeRecolorCommands(host: BundleHost): Disposable {
  const disposers = [
    registerCommand(host, {
      id: RECOLOR_ARTWORK_COMMAND_ID,
      title: M.recolor,
      category: RECOLOR_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyRecolorArtwork(host, payload).then(() => undefined),
    }),
    registerCommand(host, {
      id: RECOLOR_ARTWORK_OPTIONS_COMMAND_ID,
      title: M.recolorOptions,
      category: RECOLOR_COMMAND_CATEGORY,
      // With no panel door, the row degrades to the default recolour (a
      // complementary harmony) and says so.
      handler: async () => {
        if (host.supports("shell.openPanel@1")) {
          await host.shell.openPanel(RECOLOR_PANEL_ID);
          return;
        }
        host.log.info(
          `${RECOLOR_ARTWORK_OPTIONS_COMMAND_ID}: this host cannot raise the ` +
            "Recolor Artwork panel — applying the default (complementary) recolour",
        );
        await applyRecolorArtwork(host, {});
      },
    }),
    registerCommand(host, {
      id: APPLY_GUIDE_COLOR_COMMAND_ID,
      title: M.applyGuide,
      category: RECOLOR_COMMAND_CATEGORY,
      handler: (_paged, payload) =>
        applyGuideColor(host, payload).then(() => undefined),
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
