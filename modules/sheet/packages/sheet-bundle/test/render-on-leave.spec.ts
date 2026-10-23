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
