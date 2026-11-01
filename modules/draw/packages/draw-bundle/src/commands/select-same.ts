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

// Select-same — select every element sharing the active element's fill /
// stroke / stroke-weight (concept §13.9 "Select by same fill/stroke/
// appearance/etc.", Tier A). PURE SELECTION — no mutation: it reads the
// reference element's typed properties (`host.document.elementProperties`),
// enumerates the document's leaf elements (`host.document.tree`), reads
// each candidate's same property, and `host.selection.set`s the matches.
//
// One command per criterion: same FILL color, same STROKE color, same
// STROKE WEIGHT, and (WP6.1) same OPACITY, same BLENDING MODE, same
// APPEARANCE, same GRAPHIC STYLE, same SYMBOL (instances of one symbol)
// and same SHAPE KIND. The reference is the FIRST selected element; no
// selection (or the reference exposes no such property) ⇒ no-op (a debug
// log, never a throw). The reference itself is always included in the
// result (it trivially matches itself).
//
// Host-agnostic: imports only plugin-api types; every engine touch is a
// `host.*` facade (elementProperties / tree / selection).
//
// WHAT IT COSTS, and what it used to (`test/perf/perf-budgets-commands
// .spec.ts`): one `elementProperties` round trip per leaf of the
// document — this door takes ONE id (`elementGeometry` takes a list; it
// does not), so a pass over the document is a read per leaf, the same
// engine gap the link walk has. Those reads now go out in parallel
// windows instead of one awaited after the other, the reference is not
// read a second time by the pass, and ONE pass answers all three
// criteria: a leaf's fill, stroke and stroke weight are kept per
// DOCUMENT REVISION (the link index's revision — `../link-index`), so
// "same fill" followed by "same stroke" on an unchanged document reads
// nothing the second time. What is kept is the three values per leaf,
// not the property tables they were read from.
//
// THE WP6.1 CRITERIA, and what each one reads:
//   · OPACITY (`frameOpacity`, a length in percent; an unset one reads
//     back null and is the default 100) and BLENDING MODE
//     (`frameBlendMode`, text — `""` is the engine's unset, read as
//     Normal, and names compare case-blind) ride the SAME property pass
//     as the three above: no extra read.
//   · APPEARANCE is the COMPLETE appearance Graphic Styles digests — the
//     ADR 354 metadata stack (`data.appearance`) plus the base paint the
//     frame's own slots carry — compared through the one canonical form
//     (`canonicalGraphicAppearance`, numbers to 4 dp). So two plain
//     shapes with the same paint and no stack are the same appearance,
//     and a stack layer more or less is a different one. It costs the
//     property pass plus the link index's envelopes (free off the tree
//     on an engine with C-65).
//   · GRAPHIC STYLE matches every leaf LINKED to the reference's style
//     (`data.graphicStyle.id`), overridden or not — "linked" is what the
//     style panel counts too. SYMBOL matches every leaf of every
//     instance of the reference's symbol (`data.symbolInstance.symbol`).
//     Both read envelopes only; an unlinked reference is a no-op.
//   · SHAPE KIND is the element's own kind (`rectangle`, `oval`,
//     `polygon`, `graphicLine`, `textFrame`) and reads nothing. IDML
//     stores a pen path and a drawn polygon alike as a `Polygon`, and no
//     read separates them, so "path" and "polygon" are one kind here.
//
// TOLERANCE — for STROKE WEIGHT ONLY, and why only there. A weight is a
// number (`{ type: "length", value }`), so "within 0.5 pt" means
// something: the command's payload `{ tolerance }` (pt, inclusive) widens
// the match to every leaf whose weight is within that distance of the
// reference's; absent or 0 it is the exact match it always was (1e-3,
// for round-tripped floats). The Path Options panel's "Select same
// stroke weight" section is where the number is typed.
//
// A COLOUR CANNOT TAKE ONE HERE, and this is a contract gap, not a
// choice. What `elementProperties` returns for `frameFillColor` /
// `frameStrokeColor` is `{ type: "colorRef", value: "Color/u12" }` — a
// swatch IDENTITY — and there is no door from a bundle to that swatch's
// numbers: `document.collection("swatches")` answers `SwatchSummary`
// (`selfId`, `name`, `kind`, `totalAreaCoveragePct` — no channels), and
// the one wire message that does carry them (`requestColorPreview
// { swatchId }` → `colorPreviewReply { result: ColorPreview { cmyk,
// rgbHex } }`) has no `DocumentSurface` facade; it is reachable only
// through the raw `host.editor.client` escape hatch, which this bundle
// does not take for a feature. Two DIFFERENT swatches holding the same
// colour are therefore not "the same fill" here, exactly as before. A
// tolerance passed to the fill / stroke commands is ignored, and the log
// says why.

import type {
  BundleHost,
  Disposable,
  ElementId,
  PluginMetadataEnvelope,
  PropertyPath,
} from "@paged-media/plugin-api";

import { leafIdsOf, linkIndex } from "../link-index";

import { registerCommand } from "../command-registry";
import { defineMessages } from "@paged-media/strings";
import { appearanceOf } from "./appearance";
import { layersOfValue } from "./appearance-native";
import { entriesOfValue } from "./envelope";
import {
  canonicalGraphicAppearance,
  graphicStyleRefOf,
  type GraphicStyleAppearance,
  type GraphicStyleBase,
} from "./graphic-styles";
import { symbolInstanceOf } from "./symbols";
import { engineSymbols, readEngineSymbols } from "./symbols-engine";

/** Command titles, message keys `registerCommand` reads in the editor's locale. */
const M = defineMessages("draw.selectSame", {
  fill: "Select same: Fill",
  stroke: "Select same: Stroke",
  strokeWeight: "Select same: Stroke weight",
  opacity: "Select same: Opacity",
  blendMode: "Select same: Blending mode",
  appearance: "Select same: Appearance",
  graphicStyle: "Select same: Graphic style",
  symbol: "Select same: Symbol instance",
  shapeKind: "Select same: Shape kind",
});
// The leaf walk lives beside the index that walks it; every other module
// keeps importing it from here.
export { leafIdsOf };

export const SELECT_SAME_COMMAND_CATEGORY = "Select";

export const SELECT_SAME_FILL_COMMAND_ID =
  "media.paged.draw.command.selectSameFill";
export const SELECT_SAME_STROKE_COMMAND_ID =
  "media.paged.draw.command.selectSameStroke";
export const SELECT_SAME_STROKE_WEIGHT_COMMAND_ID =
  "media.paged.draw.command.selectSameStrokeWeight";
export const SELECT_SAME_OPACITY_COMMAND_ID =
  "media.paged.draw.command.selectSameOpacity";
export const SELECT_SAME_BLEND_MODE_COMMAND_ID =
  "media.paged.draw.command.selectSameBlendMode";
export const SELECT_SAME_APPEARANCE_COMMAND_ID =
  "media.paged.draw.command.selectSameAppearance";
export const SELECT_SAME_GRAPHIC_STYLE_COMMAND_ID =
  "media.paged.draw.command.selectSameGraphicStyle";
export const SELECT_SAME_SYMBOL_COMMAND_ID =
  "media.paged.draw.command.selectSameSymbolInstance";
export const SELECT_SAME_SHAPE_KIND_COMMAND_ID =
  "media.paged.draw.command.selectSameShapeKind";

/** The criterion a Select-same command matches on. */
export type SelectSameCriterion =
  PaintCriterion | "appearance" | "graphicStyle" | "symbol" | "shapeKind";

/** The criteria read straight off one property row. */
export type PaintCriterion =
  "fill" | "stroke" | "strokeWeight" | "opacity" | "blendMode";

/** Each command and the criterion it matches, in registration order. */
const COMMANDS: readonly [id: string, c: SelectSameCriterion, title: string][] =
  [
    [SELECT_SAME_FILL_COMMAND_ID, "fill", M.fill],
    [SELECT_SAME_STROKE_COMMAND_ID, "stroke", M.stroke],
    // Run bare it is the EXACT match it always was; a payload
    // `{ tolerance }` (pt) widens it. A remembered tolerance is NOT
    // applied here — "same" from the menu must not quietly mean "within
    // whatever was typed last week". The "within…" row is the Path
    // Options panel's.
    [SELECT_SAME_STROKE_WEIGHT_COMMAND_ID, "strokeWeight", M.strokeWeight],
    [SELECT_SAME_OPACITY_COMMAND_ID, "opacity", M.opacity],
    [SELECT_SAME_BLEND_MODE_COMMAND_ID, "blendMode", M.blendMode],
    [SELECT_SAME_APPEARANCE_COMMAND_ID, "appearance", M.appearance],
    [SELECT_SAME_GRAPHIC_STYLE_COMMAND_ID, "graphicStyle", M.graphicStyle],
    [SELECT_SAME_SYMBOL_COMMAND_ID, "symbol", M.symbol],
    [SELECT_SAME_SHAPE_KIND_COMMAND_ID, "shapeKind", M.shapeKind],
  ];

/** The contributed command ids, in registration order. */
export const SELECT_SAME_COMMAND_IDS = COMMANDS.map(([id]) => id);

/** The PropertyPath each property criterion reads. */
export function pathForCriterion(c: PaintCriterion): PropertyPath {
  switch (c) {
    case "fill":
      return "frameFillColor";
    case "stroke":
      return "frameStrokeColor";
    case "strokeWeight":
      return "frameStrokeWeight";
    case "opacity":
      return "frameOpacity";
    case "blendMode":
      return "frameBlendMode";
  }
}

/** A criterion's comparable value read off a property snapshot — a
 *  colorRef string, a length number, a blending mode, or null when the
 *  element doesn't carry it. Exported so the conformance spec asserts
 *  the read shape. */
export async function valueForCriterion(
  host: BundleHost,
  id: ElementId,
  c: PaintCriterion,
): Promise<string | number | null> {
  try {
    return criterionValue(await host.document.elementProperties(id), c);
  } catch {
    /* unreadable ⇒ no match contribution */
  }
  return null;
}

type PropertyTable = Awaited<
  ReturnType<BundleHost["document"]["elementProperties"]>
>;

/** A blending mode as compared: `""` (the engine's unset) is Normal, and
 *  names compare case-blind. */
const blendModeKey = (raw: string): string =>
  raw === "" ? "normal" : raw.toLowerCase();

/** One row's raw value off a property table that has been read. */
function rowValue(
  props: PropertyTable,
  path: PropertyPath,
): string | number | null {
  for (const e of props?.entries ?? []) {
    if (e.path !== path) continue;
    const v = e.value;
    if (!v) return null;
    if (v.type === "colorRef") return v.value; // string | null
    if (v.type === "length") return v.value; // number | null
    if (v.type === "text") return v.value;
    return null;
  }
  return null;
}

/** One criterion's value off a property table that has been read. The
 *  one rule both the single read above and the document pass below use. */
function criterionValue(
  props: PropertyTable,
  c: PaintCriterion,
): string | number | null {
  const path = pathForCriterion(c);
  const v = rowValue(props, path);
  // An opacity the element never set reads back as a null length: it is
  // the default, 100 %. (A kind with no opacity row stays null.)
  if (c === "opacity" && v === null) {
    return props?.entries.some((e) => e.path === path) ? 100 : null;
  }
  if (c === "blendMode") return typeof v === "string" ? blendModeKey(v) : null;
  if (c === "fill" || c === "stroke") return typeof v === "string" ? v : null;
  return typeof v === "number" ? v : null;
}

/** The exact-match slack for a stroke weight (pt): a round-tripped 1.0
 *  vs 0.9999 must not miss. What "no tolerance" means. */
export const STROKE_WEIGHT_EPSILON = 1e-3;

/** The largest stroke-weight tolerance a payload may ask for (pt). A
 *  typo of 1e6 would select every stroked leaf — clamped, not obeyed. */
export const MAX_STROKE_WEIGHT_TOLERANCE = 1000;

/** A payload's tolerance as a usable number: finite, ≥ 0, clamped; 0
 *  for anything else. Exported for the spec and the panel. */
export function strokeWeightToleranceOf(payload: unknown): number {
  const t =
    payload !== null && typeof payload === "object"
      ? (payload as { tolerance?: unknown }).tolerance
      : undefined;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return 0;
  return Math.min(t, MAX_STROKE_WEIGHT_TOLERANCE);
}

/** Equality for a criterion's value. Numbers (stroke weight in pt,
 *  opacity in percent) match within `tolerance` INCLUSIVE when one is
 *  given, else within the round-trip epsilon; everything else (swatch
 *  refs, blending modes, canonical appearances, ids, kinds) compares by
 *  identity — see the header for why a colour cannot take a tolerance. */
function sameValue(
  a: string | number | null,
  b: string | number | null,
  tolerance = 0,
): boolean {
  if (a === null || b === null) return false;
  if (typeof a === "number" && typeof b === "number") {
    return tolerance > 0
      ? Math.abs(a - b) <= tolerance + 1e-9
      : Math.abs(a - b) < STROKE_WEIGHT_EPSILON;
  }
  return a === b;
}

/** What one leaf's property table answers: every property criterion,
 *  plus the fill tint the appearance criterion's base paint needs. */
type PaintFacts = Record<PaintCriterion, string | number | null> & {
  fillTint: number | null;
  /** The native parts (draw ADR 367): layers, object effects, targets. */
  native?: Pick<GraphicStyleAppearance, "layers" | "effects" | "targets">;
};

const NO_FACTS: PaintFacts = {
  fill: null,
  stroke: null,
  strokeWeight: null,
  opacity: null,
  blendMode: null,
  fillTint: null,
};

const factsOf = (props: PropertyTable): PaintFacts => {
  const tint = rowValue(props, "frameFillTint");
  const raw = (path: string) =>
    props?.entries.find((e) => e.path === path)?.value ?? null;
  const num = (path: PropertyPath) => {
    const v = rowValue(props, path);
    return typeof v === "number" ? v : null;
  };
  const txt = (path: PropertyPath) => {
    const v = rowValue(props, path);
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    fill: criterionValue(props, "fill"),
    stroke: criterionValue(props, "stroke"),
    strokeWeight: criterionValue(props, "strokeWeight"),
    opacity: criterionValue(props, "opacity"),
    blendMode: criterionValue(props, "blendMode"),
    fillTint: typeof tint === "number" ? tint : null,
    native: {
      layers: layersOfValue(raw("frameAppearance")) ?? [],
      effects: entriesOfValue(raw("frameEffectStack")) ?? [],
      targets: {
        fillOpacity: num("frameFillOpacity"),
        fillBlendMode: txt("frameFillBlendMode"),
        strokeOpacity: num("frameStrokeOpacity"),
        strokeBlendMode: txt("frameStrokeBlendMode"),
      },
    },
  };
};

async function readFacts(host: BundleHost, id: ElementId): Promise<PaintFacts> {
  try {
    return factsOf(await host.document.elementProperties(id));
  } catch {
    return NO_FACTS; /* unreadable ⇒ nothing to match on */
  }
}

/** The appearance criterion's value: the canonical form of the complete
 *  appearance (stack + base paint) Graphic Styles digests. A Normal blend
 *  is no blend, as there. */
function appearanceValue(
  facts: PaintFacts,
  envelope: PluginMetadataEnvelope | null,
): string {
  const blend = typeof facts.blendMode === "string" ? facts.blendMode : null;
  const base: GraphicStyleBase = {
    fill: typeof facts.fill === "string" ? facts.fill : null,
    fillTint: facts.fillTint,
    stroke: typeof facts.stroke === "string" ? facts.stroke : null,
    strokeWeight:
      typeof facts.strokeWeight === "number" ? facts.strokeWeight : null,
    opacity: typeof facts.opacity === "number" ? facts.opacity : null,
    blendMode: blend === null || blend === "normal" ? null : blend,
  };
  // The native parts (draw ADR 367) too: two objects with the same
  // fills, strokes and effects on the engine's appearance look the same.
  return canonicalGraphicAppearance({
    stack: appearanceOf(envelope),
    base,
    ...(facts.native ?? {}),
  });
}

/** The value a LINK criterion reads off an envelope. */
function linkValue(
  envelope: PluginMetadataEnvelope | null,
  c: "graphicStyle" | "symbol",
): string | null {
  return c === "graphicStyle"
    ? (graphicStyleRefOf(envelope)?.id ?? null)
    : (symbolInstanceOf(envelope)?.symbol ?? null);
}

const sameElement = (a: ElementId, b: ElementId): boolean =>
  a.kind === b.kind && a.id === b.id;

const keyOf = (id: ElementId): string => `${id.kind}:${JSON.stringify(id.id)}`;

/** Leaves read per parallel window — see `LEAF_READ_WINDOW` in
 *  `../link-index` for why a window and not all at once. */
const PAINT_READ_WINDOW = 64;

/** The revision-cache key of the pass below. */
const PAINT_FACTS_KEY = "select-same:paint";

type LeafFacts = { id: ElementId; facts: PaintFacts }[];

/** Every leaf's property facts, in tree order. ONE property read per
 *  leaf — the engine gap, as for the link walk: `elementProperties`
 *  takes one id (`elementGeometry` takes a list; this door does not) —
 *  kept for the document revision, so the next criterion costs nothing.
 *  `known` is a leaf the caller has already read. */
function paintFacts(
  host: BundleHost,
  known?: { id: ElementId; facts: PaintFacts },
): Promise<LeafFacts> {
  const index = linkIndex(host);
  return index.cached(PAINT_FACTS_KEY, async () => {
    const leaves = leafIdsOf(await index.tree());
    const out: LeafFacts = new Array(leaves.length);
    for (let at = 0; at < leaves.length; at += PAINT_READ_WINDOW) {
      await Promise.all(
        leaves.slice(at, at + PAINT_READ_WINDOW).map(async (id, i) => {
          const facts =
            known && sameElement(known.id, id)
              ? known.facts
              : await readFacts(host, id);
          out[at + i] = { id, facts };
        }),
      );
    }
    return out;
  });
}

/** The reference's property facts and the document's: the reference
 *  FIRST, on its own, so one with nothing to match on (`hasValue` false)
 *  never costs a pass over the document. */
async function paintPass(
  host: BundleHost,
  reference: ElementId,
  hasValue: (facts: PaintFacts) => boolean,
): Promise<{ facts: PaintFacts; leaves: LeafFacts | null }> {
  let leaves = (await linkIndex(host).peek<LeafFacts>(PAINT_FACTS_KEY)) ?? null;
  const own = leaves?.find((leaf) => sameElement(leaf.id, reference));
  // The document was read at this revision and the reference is one of
  // its leaves: nothing to ask the engine.
  if (own) return { facts: own.facts, leaves };
  const facts = await readFacts(host, reference);
  if (hasValue(facts)) {
    leaves ??= await paintFacts(host, { id: reference, facts });
  }
  return { facts, leaves };
}

/** Compute the matching set (the pure core, exported for the conformance
 *  spec): every leaf whose criterion value equals the reference's — for
 *  `strokeWeight`, within `tolerance` pt when one is given (ignored for
 *  every other criterion). The reference is included when it is a leaf.
 *  Returns `[]` when the reference value is null (nothing to match on). */
export async function selectSameMatches(
  host: BundleHost,
  reference: ElementId,
  c: SelectSameCriterion,
  tolerance = 0,
): Promise<ElementId[]> {
  const index = linkIndex(host);
  if (c === "shapeKind") {
    // The kind is in the id: nothing to read but the tree.
    return leafIdsOf(await index.tree()).filter(
      (id) => id.kind === reference.kind,
    );
  }
  // WP6.8 (draw ADR 365) — an engine instance is one page item that names
  // its symbol; the store lists every instance of each.
  if (c === "symbol" && engineSymbols(host) && reference.kind === "instance") {
    const address = `instance:${String(reference.id)}`;
    const row = (await readEngineSymbols(host)).find((r) =>
      r.instances.includes(address),
    );
    return (row?.instances ?? []).map(
      (a) =>
        ({ kind: "instance", id: a.slice("instance:".length) }) as ElementId,
    );
  }
  if (c === "graphicStyle" || c === "symbol") {
    const refValue = linkValue(await index.envelopeOf(reference), c);
    if (refValue === null) return [];
    const { leaves } = await index.snapshot();
    return leaves
      .filter((leaf) => linkValue(leaf.envelope, c) === refValue)
      .map((leaf) => leaf.id);
  }
  if (c === "appearance") {
    const { facts, leaves } = await paintPass(host, reference, () => true);
    if (!leaves) return [];
    const refValue = appearanceValue(facts, await index.envelopeOf(reference));
    const { leaves: linked } = await index.snapshot();
    const envelopes = new Map(linked.map((l) => [keyOf(l.id), l.envelope]));
    const out: ElementId[] = [];
    for (const leaf of leaves) {
      const envelope =
        envelopes.get(keyOf(leaf.id)) ?? (await index.envelopeOf(leaf.id));
      if (appearanceValue(leaf.facts, envelope) === refValue) out.push(leaf.id);
    }
    return out;
  }
  const slack = c === "strokeWeight" ? tolerance : 0;
  const { facts, leaves } = await paintPass(
    host,
    reference,
    (f) => f[c] !== null,
  );
  const refValue = facts[c];
  if (refValue === null || !leaves) return [];
  return leaves
    .filter((leaf) => sameValue(leaf.facts[c], refValue, slack))
    .map((leaf) => leaf.id);
}

async function applySelectSame(
  host: BundleHost,
  commandId: string,
  c: SelectSameCriterion,
  payload?: unknown,
): Promise<ElementId[]> {
  const tolerance = strokeWeightToleranceOf(payload);
  if (tolerance > 0 && c !== "strokeWeight") {
    host.log.debug(
      `${commandId}: a tolerance applies to stroke WEIGHT only — a colour is ` +
        "a swatch reference here, and no bundle door reads a swatch's values " +
        "(see commands/select-same.ts) — matching exactly",
    );
  }
  const selection = host.selection.get();
  if (selection.length === 0) {
    host.log.debug(`${commandId}: no reference selected — no-op`);
    return [];
  }
  const reference = selection[0];
  const matches = await selectSameMatches(host, reference, c, tolerance);
  if (matches.length === 0) {
    host.log.debug(
      `${commandId}: reference exposes no ${c} (or no matches) — no-op`,
    );
    return [];
  }
  await host.selection.set(matches);
  return matches;
}

/** Select every leaf whose stroke weight is within `tolerance` pt of the
 *  first selected element's — what the Path Options panel's "Select same
 *  stroke weight" section runs. Answers the new selection (empty = a
 *  no-op, logged). */
export function applySelectSameStrokeWeight(
  host: BundleHost,
  tolerance: number,
): Promise<ElementId[]> {
  return applySelectSame(
    host,
    SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
    "strokeWeight",
    { tolerance },
  );
}

/** Register the Select-same commands, one per criterion. Pure selection —
 *  no document mutation, so no undo step. */
export function contributeSelectSameCommands(host: BundleHost): Disposable {
  const disposers = COMMANDS.map(([id, c, title]) =>
    registerCommand(host, {
      id,
      title,
      category: SELECT_SAME_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        await applySelectSame(host, id, c, payload);
      },
    }),
  );
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
