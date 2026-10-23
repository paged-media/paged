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

// ADR 023 phase D — paged.sheet as the CHARACTER/PARAGRAPH binding
// provider: the VALUE axis, and the third proof consumer.
//
// WHY THIS SHAPE IS DIFFERENT FROM THE OTHER TWO, in one line each:
//
//   · Layers   — an element COLLECTION, addressed by ROW IDENTITY.
//   · Swatches — a DOCUMENT RESOURCE, addressed by NOTHING (
//                `readCollection` takes no target by construction).
//   · Character/Paragraph — SCALAR values addressed by a RANGE, whose
//                value over a multi-format selection is MIXED, not a
//                scalar. Neither of the other two can be mixed: a layer
//                row has one visibility, a swatch list is a list.
//
// WHY PAGED.SHEET AND NOT PAGED.DOC OR PAGED.IMAGE. The Swatches slice's
// standard was "a provider must serve something the plugin GENUINELY
// OWNS, not a contrived shim", and only one of the three named text
// candidates passes it:
//
//   · paged.doc LOWERS DOCX to native paged content (synthesized styles,
//     applyStyle-only). After a place, the runs ARE core runs in a core
//     story — core already answers the Character panel correctly, and
//     its `wordDocument` edit context deliberately leaves the caret to
//     the editor. A doc "text provider" would be a shim in front of the
//     right answer.
//   · paged.image has no text-layer model to read (PSD type layers are
//     not mutatable through its ABI today).
//   · paged.sheet OWNS cell text formatting outright — it lives in the
//     workbook's style table, in Rust, and never becomes core runs while
//     you are inside the frame. And it does not have to be TAUGHT core's
//     vocabulary: `sheet-host-model`'s `styleProps()` ALREADY maps a
//     `LoweredStyle` onto `characterFontStyle` / `characterFontFamily` /
//     `characterFontSize` / `characterFillColor`, from PRODUCTION code,
//     for the page lowering. This provider reads that same translation
//     from the other end. Same argument the ADR made for colour — the
//     work is already there, it has no surface — applied to text.
//
// WHAT IT SERVES WITH A VALUE: `characterFontFamily`,
// `characterFontStyle`, `characterFontSize`. Three paths, each one a
// genuine per-cell override in the workbook (the engine deliberately
// records size/name ONLY when they differ from the document default
// font — `sheet-xlsx` `visual_of`, the §8.3 "don't splatter ten thousand
// local overrides" ruling — so a value here is always a real authored
// choice, never a restated default).
//
// WHAT IT DECLARES AND ANSWERS `absent` FOR: EVERYTHING ELSE ON BOTH
// PANELS. This is the load-bearing decision of the whole slice, so it is
// worth stating why rather than leaving it to be discovered:
//
//   A cell has no leading, no tracking, no baseline shift, no drop cap,
//   no paragraph rule. The tempting move is to leave those paths OUT of
//   `provides.paths` and let them decline — but a decline FALLS THROUGH
//   TO CORE, and core's answer is the text caret's, which is
//   INDEPENDENT of the edit-context stack: entering a sheet frame does
//   not clear a caret left in a text frame two pages back. So the
//   Character panel would sit there, over a spreadsheet cell, showing
//   some unrelated paragraph's leading. That is precisely the
//   conflation `absent` exists for ("this provider OWNS the target, but
//   the path does not apply to it"), and owning the target requires
//   declaring the path. A provider that owns the selection owns the
//   whole panel surface.
//
//   `characterFillColor` is the interesting member of that set, and it
//   is `absent` for a DIFFERENT reason — one that survived the ground
//   moving under it. The cell's text colour IS known. Core resolves a
//   `colorRef` by SWATCH ID, and since `c321642` `styleProps` no longer
//   hands over the raw `#RRGGBB` (which named nothing and rendered as
//   the default text colour, silently) — it emits the DETERMINISTIC
//   MINTED id `palette.ts` owns. So the value is expressible now.
//
//   It still stays `absent`, because that commit also settled the other
//   half: the cell-text mint has NO DRIVER. Nothing applies
//   `StyleEmission`, so the id names a swatch the document does not
//   carry, and a colour chip for a swatch that does not exist is the
//   same lie one axis over — which is exactly what the SWATCHES slice
//   found from the other side, and marked
//   `data-swatch-preview="unresolved"` rather than paint a plausible
//   grey. When a driver lands and cell text colours become real document
//   swatches, this path moves from ABSENT_PATHS to VALUED_PATHS and
//   nothing else here changes.
//
// WHAT IT WRITES: NOTHING, and it SAYS SO — `writablePaths: []`.
//
//   The sheet engine has no cell-style write API. That is not an
//   oversight to route around in TypeScript: this repo's first rule is
//   that ALL spreadsheet semantics live in Rust, so a style write is a
//   `sheet-js` API and a Rust change, not a bundle change. Until it
//   exists, the honest surface is a read-only readout.
//
//   Declaring it is what makes it honest rather than merely true. Before
//   `provides.writablePaths` the host had no way to know: `writeProperty`
//   is a callback, and a callback's absence does not reach
//   `activeProviders()` — so the panel would have rendered editable
//   fields whose commits either silently failed or, worse, fell through
//   to core and landed on the text caret. That gap is what the VALUE
//   axis found that Layers and Swatches could not: both of those write
//   STRUCTURALLY, through `provides.ops`, which was declared all along.

import type { BundleHost } from "@paged-media/plugin-api";
import {
  styleProps,
  type LoweredContent,
  type LoweredStyle,
} from "../../../sheet-host-model/src";

import type {
  BindingProvider,
  BindingPropertyWrite,
  BindingRead,
  BindingTarget,
  BindingWrite,
  PropertyPath,
  Value,
} from "@paged-media/plugin-api";

import type { CellStylePatch, DocSwatch } from "../engine";

/** What the provider needs from the workbook session. Narrowed to two
 *  methods so it is unit-testable without an engine or a host, and so
 *  the session stays the only thing that talks to wasm. */
export interface CellTextSource {
  /** The (sheet, A1 range) the host's text panels are about — the cell
   *  selection, or the entered frame's whole projected range. */
  textSelectionRange(): { sheet: number; range: string } | null;
  /** Lower that range to the IR (the SAME call the page lowering makes;
   *  all geometry + style resolution decided in Rust). */
  lowerRange(sheet: number, range: string): LoweredContent | null;
  /** Sheet ADR 518 / P7 — write a style patch to the selected cells (one
   *  undo step). Absent: the provider is read-only. */
  applyStyle?(patch: CellStylePatch): { ok: boolean; message?: string };
  /** The document swatch `id` as a cell colour reference (its model and
   *  the sRGB an xlsx reader shows), or null when the document has none. */
  swatchRef?(id: string): Promise<DocSwatch | null>;
}

/**
 * The paths this provider answers with a VALUE. Order is the panel's,
 * not alphabetical — it reads as the Character panel's own top row.
 */
export const VALUED_PATHS: readonly PropertyPath[] = [
  "characterFontFamily",
  "characterFontStyle",
  "characterFontSize",
  // P7 (sheet ADR 518) — a cell's text colour as a document swatch, the
  // text decorations, its alignment, and the document styles it maps to.
  "characterFillColor",
  "characterUnderline",
  "characterStrikethru",
  "characterPosition",
  "paragraphJustification",
  "appliedCharacterStyle",
  "appliedParagraphStyle",
  "appliedCellStyle",
  // The fill/stroke control's container fill: inside an entered sheet
  // frame it is the selected cells' fill (a document swatch).
  "frameFillColor",
];

/** The paths a style write reaches (`CellTextSource.applyStyle`). */
export const WRITABLE_PATHS: readonly PropertyPath[] = VALUED_PATHS;

/**
 * The paths this provider OWNS but has nothing to say about. Every
 * remaining binding on the host Character and Paragraph panels — see
 * the module header for why silence here would be worse than a blank.
 */
export const ABSENT_PATHS: readonly PropertyPath[] = [
  // Character — modelled by core for a story run, not by a sheet cell.
  "characterLeading",
  "characterTracking",
  "characterKerningMethod",
  "characterBaselineShift",
  "characterHorizontalScale",
  "characterVerticalScale",
  "characterSkew",
  "characterCase",
  "characterLigatures",
  "characterLanguage",
  "characterOtfFeatures",
  // Paragraph — a cell has no paragraph at all.
  "paragraphLeftIndent",
  "paragraphRightIndent",
  "paragraphFirstLineIndent",
  "paragraphSpaceBefore",
  "paragraphSpaceAfter",
  "paragraphDropCapCharacters",
  "paragraphDropCapLines",
  "paragraphHyphenation",
  "paragraphKeepLinesTogether",
  "paragraphKeepWithNext",
  "paragraphRuleAbove",
  "paragraphRuleBelow",
];

export const SERVED_PATHS: readonly PropertyPath[] = [
  ...VALUED_PATHS,
  ...ABSENT_PATHS,
];

/** A cell's contribution to one path: the value it declares, or the
 *  `undefined` sentinel for "this cell declares no override". The two
 *  are kept apart through the collapse on purpose — see
 *  {@link collapseCells}. */
type CellValue = Value | undefined;

/**
 * Collapse the selected cells' values for one path into a read answer.
 *
 * THE MIXED RULE, stated rather than implied, because this is the axis
 * the whole consumer exists to test:
 *
 *   · every cell agrees on a value → that value;
 *   · they disagree → `mixed`. NEVER a winner, and never the first
 *     one — a Character panel that silently picks one of two font sizes
 *     is the failure ADR-023 names for this shape;
 *   · SOME declare and some do not → also `mixed`. A cell with no
 *     override inherits the workbook default, which is by construction
 *     NOT the value the other cell declared (the engine only records an
 *     override when it differs from the default). So they genuinely
 *     disagree, and rounding that to "18 pt" would be the same silent
 *     winner in a subtler costume;
 *   · nobody declares → `absent`, with the reason. Not `mixed`: there
 *     is nothing to disagree about. Not a fall-through either — the
 *     workbook default is a real answer to "what size is this cell",
 *     it is just not one paged.sheet models per cell, and core has no
 *     opinion about a spreadsheet.
 */
export function collapseCells(
  values: readonly CellValue[],
  path: PropertyPath,
): BindingRead {
  if (values.length === 0) {
    return { kind: "absent", reason: `no cells in range for "${path}"` };
  }
  if (values.every((v) => v === undefined)) {
    return {
      kind: "absent",
      reason:
        `no cell in the selection overrides "${path}" — the workbook ` +
        `default applies, and paged.sheet does not model it per cell`,
    };
  }
  const first = values[0];
  for (const v of values.slice(1)) {
    if (!sameValue(first, v)) return { kind: "mixed" };
  }
  // `first` is defined here: an all-undefined list returned above, and a
  // uniform list that reached here shares first's definedness.
  return { kind: "value", value: first as Value };
}

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.type !== b.type) return false;
  return JSON.stringify(a.value) === JSON.stringify(b.value);
}

/** The styles of every POPULATED cell in a lowered range, in row-major
 *  order. Empty cells are absent from the IR (it is sparse) and are
 *  skipped rather than counted as "no override": an empty cell has no
 *  text, so it has no text formatting to agree or disagree about. */
export function stylesOfRange(content: LoweredContent): LoweredStyle[] {
  const table = content.styles ?? [];
  const out: LoweredStyle[] = [];
  for (const row of content.rows) {
    for (const cell of row.cells) {
      const style = table[cell.styleKey ?? 0];
      if (style) out.push(style);
    }
  }
  return out;
}

/** One cell's value for `path`, via the SAME `styleProps` translation
 *  the page lowering uses. `undefined` ⇒ this cell declares no override
 *  for that path. */
export function cellValueOf(
  style: LoweredStyle,
  path: PropertyPath,
): CellValue {
  // P7 — the paths a document reference answers, read off the IR.
  switch (path) {
    case "characterFillColor":
      // Only a DOCUMENT swatch names a colour the document carries (a
      // plain workbook colour has no swatch until the page mints one).
      return style.textSwatch
        ? { type: "colorRef", value: style.textSwatch }
        : undefined;
    case "frameFillColor":
      return style.fillSwatch
        ? { type: "colorRef", value: style.fillSwatch }
        : undefined;
    case "characterStrikethru":
      return style.strike ? { type: "bool", value: true } : undefined;
    case "characterPosition":
      return style.vertAlign === "superscript"
        ? { type: "text", value: "Superscript" }
        : style.vertAlign === "subscript"
          ? { type: "text", value: "Subscript" }
          : undefined;
    case "paragraphJustification": {
      // Only an extended or explicit horizontal alignment is a style; the
      // plain left/right of "general" lives on the cell, not here.
      const h = style.hAlign;
      const j = h ? JUSTIFICATION_OF[h] : undefined;
      return j ? { type: "text", value: j } : undefined;
    }
    case "appliedCharacterStyle":
      return style.docCharStyle
        ? { type: "text", value: style.docCharStyle }
        : undefined;
    case "appliedParagraphStyle":
      return style.docParaStyle
        ? { type: "text", value: style.docParaStyle }
        : undefined;
    case "appliedCellStyle":
      return style.docCellStyle
        ? { type: "text", value: style.docCellStyle }
        : undefined;
  }
  const props = styleProps(style);
  return props.find((p) => p.path === path)?.value as CellValue;
}

/** A cell's horizontal alignment as a paragraph justification. */
const JUSTIFICATION_OF: Record<string, string> = {
  left: "LeftAlign",
  center: "CenterAlign",
  right: "RightAlign",
  justify: "FullyJustified",
  distributed: "FullyJustified",
};

/** A paragraph justification as a cell's horizontal alignment. */
function alignOfJustification(j: string): string {
  if (j === "CenterAlign" || j === "CenterJustified") return "center";
  if (j === "RightAlign" || j === "RightJustified") return "right";
  if (j === "LeftAlign" || j === "LeftJustified") return "left";
  if (j === "FullyJustified") return "justify";
  return "general";
}

/** The style patch one path's write means, or a refusal reason. */
export async function patchForWrite(
  path: PropertyPath,
  value: Value,
  swatchRef: ((id: string) => Promise<DocSwatch | null>) | undefined,
): Promise<CellStylePatch | string> {
  const text = value.type === "text" ? value.value : null;
  switch (path) {
    case "characterFontFamily":
      return text ? { fontName: text } : "a font family is text";
    case "characterFontStyle": {
      if (text === null) return "a font style is text";
      return {
        bold: /bold|black|heavy|semibold/i.test(text),
        italic: /italic|oblique/i.test(text),
      };
    }
    case "characterFontSize":
      return value.type === "length" && value.value && value.value > 0
        ? { fontSize: value.value }
        : "a font size is a positive length";
    case "characterUnderline":
      return value.type === "bool"
        ? { underline: value.value }
        : "underline is on or off";
    case "characterStrikethru":
      return value.type === "bool"
        ? { strike: value.value }
        : "strike-through is on or off";
    case "characterPosition":
      if (text === null) return "a position is text";
      return {
        vertAlign:
          text === "Superscript" || text === "OTSuperscript"
            ? "superscript"
            : text === "Subscript" || text === "OTSubscript"
              ? "subscript"
              : "baseline",
      };
    case "paragraphJustification":
      return text
        ? { hAlign: alignOfJustification(text) }
        : "a justification is text";
    case "characterFillColor": {
      if (value.type !== "colorRef") return "a text colour is a swatch";
      if (value.value === null) return { fontColor: "", fontSwatch: null };
      if (!swatchRef) return "the document's swatches cannot be read";
      const ref = await swatchRef(value.value);
      return ref
        ? { fontSwatch: ref }
        : `no swatch "${value.value}" in the document`;
    }
    case "frameFillColor": {
      if (value.type !== "colorRef") return "a cell fill is a swatch";
      if (value.value === null) return { fill: "", fillSwatch: null };
      if (!swatchRef) return "the document's swatches cannot be read";
      const ref = await swatchRef(value.value);
      return ref
        ? { fillSwatch: ref }
        : `no swatch "${value.value}" in the document`;
    }
    case "appliedCharacterStyle":
      return text !== null ? { docCharStyle: text } : "a style is named by id";
    case "appliedParagraphStyle":
      return text !== null ? { docParaStyle: text } : "a style is named by id";
    case "appliedCellStyle":
      return text !== null ? { docCellStyle: text } : "a style is named by id";
  }
  return `a spreadsheet cell has no "${path}" to write`;
}

export interface TextBindingProvider {
  provider: BindingProvider;
  /** The range last read — exposed for conformance, not for the host. */
  lastRange(): string | null;
}

/**
 * Build the Character/Paragraph provider for the `sheet` edit context.
 *
 * Lifetime is BORROWED from that context (phase A wraps its
 * `onEnter`/`onExit`), exactly like the Swatches one: there is no
 * `enter`/`exit` here and there must not be, because a second notion of
 * "who is active" is the drift the borrow exists to prevent.
 */
export function makeTextBindingProvider(
  host: BundleHost,
  source: CellTextSource,
): TextBindingProvider {
  let lastRange: string | null = null;

  /** The selected cells' styles, or `null` when there is nothing to
   *  read (no workbook, no lowered range, a lowering that threw). */
  const selectedStyles = (): LoweredStyle[] | null => {
    const sel = source.textSelectionRange();
    if (!sel) {
      lastRange = null;
      return null;
    }
    lastRange = sel.range;
    let content: LoweredContent | null;
    try {
      content = source.lowerRange(sel.sheet, sel.range);
    } catch (err) {
      host.log.warn("text provider: lower read failed", err);
      return null;
    }
    if (!content) return null;
    return stylesOfRange(content);
  };

  const provider: BindingProvider = {
    provides: {
      paths: SERVED_PATHS,
      // P7 — with a style write door (sheet ADR 518 `setStyle`) the
      // valued paths write the selected cells; without one the provider
      // stays a read-only readout and says so.
      writablePaths: source.applyStyle ? WRITABLE_PATHS : [],
    },

    readProperty(request): BindingRead {
      const target: BindingTarget = request.target;
      // This provider answers for the SELECTION, in its own realm — it
      // knows which cells are picked, and the host never has to name a
      // thing it cannot address. A row- or element-scoped read belongs
      // to whoever owns that addressing.
      if (target.kind !== "selection") {
        return { kind: "decline", reason: "selection-scoped provider" };
      }
      const styles = selectedStyles();
      if (styles === null) {
        // A DECLINE, not `absent`. The distinction matters: `absent`
        // claims the target, and with no workbook loaded or nothing
        // lowered there is no cell here to claim. Core is then the
        // truthful answer — which, inside a sheet context with no core
        // content selection, is an honestly empty panel.
        return {
          kind: "decline",
          reason: "no workbook / no lowered range to read",
        };
      }
      if (!VALUED_PATHS.includes(request.path)) {
        // Declared, owned, and nothing to say. NOT a decline — see the
        // module header; a decline here shows the text caret's value
        // over a spreadsheet cell.
        return {
          kind: "absent",
          reason: `a spreadsheet cell has no "${request.path}"`,
        };
      }
      return collapseCells(
        styles.map((s) => cellValueOf(s, request.path)),
        request.path,
      );
    },

    async writeProperty(request: BindingPropertyWrite): Promise<BindingWrite> {
      if (request.target.kind !== "selection") {
        return { kind: "decline", reason: "selection-scoped provider" };
      }
      if (!source.applyStyle || !WRITABLE_PATHS.includes(request.path)) {
        return {
          kind: "applied",
          outcome: {
            applied: false,
            error: `a spreadsheet cell has no writable "${request.path}"`,
          },
        };
      }
      const patch = await patchForWrite(
        request.path,
        request.value,
        source.swatchRef,
      );
      if (typeof patch === "string") {
        return { kind: "applied", outcome: { applied: false, error: patch } };
      }
      const r = source.applyStyle(patch);
      return {
        kind: "applied",
        outcome: r.ok
          ? { applied: true, createdId: null, pageIds: [] }
          : {
              applied: false,
              error: r.message ?? "the style write was refused",
            },
      };
    },
  };

  return { provider, lastRange: () => lastRange };
}
