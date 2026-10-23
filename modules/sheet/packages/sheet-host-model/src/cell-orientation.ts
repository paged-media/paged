// Cell rotation and diagonal borders on a NATIVE placed table (W2.2, sheet
// ADR 518). The engine resolves both per style; this turns them into page
// content:
//
// - ROTATION: a native cell rotates its text by its cell style's rotation
//   angle (0 / 90 / 180 / 270 — the table model's set). Excel's angles map
//   to the nearest of those (1–44° stays upright, 45–90° turns a quarter
//   counter-clockwise, 91–180 is clockwise by `value − 90`), each through a
//   cell style at a fixed id, minted with the read-first discipline and
//   applied by `appliedCellStyle`. Stacked text (255) needs none: the engine
//   already broke it into one character per line. A cell that maps to a
//   document cell style keeps that style instead.
// - DIAGONALS: a table cell has no diagonal stroke, so each diagonal is drawn
//   as a page line over its cell (the data-bar lane's geometry mapping: the
//   cell's column position and width in the native table), stroked in the
//   border's colour and weight.
//
// PURE: content in, mutations out.

import type { ElementId, Mutation, PageId } from "@paged-media/plugin-api";

import type { BorderLine, LoweredContent } from "./lowered";
import { columnOrder } from "./lower-to-table";
import { normalizePaletteHex, paletteSwatchId } from "./palette";

/** The table angle an Excel `textRotation` shows as (0 = upright). */
export function tableRotation(rotation: number | null | undefined): number {
  const r = rotation ?? 0;
  if (r <= 0 || r === 255 || r > 180) return 0;
  if (r <= 90) return r >= 45 ? 90 : 0;
  return r - 90 >= 45 ? 270 : 0;
}

/** The cell style id of a table rotation. */
export function rotationCellStyleId(angle: number): string {
  return `CellStyle/paged.sheet rotate ${angle}`;
}

/** Each populated cell's rotation cell style, keyed `row:col` at table
 *  positions (only cells that turn). */
function rotatedCells(content: LoweredContent): Map<string, number> {
  const styleByKey = new Map((content.styles ?? []).map((s) => [s.key, s]));
  const order = columnOrder(content);
  const out = new Map<string, number>();
  content.rows.forEach((row, r) => {
    for (const cell of row.cells) {
      const st = cell.styleKey ? styleByKey.get(cell.styleKey) : undefined;
      if (!st || st.docCellStyle) continue;
      const angle = tableRotation(st.rotation);
      const c = order.indexOf(cell.col);
      if (angle !== 0 && c >= 0) out.set(`${r}:${c}`, angle);
    }
  });
  return out;
}

/** Whether any cell turns (a caller skips the cell-style read otherwise). */
export function needsRotationStyles(content: LoweredContent): boolean {
  return rotatedCells(content).size > 0;
}

/** The rotation cell-style mints the content needs and the document lacks
 *  (`known === null`: the read failed — nothing is minted and nothing
 *  applied), then the `appliedCellStyle` per turning cell. */
export function cellRotationOps(
  content: LoweredContent,
  storyId: string,
  tableId: string,
  known: ReadonlySet<string> | null,
): Mutation[] {
  if (known === null) return [];
  const cells = rotatedCells(content);
  const ops: Mutation[] = [];
  for (const angle of new Set(cells.values())) {
    const id = rotationCellStyleId(angle);
    if (known.has(id)) continue;
    ops.push(
      {
        op: "createCellStyle",
        args: { selfId: id, name: `Sheet · rotate ${angle}°` },
      },
      {
        op: "setStyleProperty",
        args: {
          collection: "cell",
          styleId: id,
          path: "cellStyleRotationAngle",
          value: { type: "length", value: angle },
        },
      },
    );
  }
  for (const [key, angle] of cells) {
    const [row, col] = key.split(":").map(Number);
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: {
          kind: "tableCell",
          id: { story_id: storyId, table_id: tableId, row, col },
        },
        path: "appliedCellStyle",
        value: { type: "text", value: rotationCellStyleId(angle) },
      },
    });
  }
  return ops;
}

const CREATED_LINE: ElementId = { kind: "polygon", id: "$created" };

/** One diagonal to draw: its page-local endpoints and its line. */
export interface DiagonalLine {
  from: [number, number];
  to: [number, number];
  line: BorderLine;
}

/** The diagonals of a lowered region mapped onto the native table's
 *  geometry (`widths` in table order; rows keep their IR heights), in
 *  frame-content pt. */
export function tableDiagonals(
  content: LoweredContent,
  widths: readonly number[],
): DiagonalLine[] {
  const styleByKey = new Map((content.styles ?? []).map((s) => [s.key, s]));
  const order = columnOrder(content);
  const irW = new Map(content.cols.map((c) => [c.index, c.widthPt]));
  const xs: number[] = [0];
  order.forEach((m, i) => xs.push(xs[i] + (widths[i] ?? irW.get(m) ?? 0)));
  const out: DiagonalLine[] = [];
  let y = 0;
  for (const row of content.rows) {
    for (const cell of row.cells) {
      const st = cell.styleKey ? styleByKey.get(cell.styleKey) : undefined;
      const c = order.indexOf(cell.col);
      if (!st || c < 0) continue;
      const [x0, x1, y1] = [xs[c], xs[c + 1], y + row.heightPt];
      const up = st.borderLines?.diagonalUp;
      const down = st.borderLines?.diagonalDown;
      if (up) out.push({ from: [x0, y1], to: [x1, y], line: up });
      if (down) out.push({ from: [x0, y], to: [x1, y1], line: down });
    }
    y += row.heightPt;
  }
  return out;
}

/** The ops that draw a native table's diagonals on its page: per diagonal
 *  an open path, its stroke colour (a document swatch, or the `cellStroke`
 *  swatch the table's own mints created) and weight. `origin` is the
 *  frame's page-local top-left. */
export function tableDiagonalOps(
  content: LoweredContent,
  widths: readonly number[],
  pageId: PageId,
  origin: [number, number],
): Mutation[] {
  const [top, left] = origin;
  const ops: Mutation[] = [];
  for (const d of tableDiagonals(content, widths)) {
    const pt = (p: [number, number]): [number, number] => [
      left + p[0],
      top + p[1],
    ];
    const anchors = [pt(d.from), pt(d.to)].map((p) => ({
      anchor: p,
      left: p,
      right: p,
    }));
    ops.push({ op: "insertPath", args: { pageId, anchors, open: true } });
    const hex = normalizePaletteHex(d.line.rgb ?? "#000000");
    const ref =
      d.line.swatch ??
      (hex != null ? paletteSwatchId("cellStroke", hex) : null);
    if (ref != null)
      ops.push({
        op: "setElementProperty",
        args: {
          elementId: CREATED_LINE,
          path: "frameStrokeColor",
          value: { type: "colorRef", value: ref },
        },
      });
    ops.push({
      op: "setElementProperty",
      args: {
        elementId: CREATED_LINE,
        path: "frameStrokeWeight",
        value: { type: "length", value: d.line.weightPt },
      },
    });
  }
  return ops;
}
