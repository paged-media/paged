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

// paged.sheet's grid verbs as COMMANDS (sheet ADRs 510, 517), the component
// layer: the real bundle on the SDK's fake editor with the real sheet
// engine, and the sheet's own frame surface and bar (the components it
// contributes) rendered over that bundle's session. Each palette command
// and its typed twin is run, and what it changed is read where a user
// sees it: the cells, the bar's cards, the AutoFilter's header buttons, the
// panel the host was asked to open. The right-click rows that run the same
// commands in the editor are the e2e layer
// (apps/editor/apps/canvas/tests/plugin-surface/menus-sheet-context.spec.ts).

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import type { ComponentType, ReactElement } from "react";

import type { FrameSurfaceProps } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { PERSIST_DEBOUNCE_MS } from "../src/session";
import type { FrameSurfaceSession } from "../src/surface/sheet-frame-surface";
import { P, unitEnv, type SheetEnv } from "./conformance/env";
import {
  C,
  cell,
  openBook,
  selectCell,
  selectRect,
} from "./conformance/scenarios";
import { ENGINE_BUILT } from "./perf/workload";
import { xlsxEntries } from "./saved-workbook";

interface Surface {
  render: ComponentType<FrameSurfaceProps>;
  bar: ComponentType<FrameSurfaceProps>;
}

const props: FrameSurfaceProps = {
  elementId: "f1",
  widthPt: 300,
  heightPt: 200,
  pxPerPt: 1,
  presentation: "frame",
  frameBoxPt: { widthPt: 300, heightPt: 200 },
  toContentPt: (x, y) => [x, y],
  requestPresentation: () => {},
  exit: () => {},
};

describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet grid verbs as commands${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv & ReturnType<typeof unitEnv>;
    beforeEach(() => {
      env = unitEnv();
    });
    afterEach(() => env.dispose());

    const surface = (): Surface => {
      const found = env.fake.registered<Surface & { contextType: string }>(
        "frameSurfaces",
      );
      const s = found.find((x) => x.contextType === "sheet");
      if (!s) throw new Error("the sheet frame surface is not registered");
      return s;
    };
    const run = async (id: string) => {
      await env.command(`${C}.${id}`).handler(env.host.editor, undefined);
      await env.settle();
    };
    const invoke = async (id: string) => {
      await env.objects.invoke(`${C}.${id}` as never, {});
      await env.settle();
    };
    const offered = (id: string) =>
      (env.command(`${C}.${id}`).when as (s: unknown) => boolean)(null);

    it("cutSelection — the cut cells move where the paste lands; the source empties", async () => {
      covers("command:media.paged.sheet.command.cutSelection");
      expect(offered("cutSelection")).toBe(false);
      await openBook(env);
      expect(offered("cutSelection")).toBe(true);
      selectRect(env, 1, 0, 1, 1); // A2:B2
      await run("cutSelection");
      expect(env.clipboard.payload?.tabular?.rows).toEqual([["Apples", "12"]]);
      // A cut changes nothing until its paste lands.
      expect(await cell(env, "A2")).toBe("Apples");
      selectCell(env, 5, 0); // A6
      await run("pasteSelection");
      expect([await cell(env, "A6"), await cell(env, "B6")]).toEqual([
        "Apples",
        "12",
      ]);
      expect([await cell(env, "A2"), await cell(env, "B2")]).toEqual(["", ""]);
      // The typed twin cuts the grid's selection the same way.
      selectCell(env, 2, 0); // A3
      await invoke("cutSelection");
      expect(env.clipboard.payload?.tabular?.rows).toEqual([["Pears"]]);
    });

    it("formatCells — opens the Sheet properties panel, palette and typed", async () => {
      covers("command:media.paged.sheet.command.formatCells");
      expect(offered("formatCells")).toBe(false);
      await openBook(env);
      const before = env.opened.length;
      await run("formatCells");
      expect(env.opened.slice(before)).toEqual([
        "media.paged.sheet.panel.properties",
      ]);
      await invoke("formatCells");
      expect(env.opened.slice(before)).toEqual([
        "media.paged.sheet.panel.properties",
        "media.paged.sheet.panel.properties",
      ]);
    });

    /** The session the sheet's bar renders from: the contributed bar
     *  component hands it to its view, so this is exactly what the bar
     *  shows (a card open, the circles drawn), read without a DOM. */
    const shown = (): FrameSurfaceSession => {
      const el = (surface().bar as (p: FrameSurfaceProps) => ReactElement)(
        props,
      );
      return (el.props as { link: { session: FrameSurfaceSession } }).link
        .session;
    };

    /** A command that opens a card on the sheet bar: the palette verb opens
     *  it and writes nothing; so does its typed twin, on a fresh bundle. */
    async function opensCard(
      id: string,
      isOpen: (s: FrameSurfaceSession) => boolean,
    ): Promise<void> {
      expect(offered(id)).toBe(false);
      await openBook(env);
      expect(offered(id)).toBe(true);
      expect(isOpen(shown())).toBe(false);
      const m = env.mark();
      await run(id);
      expect(isOpen(shown())).toBe(true);
      expect(env.mutationsSince(m)).toEqual([]);
      expect(await cell(env, "A2")).toBe("Apples");
      env.dispose();
      env = unitEnv();
      await openBook(env);
      expect(isOpen(shown())).toBe(false);
      await invoke(id);
      expect(isOpen(shown())).toBe(true);
    }

    it("pasteSpecial — opens Paste special's card on the sheet bar; nothing is pasted until OK; typed too", async () => {
      covers("command:media.paged.sheet.command.pasteSpecial");
      await opensCard("pasteSpecial", (s) => s.pasteSpecialOpen());
    });

    it("dataValidation — opens the Data validation card on the selection; typed too", async () => {
      covers("command:media.paged.sheet.command.dataValidation");
      await opensCard(
        "dataValidation",
        (s) => s.dataCard()?.kind === "validation",
      );
      selectRect(env, 1, 1, 3, 1); // B2:B4
      expect(shown().validationDraft()?.range).toBe("B2:B4");
    });

    it("goalSeek — opens the Goal Seek card; typed too", async () => {
      covers("command:media.paged.sheet.command.goalSeek");
      await opensCard("goalSeek", (s) => s.dataCard()?.kind === "goalSeek");
    });

    it("circleInvalid — circles the cells that break their rule, and takes them off again; typed too", async () => {
      covers("command:media.paged.sheet.command.circleInvalid");
      expect(offered("circleInvalid")).toBe(false);
      await openBook(env);
      // qty under 10: 12 (B2) breaks it, 3 and 7 keep it.
      selectRect(env, 1, 1, 3, 1);
      expect(
        shown().applyValidation({
          type: "whole",
          operator: "lessThan",
          formula1: "10",
          errorStyle: "stop",
          showError: true,
        }).ok,
      ).toBe(true);
      const circled = () =>
        shown()
          .invalidCircles()
          ?.map((c) => [c.row, c.col]) ?? null;
      expect(circled()).toBeNull();
      await run("circleInvalid");
      expect(circled()).toEqual([[1, 1]]);
      await run("circleInvalid");
      expect(circled()).toBeNull();
      await invoke("circleInvalid");
      expect(circled()).toEqual([[1, 1]]);
    });

    /** The row tags of the workbook the session last persisted into the
     *  document's part (written PERSIST_DEBOUNCE_MS after an edit). */
    const savedSheet = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, PERSIST_DEBOUNCE_MS + 250));
      await env.settle();
      const bytes = await env.host.parts.read("workbook.xlsx");
      if (!bytes) throw new Error("the workbook part was never written");
      return xlsxEntries(bytes).get("xl/worksheets/sheet1.xml") ?? "";
    };
    const savedRows = async (): Promise<string[]> =>
      (await savedSheet()).match(/<row [^>]*>/g) ?? [];
    const rowTag = (rows: string[], r: number) =>
      rows.find((t) => t.includes(` r="${r}"`)) ?? "";
    const HIDDEN = /\shidden="(1|true)"/;

    it("hideSelection / unhideSelection — the selected row is hidden, then shown again; typed too", async () => {
      covers(
        "command:media.paged.sheet.command.hideSelection",
        "command:media.paged.sheet.command.unhideSelection",
      );
      expect(offered("hideSelection")).toBe(false);
      expect(offered("unhideSelection")).toBe(false);
      await openBook(env);
      selectCell(env, 1, 0); // row 2
      await run("hideSelection");
      expect(rowTag(await savedRows(), 2)).toMatch(HIDDEN);
      // A1:A3 spans the hidden row.
      selectRect(env, 0, 0, 2, 0);
      await run("unhideSelection");
      expect(rowTag(await savedRows(), 2)).not.toMatch(HIDDEN);
      selectCell(env, 2, 0); // row 3
      await invoke("hideSelection");
      expect(rowTag(await savedRows(), 3)).toMatch(HIDDEN);
      selectRect(env, 1, 0, 3, 0);
      await invoke("unhideSelection");
      expect(rowTag(await savedRows(), 3)).not.toMatch(HIDDEN);
    });

    it("groupSelection / ungroupSelection — the selected rows go one outline level in, then out; typed too", async () => {
      covers(
        "command:media.paged.sheet.command.groupSelection",
        "command:media.paged.sheet.command.ungroupSelection",
      );
      expect(offered("groupSelection")).toBe(false);
      expect(offered("ungroupSelection")).toBe(false);
      await openBook(env);
      const LEVEL = /\soutlineLevel="1"/;
      selectRect(env, 1, 0, 2, 0); // rows 2–3
      await run("groupSelection");
      let rows = await savedRows();
      expect(rowTag(rows, 2)).toMatch(LEVEL);
      expect(rowTag(rows, 3)).toMatch(LEVEL);
      expect(rowTag(rows, 1)).not.toMatch(/outlineLevel/);
      await run("ungroupSelection");
      expect(rowTag(await savedRows(), 2)).not.toMatch(LEVEL);
      await invoke("groupSelection");
      expect(rowTag(await savedRows(), 2)).toMatch(LEVEL);
      await invoke("ungroupSelection");
      rows = await savedRows();
      expect(rowTag(rows, 2)).not.toMatch(LEVEL);
      expect(rowTag(rows, 3)).not.toMatch(LEVEL);
    });
    it("toggleFilter — turns the AutoFilter on over the selection's region, and off again; typed too", async () => {
      covers("command:media.paged.sheet.command.toggleFilter");
      expect(offered("toggleFilter")).toBe(false);
      await openBook(env);
      selectCell(env, 1, 0);
      await run("toggleFilter");
      expect(await savedSheet()).toMatch(/<autoFilter ref="A1:B4"/);
      await run("toggleFilter");
      expect(await savedSheet()).not.toContain("<autoFilter");
      await invoke("toggleFilter");
      expect(await savedSheet()).toMatch(/<autoFilter ref="A1:B4"/);
    });
  },
);

// The typed placement and chart-delete commands (plan G4) on the fake
// editor: what the bundle sends the document, and what it refuses before
// any write. Their effect on a real document is the headless layer
// (./headless/placement.headless.test.ts).
describe.skipIf(!ENGINE_BUILT)(
  `paged.sheet place and deleteChart on the fake editor${ENGINE_BUILT ? "" : " (unavailable: the sheet wasm, bash scripts/build-wasm.sh)"}`,
  () => {
    setDefaultTimeout(30_000);
    let env: SheetEnv & ReturnType<typeof unitEnv>;
    beforeEach(() => {
      env = unitEnv();
    });
    afterEach(() => env.dispose());

    it("place — a range is sent as one batch; what cannot be placed is refused before any write", async () => {
      covers("command:media.paged.sheet.command.place");
      await openBook(env);
      // The range goes out as ONE batch carrying the frame and its native
      // table. The fake editor records it but creates no frame, so the
      // command reports that nothing was placed.
      let m = env.mark();
      await expect(
        env.objects.invoke(`${C}.place` as never, { ref: "book!A1:B3" }),
      ).rejects.toThrow(/could not place book!A1:B3/);
      await env.settle();
      expect(env.mutationsSince(m).map((e) => e.op)).toEqual(["batch"]);
      m = env.mark();
      await expect(
        env.objects.invoke(`${C}.place` as never, {
          source: "name",
          ref: "Nothing",
        }),
      ).rejects.toThrow(/no defined name or table/);
      await expect(
        env.objects.invoke(`${C}.place` as never, {
          source: "printArea",
          ref: "nosuch",
        }),
      ).rejects.toThrow(/no sheet named/);
      expect(env.mutationsSince(m)).toEqual([]);
    });

    it("deleteChart — the chart leaves the workbook; the others keep their index; an unknown chart is refused", async () => {
      covers("command:media.paged.sheet.command.deleteChart");
      await openBook(env);
      const chart = {
        op: "create",
        kind: `${P}/chart`,
        props: {
          kind: "column",
          title: "Stock",
          series: [
            {
              values: "book!B2:B4",
              categories: "book!A2:A4",
              name: "qty",
              color: "",
            },
          ],
        },
      } as never;
      expect((await env.objects.batch([chart, chart])).reason ?? "").toBe("");
      await env.settle();
      const charts = () => env.objects.query(`${P}/chart` as never);
      expect(await charts()).toEqual([`${P}/chart/0`, `${P}/chart/1`]);
      // Nothing of it was placed: no page art to remove.
      expect(
        await env.objects.invoke(`${C}.deleteChart` as never, { chart: 0 }),
      ).toBe(0);
      await env.settle();
      expect(await charts()).toEqual([`${P}/chart/1`]);
      await expect(
        env.objects.invoke(`${C}.deleteChart` as never, { chart: 7 }),
      ).rejects.toThrow();
      expect(await charts()).toEqual([`${P}/chart/1`]);
    });
  },
);
