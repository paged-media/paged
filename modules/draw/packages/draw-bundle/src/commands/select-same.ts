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
// Three commands (one criterion each): same FILL color, same STROKE color,
// same STROKE WEIGHT. The reference is the FIRST selected element; no
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
  PropertyPath,
} from "@paged-media/plugin-api";

import { leafIdsOf, linkIndex } from "../link-index";

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

/** The contributed command ids, in registration order. */
export const SELECT_SAME_COMMAND_IDS = [
  SELECT_SAME_FILL_COMMAND_ID,
  SELECT_SAME_STROKE_COMMAND_ID,
  SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
];

/** The criterion a Select-same command matches on. */
export type SelectSameCriterion = "fill" | "stroke" | "strokeWeight";

/** The PropertyPath each criterion reads. */
export function pathForCriterion(c: SelectSameCriterion): PropertyPath {
  switch (c) {
    case "fill":
      return "frameFillColor";
    case "stroke":
      return "frameStrokeColor";
    case "strokeWeight":
      return "frameStrokeWeight";
  }
}

/** A criterion's comparable value read off a property snapshot — a
 *  colorRef string, a length number, or null when the element doesn't
 *  carry it. Exported so the conformance spec asserts the read shape. */
export async function valueForCriterion(
  host: BundleHost,
  id: ElementId,
  c: SelectSameCriterion,
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

/** One criterion's value off a property table that has been read. The
 *  one rule both the single read above and the document pass below use. */
function criterionValue(
  props: PropertyTable,
  c: SelectSameCriterion,
): string | number | null {
  const path = pathForCriterion(c);
  for (const e of props?.entries ?? []) {
    if (e.path !== path) continue;
    const v = e.value;
    if (!v) return null;
    if (v.type === "colorRef") return v.value; // string | null
    if (v.type === "length") return v.value; // number | null
    return null;
  }
  return null;
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

/** Equality for a criterion's value. Numbers (stroke weight, pt) match
 *  within `tolerance` INCLUSIVE when one is given, else within the
 *  round-trip epsilon; colours (swatch refs) compare by identity — see
 *  the header for why a colour cannot take a tolerance. */
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

/** What one leaf answers to all three criteria. */
type PaintFacts = Record<SelectSameCriterion, string | number | null>;

const NO_FACTS: PaintFacts = { fill: null, stroke: null, strokeWeight: null };

const factsOf = (props: PropertyTable): PaintFacts => ({
  fill: criterionValue(props, "fill"),
  stroke: criterionValue(props, "stroke"),
  strokeWeight: criterionValue(props, "strokeWeight"),
});

const sameElement = (a: ElementId, b: ElementId): boolean =>
  a.kind === b.kind && a.id === b.id;

/** Leaves read per parallel window — see `LEAF_READ_WINDOW` in
 *  `../link-index` for why a window and not all at once. */
const PAINT_READ_WINDOW = 64;

/** The revision-cache key of the pass below. */
const PAINT_FACTS_KEY = "select-same:paint";

type LeafFacts = { id: ElementId; facts: PaintFacts }[];

/** Every leaf's three criterion values, in tree order. ONE property read
 *  per leaf — the engine gap, as for the link walk: `elementProperties`
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
          let facts = NO_FACTS;
          if (known && sameElement(known.id, id)) {
            facts = known.facts;
          } else {
            try {
              facts = factsOf(await host.document.elementProperties(id));
            } catch {
              /* unreadable ⇒ no match contribution */
            }
          }
          out[at + i] = { id, facts };
        }),
      );
    }
    return out;
  });
}

/** Compute the matching set (the pure core, exported for the conformance
 *  spec): every leaf whose criterion value equals the reference's — for
 *  `strokeWeight`, within `tolerance` pt when one is given (ignored for
 *  the colour criteria). The reference is included. Returns `[]` when the
 *  reference value is null (nothing to match on). */
export async function selectSameMatches(
  host: BundleHost,
  reference: ElementId,
  c: SelectSameCriterion,
  tolerance = 0,
): Promise<ElementId[]> {
  const slack = c === "strokeWeight" ? tolerance : 0;
  const index = linkIndex(host);
  let leaves = await index.peek<LeafFacts>(PAINT_FACTS_KEY);
  let refValue: string | number | null;
  const own = leaves?.find((leaf) => sameElement(leaf.id, reference));
  if (own) {
    // The document was read at this revision and the reference is one of
    // its leaves: nothing to ask the engine.
    refValue = own.facts[c];
  } else {
    // The reference FIRST, on its own: one with nothing to match on must
    // not cost a pass over the document.
    let facts = NO_FACTS;
    try {
      facts = factsOf(await host.document.elementProperties(reference));
    } catch {
      /* unreadable ⇒ nothing to match on */
    }
    refValue = facts[c];
    if (refValue !== null) {
      leaves ??= await paintFacts(host, { id: reference, facts });
    }
  }
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

/** Register the three Select-same commands (same fill / stroke / stroke
 *  weight). Pure selection — no document mutation. */
export function contributeSelectSameCommands(host: BundleHost): Disposable {
  const disposers = [
    host.contribute.command({
      id: SELECT_SAME_FILL_COMMAND_ID,
      title: "Select same: Fill",
      category: SELECT_SAME_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        await applySelectSame(host, SELECT_SAME_FILL_COMMAND_ID, "fill", payload);
      },
    }),
    host.contribute.command({
      id: SELECT_SAME_STROKE_COMMAND_ID,
      title: "Select same: Stroke",
      category: SELECT_SAME_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        await applySelectSame(
          host,
          SELECT_SAME_STROKE_COMMAND_ID,
          "stroke",
          payload,
        );
      },
    }),
    host.contribute.command({
      id: SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
      // Run bare it is the EXACT match it always was; a payload
      // `{ tolerance }` (pt) widens it. A remembered tolerance is NOT
      // applied here — "same" from the menu must not quietly mean
      // "within whatever was typed last week". The "within…" row is the
      // Path Options panel's.
      title: "Select same: Stroke weight",
      category: SELECT_SAME_COMMAND_CATEGORY,
      handler: async (_paged, payload) => {
        await applySelectSame(
          host,
          SELECT_SAME_STROKE_WEIGHT_COMMAND_ID,
          "strokeWeight",
          payload,
        );
      },
    }),
  ];
  return {
    dispose() {
      for (const d of disposers) d.dispose();
    },
  };
}
