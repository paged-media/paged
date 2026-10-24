// W2.3 (sheet ADR 526) — hyperlinks and notes through the session: set,
// replace, remove, each one undo step, against the REAL sheet engine and a
// real headless host; pictures listed with their bytes and attached to the
// page content.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { createWorkbookSession, type WorkbookSession } from "../src";
import {
  ENGINE_BUILT,
  blankPageIdml,
  openHost,
  sheetHost,
  withSceneChannel,
} from "./perf/workload";

describe.skipIf(!ENGINE_BUILT)(
  "hyperlinks and notes [sheet.xlsx.hyperlinks]",
  () => {
    setDefaultTimeout(60_000);
    let h: HeadlessHost;
    let s: WorkbookSession | null = null;

    beforeEach(async () => {
      h = await openHost();
      await h.load(blankPageIdml());
    });
    afterEach(() => {
      s?.dispose();
      s = null;
      h?.dispose();
    });

    it("links, relinks and unlinks a range, one undo step each", async () => {
      const session = createWorkbookSession(
        withSceneChannel(sheetHost(h)).host,
      );
      s = session;
      await session.newWorkbook();
      session.editCell(0, 0, 0, "paged");
      expect(
        session.setHyperlink("A1", { url: "https://paged.media" }),
      ).toEqual({ ok: true });
      expect(session.hyperlinks()).toEqual([
        expect.objectContaining({ range: "A1", url: "https://paged.media" }),
      ]);
      expect(
        session.setHyperlink("A1", { location: "Sheet1!C3", tooltip: "Go" }),
      ).toEqual({ ok: true });
      expect(session.hyperlinks()[0]).toMatchObject({
        location: "Sheet1!C3",
        tooltip: "Go",
      });
      expect(session.removeHyperlinks("A1:B2")).toEqual({ ok: true });
      expect(session.hyperlinks()).toEqual([]);
      expect(session.undoCellEdit()).toBe(true);
      expect(session.hyperlinks()[0]?.location).toBe("Sheet1!C3");
      expect(session.undoCellEdit()).toBe(true);
      expect(session.hyperlinks()[0]?.url).toBe("https://paged.media");
      expect(session.undoCellEdit()).toBe(true);
      expect(session.hyperlinks()).toEqual([]);
      expect(session.redoCellEdit()).toBe(true);
      expect(session.hyperlinks()).toHaveLength(1);
    });

    it("adds, edits and deletes a note, one undo step each", async () => {
      const session = createWorkbookSession(
        withSceneChannel(sheetHost(h)).host,
      );
      s = session;
      await session.newWorkbook();
      const notes = () =>
        session
          .state()
          .engine!.listComments()
          .map((c) => [c.row, c.col, c.text]);
      expect(session.setNote(1, 1, "Check")).toEqual({ ok: true });
      expect(session.setNote(1, 1, "Checked")).toEqual({ ok: true });
      expect(notes()).toEqual([[1, 1, "Checked"]]);
      expect(session.deleteNote(1, 1)).toEqual({ ok: true });
      expect(notes()).toEqual([]);
      expect(session.undoCellEdit()).toBe(true);
      expect(notes()).toEqual([[1, 1, "Checked"]]);
      expect(session.undoCellEdit()).toBe(true);
      expect(notes()).toEqual([[1, 1, "Check"]]);
      expect(session.undoCellEdit()).toBe(true);
      expect(notes()).toEqual([]);
    });
  },
);
