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

// Live charts (slide ADR 715), the TypeScript half: where a deck
// document keeps its chart workbooks and which page items draw them. The
// workbooks themselves are paged.sheet's, in the slide wasm (slide-sheet):
// this file only stores them, finds the chart frames on the pages and swaps
// a redrawn frame in for the old one.
//
// Each chart part's workbook is a container part of its own,
// `charts/<chart file>.xlsx`: the deck's embedded workbook as imported, or
// the one made from the chart's cached values, and later the edited one.
// `charts/charts.json` indexes them by chart part with their origin and
// whether the document edited them (export rewrites only those).

import type {
  BundleHost,
  ElementId,
  MutationInput,
} from "@paged-media/plugin-api";

import { bytesToBase64 } from "@paged-media/helpers";

import type { ChartPlan, ChartReport, LiveCharts } from "./engine.js";
import { SLIDE_KEY, type PluginMetadataEntry } from "./slides-model.js";

export const CHARTS_INDEX_PART = "charts/charts.json";

export type ChartOrigin = "embedded" | "synthesized";

export interface ChartEntry {
  /** The container part holding the workbook. */
  workbook: string;
  origin: ChartOrigin;
  /** The document changed the workbook (export writes the chart). */
  edited: boolean;
}

export interface ChartsIndex {
  v: 1;
  charts: Record<string, ChartEntry>;
}

/** A chart part's workbook part: `ppt/charts/chart3.xml` → `charts/chart3.xlsx`. */
export function workbookPart(chartPart: string): string {
  const file = chartPart.split("/").pop() ?? chartPart;
  return `charts/${file.replace(/\.xml$/i, "")}.xlsx`;
}

/** The index and workbook parts an import writes, from its report. */
export function importedCharts(
  charts: readonly ChartReport[],
  workbooks: Uint8Array,
): { index: ChartsIndex; parts: [string, Uint8Array][] } {
  const index: ChartsIndex = { v: 1, charts: {} };
  const parts: [string, Uint8Array][] = [];
  for (const c of charts) {
    const part = workbookPart(c.part);
    index.charts[c.part] = { workbook: part, origin: c.origin, edited: false };
    parts.push([part, workbooks.slice(c.offset, c.offset + c.length)]);
  }
  return { index, parts };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function readIndex(host: BundleHost): Promise<ChartsIndex | null> {
  if (!host.supports("storage.parts@1")) return null;
  try {
    const bytes = await host.parts.read(CHARTS_INDEX_PART);
    if (!bytes) return null;
    const v = JSON.parse(dec.decode(bytes)) as ChartsIndex;
    return v && typeof v.charts === "object" ? v : null;
  } catch {
    return null;
  }
}

export async function writeIndex(
  host: BundleHost,
  index: ChartsIndex,
): Promise<void> {
  await host.parts.write(CHARTS_INDEX_PART, enc.encode(JSON.stringify(index)));
}

/** A chart frame on a page: the group that draws it and what its label
 *  says (the chart part, the slide shape it is, its box). */
export interface ChartFrame {
  groupId: string;
  pageId: string;
  /** Its index in the page's stacking list, back to front. */
  z: number;
  part: string;
  slidePart: string;
  shapeId: number;
  /** The frame's box when it was drawn: x, y, w, h (pt, page space). */
  box: [number, number, number, number];
  /** The group's members (deleted when it is redrawn). */
  members: { kind: string; id: string }[];
}

type TreeNode = {
  id?: { kind: string; id: string } | null;
  kind: string;
  children?: TreeNode[];
  pluginMetadata?: PluginMetadataEntry[];
};

/** A chart frame's label (`data.chart`, `data.shape`, `data.box`). */
export function chartLabel(meta: readonly PluginMetadataEntry[] | undefined): {
  part: string;
  slidePart: string;
  shapeId: number;
  box: ChartFrame["box"];
} | null {
  const entry = meta?.find((m) => m.key === SLIDE_KEY);
  if (!entry) return null;
  try {
    const d = (JSON.parse(entry.value) as { data?: Record<string, unknown> })
      .data;
    if (!d || typeof d.chart !== "string" || typeof d.shape !== "string")
      return null;
    const [slidePart, key] = d.shape.split("#");
    const shapeId = Number(key);
    const box = d.box;
    if (!slidePart || !Number.isInteger(shapeId)) return null;
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      !box.every((v) => typeof v === "number")
    )
      return null;
    return {
      part: d.chart,
      slidePart,
      shapeId,
      box: box as ChartFrame["box"],
    };
  } catch {
    return null;
  }
}

function memberIds(
  n: TreeNode,
  out: { kind: string; id: string }[] = [],
): { kind: string; id: string }[] {
  for (const c of n.children ?? []) {
    if (c.id) out.push(c.id);
    if (c.kind.toLowerCase() === "group") memberIds(c, out);
  }
  return out;
}

/** Every chart frame on the document's pages (top-level groups only: a
 *  chart inside a PowerPoint group is drawn, but not redrawn). */
export async function chartFrames(host: BundleHost): Promise<ChartFrame[]> {
  const doc = host.document;
  const tree = (await doc.tree()) as TreeNode[];
  const pages = await doc.collection<{ selfId: string }>("pages");
  const out: ChartFrame[] = [];
  tree.forEach((spread, i) => {
    const page = pages[i];
    const items = spread.children?.[0]?.children ?? [];
    items.forEach((n, z) => {
      if (!page || !n.id || n.kind.toLowerCase() !== "group") return;
      const label = chartLabel(n.pluginMetadata);
      if (!label) return;
      out.push({
        groupId: n.id.id,
        pageId: page.selfId,
        z,
        ...label,
        members: memberIds(n),
      });
    });
  });
  return out;
}

/** The frame's box now: its box when drawn, moved and scaled by what the
 *  user did to the group since (its item transform). */
export function boxNow(
  box: ChartFrame["box"],
  m: readonly number[] | null | undefined,
): ChartFrame["box"] {
  if (!m || m.length !== 6) return box;
  const [a, b, c, d, e, f] = m;
  const [x, y, w, h] = box;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  return [a * x + c * y + e, b * x + d * y + f, w * sx, h * sy];
}

/** The ops that swap a redrawn chart (`snippet`) in for `frame`, as ONE
 *  undo step: the old group dissolved and its members deleted (the engine
 *  has no delete for a group), the snippet pasted where the page has it,
 *  and put back at the old group's place in the stacking order. */
export function redrawOps(frame: ChartFrame, snippet: string): MutationInput[] {
  return [
    { op: "dissolveGroup", args: { groupId: frame.groupId } },
    ...frame.members.map((m): MutationInput => ({
      op: "deleteFrame",
      args: { frameId: m.id },
    })),
    { op: "pasteElements", args: { snippet, pageId: frame.pageId } },
    { op: "bindCreated", args: { handle: "chart" } },
    {
      op: "reorderElement",
      args: {
        elementId: { kind: "group", id: "$h:chart" } as unknown as ElementId,
        to: { index: frame.z },
      },
    },
  ] as MutationInput[];
}

/** Redraw every frame of `part` from the live workbook. Answers how many
 *  were redrawn. */
export async function redrawChart(
  host: BundleHost,
  live: LiveCharts,
  part: string,
): Promise<number> {
  const frames = (await chartFrames(host)).filter((f) => f.part === part);
  if (frames.length === 0) return 0;
  const geometry = await host.document.elementGeometry(
    frames.map((f) => ({ kind: "group", id: f.groupId })) as never,
  );
  const transforms = new Map<string, number[] | null>();
  for (const g of geometry as Array<{
    id: { id: string };
    itemTransform?: number[] | null;
  }>) {
    transforms.set(g.id.id, g.itemTransform ?? null);
  }
  const ops: MutationInput[] = [];
  // Later frames first on a page, so the stacking indices of the earlier
  // ones still hold when their turn comes.
  const ordered = [...frames].sort((a, b) =>
    a.pageId === b.pageId ? b.z - a.z : 0,
  );
  for (const f of ordered) {
    const [x, y, w, h] = boxNow(f.box, transforms.get(f.groupId));
    const snippet = live.snippet(part, f.slidePart, f.shapeId, x, y, w, h);
    ops.push({
      op: "batch",
      args: { ops: redrawOps(f, snippet) },
    } as MutationInput);
  }
  const r = await host.document.mutate(
    ops.length === 1
      ? ops[0]!
      : ({ op: "batch", args: { ops } } as MutationInput),
  );
  return r.applied ? frames.length : 0;
}

/** Keep an import's chart workbooks and their index (container parts). */
export async function keepCharts(
  host: BundleHost,
  charts: readonly ChartReport[] | undefined,
  workbooks: Uint8Array,
): Promise<void> {
  if (!host.supports("storage.parts@1")) return;
  const { index, parts } = importedCharts(charts ?? [], workbooks);
  for (const [part, bytes] of parts) await host.parts.write(part, bytes);
  await writeIndex(host, index);
}

/** The export plans of the charts whose workbooks the document edited. */
export async function chartPlans(host: BundleHost): Promise<ChartPlan[]> {
  const index = await readIndex(host);
  if (!index) return [];
  const out: ChartPlan[] = [];
  for (const [part, entry] of Object.entries(index.charts)) {
    if (!entry.edited) continue;
    const bytes = await host.parts.read(entry.workbook);
    if (!bytes) continue;
    out.push({ part, origin: entry.origin, workbook: bytesToBase64(bytes) });
  }
  return out;
}
