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

// [sheet.comments.threads] The whole path on the real engine: a workbook
// with an Excel thread is placed in a frame, the thread appears in the
// document's comments anchored to that frame, an answer written the way the
// host's Comments panel writes it lands in the workbook, and deleting the
// frame orphans the thread. Skipped without the sheet and engine wasm.

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

import { createWorkbookSession, type WorkbookSession } from "../src";
import {
  ENGINE_BUILT,
  authorWorkbook,
  blankPageIdml,
  openHost,
  settle,
  sheetHost,
  withSceneChannel,
} from "./perf/workload";

interface Row {
  id: string;
  parentId?: string | null;
  text: string;
  resolved: boolean;
  orphaned?: boolean;
  anchor?: { kind: string; item?: string; address?: string } | null;
}

describe.skipIf(!ENGINE_BUILT)(
  "sheet threads in the document's comments",
  () => {
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

    const rows = async () =>
      (await host.document.collection("comments" as never)) as unknown as Row[];

    it("shows the thread on its frame, takes the panel's reply, orphans on delete", async () => {
      const session = createWorkbookSession(host);
      s = session;
      await session.import(
        await authorWorkbook(3, 2, (r, c) => String(r * 2 + c + 1)),
        "c.xlsx",
      );
      const engine = session.state().engine!;
      const sheet = session.state().activeSheet!;
      const root = engine.addThread!(
        sheet,
        0,
        0,
        {
          displayName: "Ann Author",
          userId: "ann@example.com",
          providerId: "AD",
        },
        "2026-11-01T10:00:00.00",
        "check this",
        3,
      );
      session.setRange("A1:B3");
      const frame = await session.lowerSelection();
      expect(frame).not.toBeNull();
      await settle();
      await session.syncComments();

      const name = engine.listSheets().find((x) => x.id === sheet)!.name;
      let all = await rows();
      expect(all.map((r) => r.id)).toEqual([root]);
      expect(all[0]!.anchor).toEqual({
        kind: "cell",
        item: frame!,
        address: `${name}!A1`,
      });

      // The panel's reply: the engine mints its id; the workbook's replaces it.
      const out = await host.document.mutate({
        op: "replyComment",
        args: {
          parentId: root,
          comment: { author: "Bob", text: "looks fine" },
        },
      } as never);
      expect(out.applied).toBe(true);
      await settle();
      await session.syncComments();
      const [thread] = engine.listThreads!(sheet);
      expect(thread!.comments.map((c) => c.text)).toEqual([
        "check this",
        "looks fine",
      ]);
      all = await rows();
      expect(all.map((r) => r.id)).toEqual(thread!.comments.map((c) => c.id));

      // Resolve from the panel.
      await host.document.mutate({
        op: "resolveComment",
        args: { commentId: root, resolved: true },
      } as never);
      await settle();
      await session.syncComments();
      expect(engine.listThreads!(sheet)[0]!.resolved).toBe(true);

      // The frame goes: the thread stays, orphaned; the workbook keeps it.
      await host.document.mutate({
        op: "deleteFrame",
        args: { frameId: frame! },
      } as never);
      await settle();
      all = await rows();
      expect(all.every((r) => r.orphaned)).toBe(true);
      expect(engine.listThreads!(sheet)).toHaveLength(1);
    });

    it("starts a thread on a cell through the comments door; the workbook takes it", async () => {
      const session = createWorkbookSession(host);
      s = session;
      await session.import(
        await authorWorkbook(3, 2, (r, c) => String(r * 2 + c + 1)),
        "c.xlsx",
      );
      const engine = session.state().engine!;
      const sheet = session.state().activeSheet!;
      session.setRange("A1:B3");
      const frame = await session.lowerSelection();
      expect(frame).not.toBeNull();
      await settle();
      expect(engine.listThreads!(sheet)).toHaveLength(0);

      session.selectCell(1, 1); // B2
      const r = await session.startCellComment("look at this");
      expect(r.ok).toBe(true);
      await settle();

      // The workbook holds it: one thread at B2, the text as typed.
      const threads = engine.listThreads!(sheet);
      expect(threads).toHaveLength(1);
      expect([threads[0]!.row, threads[0]!.col]).toEqual([1, 1]);
      expect(threads[0]!.comments.map((c) => c.text)).toEqual(["look at this"]);
      // The document's thread is the workbook's: same id, cell anchor on the frame.
      const name = engine.listSheets().find((x) => x.id === sheet)!.name;
      const all = await rows();
      expect(all.map((x) => x.id)).toEqual([threads[0]!.comments[0]!.id]);
      expect(all[0]!.anchor).toEqual({
        kind: "cell",
        item: frame!,
        address: `${name}!B2`,
      });
      // A second reconcile changes nothing; the saved workbook carries it.
      await session.syncComments();
      expect(await rows()).toHaveLength(1);
      expect(engine.listThreads!(sheet)).toHaveLength(1);
    });

    it("resolves a cell address to its rectangle in the placed frame", async () => {
      const session = createWorkbookSession(host);
      s = session;
      await session.import(
        await authorWorkbook(3, 2, (r, c) => String(r * 2 + c + 1)),
        "c.xlsx",
      );
      const engine = session.state().engine!;
      const sheet = session.state().activeSheet!;
      const name = engine.listSheets().find((x) => x.id === sheet)!.name;
      session.setRange("A1:B3");
      const frame = await session.lowerSelection();
      await settle();

      const a1 = session.commentAnchor(`${name}!A1`, frame!);
      const b2 = session.commentAnchor(`${name}!B2`, frame!);
      expect(a1).not.toBeNull();
      expect(a1!.rect.slice(0, 2)).toEqual([0, 0]);
      expect(a1!.label).toBe(`${name}!A1`);
      // B2 sits right of A and below row 1 by exactly their sizes.
      expect(b2!.rect[0]).toBeCloseTo(a1!.rect[2], 5);
      expect(b2!.rect[1]).toBeCloseTo(a1!.rect[3], 5);
      expect(b2!.rect[2]).toBeGreaterThan(0);
      // Not shown / not ours: the pin stays at the frame's top-left.
      expect(session.commentAnchor(`${name}!A9`, frame!)).toBeNull();
      expect(session.commentAnchor("Other!A1", frame!)).toBeNull();
      expect(session.commentAnchor(`${name}!A1`, "no-such-frame")).toBeNull();
    });

    it("names the active cell of the frame that shows the active sheet", async () => {
      const session = createWorkbookSession(host);
      s = session;
      await session.import(
        await authorWorkbook(3, 2, (r, c) => String(r * 2 + c + 1)),
        "c.xlsx",
      );
      const engine = session.state().engine!;
      const sheet = session.state().activeSheet!;
      const name = engine.listSheets().find((x) => x.id === sheet)!.name;
      session.setRange("A1:B3");
      const frame = await session.lowerSelection();
      await settle();

      session.selectCell(1, 1);
      expect(session.selectedAddress(frame!)).toBe(`${name}!B2`);
      session.selectCell(2, 0);
      expect(session.selectedAddress(frame!)).toBe(`${name}!A3`);
      expect(session.selectedAddress("no-such-frame")).toBeNull();
    });
  },
);
