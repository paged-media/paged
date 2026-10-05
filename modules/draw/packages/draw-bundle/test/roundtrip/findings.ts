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
  writeNewDropsCorners: {
    verdict: "defect",
    owner: "exporter",
    title: "live corners on a draw-made Polygon are not exported",
    why:
      "The engine holds the corner option + radius on the inserted Polygon (the " +
      "live-corner command wrote them, the model reads them back), but the write-NEW " +
      "lane emits no `*CornerOption` / `*CornerRadius` attribute, so InDesign draws " +
      "square corners. The same command on a SOURCE <Rectangle> exports (live-corners-rectangle).",
  },
  writeNewDropsDash: {
    verdict: "defect",
    owner: "exporter",
    title: "a dash on a draw-made path is not exported",
    why:
      "The model holds `frameStrokeDashArray`; the write-new lane emits neither a " +
      "`StrokeType=\"StrokeStyle/$ID/Dashed\"` nor `StrokeDashAndGap`, so InDesign " +
      "strokes it solid.",
  },
  writeNewDropsJoin: {
    verdict: "defect",
    owner: "exporter",
    title: "stroke join and miter limit on a draw-made path are not exported",
    why:
      "The engine accepts and reads back `frameStrokeJoin` / `frameStrokeMiterLimit` " +
      "on an inserted Polygon; the write-new lane emits no `EndJoin` / `MiterLimit`, " +
      "so InDesign answers its defaults (miter, 4).",
  },
  textPathNotExported: {
    verdict: "defect",
    owner: "exporter",
    title: "Type on a Path is not exported, and the lost list does not say so",
    why:
      "The path carries no <TextPath>; the story is written as a stand-alone " +
      "Stories/ part that nothing references, and InDesign discards it (the recording " +
      "lists NO story at all). The export's `lost` list is empty — a silent loss.",
  },
  paperNotDeclared: {
    verdict: "defect",
    owner: "exporter",
    title: "a fill of Color/Paper is exported without declaring the swatch",
    why:
      "The engine paints the appearance bake's Paper layer with its implicit " +
      "`Color/Paper`; the exported Graphic.xml (the source's, passed through) never " +
      "defines it, and InDesign resolves the unknown reference to NO fill.",
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
const SQUARE = allCorners("NONE", null);

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
  "live-corners-polygon": CORNER_OPTIONS.map((option, i) => ({
    at: String(i),
    field: "corners",
    ours: allCorners(option, 12),
    theirs: SQUARE,
    finding: "writeNewDropsCorners" as const,
  })),
  "dash-presets": [
    // Item 0 is the Solid preset: nothing to lose.
    { at: "1", field: "dash", ours: [6, 3], theirs: [], finding: "writeNewDropsDash" },
    { at: "2", field: "dash", ours: [1, 3], theirs: [], finding: "writeNewDropsDash" },
    { at: "3", field: "dash", ours: [6, 3, 1, 3], theirs: [], finding: "writeNewDropsDash" },
  ],
  "stroke-attributes": [
    { at: "0", field: "endJoin", ours: "ROUND_END_JOIN", theirs: "MITER_END_JOIN", finding: "writeNewDropsJoin" },
    { at: "1", field: "endJoin", ours: "BEVEL_END_JOIN", theirs: "MITER_END_JOIN", finding: "writeNewDropsJoin" },
    { at: "2", field: "miterLimit", ours: 2, theirs: 4, finding: "writeNewDropsJoin" },
  ],
  // `gradient-linear` has none since 0.66.0: angle 30 and length 250 read
  // back, as InDesign reads them. `gradient-radial`'s unset angle is
  // compared as InDesign's default (0, INDESIGN_DEFAULTS); its length is
  // not a default — see the finding.
  "gradient-radial": [
    // 120.5 = the circle's radius (120) + half its 1 pt stroke: InDesign's
    // derived length for an axis the file does not state.
    { at: "0", field: "gradientLength", ours: null, theirs: 120.5, finding: "gradientLengthDerived" },
  ],
  "appearance-bake": [
    { at: "0/2", field: "fill", ours: "Paper", theirs: "None", finding: "paperNotDeclared" },
  ],
  "text-on-path": [
    { at: "0", field: "textPath", ours: "Type on a path", theirs: null, finding: "textPathNotExported" },
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

/** The cases whose `lost` list SHOULD name something and does not. */
export const MISSING_LOST: Record<string, { pattern: RegExp; finding: FindingId }> = {
  "text-on-path": { pattern: /text|path|story/i, finding: "textPathNotExported" },
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
    // InDesign resolved the undeclared Paper to no fill when it OPENED the
    // file, so its own export says None — the forward defect, carried home.
    { at: "0/2", field: "fill", ours: "Paper", theirs: "None", finding: "paperNotDeclared" },
  ],
};

/** The cases whose InDesign re-export is committed. */
export const REIMPORT_CASES = Object.keys(KNOWN_REIMPORT);
