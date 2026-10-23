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

// Sheet ADR 510 — render on leave, on the real engine: a placed range is a
// window onto the sheet. Scroll inside the frame, leave it, and the page
// table shows the window you left (the binding names its new top-left);
// a locked view snaps back instead.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import type { BundleHost } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { parseBinding } from "@paged-media/sheet-host-model";

import { createWorkbookSession, type WorkbookSession } from "../src";

import {
  ENGINE_BUILT,
  WASM,
  authorWorkbook,
  blankPageIdml,
  exportedTableCells,
  openHost,
  settle,
  sheetHost,
  withSceneChannel,
} from "./perf/workload";

if (process.env.REQUIRE_REAL_ENGINE === "1" && !ENGINE_BUILT) {
  describe("render on leave (wasm artifact) — REQUIRED", () => {
    it("FAILS: REQUIRE_REAL_ENGINE=1 but the wasm artifact is missing", () => {
      throw new Error(`REQUIRE_REAL_ENGINE=1 but ${WASM} is missing`);
    });
  });
}

describe.skipIf(!ENGINE_BUILT)("render on leave [sheet.lower.page]", () => {
  setDefaultTimeout(60_000);
  let h: HeadlessHost;
  let host: BundleHost;
  let s: WorkbookSession | null = null;

  beforeEach(async () => {
    h = await openHost();
    await h.load(blankPageIdml());
    host = withSceneChannel(sheetHost(h)).host;
  });
  afterEach(() => {
    s?.dispose();
    s = null;
    h?.dispose();
  });

  async function placed(): Promise<{ s: WorkbookSession; frame: string }> {
    const session = createWorkbookSession(host);
    s = session;
    await session.import(
      await authorWorkbook(40, 6, (r, c) => `r${r}c${c}`),
      "w.xlsx",
    );
    session.setRange("A1:C5");
    const frame = await session.lowerSelection();
    expect(frame).not.toBeNull();
    await settle();
    return { s: session, frame: frame! };
  }

  const bindingOf = async (frame: string) =>
    parseBinding(
      await host.document.getMetadata({
        kind: "textFrame",
        id: frame,
      } as never),
    )?.data;

  it("a placed range is a window frame showing its range", async () => {
    const { frame } = await placed();
    const b = await bindingOf(frame);
    expect(b?.sizing).toBe("window");
    expect(b?.view).toEqual({ topLeft: "A1", lock: false });
    expect(b?.range).toBe("A1:C5");
    const [cells] = await exportedTableCells(h);
    expect(cells.get("0:0")).toBe("r0c0");
    expect(cells.get("4:2")).toBe("r4c2");
  });

  it("leaving the frame writes the window it was scrolled to", async () => {
    const { s, frame } = await placed();
    expect(await s.showGridInFrame(frame)).toBe(true);
    expect(s.scrollInFrame(10, 1)).toBe(true);
    s.hideGridInFrame();
    await s.refreshPlacements();
    await settle();
    const b = await bindingOf(frame);
    expect(b?.view.topLeft).toBe("B11");
    expect(b?.range.startsWith("B11:")).toBe(true);
    expect(s.frameView(frame)?.topLeft).toBe("B11");
    const tables = await exportedTableCells(h);
    expect(tables).toHaveLength(1);
    expect(tables[0].get("0:0")).toBe("r10c1");
  });

  it("resizing the frame re-windows the page table (P6)", async () => {
    const { s, frame } = await placed();
    const [g] = await host.document.elementGeometry([
      { kind: "textFrame", id: frame },
    ]);
    const [top, left, bottom, right] = g.bounds;
    // Twice as tall: about twice the rows fit.
    const r = await host.document.mutate({
      op: "resizeFrame",
      args: {
        frameId: frame,
        bounds: [top, left, top + 2 * (bottom - top), right],
      },
    });
    expect(r.applied).toBe(true);
    await settle();
    await s.refreshPlacements();
    await settle();
    const b = await bindingOf(frame);
    expect(b?.view.topLeft).toBe("A1");
    const [cells] = await exportedTableCells(h);
    // The range showed rows 1–5; the taller frame shows more of them.
    expect(cells.get("8:0")).toBe("r8c0");
    expect(b?.range.startsWith("A1:")).toBe(true);
    expect(b?.range).not.toBe("A1:C5");
  });

  it("a frame linked to another becomes one window over both (P6)", async () => {
    const { s, frame } = await placed();
    const [g] = await host.document.elementGeometry([
      { kind: "textFrame", id: frame },
    ]);
    const [top, left, bottom, right] = g.bounds;
    const pageId = g.pageId!;
    // A second frame below, as tall as the first, threaded after it.
    const made = await host.document.mutate({
      op: "insertTextFrame",
      args: {
        pageId,
        bounds: [bottom + 40, left, bottom + 40 + (bottom - top), right],
      },
    });
    if (!made.applied) throw new Error("insertTextFrame was refused");
    const next = (made.createdId as { id: string }).id;
    const link = await host.document.mutate({
      op: "linkFrames",
      args: { from: frame, to: next },
    });
    expect(link.applied).toBe(true);
    // The chain read is debounced; then the refresh lowers the window.
    await new Promise((r) => setTimeout(r, 600));
    await s.refreshPlacements();
    await settle();
    const b = await bindingOf(frame);
    expect(b?.range.startsWith("A1:")).toBe(true);
    const [cells] = await exportedTableCells(h);
    // About twice the rows: the table flows into the second frame.
    expect(cells.get("8:0")).toBe("r8c0");
    const storyId = (g as { storyId?: string }).storyId!;
    const chain = await host.document.frameChain(storyId);
    expect(chain.map((l) => l.frameId)).toEqual([frame, next]);
    expect(chain.some((l) => l.overflow)).toBe(false);

    // Entering the continuation starts its grid at the rows it holds;
    // scrolling there and leaving scrolls the chain.
    expect(await s.showGridInFrame(next)).toBe(true);
    expect(s.scrollInFrame(3, 0)).toBe(true);
    s.hideGridInFrame();
    await s.refreshPlacements();
    await settle();
    expect((await bindingOf(frame))?.view.topLeft).toBe("A4");
  });

  it("switching the frame's sheet puts that sheet on the page", async () => {
    const { s, frame } = await placed();
    expect(s.addSheet("Prices").ok).toBe(true);
    const id = s.sheets().find((x) => x.name === "Prices")?.id;
    expect(id).toBeDefined();
    s.editCell(id!, 0, 0, "price");
    await s.refreshPlacements();
    await settle();
    expect(await s.showGridInFrame(frame)).toBe(true);
    expect(s.setFrameSheet(id!)).toBe(true);
    s.hideGridInFrame();
    await s.refreshPlacements();
    await settle();
    const b = await bindingOf(frame);
    expect(b?.sheet).toBe("Prices");
    expect(b?.view.topLeft).toBe("A1");
    const tables = await exportedTableCells(h);
    expect(tables).toHaveLength(1);
    expect(tables[0].get("0:0")).toBe("price");
  });

  it("the document's basic paragraph face is the grid's default (P7)", async () => {
    const session = createWorkbookSession(host);
    s = session;
    const made = await host.document.mutate({
      op: "batch",
      args: {
        ops: [
          {
            op: "createParagraphStyle",
            args: {
              selfId: "ParagraphStyle/$ID/NormalParagraphStyle",
              name: "$ID/NormalParagraphStyle",
            },
          },
          {
            op: "setStyleProperty",
            args: {
              collection: "paragraph",
              styleId: "ParagraphStyle/$ID/NormalParagraphStyle",
              path: "characterFontFamily",
              value: { type: "text", value: "Minion Pro" },
            },
          },
          {
            op: "setStyleProperty",
            args: {
              collection: "paragraph",
              styleId: "ParagraphStyle/$ID/NormalParagraphStyle",
              path: "characterFontSize",
              value: { type: "length", value: 9 },
            },
          },
        ],
      },
    });
    expect(made.applied).toBe(true);
    expect(await session.documentTextDefault()).toEqual({
      family: "Minion Pro",
      style: null,
      sizePt: 9,
    });
  });

  it("a document swatch and paragraph style set on a cell reach the page lowering (P7)", async () => {
    const { s } = await placed();
    s.selectCell(1, 1);
    const r = s.setStyle({
      fontSwatch: { id: "Color/Brand", model: "spot", fallbackRgb: "#C8102E" },
      docParaStyle: "ParagraphStyle/Table body",
    });
    expect(r.ok).toBe(true);
    const engine = s.state().engine!;
    const sheet = s.sheets()[0]!.id;
    const page = engine.getRangePage!(sheet, "B2:B2", {
      includeGridRules: true,
    });
    const key = page.rows[0]?.cells[0]?.styleKey ?? 0;
    const st = page.styles?.find((x) => x.key === key);
    expect(st?.textSwatch).toBe("Color/Brand");
    expect(st?.docParaStyle).toBe("ParagraphStyle/Table body");
    expect(st?.textRgb?.toUpperCase()).toBe("#C8102E");
  });

  it("the bar's swatch picker lists document swatches and applies a CMYK spot as a reference (P7)", async () => {
    const { s } = await placed();
    const made = await host.document.mutate({
      op: "createSwatch",
      args: {
        spec: {
          selfId: "Color/Brand Red",
          name: "Brand Red",
          space: "CMYK",
          value: [0, 100, 80, 5],
          model: "Spot",
        },
      },
    });
    expect(made.applied).toBe(true);
    const choices = await s.documentStyleChoices();
    const brand = choices.swatches.find((x) => x.id === "Color/Brand Red");
    expect(brand?.name).toBe("Brand Red");
    expect(brand?.rgbHex).toMatch(/^#[0-9a-f]{6}$/i);
    s.selectCell(0, 0);
    expect((await s.applyDocumentSwatch("fill", "Color/Brand Red")).ok).toBe(
      true,
    );
    const engine = s.state().engine!;
    const sheet = s.sheets()[0]!.id;
    const page = engine.getRangePage!(sheet, "A1:A1", {
      includeGridRules: true,
    });
    const key = page.rows[0]?.cells[0]?.styleKey ?? 0;
    const st = page.styles?.find((x) => x.key === key);
    expect(st?.fillSwatch).toBe("Color/Brand Red");
    expect(s.styleAtTarget()?.fillSwatch?.model).toBe("spot");
  });

  it("full screen outlines where the page window lands on leaving", async () => {
    const { s, frame } = await placed();
    expect(await s.showGridInFrame(frame)).toBe(true);
    expect(s.pageWindowsOnLeave()).toEqual([
      { top: 0, left: 0, bottom: 4, right: 2 },
    ]);
    expect(s.scrollInFrame(10, 1)).toBe(true);
    const [w] = s.pageWindowsOnLeave();
    expect(w!.top).toBe(10);
    expect(w!.left).toBe(1);
    expect(w!.bottom - w!.top).toBe(4);
    s.hideGridInFrame();
  });

  it("a locked view snaps back on leaving", async () => {
    const { s, frame } = await placed();
    expect(await s.showGridInFrame(frame)).toBe(true);
    expect(s.setFrameViewLock(true)).toBe(true);
    expect(s.scrollInFrame(10, 1)).toBe(true);
    s.hideGridInFrame();
    await s.refreshPlacements();
    await settle();
    const b = await bindingOf(frame);
    expect(b?.view).toEqual({ topLeft: "A1", lock: true });
    const [cells] = await exportedTableCells(h);
    expect(cells.get("0:0")).toBe("r0c0");
  });
});
