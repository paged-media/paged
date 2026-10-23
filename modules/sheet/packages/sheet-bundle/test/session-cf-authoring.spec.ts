// W2.5 (sheet ADR 523) — conditional-format authoring through the session:
// add / edit / reorder / stop / delete on the active sheet, each one undo
// step, against the REAL sheet engine and a real headless host.

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

const fill = {
  fill: {
    kind: "pattern",
    pattern: "solid",
    fg: { concrete: { kind: "rgb", r: 255, g: 199, b: 206 } },
  },
};

describe.skipIf(!ENGINE_BUILT)(
  "conditional-format authoring [sheet.xlsx.condfmt]",
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

    it("adds, reorders, stops and deletes rules, one undo step each", async () => {
      const session = createWorkbookSession(
        withSceneChannel(sheetHost(h)).host,
      );
      s = session;
      await session.newWorkbook();
      for (let r = 0; r < 5; r++) session.editCell(0, r, 0, String(r * 10));
      expect(
        session.addCfRule({
          ranges: ["A1:A5"],
          kind: { type: "cellIs", op: "greaterThan", formulas: ["15"] },
          dxf: fill,
        }),
      ).toEqual({ ok: true });
      expect(
        session.addCfRule({
          ranges: ["A1:A5"],
          kind: { type: "top10", rank: 1, percent: false, bottom: false },
          dxf: fill,
        }),
      ).toEqual({ ok: true });
      let rules = session.cfRules();
      expect(rules.map((r) => r.rule.kind.type)).toEqual(["top10", "cellIs"]);
      expect(session.reorderCfRules([1, 0])).toEqual({ ok: true });
      expect(session.setCfStopIfTrue(0, true)).toEqual({ ok: true });
      rules = session.cfRules();
      expect(rules[0].rule.kind.type).toBe("cellIs");
      expect(rules[0].rule.stopIfTrue).toBe(true);
      // The engine paints: A5 (40 > 15) carries the rule's fill.
      const page = session.state().engine!.getRangePage!(0, "A1:A5");
      const a5 = page.rows[4].cells[0];
      expect(page.styles?.[a5.styleKey ?? 0]?.fillRgb).toBe("#FFC7CE");

      expect(session.deleteCfRule(1)).toEqual({ ok: true });
      expect(session.cfRules()).toHaveLength(1);
      expect(session.undoCellEdit()).toBe(true); // the delete
      expect(session.cfRules()).toHaveLength(2);
      expect(session.undoCellEdit()).toBe(true); // stop-if-true
      expect(session.cfRules()[0].rule.stopIfTrue).toBe(false);
      expect(session.undoCellEdit()).toBe(true); // the reorder
      expect(session.cfRules()[0].rule.kind.type).toBe("top10");
      expect(session.redoCellEdit()).toBe(true);
      expect(session.cfRules()[0].rule.kind.type).toBe("cellIs");
      expect(
        session.updateCfRule(0, {
          ranges: ["A1:A5"],
          kind: { type: "cellIs", op: "lessThan", formulas: ["5"] },
          dxf: fill,
        }),
      ).toEqual({ ok: true });
      expect(session.cfRules()[0].rule.kind).toMatchObject({ op: "lessThan" });
    });
  },
);
