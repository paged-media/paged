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

// [plugin-slide.charts] Live charts on the real engine (the canvas
// wasm, headless) and the real slide wasm (slide ADR 715): a deck's chart
// workbooks are kept when it opens; a cell entered in a chart's workbook
// and committed redraws the chart's frame (one undo step, at the frame's
// place in the stacking order); export writes the chart and its workbook,
// and the exported deck, imported again, holds the same data.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "bun:test";
import { waitFor } from "@paged-media/test-kit";

import type { ExporterContribution } from "@paged-media/plugin-api";
import { createHeadlessHost, type HeadlessHost } from "@paged-media/plugin-sdk";

import { CHART_CONTEXT, ChartEditing, parseGrid } from "../../src/charts";
import { chartFrames, readIndex } from "../../src/charts-model";
import { liveCharts } from "../../src/engine";
import slideBundle from "../../src/index";
import { IMPORT_PPTX_COMMAND } from "../../src/object-model";

const ENGINE_ANCHOR = fileURLToPath(new URL("..", import.meta.url));
const fixture = () =>
  new Uint8Array(
    readFileSync(
      new URL(
        "../../../../slide-conformance/fixtures/charts.pptx",
        import.meta.url,
      ),
    ),
  );

const hosts: HeadlessHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

async function open() {
  const h = await createHeadlessHost({ resolveFrom: ENGINE_ANCHOR });
  hosts.push(h);
  h.loadBundle(slideBundle);
  await h.objects.invoke(IMPORT_PPTX_COMMAND, {
    bytes: fixture(),
    name: "charts.pptx",
  });
  const exporter = h.exportersContributed()[0] as ExporterContribution;
  const exported = async () => {
    const r = await exporter.export();
    if (!r) throw new Error("the exporter wrote nothing");
    return r.bytes;
  };
  return { h, exported };
}

const COL = "ppt/charts/chart1.xml";

type Geom = { id: { id: string }; bounds: number[] };

async function memberBounds(
  h: HeadlessHost,
  members: { kind: string; id: string }[],
) {
  const g = (await h.host.document.elementGeometry(members as never)) as Geom[];
  return g.map((x) => x.bounds.map((v) => Math.round(v * 10) / 10));
}

describe("[plugin-slide.charts] live charts, headless", () => {
  it("keeps every chart's workbook and labels the chart frames", async () => {
    const { h } = await open();
    const index = await readIndex(h.host);
    expect(Object.keys(index!.charts).sort()).toEqual(
      [1, 2, 3, 4, 5].map((n) => `ppt/charts/chart${n}.xml`),
    );
    expect(index!.charts["ppt/charts/chart5.xml"]!.origin).toBe("synthesized");
    expect(index!.charts[COL]!.origin).toBe("embedded");
    const xlsx = await h.host.parts.read(index!.charts[COL]!.workbook);
    expect(xlsx?.byteLength).toBeGreaterThan(1000);
    const frames = await chartFrames(h.host);
    expect(frames.map((f) => f.part).sort()).toEqual(
      Object.keys(index!.charts).sort(),
    );
    const f = frames.find((x) => x.part === COL)!;
    expect(f.slidePart).toBe("ppt/slides/slide1.xml");
    expect(f.box.map(Math.round)).toEqual([80, 60, 560, 360]);
    expect(f.members.length).toBeGreaterThan(10);
    // A double-click on a member of the frame enters the chart context.
    const ctx = h
      .editContextsContributed()
      .find((c) => c.type === CHART_CONTEXT)!;
    const object = h
      .objectTypesContributed()
      .find((o) => o.type === CHART_CONTEXT)!;
    const candidate = {
      id: f.members[0]! as never,
      groupChain: [f.groupId],
      metadata: null,
    };
    await waitFor(() => expect(object.matches(candidate)).toBe(true));
    expect(ctx.matches?.(candidate)).toBe(true);
    expect(
      object.matches({
        ...candidate,
        id: { kind: "polygon", id: "x" } as never,
        groupChain: [],
      }),
    ).toBe(false);
  }, 180_000);

  it("a cell edit redraws the chart in one undo step; export writes it and it imports back equal", async () => {
    const { h, exported } = await open();
    const before = (await chartFrames(h.host)).find((f) => f.part === COL)!;
    const beforeBounds = await memberBounds(h, before.members);

    const editing = new ChartEditing(h.host);
    await editing.refresh();
    expect(await editing.open(COL)).toBe(true);
    expect(editing.grid()![0]!.name).toBe("Sheet1");
    expect(editing.enter("Sheet1", 2, 1, "9.25")).toBe(true);
    expect(editing.enter("Sheet1", 0, 2, "Coast")).toBe(true);
    const grid = editing.grid()!;
    const cell = (r: number, c: number) =>
      grid[0]!.cells.find((x) => x.row === r && x.col === c)?.text;
    expect(cell(2, 1)).toBe("9.25");
    expect(await editing.commit()).toBe(1);

    const after = (await chartFrames(h.host)).find((f) => f.part === COL)!;
    expect(after.groupId).not.toBe(before.groupId);
    expect(after.z).toBe(before.z);
    expect(after.box.map(Math.round)).toEqual(before.box.map(Math.round));
    const afterBounds = await memberBounds(h, after.members);
    expect(afterBounds).not.toEqual(beforeBounds);
    expect((await readIndex(h.host))!.charts[COL]!.edited).toBe(true);

    // One undo step brings the old drawing back.
    await h.host.document.undo();
    const undone = (await chartFrames(h.host)).find((f) => f.part === COL)!;
    expect(await memberBounds(h, undone.members)).toEqual(beforeBounds);
    await h.host.document.redo();

    // Export, then the deck imported again holds the edited data.
    const bytes = await exported();
    const live = await liveCharts(bytes);
    const back = parseGrid(live.open(COL, undefined, "embedded"));
    live.free();
    const text = (r: number, c: number) =>
      back[0]!.cells.find((x) => x.row === r && x.col === c)?.text;
    expect(text(2, 1)).toBe("9.25");
    expect(text(0, 2)).toBe("Coast");
    expect(back[0]!.cells.map((c) => [c.row, c.col, c.text])).toEqual(
      grid[0]!.cells.map((c) => [c.row, c.col, c.text]),
    );
    editing.dispose();
  }, 180_000);

  it("an untouched chart deck exports its own bytes", async () => {
    const { exported } = await open();
    const bytes = await exported();
    expect(Buffer.from(bytes).equals(Buffer.from(fixture()))).toBe(true);
  }, 180_000);
});
