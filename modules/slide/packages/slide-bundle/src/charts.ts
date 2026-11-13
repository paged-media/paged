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

// Live charts (slide ADR 715): a chart frame is entered like any content
// (double-click, the `slideChart` edit context), its workbook opens in the
// chart data sheet (the context's frame surface, which can go full screen),
// and when the user leaves, the workbook is kept in the document and every
// frame of the chart is redrawn from it in one undo step. Leaving keeps the
// session's edits whichever way the user leaves — Esc in the data sheet, Esc
// on the page, a press outside (editor ADR 1211: the context declares
// `commit-if-safe`); the one undo step takes them back. Export writes the
// chart part and its workbook.
//
// The data sheet is paged.sheet's grid and engine, reached through the
// workbook door (extensions ADR 1102, slide ADR 724 amendment 1): the
// chart's workbook bytes go over, the edited bytes come back. The slide
// wasm keeps reading the workbook (its chart book recalculates and draws
// the chart from it) but no longer edits it.

import type {
  BundleHost,
  ElementId,
  WorkbookEditSession,
  WorkbookRange,
} from "@paged-media/plugin-api";

import { t } from "@paged-media/strings";

import { makeChartDataSurface } from "./chart-data-surface.js";
import { PANELS } from "./messages.js";
import {
  chartFrames,
  readIndex,
  redrawChart,
  workbookPart,
  writeIndex,
  type ChartFrame,
  type ChartOrigin,
} from "./charts-model.js";
import { liveCharts, type LiveCharts } from "./engine.js";

export const CHART_CONTEXT = "slideChart";
export const CHART_OBJECT_TYPE = "slideChart";

/** The source deck part the live charts are read from (activate.ts). */
const SOURCE_PART = "source/original.pptx";

/** One sheet of a chart's workbook as the slide wasm reads it: the cells
 *  and the blocks the chart's series read (`[r0, c0, r1, c1]`). */
export interface GridSheet {
  name: string;
  rows: number;
  cols: number;
  cells: { row: number; col: number; text: string; input: string }[];
  bound: [number, number, number, number][];
}

/** Why no data sheet is shown for the chart being entered. */
export type ChartEditProblem = "noEditor" | "failed";

/** The ranges the chart reads, by role, for the workbook editor's tints:
 *  a single cell names a series, the first column's blocks are the
 *  categories, the rest values (PowerPoint's colours). */
export function rangesOf(sheets: readonly GridSheet[]): WorkbookRange[] {
  const out: WorkbookRange[] = [];
  for (const sheet of sheets) {
    for (const [r0, c0, r1, c1] of sheet.bound) {
      const firstCol = sheet.bound.every(([, bc0]) => c0 <= bc0);
      out.push({
        sheet: sheet.name,
        startRow: r0,
        startCol: c0,
        endRow: r1,
        endCol: c1,
        role:
          r0 === r1 && c0 === c1
            ? "name"
            : firstCol && c0 === 0
              ? "category"
              : "value",
      });
    }
  }
  return out;
}

/** The chart editing of one bundle activation. */
export class ChartEditing {
  private frames: ChartFrame[] = [];
  private live: LiveCharts | null = null;
  private liveFor: Uint8Array | null = null;
  private part: string | null = null;
  private origin: ChartOrigin = "embedded";
  private open_: WorkbookEditSession | null = null;
  private problem_: ChartEditProblem | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: BundleHost) {}

  // ── what the surface shows ──────────────────────────────────────────

  /** The chart's workbook open in the workbook editor, or null. */
  readonly session = (): WorkbookEditSession | null => this.open_;

  /** Why no workbook editor is open for the chart being entered. */
  readonly problem = (): ChartEditProblem | null => this.problem_;

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of [...this.listeners]) l();
  }

  // ── which page items are charts ─────────────────────────────────────

  /** Re-read the chart frames on the pages (after a document change). */
  async refresh(): Promise<void> {
    try {
      this.frames = await chartFrames(this.host);
    } catch {
      this.frames = [];
    }
  }

  /** The chart frame an element is, or is inside of. */
  frameOf(id: string, groupChain: readonly string[] = []): ChartFrame | null {
    return (
      this.frames.find(
        (f) =>
          f.groupId === id ||
          f.members.some((m) => m.id === id) ||
          groupChain.includes(f.groupId),
      ) ?? null
    );
  }

  // ── a session ───────────────────────────────────────────────────────

  private async engine(): Promise<LiveCharts | null> {
    const source = await this.host.parts.read(SOURCE_PART);
    if (!source) return null;
    if (this.live && this.liveFor === source) return this.live;
    this.live?.free();
    this.live = await liveCharts(source);
    this.liveFor = source;
    return this.live;
  }

  private fail(problem: ChartEditProblem, why?: unknown): false {
    if (why !== undefined)
      this.host.log.warn(`paged.slide chart: ${String(why)}`);
    this.problem_ = problem;
    this.emit();
    return false;
  }

  /** Open the chart `part`'s workbook, as the document holds it, in the
   *  workbook editor. */
  async open(part: string): Promise<boolean> {
    this.close();
    const live = await this.engine();
    if (!live) return this.fail("failed");
    const index = await readIndex(this.host);
    const entry = index?.charts[part];
    const stored = entry ? await this.host.parts.read(entry.workbook) : null;
    const origin = entry?.origin ?? "embedded";
    let sheets: GridSheet[];
    let xlsx: Uint8Array;
    try {
      sheets = parseGrid(live.open(part, stored ?? undefined, origin));
      xlsx = stored ?? live.workbook(part);
    } catch (e) {
      return this.fail("failed", `${part}: ${String(e)}`);
    }
    if (!this.host.supports("workbooks@1") || !this.host.workbooks.available())
      return this.fail("noEditor");
    let session: WorkbookEditSession;
    try {
      session = await this.host.workbooks.open({
        xlsx,
        name: workbookPart(part).split("/").pop(),
        ranges: rangesOf(sheets),
      });
    } catch (e) {
      return this.fail("failed", `${part}: ${String(e)}`);
    }
    this.part = part;
    this.origin = origin;
    this.open_ = session;
    this.emit();
    return true;
  }

  /** Keep the session's edits and redraw the chart. Answers the number of
   *  frames redrawn (none when nothing changed: the document and the
   *  chart's parts stay as they were). */
  async commit(): Promise<number> {
    const part = this.part;
    const live = this.live;
    const session = this.open_;
    const origin = this.origin;
    const bytes = session?.changed() ? session.xlsx() : null;
    this.close();
    if (!part || !live || !bytes) return 0;
    // The chart book reads the edited workbook (recalculated in the slide
    // wasm) before the chart is drawn from it.
    live.open(part, bytes, origin);
    const index = (await readIndex(this.host)) ?? { v: 1 as const, charts: {} };
    const entry = index.charts[part] ?? {
      workbook: workbookPart(part),
      origin,
      edited: false,
    };
    await this.host.parts.write(entry.workbook, bytes);
    index.charts[part] = { ...entry, edited: true };
    await writeIndex(this.host, index);
    const n = await redrawChart(this.host, live, part);
    await this.refresh();
    return n;
  }

  /** Throw the session's edits away. */
  cancel(): void {
    this.close();
  }

  private close() {
    this.open_?.close();
    this.open_ = null;
    this.part = null;
    this.problem_ = null;
    this.emit();
  }

  dispose() {
    this.close();
    this.live?.free();
    this.live = null;
    this.listeners.clear();
  }
}

export function parseGrid(json: string): GridSheet[] {
  return (JSON.parse(json) as { sheets: GridSheet[] }).sheets;
}

/** Register the chart context, its object type and its surface. */
export function contributeCharts(
  host: BundleHost,
  editing: ChartEditing,
): Array<() => void> {
  const out: Array<() => void> = [];
  const refresh = () => void editing.refresh();
  out.push(host.document.onDidChange(refresh).dispose);
  out.push(host.document.onDidOpen(refresh).dispose);
  refresh();
  out.push(
    host.contribute.editContext({
      type: CHART_CONTEXT,
      entry: "doubleClick",
      // Extensions ADR 1106 — the breadcrumb's name (F-45) and how the host
      // leaves: the edits are kept as one undo step (see the header).
      label: t(PANELS.chart),
      exitPolicy: "commit-if-safe",
      matches: (c) =>
        editing.frameOf(
          (c.id as unknown as { id: string }).id,
          c.groupChain,
        ) !== null,
      onEnter: (ctx) => {
        const id = (ctx.id as unknown as { id: string }).id;
        const frame = editing.frameOf(id);
        if (!frame) return;
        void editing.open(frame.part);
      },
      onCommit: () => {
        void editing
          .commit()
          .catch((e: unknown) =>
            host.log.warn(`paged.slide chart redraw: ${String(e)}`),
          );
      },
      onCancel: () => editing.cancel(),
    }).dispose,
  );
  out.push(
    host.contribute.objectType({
      type: CHART_OBJECT_TYPE,
      matches: (c) =>
        editing.frameOf(
          (c.id as unknown as { id: string }).id,
          c.groupChain,
        ) !== null,
      editContextType: CHART_CONTEXT,
      bakedFallback: "group",
    }).dispose,
  );
  if (host.supports("editContext.frameSurface@1")) {
    out.push(
      host.contribute.frameSurface({
        contextType: CHART_CONTEXT,
        render: makeChartDataSurface(editing, () =>
          host.supports("editContext.frameSurface.fullscreen@1"),
        ),
      }).dispose,
    );
  }
  return out;
}

/** Enter the chart context on a chart frame without a pointer (the Edit
 *  Data command). */
export async function editChartData(
  host: BundleHost,
  editing: ChartEditing,
  elementId: string,
): Promise<boolean> {
  await editing.refresh();
  const frame = editing.frameOf(elementId);
  if (!frame || !host.supports("shell.enterEditContext@1")) return false;
  return host.shell.enterEditContext(CHART_CONTEXT, {
    kind: "group",
    id: frame.groupId,
  } as unknown as ElementId);
}
