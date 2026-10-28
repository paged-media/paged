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
// frame of the chart is redrawn from it in one undo step. Esc throws the
// session's edits away. Export writes the chart part and its workbook.

import type { BundleHost, ElementId } from "@paged-media/plugin-api";

import {
  makeChartSurface,
  type ChartEditSession,
  type GridSheet,
} from "./chart-surface.js";
import {
  chartFrames,
  readIndex,
  redrawChart,
  writeIndex,
  type ChartFrame,
} from "./charts-model.js";
import { liveCharts, type LiveCharts } from "./engine.js";

export const CHART_CONTEXT = "slideChart";
export const CHART_OBJECT_TYPE = "slideChart";

/** The source deck part the live charts are read from (activate.ts). */
const SOURCE_PART = "source/original.pptx";

/** The chart editing of one bundle activation. */
export class ChartEditing implements ChartEditSession {
  private frames: ChartFrame[] = [];
  private live: LiveCharts | null = null;
  private liveFor: Uint8Array | null = null;
  private part: string | null = null;
  private sheets: GridSheet[] | null = null;
  private dirty = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: BundleHost) {}

  // ── the surface's session ────────────────────────────────────────────

  readonly grid = (): GridSheet[] | null => this.sheets;

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  enter(sheet: string, row: number, col: number, input: string): boolean {
    if (!this.live || !this.part) return false;
    try {
      this.sheets = parseGrid(
        this.live.enter(this.part, sheet, row, col, input),
      );
      this.dirty = true;
      this.emit();
      return true;
    } catch (e) {
      this.host.log.warn(`paged.slide chart: ${String(e)}`);
      return false;
    }
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
    if (!this.host.supports("storage.parts@1")) return null;
    const source = await this.host.parts.read(SOURCE_PART);
    if (!source) return null;
    if (this.live && this.liveFor === source) return this.live;
    this.live?.free();
    this.live = await liveCharts(source);
    this.liveFor = source;
    return this.live;
  }

  /** Open the chart `part`'s workbook as the document holds it. */
  async open(part: string): Promise<boolean> {
    const live = await this.engine();
    if (!live) return false;
    const index = await readIndex(this.host);
    const entry = index?.charts[part];
    const bytes = entry ? await this.host.parts.read(entry.workbook) : null;
    try {
      this.sheets = parseGrid(
        live.open(part, bytes ?? undefined, entry?.origin ?? "embedded"),
      );
    } catch (e) {
      this.host.log.warn(`paged.slide chart ${part}: ${String(e)}`);
      return false;
    }
    this.part = part;
    this.dirty = false;
    this.emit();
    return true;
  }

  /** Keep the session's edits and redraw the chart. Answers the number of
   *  frames redrawn. */
  async commit(): Promise<number> {
    const part = this.part;
    const live = this.live;
    const changed = this.dirty;
    this.close();
    if (!part || !live || !changed) return 0;
    const index = (await readIndex(this.host)) ?? { v: 1 as const, charts: {} };
    const entry = index.charts[part] ?? {
      workbook: `charts/${(part.split("/").pop() ?? part).replace(/\.xml$/i, "")}.xlsx`,
      origin: "embedded" as const,
      edited: false,
    };
    await this.host.parts.write(entry.workbook, live.workbook(part));
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
    this.part = null;
    this.sheets = null;
    this.dirty = false;
    this.emit();
  }

  dispose() {
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
  if (!host.supports("contribute.editContext@1")) return out;
  const refresh = () => void editing.refresh();
  if (host.supports("document.onDidChange@1"))
    out.push(host.document.onDidChange(refresh).dispose);
  if (host.supports("document.onDidOpen@1"))
    out.push(host.document.onDidOpen(refresh).dispose);
  refresh();
  out.push(
    host.contribute.editContext({
      type: CHART_CONTEXT,
      entry: "doubleClick",
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
  if (host.supports("contribute.objectType@1")) {
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
  }
  if (host.supports("editContext.frameSurface@1")) {
    out.push(
      host.contribute.frameSurface({
        contextType: CHART_CONTEXT,
        render: makeChartSurface(editing, () =>
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
