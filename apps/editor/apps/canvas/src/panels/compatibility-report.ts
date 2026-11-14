/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The compatibility report's model (editor ADR 1222; the interaction
// specification's UXI-FIL-002; the UX strategy's §6.4; task DF4). PURE.
//
// Every importer, exporter and mapper answers with the engine's one loss
// report (engine ADR 1097): `LossEntry { code, count, severity, pages,
// items, message }`. This turns a report into what a person reads: the
// area a code belongs to ("Fonts", "Effects", …), what its severity means
// ("Left out", "Converted", "Note"), a sentence (the producer's own, else
// the area's), the summary line after an import ("Imported · 2 font
// substitutions · 1 unsupported effect · 3 converted objects") and the
// round-trip risk of the format. The code itself stays available, on
// demand, for whoever needs the technical detail.

import type { LossEntry, LossSeverity } from "@paged-media/plugin-api";
import { defineMessages, t as translate } from "@paged-media/strings";

type T = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
) => string;

/** One import or export's report. */
export interface CompatReport {
  /** Stable per operation kind: a later report of the same kind replaces it. */
  id: string;
  direction: "import" | "export";
  /** The source or target format: `idml`, `pptx`, `docx`, `svg`, … */
  format: string;
  /** The file, when there is one. */
  name?: string;
  /** When it was made (ms since the epoch). */
  at: number;
  losses: readonly LossEntry[];
  /** Who reported it: an editor area or a bundle id. */
  source: string;
  /** What the operation made (an import's items), to show them. */
  made?: readonly string[];
}

/** The areas a loss code belongs to, in the order the report lists them. */
export type LossArea =
  "fonts" | "effects" | "paint" | "pictures" | "text" | "structure" | "other";

export const LOSS_AREAS: readonly LossArea[] = [
  "fonts",
  "effects",
  "paint",
  "pictures",
  "text",
  "structure",
  "other",
];

// Each producer names its codes in its own vocabulary (engine ADR 1097):
// `idml.<area>.<what>`, `dml.<area>.<what>`, `pptx.<area>.<what>`,
// `eps.<area>.<what>`, `xlsx.<area>.<what>`, `docx.tier<n>`, an SVG
// construct (`filter`), a Photoshop effect (`Drop Shadow`), a PDF mapper
// code (`shading.sampled`). The area is read from the segments.
const AREA_WORDS: ReadonlyArray<readonly [LossArea, RegExp]> = [
  ["fonts", /(^|[.\s])(font|fonts|glyph|typeface)([.\s]|$)/i],
  [
    "effects",
    /(^|[.\s])(effect|effects|shadow|blur|glow|bevel|3d|reflection|filter|mask|blendmode|mixblendmode|backgroundblendmode|appearance|vectoreffect|livephotoshopeffect|drop shadow|inner shadow|outer glow|inner glow|satin|stroke emboss|overlay)([.\s]|$)/i,
  ],
  [
    "paint",
    /(^|[.\s])(paint|gradient|pattern|meshfill|fill|fillrule|line|shading|colour|colours|color|colors|swatch|theme|ink|tint|stroke)([.\s]|$)/i,
  ],
  [
    "pictures",
    /(^|[.\s])(picture|image|media|link|imageadjustment|raster|bitmap|psd|layer)([.\s]|$)/i,
  ],
  [
    "text",
    /(^|[.\s])(story|text|table|cell|cells|celltext|comment|comments|paragraph|character|note|notes|footnote|hyperlink)([.\s]|$)/i,
  ],
  [
    "structure",
    /(^|[.\s])(section|spread|page|guide|condition|conditionset|symbol|group|pageitem|shape|frame|smartart|chart|part|rel|master|layout|slide|export|livshape|liveshape|clippath|entity|annotation)([.\s]|$)/i,
  ],
];

/** The area `entry`'s code (or, for a code that says nothing, its
 *  message) belongs to. */
export function areaOf(
  entry: Pick<LossEntry, "code" | "message"> & Partial<LossEntry>,
): LossArea {
  // `idml.gradient.conic` → "gradient conic"; `Drop Shadow` stays.
  const words = entry.code
    .replace(/^(idml|dml|pptx|eps|xlsx|docx|svg|pdf|dxf|psd)\./, "")
    .replace(/\./g, " ");
  for (const [area, re] of AREA_WORDS) if (re.test(words)) return area;
  if (/^docx\.tier\d$/.test(entry.code) || entry.code.endsWith(".legacy")) {
    for (const [area, re] of AREA_WORDS)
      if (entry.message && re.test(entry.message)) return area;
  }
  return "other";
}

/** An entry's severity: `dropped` when the producer said nothing. */
export function severityOfLoss(
  entry: Pick<LossEntry, "severity">,
): LossSeverity {
  return entry.severity ?? "dropped";
}

const M = defineMessages("app.compatibilityReport", {
  areaFonts: "Fonts",
  areaEffects: "Effects",
  areaPaint: "Colour and paint",
  areaPictures: "Pictures and links",
  areaText: "Text and tables",
  areaStructure: "Pages and objects",
  areaOther: "Other",
  dropped: "Left out",
  approximated: "Converted",
  info: "Note",
  explainDropped:
    "Something in the {area} of the file could not be carried and was left out.",
  explainApproximated:
    "Something in the {area} of the file was converted and may look different.",
  explainInfo: "Worth knowing; nothing visible changed.",
  imported: "Imported",
  importedName: "Imported {name}",
  exported: "Exported",
  exportedName: "Exported {name}",
  exactly: "nothing was lost",
  fontSubstitutions:
    "{count, plural, one {# font substitution} other {# font substitutions}}",
  unsupportedEffects:
    "{count, plural, one {# unsupported effect} other {# unsupported effects}}",
  convertedObjects:
    "{count, plural, one {# converted object} other {# converted objects}}",
  leftOut: "{count, plural, one {# item left out} other {# items left out}}",
  notes: "{count, plural, one {# note} other {# notes}}",
  riskIdml:
    "Saving as IDML writes what InDesign reads. What is listed here as left out or converted comes back changed, and an IDML export reports what it could not write.",
  riskPptx:
    "Exporting to PowerPoint keeps the slides and writes back the edits it can map. What is listed here does not return as it was.",
  riskDocx:
    "Saving back to Word writes the edits it can map into the original file. What is listed here as left out does not return.",
  riskXlsx:
    "Saving back to Excel writes the workbook from the sheet. What is listed here does not return as it was.",
  riskPsd:
    "Exporting to Photoshop writes the layers back. Effects and adjustments listed here are flattened or left out.",
  riskPdf:
    "A PDF does not round-trip: Paged writes a new PDF and never edits the original.",
  riskSvg:
    "Exporting as SVG writes a new drawing. Constructs listed here do not come back.",
  riskOther:
    "A round trip to {format} is not verified: what is listed here does not come back.",
});

/** The words of the report panel (the panel reads them here). */
export const COMPAT_STRINGS = M;

const AREA_KEY: Record<LossArea, string> = {
  fonts: M.areaFonts,
  effects: M.areaEffects,
  paint: M.areaPaint,
  pictures: M.areaPictures,
  text: M.areaText,
  structure: M.areaStructure,
  other: M.areaOther,
};

export function areaLabel(area: LossArea, t: T = translate): string {
  return t(AREA_KEY[area]);
}

export function severityLabel(
  severity: LossSeverity,
  t: T = translate,
): string {
  return t(
    severity === "info"
      ? M.info
      : severity === "approximated"
        ? M.approximated
        : M.dropped,
  );
}

/** What the entry means, in a sentence: the producer's own words, else
 *  the area's. */
export function explainLoss(entry: LossEntry, t: T = translate): string {
  if (entry.message && entry.message.trim()) return entry.message.trim();
  const area = areaLabel(areaOf(entry), t).toLowerCase();
  const severity = severityOfLoss(entry);
  return t(
    severity === "info"
      ? M.explainInfo
      : severity === "approximated"
        ? M.explainApproximated
        : M.explainDropped,
    { area },
  );
}

/** The counts the summary line names. An entry counts `count` times. */
export interface LossSummary {
  fontSubstitutions: number;
  unsupportedEffects: number;
  convertedObjects: number;
  leftOut: number;
  notes: number;
  total: number;
}

export function summarizeLosses(losses: readonly LossEntry[]): LossSummary {
  const s: LossSummary = {
    fontSubstitutions: 0,
    unsupportedEffects: 0,
    convertedObjects: 0,
    leftOut: 0,
    notes: 0,
    total: 0,
  };
  for (const e of losses) {
    const n = Math.max(1, e.count | 0);
    const severity = severityOfLoss(e);
    const area = areaOf(e);
    s.total += n;
    if (severity === "info") s.notes += n;
    else if (area === "fonts") s.fontSubstitutions += n;
    else if (area === "effects" && severity === "dropped")
      s.unsupportedEffects += n;
    else if (severity === "approximated") s.convertedObjects += n;
    else s.leftOut += n;
  }
  return s;
}

/** "Imported deck.pptx · 2 font substitutions · 1 unsupported effect · 3
 *  converted objects" (the UX strategy's §6.4). */
export function summaryLine(report: CompatReport, t: T = translate): string {
  const head =
    report.direction === "import"
      ? report.name
        ? t(M.importedName, { name: report.name })
        : t(M.imported)
      : report.name
        ? t(M.exportedName, { name: report.name })
        : t(M.exported);
  const s = summarizeLosses(report.losses);
  const parts: string[] = [];
  if (s.fontSubstitutions)
    parts.push(t(M.fontSubstitutions, { count: s.fontSubstitutions }));
  if (s.unsupportedEffects)
    parts.push(t(M.unsupportedEffects, { count: s.unsupportedEffects }));
  if (s.convertedObjects)
    parts.push(t(M.convertedObjects, { count: s.convertedObjects }));
  if (s.leftOut) parts.push(t(M.leftOut, { count: s.leftOut }));
  if (s.notes) parts.push(t(M.notes, { count: s.notes }));
  if (parts.length === 0) parts.push(t(M.exactly));
  return [head, ...parts].join(" · ");
}

/** Whether a round trip to `format` may lose information, said plainly. */
export function roundTripRisk(format: string, t: T = translate): string {
  switch (format.toLowerCase()) {
    case "idml":
    case "indd":
      return t(M.riskIdml);
    case "pptx":
    case "potx":
      return t(M.riskPptx);
    case "docx":
    case "dotx":
      return t(M.riskDocx);
    case "xlsx":
      return t(M.riskXlsx);
    case "psd":
      return t(M.riskPsd);
    case "pdf":
    case "ai":
    case "eps":
      return t(M.riskPdf);
    case "svg":
      return t(M.riskSvg);
    default:
      return t(M.riskOther, { format: format.toUpperCase() });
  }
}

/** The order the report lists entries in: left out, converted, notes;
 *  then by area. */
export function sortLosses(losses: readonly LossEntry[]): LossEntry[] {
  const rank = (e: LossEntry) => {
    const s = severityOfLoss(e);
    return s === "dropped" ? 0 : s === "approximated" ? 1 : 2;
  };
  return [...losses].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      LOSS_AREAS.indexOf(areaOf(a)) - LOSS_AREAS.indexOf(areaOf(b)),
  );
}

// Where a bundle's keyed diagnostics come from, when they carry losses:
// the direction and the format of the operation that published them.
const KNOWN_KEYS: ReadonlyArray<
  readonly [
    bundle: string,
    key: RegExp,
    direction: "import" | "export",
    format: string,
  ]
> = [
  ["media.paged.slide", /\/import$|\/fonts$/, "import", "pptx"],
  ["media.paged.slide", /\/export$/, "export", "pptx"],
  ["media.paged.doc", /.*/, "import", "docx"],
  ["media.paged.pdf", /.*/, "import", "pdf"],
  ["media.paged.publish", /export/i, "export", "idml"],
  ["media.paged.draw", /.*/, "import", "svg"],
  ["media.paged.image", /.*/, "import", "psd"],
  ["media.paged.sheet", /.*/, "import", "xlsx"],
  ["paged.svg", /.*/, "import", "svg"],
  ["paged.clipboard", /.*/, "import", "svg"],
];

/** The direction and format of a bundle's keyed loss diagnostics. */
export function operationOfKey(
  bundleId: string,
  key: string,
): { direction: "import" | "export"; format: string } {
  for (const [bundle, re, direction, format] of KNOWN_KEYS)
    if (bundleId === bundle && re.test(key)) return { direction, format };
  const tail = bundleId.split(".").pop() ?? bundleId;
  return {
    direction: /export/i.test(key) ? "export" : "import",
    format: tail,
  };
}
