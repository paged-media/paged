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

// What every difference the round trip found IS. Each one is one of:
//
//   DEFECT      ours is wrong (the exporter, the engine, or draw's own
//               code). Kept as an `it.fails` naming both values, so it is
//               visible and turns red the day it is fixed;
//   CONVENTION  both sides are right in their own terms — pinned with both
//               values and the sentence that says why;
//   LOSS        IDML cannot carry it, and the engine's export says so in
//               its `lost` list (asserted, not assumed).
//
// A difference that is not listed here fails the replay; so does a listed
// one that no longer occurs. Both values are the ones MEASURED — Adobe
// InDesign 20.0.1.32 on the committed recordings, the engine pinned by
// `engine-pin.spec.ts` (canvas-wasm 0.66.0).
//
// FIXED in 0.66.0, and gone from these tables: a Pen-drawn path (a
// Polygon) now takes a cap and arrowheads (RFI C-62) — `arrowheads` and
// `stroke-attributes` were regenerated and re-recorded, and InDesign
// reads the round cap and both line ends; and a Polygon's gradient axis
// now reads back (C-83b) — `gradient-linear` reads angle 30 and length
// 250, InDesign's own values.

import { enumName } from "./view";

export type Verdict = "defect" | "convention" | "loss";
export type Owner = "exporter" | "engine" | "draw" | "indesign";

export interface Finding {
  verdict: Verdict;
  owner: Owner;
  title: string;
  why: string;
}

export const FINDINGS = {
  // -- the WRITE-NEW lane: page items the document did not carry -------------
  // Five defects of this lane were fixed by the 0.70.0 engine (its pinned
  // exporter, plugin-publish 47ab9d9) and their entries deleted: live corners,
  // dash, join + miter limit on a draw-made path, an undeclared Color/Paper,
  // and Type on a Path (now written as a <TextPath>). Re-recorded with
  // InDesign 20.0.1 on 2026-10-06.
  textPathEndBracketAbsent: {
    verdict: "defect",
    owner: "exporter",
    title: "a <TextPath> with no end bracket is exported without EndBracket; InDesign reads 0 and the story is overset",
    why:
      "draw attaches the text with `startBracket: 10` and no end, which the model holds " +
      "as `end_bracket: None` — flow to the end of the path, as the renderer draws it. " +
      "The exporter writes `StartBracket=\"10\"` and omits `EndBracket`; InDesign takes " +
      "the absent attribute as 0, so the window is empty, the path shows no text " +
      "(`contents: \"\"`, `overflows: true`) and the story is reported overset. " +
      "The exporter should write the path's length for an unset end bracket.",
  },
  dashImpliesDashedType: {
    verdict: "convention",
    owner: "engine",
    title: "a dash is the dash array alone in the model; IDML also names the Dashed stroke type",
    why:
      "draw's dash presets write `frameStrokeDashArray` and leave `frameStrokeType` " +
      "unset, which reads back as InDesign's default Solid. IDML only honours " +
      "`StrokeDashAndGap` under `StrokeType=\"StrokeStyle/$ID/Dashed\"`, so the exporter " +
      "writes that type whenever a dash array is present, and InDesign answers Dashed. " +
      "The same dashed stroke (the dash arrays agree) — pinned with both values.",
  },
  absentStrokeReadAsNone: {
    verdict: "defect",
    owner: "engine",
    title: "a <Rectangle> with no StrokeColor is read as unstroked; InDesign strokes it",
    why:
      "The source rectangle states no StrokeColor / StrokeWeight. The engine models " +
      "that as no stroke; InDesign applies its default (Black, 1 pt). The export keeps " +
      "the attribute absent, so the file InDesign opens strokes what the canvas does not.",
  },
  gradientLengthDerived: {
    verdict: "convention",
    owner: "indesign",
    title: "an unset gradient length is unset in the model; InDesign derives one from the item",
    why:
      "The radial-gradient command sets no axis, so the model reads " +
      "`frameGradientFillLength` back as unset (null — the read door is there since " +
      "0.66.0) and the export writes no `GradientFillLength`. InDesign does not answer a " +
      "constant default for the absence: it DERIVES a length from the item (the circle's " +
      "radius plus half its stroke), so it cannot sit in INDESIGN_DEFAULTS. Both say " +
      "\"no explicit axis\" — pinned with both values.",
  },
  bevelSpelling: {
    verdict: "convention",
    owner: "engine",
    title: "the bevel corner is BeveledCorner in the model, BevelCorner in IDML",
    why:
      "draw's preset writes the engine token `BeveledCorner` and the model reads it " +
      "back so; IDML (and InDesign's enum) spell it `BevelCorner`, and the exporter " +
      "translates. The same corner — a spelling, pinned so the map stays deliberate.",
  },
  opacityMaskLost: {
    verdict: "loss",
    owner: "exporter",
    title: "an opacity mask is not IDML — the mask artwork exports as an ordinary item",
    why:
      "IDML has no opacity-mask element. The export says so in `lost`; the mask " +
      "artwork, which the model keeps OUT of the scene tree, is written as a plain " +
      "item, so InDesign shows one more item than the model — the black mask shape, " +
      "painted on top of its target.",
  },
  // -- re-import of InDesign's OWN export -------------------------------------
  itemTransformIsSpreadRelative: {
    verdict: "defect",
    owner: "engine",
    title: "`itemTransform` composes against the SPREAD on a page that is not at the spread origin",
    why:
      "InDesign writes its single page at ItemTransform `1 0 0 1 -612 -396` and each " +
      "item with the same transform. The engine's bounds and hitTest are page-local " +
      "(the polygon hits at its page coordinates), but `pathAnchors`/`elementGeometry` " +
      "hand back the item's raw transform, so inner → page through it lands every " +
      "path 612 pt left and 396 pt up — against the contract's own convention " +
      "(\"`bounds` + `item_transform` compose against the SPREAD origin\" ONLY for a " +
      "pageless item). Every draw tool that maps anchors through it is off on an " +
      "InDesign-authored file.",
  },
  objectStyleNotInherited: {
    verdict: "defect",
    owner: "engine",
    title: "attributes InDesign leaves to the object style are read as unset",
    why:
      "InDesign's own export applies `[Normal Graphics Frame]` and OMITS every " +
      "attribute equal to that style's (StrokeColor Black, StrokeWeight 1, " +
      "CornerRadius 12). The engine does not resolve object-style inheritance, so " +
      "it reads those items as unstroked, weightless, radius-less.",
  },
} as const satisfies Record<string, Finding>;

export type FindingId = keyof typeof FINDINGS;

export interface Known {
  /** Index path(s) the difference occurs at (see `Difference.at`). */
  at: string | readonly string[];
  field: string;
  ours: unknown;
  theirs: unknown;
  finding: FindingId;
}

/** An engine REFUSAL the author records (the capability is not there). */
export interface KnownRefusal {
  what: string;
  /** A substring of the engine's own sentence. */
  error: string;
  finding: string;
}

/** What each known refusal IS. Empty since 0.66.0: the one refusal the
 *  authoring met — a cap and arrowheads on a Pen-drawn path, RFI C-62 —
 *  is fixed, and the same attempts now apply (`arrowheads`,
 *  `stroke-attributes`). */
export const REFUSAL_FINDINGS: Record<string, Finding> = {};

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

const allCorners = (option: string, radius: number | null) => ({
  topLeft: { option, radius },
  topRight: { option, radius },
  bottomRight: { option, radius },
  bottomLeft: { option, radius },
});

/** The five live-corner styles, in the order the cases apply them. */
const CORNER_OPTIONS = [
  "RoundedCorner",
  "InverseRoundedCorner",
  "BeveledCorner",
  "FancyCorner",
  "InsetCorner",
].map(enumName);

/** Every classified difference between OUR model and InDesign's reading
 *  of the exported IDML, per case. A case not listed has none. */
export const KNOWN: Record<string, readonly Known[]> = {
  "live-corners-rectangle": [
    {
      at: ["0", "1", "2", "3", "4"],
      field: "stroke",
      ours: "None",
      theirs: "Black",
      finding: "absentStrokeReadAsNone",
    },
    {
      at: ["0", "1", "2", "3", "4"],
      field: "strokeWeight",
      ours: null,
      theirs: 1,
      finding: "absentStrokeReadAsNone",
    },
    {
      at: "2",
      field: "corners",
      ours: allCorners("BEVELED_CORNER", 12),
      theirs: allCorners("BEVEL_CORNER", 12),
      finding: "bevelSpelling",
    },
  ],
  // Every corner survives since 0.70.0; the bevel is the same spelling
  // convention as on a source <Rectangle>.
  "live-corners-polygon": [
    {
      at: "2",
      field: "corners",
      ours: allCorners("BEVELED_CORNER", 12),
      theirs: allCorners("BEVEL_CORNER", 12),
      finding: "bevelSpelling",
    },
  ],
  // The dash arrays survive since 0.70.0. Item 0 is the Solid preset.
  "dash-presets": ["1", "2", "3"].map((at) => ({
    at,
    field: "strokeType",
    ours: "$ID/Solid",
    theirs: "$ID/Dashed",
    finding: "dashImpliesDashedType" as const,
  })),
  // `stroke-attributes` has none since 0.70.0: join and miter limit export.
  // `gradient-linear` has none since 0.66.0: angle 30 and length 250 read
  // back, as InDesign reads them. `gradient-radial`'s unset angle is
  // compared as InDesign's default (0, INDESIGN_DEFAULTS); its length is
  // not a default — see the finding.
  "gradient-radial": [
    // 120.5 = the circle's radius (120) + half its 1 pt stroke: InDesign's
    // derived length for an axis the file does not state.
    { at: "0", field: "gradientLength", ours: null, theirs: 120.5, finding: "gradientLengthDerived" },
  ],
  // `appearance-bake` has none since 0.70.0: Color/Paper is declared.
  "text-on-path": [
    { at: "0", field: "textPath", ours: "Type on a path", theirs: "", finding: "textPathEndBracketAbsent" },
  ],
  "opacity-mask": [
    { at: "page", field: "children", ours: ["polygon"], theirs: ["polygon", "polygon"], finding: "opacityMaskLost" },
  ],
};

/** What the authoring ASKED for and the engine refused, per case. None
 *  since 0.66.0 (C-62, above). */
export const KNOWN_REFUSALS: Record<string, readonly KnownRefusal[]> = {};

/** The engine's `lost` list per case: one pattern per entry, in order. */
export const KNOWN_LOST: Record<string, readonly RegExp[]> = {
  "opacity-mask": [/^opacity mask on `u1` \(artwork `u2`\) is a paged-native construct — IDML has no opacity-mask element/],
};

/** The cases whose `lost` list SHOULD name something and does not. None
 *  since 0.70.0: Type on a Path is exported, so nothing is silently lost. */
export const MISSING_LOST: Record<string, { pattern: RegExp; finding: FindingId }> = {};

/** The warnings InDesign raised when it opened a case's IDML, per case,
 *  each one the symptom of a classified finding. */
export const KNOWN_WARNINGS: Record<string, readonly { warning: unknown; finding: FindingId }[]> = {
  "text-on-path": [
    { warning: { source: "overset", story: "Type on a path" }, finding: "textPathEndBracketAbsent" },
  ],
};

/** Differences between the model as authored and the same document after
 *  InDesign opened it, re-exported it as IDML, and the ENGINE re-imported
 *  that file — the real round trip. */
export const KNOWN_REIMPORT: Record<string, readonly Known[]> = {
  "pen-closed": [
    {
      at: "0",
      field: "geometry",
      ours: "max deviation 612.0000 pt",
      theirs: "tolerance 0.01 pt",
      finding: "itemTransformIsSpreadRelative",
    },
    { at: "0", field: "stroke", ours: "Black", theirs: "None", finding: "objectStyleNotInherited" },
    { at: "0", field: "strokeWeight", ours: 1, theirs: null, finding: "objectStyleNotInherited" },
  ],
  "live-corners-rectangle": CORNER_OPTIONS.map((option, i) => ({
    at: String(i),
    field: "corners",
    ours: allCorners(option, 12),
    theirs: allCorners(option, null),
    finding: "objectStyleNotInherited" as const,
  })),
  "appearance-bake": [
    ...["0/1", "0/2", "0/3"].map((at) => ({
      at,
      field: "geometry",
      ours: "max deviation 612.0000 pt",
      theirs: "tolerance 0.01 pt",
      finding: "itemTransformIsSpreadRelative" as const,
    })),
    { at: "0/1", field: "strokeWeight", ours: 1, theirs: null, finding: "objectStyleNotInherited" },
    { at: "0/2", field: "strokeWeight", ours: 1, theirs: null, finding: "objectStyleNotInherited" },
    { at: "0/3", field: "stroke", ours: "Black", theirs: "None", finding: "objectStyleNotInherited" },
  ],
};

/** The cases whose InDesign re-export is committed. */
export const REIMPORT_CASES = Object.keys(KNOWN_REIMPORT);
