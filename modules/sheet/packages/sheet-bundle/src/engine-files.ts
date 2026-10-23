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

// The engine doors of files and dialect (sheet ADR 521): the package kind
// (`.xlsx`, `.xlsm`, templates) and saving as another kind, the OpenDocument
// import, the CSV export and the formula display dialect (R1C1 references,
// localized function names). Every method forwards to a sheet-js wasm call
// (the Rust engine decides everything); the camelCase facade below is spread
// into `wrapEngine`'s. All methods are optional on the facade so a test fake
// or an older artifact without them stays a valid engine.

/** The CSV export options; every field is optional. */
export interface CsvExportOptions {
  /** `","` (default), `";"` or `"\t"`. */
  delimiter?: string;
  /** What the cells show (default) or their underlying values. */
  formatted?: boolean;
  /** Lead with a UTF-8 byte-order mark. */
  bom?: boolean;
  /** A range (`"B2:D9"`, a defined name); empty = the used range. */
  range?: string;
}

/** How formulas are shown and typed. */
export interface FormulaDisplay {
  /** R1C1 references (kept in the workbook). */
  r1c1: boolean;
  /** The function-name language: `"en"` or `"de"`. */
  lang: string;
}

/** The package kinds a workbook saves as. */
export type WorkbookKind = "xlsx" | "xlsm" | "xltx" | "xltm";

export interface SheetEngineFiles {
  /** The kind of the open workbook (a template opens as a workbook). */
  workbookKind?(): WorkbookKind;
  /** Whether the workbook carries a VBA project (kept, never run). */
  hasMacros?(): boolean;
  /** The workbook as `kind`; as `.xlsx` a macro workbook leaves its VBA
   *  project out (the open workbook keeps it). */
  saveAs?(kind: WorkbookKind): Uint8Array;
  /** Replace the workbook with an OpenDocument spreadsheet. */
  loadOds?(bytes: Uint8Array): void;
  /** The sheet (or `opts.range`) as CSV text. */
  exportCsv?(sheet: number, opts?: CsvExportOptions): string;
  formulaDisplay?(): FormulaDisplay;
  /** Show formulas in R1C1 and in the language of `langTag`. */
  setFormulaDisplay?(r1c1: boolean, langTag: string): void;
  /** Canonical input (`=SUM(A1,1.5)`) → the display dialect. */
  formulaToDisplay?(row: number, col: number, input: string): string;
  /** Display-dialect input → canonical input. */
  formulaFromDisplay?(row: number, col: number, input: string): string;
}

export interface SheetWasmEngineFiles {
  workbook_kind?(): string;
  has_macros?(): boolean;
  save_as?(ext: string): Uint8Array;
  load_ods?(bytes: Uint8Array): void;
  export_csv?(
    sheet: number,
    delimiter: string,
    formatted: boolean,
    bom: boolean,
    range: string,
  ): string;
  formula_display?(): FormulaDisplay;
  set_formula_display?(r1c1: boolean, langTag: string): void;
  formula_to_display?(row: number, col: number, input: string): string;
  formula_from_display?(row: number, col: number, input: string): string;
}

type Need = <K extends keyof SheetWasmEngineFiles>(
  k: K,
) => (...a: unknown[]) => unknown;

/** The files facade over a booted wasm engine. `need` throws a "rebuild the
 *  wasm" error for a door the loaded artifact predates; `tick` marks a
 *  workbook-changing call. */
export function wrapFiles(
  need: Need,
  tick: () => void,
): Required<SheetEngineFiles> {
  const read =
    <R>(k: keyof SheetWasmEngineFiles) =>
    (...a: unknown[]) =>
      need(k)(...a) as R;
  return {
    workbookKind: read<WorkbookKind>("workbook_kind"),
    hasMacros: read<boolean>("has_macros"),
    saveAs: read<Uint8Array>("save_as"),
    loadOds: (bytes) => {
      tick();
      need("load_ods")(bytes);
    },
    exportCsv: (sheet, opts) =>
      need("export_csv")(
        sheet,
        opts?.delimiter ?? ",",
        opts?.formatted ?? true,
        opts?.bom ?? false,
        opts?.range ?? "",
      ) as string,
    formulaDisplay: read<FormulaDisplay>("formula_display"),
    setFormulaDisplay: read<void>("set_formula_display"),
    formulaToDisplay: read<string>("formula_to_display"),
    formulaFromDisplay: read<string>("formula_from_display"),
  };
}

/** UTF-8 bytes of CSV text (the BOM, when asked, is part of the text). */
export function csvBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The CSV the Export menu writes: what the cells show, UTF-8 with a BOM
 *  (so Excel reads the encoding), and the list separator of the host
 *  language — `;` where `,` is the decimal sign, as Excel's own CSV save. */
export function defaultCsvOptions(
  lang: string = (typeof navigator !== "undefined" && navigator.language) ||
    "en",
): CsvExportOptions {
  const decimalComma = /^(de|fr|es|it|nl|pt|da|fi|sv|nb|pl|cs|ru)\b/i.test(
    lang,
  );
  return { delimiter: decimalComma ? ";" : ",", formatted: true, bom: true };
}
