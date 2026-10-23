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

// paged.sheet's typed commands for what the panels do and the CLI, the SDK
// and scripts could not (plan G4): delimited text as a workbook, merges,
// borders, column widths and row heights, and placing a range, a defined
// name or a sheet's print area on the page, in one frame or across a frame
// chain. Each change is the object
// model's versioned write (`commandWrite`): applied in the engine, saved as
// a workbook version, ONE document undo step. All spreadsheet semantics are
// the engine's (`merge`, `setStyle`'s border edges, `setColWidth`,
// `setRowHeight`); this file only names them.

import type {
  BundleHost,
  Disposable,
  StructField,
  TypedCommandContribution,
  ValueType,
} from "@paged-media/plugin-api";

import type { ResolvedRange, SheetEngine } from "./engine";
import {
  PLUGIN_ID,
  WORKBOOK_ADDRESS,
  type SheetObjectModel,
} from "./object-model";
import type { WorkbookSession } from "./session";

const C = (s: string) => `${PLUGIN_ID}.command.${s}`;
const text: ValueType = { kind: "text" };
const int: ValueType = { kind: "number", integer: true };
const num: ValueType = { kind: "number" };
const bool: ValueType = { kind: "bool" };
/** The CSV export's delimiters (`tab` for a tab). */
const CSV_DELIMITERS = [",", ";", "tab"] as const;
const struct = (fields: Record<string, StructField>): ValueType => ({
  kind: "struct",
  fields,
});
const dflt = (type: ValueType, d: unknown): StructField => ({
  ...type,
  default: d,
});
const optional = (type: ValueType): StructField => ({
  ...type,
  optional: true,
});

/** The border edges `setBorders` takes; `outline` is the four outer edges
 *  of the range, `all` every cell's four. */
export const BORDER_EDGES = [
  "all",
  "outline",
  "top",
  "right",
  "bottom",
  "left",
] as const;

/** What `place` puts on the page: an A1 range (`Sheet!A1:B9`), a defined
 *  name or table (the placement keeps the NAME, so a redefinition moves
 *  it), or a sheet's print area (`ref` is the sheet's name). */
export const PLACE_SOURCES = ["range", "name", "printArea"] as const;

/** How `place` sizes a single frame (plan G4): `window` — a window onto
 *  the sheet the size of the range in sheet tracks (the default); `fixed` —
 *  a window filling the `box` the caller gives; `fit` — the earlier fixed
 *  range with text-measured column widths. */
export const PLACE_SIZINGS = ["window", "fixed", "fit"] as const;

/** The built-in defined name a sheet's print area is stored under. */
const PRINT_AREA = "_xlnm.Print_Area";

/** `textFrame:<id>` (what `place` and `lowerToFrame` answer) or a bare id. */
const frameIdOf = (ref: string): string =>
  ref.startsWith("textFrame:") ? ref.slice("textFrame:".length) : ref;

/** Resolve `Sheet!A1:B2` (or a defined name) through the engine. */
function resolveRange(engine: SheetEngine, ref: string): ResolvedRange {
  const bang = ref.lastIndexOf("!");
  let sheetName = bang > 0 ? ref.slice(0, bang) : null;
  if (sheetName?.startsWith("'") && sheetName.endsWith("'"))
    sheetName = sheetName.slice(1, -1).replace(/''/g, "'");
  const sheets = engine.listSheets();
  const sheet =
    sheetName === null
      ? sheets[0]
      : sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase());
  if (!sheet) throw new Error(`invalidValue: no sheet in "${ref}"`);
  if (!engine.resolveRange)
    throw new Error("engine wasm predates resolve_range");
  return engine.resolveRange(sheet.id, bang > 0 ? ref.slice(bang + 1) : ref);
}

function sheetIdOf(engine: SheetEngine, name: string): number {
  const s = engine
    .listSheets()
    .find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) throw new Error(`invalidValue: no sheet named "${name}"`);
  return s.id;
}

const A1 = (row: number, col: number): string => {
  let n = col;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `${label}${row + 1}`;
};

/** The commands, for the manifest spec (no engine needed). */
export function layoutCommands(
  session: WorkbookSession,
  model: SheetObjectModel,
): TypedCommandContribution[] {
  const write = (
    apply: (e: SheetEngine, touched: (r: ResolvedRange) => void) => void,
  ) => model.commandWrite(apply);

  const size = (
    id: string,
    title: string,
    axis: "column" | "row",
  ): TypedCommandContribution => ({
    id: C(id),
    title,
    args: struct({
      sheet: text,
      first: int,
      last: optional(int),
      size: optional(num),
    }),
    async handler(_ctx, a) {
      const { sheet, first, last, size } = a as {
        sheet: string;
        first: number;
        last?: number;
        size?: number;
      };
      if (first < 0 || (last !== undefined && last < first))
        throw new Error(`invalidValue: ${axis}s ${first}..${last}`);
      if (size !== undefined && !(size > 0))
        throw new Error(`invalidValue: a ${axis} size must be above 0`);
      await write((e) => {
        const sid = sheetIdOf(e, sheet);
        if (axis === "column") {
          if (!e.setColWidth)
            throw new Error("engine wasm predates set_col_width");
          e.setColWidth(sid, first, last ?? first, size ?? null);
        } else {
          if (!e.setRowHeight)
            throw new Error("engine wasm predates set_row_height");
          e.setRowHeight(sid, first, last ?? first, size ?? null);
        }
      });
    },
  });

  return [
    {
      id: C("place"),
      title: "Place on the page",
      args: struct({
        source: dflt({ kind: "enum", members: PLACE_SOURCES }, "range"),
        ref: text,
        chain: optional(text),
        repeatHeaderRows: dflt(int, 0),
        sizing: dflt({ kind: "enum", members: PLACE_SIZINGS }, "window"),
        box: optional(struct({ width: num, height: num })),
        view: optional(
          struct({ topLeft: optional(text), lock: dflt(bool, false) }),
        ),
        print: optional(
          struct({ headings: dflt(bool, false), gridlines: dflt(bool, false) }),
        ),
      }),
      result: struct({ frame: text, frames: { kind: "list", of: text } }),
      async handler(_ctx, a) {
        const {
          source,
          ref,
          chain,
          repeatHeaderRows,
          sizing,
          box,
          view,
          print,
        } = a as {
          source: (typeof PLACE_SOURCES)[number];
          ref: string;
          chain?: string;
          repeatHeaderRows: number;
          sizing: (typeof PLACE_SIZINGS)[number];
          box?: { width: number; height: number };
          view?: { topLeft?: string; lock: boolean };
          print?: { headings: boolean; gridlines: boolean };
        };
        if (!(repeatHeaderRows >= 0))
          throw new Error("invalidValue: repeatHeaderRows must be 0 or more");
        // What a view needs, checked before anything is read or written.
        if (sizing === "fixed" && !(box && box.width > 0 && box.height > 0))
          throw new Error(
            "invalidValue: sizing fixed needs a box with a width and height above 0",
          );
        if (sizing !== "fixed" && box)
          throw new Error('invalidValue: a box is given with sizing "fixed"');
        const printing = !!(print?.headings || print?.gridlines);
        const viewing = !!(view?.topLeft || view?.lock);
        if (sizing === "fit" && (printing || viewing))
          throw new Error(
            'invalidValue: sizing "fit" places a fixed range; a view and print options need "window" or "fixed"',
          );
        if (chain !== undefined && (printing || viewing || sizing !== "window"))
          throw new Error(
            "invalidValue: a chain paginates the range; a view, print options and sizing are for one frame",
          );
        if (source === "name" && (printing || viewing || sizing === "fixed"))
          throw new Error(
            "invalidValue: a defined name is placed by name; a view, print options and fixed sizing need a range or a print area",
          );
        const topLeft = view?.topLeft?.replaceAll("$", "").toUpperCase();
        if (
          topLeft !== undefined &&
          !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(topLeft)
        )
          throw new Error(
            `invalidValue: view topLeft "${view?.topLeft}" is not a cell`,
          );
        if (!(await session.ensureRestored()))
          throw new Error("no workbook is open");
        const e = session.state().engine;
        if (!e?.resolveRange)
          throw new Error("engine wasm predates resolve_range");
        // Which sheet and what ranges the placement binds; every name is
        // resolved by the engine (a print area of several ranges gives one
        // range per area, in the order it lists them).
        let sheet: number;
        let ranges: string[];
        if (source === "printArea") {
          sheet = sheetIdOf(e, ref);
          try {
            ranges = e.printAreas
              ? e.printAreas(sheet).map((r) => r.range)
              : [e.resolveRange(sheet, PRINT_AREA).range];
          } catch {
            throw new Error(`invalidValue: sheet "${ref}" has no print area`);
          }
          if (ranges.length === 0)
            throw new Error(`invalidValue: sheet "${ref}" has no print area`);
        } else if (source === "name") {
          if (ref.includes("!") || ref.includes(":"))
            throw new Error(`invalidValue: "${ref}" is a range, not a name`);
          try {
            sheet = e.resolveRange(e.listSheets()[0]?.id ?? 0, ref).sheet;
          } catch {
            throw new Error(`invalidValue: no defined name or table "${ref}"`);
          }
          ranges = [ref];
        } else {
          const r = resolveRange(e, ref);
          sheet = r.sheet;
          ranges = [r.range];
        }
        if (topLeft !== undefined && ranges.length > 1)
          throw new Error(
            "invalidValue: a print area of several ranges places each from its own top-left; a view topLeft is for one range",
          );
        session.setActiveSheet(sheet);
        session.setRange(ranges[0]!);
        if (chain === undefined) {
          // One table per range, in order, each in its own frame: the first
          // at the selection, each next one under the one before.
          const frames: string[] = [];
          for (const [i, range] of ranges.entries()) {
            session.setRange(range);
            const frame = await session.lowerSelection({
              sizing,
              ...(box
                ? { boxPt: { widthPt: box.width, heightPt: box.height } }
                : {}),
              ...(view
                ? { view: { ...view, ...(topLeft ? { topLeft } : {}) } }
                : {}),
              ...(print ? { print } : {}),
              below: i > 0,
            });
            if (!frame) throw new Error(`could not place ${ref}`);
            frames.push(`textFrame:${frame}`);
          }
          return { frame: frames[0]!, frames };
        }
        const frameId = frameIdOf(chain);
        const r = await session.paginateSelection({
          frameId,
          repeatHeaderRows,
          ...(ranges.length > 1 ? { areas: ranges } : {}),
        });
        if (!r.ok) throw new Error(`could not place ${ref}: ${r.message}`);
        return {
          frame: `textFrame:${frameId}`,
          frames: [`textFrame:${frameId}`],
        };
      },
    },
    {
      id: C("importCsv"),
      title: "Import delimited text (.csv, .tsv)",
      args: struct({ text, name: dflt(text, "data.csv") }),
      result: text,
      async handler(_ctx, a) {
        const { text: body, name } = a as { text: string; name: string };
        await session.importCsv(body, name);
        const e = session.state().engine;
        if (!e || e.listSheets().length === 0)
          throw new Error(`${name} could not be read as delimited text`);
        return WORKBOOK_ADDRESS;
      },
    },
    // Sheet ADR 521 — files and dialect.
    {
      id: C("importOds"),
      title: "Import OpenDocument spreadsheet (.ods)",
      args: struct({
        bytes: {
          kind: "bytes",
          mime: ["application/vnd.oasis.opendocument.spreadsheet"],
        },
        name: dflt(text, "workbook.ods"),
      }),
      result: text,
      async handler(_ctx, a) {
        const { bytes, name } = a as { bytes: Uint8Array; name: string };
        await session.importOds(bytes, name);
        const e = session.state().engine;
        if (!e || e.listSheets().length === 0)
          throw new Error(
            `${name} could not be read as an OpenDocument spreadsheet`,
          );
        return WORKBOOK_ADDRESS;
      },
    },
    {
      id: C("exportCsv"),
      title: "Export a sheet as CSV",
      args: struct({
        sheet: optional(text),
        range: optional(text),
        delimiter: dflt({ kind: "enum", members: CSV_DELIMITERS }, ","),
        formatted: dflt(bool, true),
        bom: dflt(bool, false),
      }),
      result: text,
      async handler(_ctx, a) {
        const { sheet, range, delimiter, formatted, bom } = a as {
          sheet?: string;
          range?: string;
          delimiter: string;
          formatted: boolean;
          bom: boolean;
        };
        await session.ensureRestored();
        const e = session.state().engine;
        if (!e) throw new Error("no workbook is open");
        if (!e.exportCsv) throw new Error("engine wasm predates export_csv");
        const id =
          sheet !== undefined
            ? sheetIdOf(e, sheet)
            : (session.state().activeSheet ?? e.listSheets()[0]?.id ?? 0);
        return e.exportCsv(id, {
          delimiter: delimiter === "tab" ? "\t" : delimiter,
          formatted,
          bom,
          range: range ?? "",
        });
      },
    },
    {
      id: C("toggleR1C1"),
      title: "R1C1 reference style",
      args: struct({ r1c1: optional(bool), lang: optional(text) }),
      result: struct({ r1c1: bool, lang: text }),
      async handler(_ctx, a) {
        const { r1c1, lang } = a as { r1c1?: boolean; lang?: string };
        await session.ensureRestored();
        const now = session.formulaDisplay();
        if (!now) throw new Error("no workbook is open");
        if (!session.setFormulaDisplay({ r1c1: r1c1 ?? !now.r1c1, lang }))
          throw new Error("engine wasm predates set_formula_display");
        return session.formulaDisplay() ?? now;
      },
    },
    {
      id: C("mergeCells"),
      title: "Merge cells",
      args: struct({ range: text }),
      async handler(_ctx, a) {
        const { range } = a as { range: string };
        await session.ensureRestored();
        await write((e, touched) => {
          if (!e.merge) throw new Error("engine wasm predates merge");
          const r = resolveRange(e, range);
          e.merge(r.sheet, r.range);
          touched(r);
        });
      },
    },
    {
      id: C("unmergeCells"),
      title: "Unmerge cells",
      args: struct({ range: text }),
      result: int,
      async handler(_ctx, a) {
        const { range } = a as { range: string };
        await session.ensureRestored();
        let removed = 0;
        await write((e, touched) => {
          if (!e.unmerge) throw new Error("engine wasm predates unmerge");
          const r = resolveRange(e, range);
          removed = e.unmerge(r.sheet, r.range);
          touched(r);
        });
        return removed;
      },
    },
    {
      id: C("setBorders"),
      title: "Set borders",
      args: struct({
        range: text,
        edges: dflt({ kind: "enum", members: BORDER_EDGES }, "all"),
        style: dflt(text, "thin"),
        color: optional(text),
      }),
      async handler(_ctx, a) {
        const { range, edges, style, color } = a as {
          range: string;
          edges: (typeof BORDER_EDGES)[number];
          style: string;
          color?: string;
        };
        await session.ensureRestored();
        const edge = { style, ...(color ? { color } : {}) };
        await write((e, touched) => {
          if (!e.setStyle) throw new Error("engine wasm predates set_style");
          const r = resolveRange(e, range);
          const set = (rng: string, sides: string[]) =>
            e.setStyle!(
              r.sheet,
              rng,
              Object.fromEntries(
                sides.map((s) => [
                  `border${s[0]!.toUpperCase()}${s.slice(1)}`,
                  edge,
                ]),
              ),
            );
          if (edges === "all") set(r.range, ["top", "right", "bottom", "left"]);
          else if (edges === "outline") {
            const row = (i: number) => `${A1(i, r.left)}:${A1(i, r.right)}`;
            const col = (j: number) => `${A1(r.top, j)}:${A1(r.bottom, j)}`;
            set(row(r.top), ["top"]);
            set(row(r.bottom), ["bottom"]);
            set(col(r.left), ["left"]);
            set(col(r.right), ["right"]);
          } else set(r.range, [edges]);
          touched(r);
        });
      },
    },
    size("setColumnWidth", "Set column width", "column"),
    size("setRowHeight", "Set row height", "row"),
  ];
}

export function contributeLayoutCommands(
  host: BundleHost,
  session: WorkbookSession,
  model: SheetObjectModel,
): Disposable {
  return host.contribute.objectModel({
    kinds: [],
    commands: layoutCommands(session, model),
  });
}
