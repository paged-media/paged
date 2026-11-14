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

// The New document dialog's model (editor ADR 1220; UX audit F-04; the UX
// strategy's §6.5; task DF5 of interaction-plan.md). PURE: the purpose
// presets, the setup a document is created from, its validation, the
// stored shape (ADR 247) and the geometry of the dialog's miniature
// preview. Lengths are points, the model's unit; the dialog shows them in
// the setup's unit (ADR 245).
//
// Facing pages are a choice (engine ADR 1307): the engine makes the blank
// document's pages as facing spreads — page 1 alone as a right-hand page,
// then left/right pairs — and a left-hand page takes its inside margin on
// its right.

import type { LengthUnit } from "@paged-media/ui";

/** The purpose groups (the strategy's §6.5). */
export type PresetCategory = "print" | "digital" | "structured" | "custom";

export const PRESET_CATEGORIES: readonly PresetCategory[] = [
  "print",
  "digital",
  "structured",
  "custom",
];

export type PresetId =
  | "magazine"
  | "book"
  | "brochure"
  | "poster"
  | "businessCard"
  | "packaging"
  | "pdfPublication"
  | "presentation"
  | "webOutput"
  | "marketingGraphic"
  | "catalog"
  | "productSheet"
  | "variableData";

/** Margins in points; inside and outside are left and right on a
 *  single-sided page (the engine's `pageMarginLeft` / `pageMarginRight`). */
export interface Margins {
  top: number;
  bottom: number;
  inside: number;
  outside: number;
}

/** What a new document is made from. */
export interface NewDocumentSetup {
  /** The preset it came from; `custom` once a field was changed. */
  preset: PresetId | "custom";
  /** The page's width and height in points (the orientation is theirs). */
  widthPt: number;
  heightPt: number;
  pages: number;
  /** The unit the dialog shows lengths in; Create makes it the editor's
   *  document unit (ADR 245). */
  unit: LengthUnit;
  /** Bleed on every side, in points. */
  bleedPt: number;
  margins: Margins;
  columns: number;
  gutterPt: number;
  /** Facing spreads (engine ADR 1307); absent: single pages. */
  facingPages?: boolean;
}

/** A paper family: the size a paper-sized preset takes where the reader
 *  is (Letter in North America, A4 elsewhere). */
export type PaperFamily = "a4" | "letter";

const MM = 72 / 25.4;
const IN = 72;
const mm = (n: number) => n * MM;
const inch = (n: number) => n * IN;

/** One preset: its group and the setup it fills in, for each paper
 *  family where that matters. */
export interface PresetDefinition {
  id: PresetId;
  category: Exclude<PresetCategory, "custom">;
  setup(family: PaperFamily): Omit<NewDocumentSetup, "preset">;
}

const paper = (family: PaperFamily): [number, number] =>
  family === "letter" ? [inch(8.5), inch(11)] : [mm(210), mm(297)];
const paperUnit = (family: PaperFamily): LengthUnit =>
  family === "letter" ? "in" : "mm";
const even = (n: number): Margins => ({
  top: n,
  bottom: n,
  inside: n,
  outside: n,
});

export const PRESETS: readonly PresetDefinition[] = [
  // Print
  {
    id: "magazine",
    category: "print",
    setup: (f) => {
      const [w, h] = paper(f);
      return {
        widthPt: w,
        heightPt: h,
        pages: 12,
        unit: paperUnit(f),
        bleedPt: mm(3),
        margins: {
          top: mm(15),
          bottom: mm(18),
          inside: mm(15),
          outside: mm(12),
        },
        columns: 3,
        gutterPt: mm(5),
      };
    },
  },
  {
    id: "book",
    category: "print",
    setup: (f) => ({
      widthPt: inch(6),
      heightPt: inch(9),
      pages: 24,
      unit: paperUnit(f),
      bleedPt: 0,
      margins: {
        top: inch(0.625),
        bottom: inch(0.75),
        inside: inch(0.75),
        outside: inch(0.5),
      },
      columns: 1,
      gutterPt: mm(5),
    }),
  },
  {
    id: "brochure",
    category: "print",
    setup: (f) => {
      const [w, h] = paper(f);
      // A tri-fold: the sheet in landscape, three panels.
      return {
        widthPt: h,
        heightPt: w,
        pages: 2,
        unit: paperUnit(f),
        bleedPt: mm(3),
        margins: even(mm(10)),
        columns: 3,
        gutterPt: mm(20),
      };
    },
  },
  {
    id: "poster",
    category: "print",
    setup: (f) =>
      f === "letter"
        ? {
            widthPt: inch(18),
            heightPt: inch(24),
            pages: 1,
            unit: "in",
            bleedPt: inch(0.125),
            margins: even(inch(0.75)),
            columns: 1,
            gutterPt: inch(0.25),
          }
        : {
            widthPt: mm(420),
            heightPt: mm(594),
            pages: 1,
            unit: "mm",
            bleedPt: mm(3),
            margins: even(mm(20)),
            columns: 1,
            gutterPt: mm(5),
          },
  },
  {
    id: "businessCard",
    category: "print",
    setup: (f) =>
      f === "letter"
        ? {
            widthPt: inch(3.5),
            heightPt: inch(2),
            pages: 2,
            unit: "in",
            bleedPt: inch(0.125),
            margins: even(inch(0.125)),
            columns: 1,
            gutterPt: inch(0.125),
          }
        : {
            widthPt: mm(85),
            heightPt: mm(55),
            pages: 2,
            unit: "mm",
            bleedPt: mm(3),
            margins: even(mm(4)),
            columns: 1,
            gutterPt: mm(4),
          },
  },
  {
    id: "packaging",
    category: "print",
    setup: (f) => ({
      widthPt: mm(297),
      heightPt: mm(420),
      pages: 1,
      unit: paperUnit(f),
      bleedPt: mm(5),
      margins: even(mm(10)),
      columns: 1,
      gutterPt: mm(5),
    }),
  },
  // Digital — the editor counts a pixel as a point (ADR 245's px).
  {
    id: "pdfPublication",
    category: "digital",
    setup: (f) => {
      const [w, h] = paper(f);
      return {
        widthPt: w,
        heightPt: h,
        pages: 8,
        unit: paperUnit(f),
        bleedPt: 0,
        margins: even(f === "letter" ? inch(0.75) : mm(20)),
        columns: 2,
        gutterPt: f === "letter" ? inch(0.25) : mm(6),
      };
    },
  },
  {
    id: "presentation",
    category: "digital",
    setup: () => ({
      widthPt: 1920,
      heightPt: 1080,
      pages: 10,
      unit: "px",
      bleedPt: 0,
      margins: even(80),
      columns: 1,
      gutterPt: 40,
    }),
  },
  {
    id: "webOutput",
    category: "digital",
    setup: () => ({
      widthPt: 1440,
      heightPt: 900,
      pages: 1,
      unit: "px",
      bleedPt: 0,
      margins: { top: 48, bottom: 48, inside: 120, outside: 120 },
      columns: 12,
      gutterPt: 24,
    }),
  },
  {
    id: "marketingGraphic",
    category: "digital",
    setup: () => ({
      widthPt: 1080,
      heightPt: 1080,
      pages: 1,
      unit: "px",
      bleedPt: 0,
      margins: even(64),
      columns: 1,
      gutterPt: 24,
    }),
  },
  // Structured
  {
    id: "catalog",
    category: "structured",
    setup: (f) => {
      const [w, h] = paper(f);
      return {
        widthPt: w,
        heightPt: h,
        pages: 16,
        unit: paperUnit(f),
        bleedPt: mm(3),
        margins: even(f === "letter" ? inch(0.5) : mm(12)),
        columns: 3,
        gutterPt: mm(4),
      };
    },
  },
  {
    id: "productSheet",
    category: "structured",
    setup: (f) => {
      const [w, h] = paper(f);
      return {
        widthPt: w,
        heightPt: h,
        pages: 2,
        unit: paperUnit(f),
        bleedPt: mm(3),
        margins: even(f === "letter" ? inch(0.6) : mm(15)),
        columns: 2,
        gutterPt: mm(6),
      };
    },
  },
  {
    id: "variableData",
    category: "structured",
    setup: (f) => {
      const [w, h] = paper(f);
      return {
        widthPt: w,
        heightPt: h,
        pages: 1,
        unit: paperUnit(f),
        bleedPt: 0,
        margins: even(f === "letter" ? inch(0.5) : mm(12.7)),
        columns: 1,
        gutterPt: mm(5),
      };
    },
  },
];

export function presetById(id: PresetId): PresetDefinition | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function presetsIn(
  category: PresetCategory,
): readonly PresetDefinition[] {
  return PRESETS.filter((p) => p.category === category);
}

/** The setup a preset fills in. */
export function setupOfPreset(
  id: PresetId,
  family: PaperFamily,
): NewDocumentSetup {
  const preset = presetById(id);
  if (!preset) return defaultSetup(family);
  return { preset: id, ...preset.setup(family) };
}

/** Regions that print on Letter (North America and the Philippines). */
const LETTER_REGIONS = new Set(["US", "CA", "MX", "PH"]);

/** Letter where the reader's locale prints on it, A4 elsewhere. */
export function paperFamilyOf(locale: string | undefined): PaperFamily {
  if (!locale) return "a4";
  let region: string | undefined;
  try {
    region = new Intl.Locale(locale).maximize().region;
  } catch {
    region = /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase();
  }
  return region && LETTER_REGIONS.has(region) ? "letter" : "a4";
}

/** The setup the dialog starts from with nothing remembered: one page of
 *  the locale's paper, half-inch (12.7 mm) margins, one column. */
export function defaultSetup(family: PaperFamily): NewDocumentSetup {
  const [w, h] = paper(family);
  return {
    preset: "custom",
    widthPt: w,
    heightPt: h,
    pages: 1,
    unit: paperUnit(family),
    bleedPt: 0,
    margins: even(inch(0.5)),
    columns: 1,
    gutterPt: mm(5),
  };
}

/** The category a setup belongs to (its preset's, or Custom). */
export function categoryOf(setup: NewDocumentSetup): PresetCategory {
  if (setup.preset === "custom") return "custom";
  return presetById(setup.preset)?.category ?? "custom";
}

export type Orientation = "portrait" | "landscape";

export function orientationOf(setup: NewDocumentSetup): Orientation {
  return setup.widthPt > setup.heightPt ? "landscape" : "portrait";
}

/** The setup turned to `orientation` (width and height swapped when it is
 *  not already so; a square page stays). The margins turn with it. */
export function withOrientation(
  setup: NewDocumentSetup,
  orientation: Orientation,
): NewDocumentSetup {
  if (orientationOf(setup) === orientation) return setup;
  if (setup.widthPt === setup.heightPt) return setup;
  const m = setup.margins;
  return {
    ...setup,
    widthPt: setup.heightPt,
    heightPt: setup.widthPt,
    margins: {
      top: m.inside,
      bottom: m.outside,
      inside: m.top,
      outside: m.bottom,
    },
  };
}

// ------------------------------------------------------------ validation

/** The largest page the engine's IDML takes, as InDesign does: 216 in. */
export const MAX_PAGE_PT = 15552;
/** The most pages the dialog makes at once. */
export const MAX_PAGES = 999;
/** InDesign's largest bleed: 6 in. */
export const MAX_BLEED_PT = 432;
/** The engine's column count range (`pageColumnCount`, 1..=216). */
export const MAX_COLUMNS = 216;

/** A field the setup has a problem with. */
export type SetupField =
  | "width"
  | "height"
  | "pages"
  | "bleed"
  | "marginsVertical"
  | "marginsHorizontal"
  | "columns"
  | "gutter";

/** Why a field cannot be created as it is (a message key's suffix). */
export type SetupProblem =
  | "sizeRange"
  | "pagesRange"
  | "bleedRange"
  | "marginsTooTall"
  | "marginsTooWide"
  | "columnsRange"
  | "columnsTooNarrow";

export type SetupProblems = Partial<Record<SetupField, SetupProblem>>;

const finite = (n: number) => Number.isFinite(n);

/** What keeps `setup` from being created; empty when it can be. */
export function validateSetup(setup: NewDocumentSetup): SetupProblems {
  const out: SetupProblems = {};
  const size = (n: number) => finite(n) && n >= 1 && n <= MAX_PAGE_PT;
  if (!size(setup.widthPt)) out.width = "sizeRange";
  if (!size(setup.heightPt)) out.height = "sizeRange";
  if (
    !Number.isInteger(setup.pages) ||
    setup.pages < 1 ||
    setup.pages > MAX_PAGES
  )
    out.pages = "pagesRange";
  if (
    !finite(setup.bleedPt) ||
    setup.bleedPt < 0 ||
    setup.bleedPt > MAX_BLEED_PT
  )
    out.bleed = "bleedRange";
  const m = setup.margins;
  const nonNegative = [m.top, m.bottom, m.inside, m.outside].every(
    (v) => finite(v) && v >= 0,
  );
  if (!nonNegative || m.top + m.bottom >= setup.heightPt)
    out.marginsVertical = "marginsTooTall";
  if (!nonNegative || m.inside + m.outside >= setup.widthPt)
    out.marginsHorizontal = "marginsTooWide";
  if (
    !Number.isInteger(setup.columns) ||
    setup.columns < 1 ||
    setup.columns > MAX_COLUMNS
  )
    out.columns = "columnsRange";
  else if (
    !finite(setup.gutterPt) ||
    setup.gutterPt < 0 ||
    columnWidth(setup) <= 0
  )
    out.gutter = "columnsTooNarrow";
  return out;
}

export function isValidSetup(setup: NewDocumentSetup): boolean {
  return Object.keys(validateSetup(setup)).length === 0;
}

/** The width of one column, in points. */
export function columnWidth(setup: NewDocumentSetup): number {
  const live = setup.widthPt - setup.margins.inside - setup.margins.outside;
  return (live - (setup.columns - 1) * setup.gutterPt) / setup.columns;
}

// --------------------------------------------------------- stored shape

const UNITS: readonly LengthUnit[] = ["pt", "pc", "in", "mm", "cm", "px"];
const PRESET_IDS = new Set<string>(PRESETS.map((p) => p.id));

/** The stored setup, field by field: a field that is not what the setup
 *  allows reads as `fallback`'s (ADR 247). Null when nothing usable is
 *  stored. */
export function readStoredSetup(
  raw: unknown,
  fallback: NewDocumentSetup,
): NewDocumentSetup | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const m =
    typeof r.margins === "object" && r.margins !== null
      ? (r.margins as Record<string, unknown>)
      : {};
  const setup: NewDocumentSetup = {
    preset:
      typeof r.preset === "string" &&
      (PRESET_IDS.has(r.preset) || r.preset === "custom")
        ? (r.preset as PresetId | "custom")
        : fallback.preset,
    widthPt: num(r.widthPt, fallback.widthPt),
    heightPt: num(r.heightPt, fallback.heightPt),
    pages: num(r.pages, fallback.pages),
    unit:
      typeof r.unit === "string" &&
      (UNITS as readonly string[]).includes(r.unit)
        ? (r.unit as LengthUnit)
        : fallback.unit,
    bleedPt: num(r.bleedPt, fallback.bleedPt),
    margins: {
      top: num(m.top, fallback.margins.top),
      bottom: num(m.bottom, fallback.margins.bottom),
      inside: num(m.inside, fallback.margins.inside),
      outside: num(m.outside, fallback.margins.outside),
    },
    columns: num(r.columns, fallback.columns),
    gutterPt: num(r.gutterPt, fallback.gutterPt),
  };
  const facing =
    typeof r.facingPages === "boolean"
      ? r.facingPages
      : fallback.facingPages === true;
  if (facing) setup.facingPages = true;
  // A stored setup that cannot be created is not offered back.
  return isValidSetup(setup) ? setup : null;
}

/** A command payload as a setup (`paged.file.new` with a setup creates it
 *  without the dialog: scripts, embeds). Only `widthPt` and `heightPt` are
 *  required; the rest default to one page, no bleed, no margins, one
 *  column. Null when it is no setup or one that cannot be created. */
export function setupFromPayload(payload: unknown): NewDocumentSetup | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.widthPt !== "number" || typeof p.heightPt !== "number")
    return null;
  const base: NewDocumentSetup = {
    preset: "custom",
    widthPt: p.widthPt,
    heightPt: p.heightPt,
    pages: 1,
    unit: "pt",
    bleedPt: 0,
    margins: even(0),
    columns: 1,
    gutterPt: 12,
  };
  return readStoredSetup({ ...base, ...p }, base);
}

// -------------------------------------------------------------- preview

export interface PreviewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The miniature's geometry, in the preview's own units: the bleed box,
 *  the page, the margin box and each column, fitted into `box`. */
export interface PreviewGeometry {
  width: number;
  height: number;
  bleed: PreviewRect | null;
  page: PreviewRect;
  margins: PreviewRect;
  columns: PreviewRect[];
  /** Facing pages: the left-hand page of the spread beside `page` (a
   *  right-hand page), with its margins mirrored (inside on its right). */
  facing: { page: PreviewRect; margins: PreviewRect } | null;
}

export function previewGeometry(
  setup: NewDocumentSetup,
  box: { width: number; height: number } = { width: 200, height: 150 },
): PreviewGeometry {
  const w = Math.max(1, setup.widthPt);
  const h = Math.max(1, setup.heightPt);
  const bleed = Math.max(0, setup.bleedPt);
  const pad = 6;
  // Facing pages show a spread: two pages wide.
  const spread = setup.facingPages === true;
  const across = spread ? 2 * w : w;
  const scale = Math.min(
    (box.width - 2 * pad) / (across + 2 * bleed),
    (box.height - 2 * pad) / (h + 2 * bleed),
  );
  const pw = w * scale;
  const ph = h * scale;
  const page: PreviewRect = {
    x: spread ? box.width / 2 : (box.width - pw) / 2,
    y: (box.height - ph) / 2,
    w: pw,
    h: ph,
  };
  const b = bleed * scale;
  const m = setup.margins;
  const margins: PreviewRect = {
    x: page.x + Math.max(0, m.inside) * scale,
    y: page.y + Math.max(0, m.top) * scale,
    w: Math.max(0, (w - m.inside - m.outside) * scale),
    h: Math.max(0, (h - m.top - m.bottom) * scale),
  };
  const columns: PreviewRect[] = [];
  const count = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(setup.columns)));
  const gutter = Math.max(0, setup.gutterPt) * scale;
  const colW = (margins.w - (count - 1) * gutter) / count;
  if (count > 1 && colW > 0)
    for (let i = 0; i < count; i++)
      columns.push({
        x: margins.x + i * (colW + gutter),
        y: margins.y,
        w: colW,
        h: margins.h,
      });
  const left: PreviewRect = { ...page, x: page.x - pw };
  return {
    width: box.width,
    height: box.height,
    bleed:
      b > 0
        ? spread
          ? { x: left.x - b, y: page.y - b, w: 2 * pw + 2 * b, h: ph + 2 * b }
          : { x: page.x - b, y: page.y - b, w: pw + 2 * b, h: ph + 2 * b }
        : null,
    page,
    margins,
    columns,
    facing: spread
      ? {
          page: left,
          margins: {
            ...margins,
            x: left.x + Math.max(0, m.outside) * scale,
          },
        }
      : null,
  };
}
