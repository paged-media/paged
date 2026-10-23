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
// borders, column widths and row heights. Each change is the object
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
