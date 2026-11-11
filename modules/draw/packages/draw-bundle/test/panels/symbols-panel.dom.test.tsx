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

// The SYMBOLS panel, RENDERED (happy-dom) against the real engine: behaviour
// first (empty state, records, buttons asserted on the DOCUMENT), then
// its reload budgets as counts at the host doors — the
// perf-budgets.spec.ts rules: MEASURED, target beside it, only lowered.
//
// The engine keeps the symbols (engine ADR 1039): a reload reads its
// `symbols` collection, one reload per burst.

import { t } from "@paged-media/strings";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyDefineSymbol,
  applyPlaceSymbolInstance,
  makeSymbolsPanel,
  readEngineSymbols,
  SYMBOLS_NOTE,
  SYMBOLS_PANEL_ID,
} from "../../src";
import { openHost } from "../headless/host";
import {
  documentBurst,
  drive,
  emptyDocument,
  mountContributed,
  mountPanel,
  panelDocument,
  plainChange,
  plainId,
  poly,
  seedRow,
  selectionBurst,
  teardownPanels,
  unmountAll,
  RECORDS,
} from "./harness";
import { covers } from "@paged-media/test-kit";

const PANEL = "[data-draw-symbols-panel]";

describe("Symbols panel — rendered against the engine", () => {
  describe("an EMPTY document (no page item at all)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(emptyDocument());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the CONTRIBUTED component mounts and shows the empty state", async () => {
      const panel = await mountContributed(h, SYMBOLS_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-symbols-panel")).toBe("0");
      expect(panel.text()).toContain("Symbols (0)");
      expect(panel.text()).toContain(
        "No symbols yet — select artwork and capture its definition.",
      );
      expect(panel.text()).toContain(
        "Select artwork to capture it as a symbol",
      );
      expect(panel.count("[data-draw-symbol-row]")).toBe(0);
      expect(panel.disabled("[data-draw-symbol-define]")).toBe(true);
      expect(panel.disabled("[data-draw-symbol-reset]")).toBe(true);
      expect(panel.disabled("[data-draw-symbol-break]")).toBe(true);
      expect(panel.get("[data-draw-symbols-note]").textContent).toBe(
        t(SYMBOLS_NOTE),
      );
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      // The mount's own reload: the engine's symbols, read twice (the
      // rows, and the current symbol). TARGET 1.
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 0,
        reads: 2,
        partReads: 0,
      });
    });
  });

  // COVERS: `reload()` on a document with R = 5 symbols among L = 40 plain
  // leaves. Each symbol was made from one object and has ONE placed
  // instance. A reload reads the engine's `symbols` collection — no link
  // walk, whatever the record count or the selection.
  describe("reload budgets (R = 5 symbols, L = 40 plain leaves)", () => {
    let h: HeadlessHost;
    /** Walks one reload costs with 0, 1, … RECORDS symbols, nothing selected. */
    const walksByRecords: number[] = [];
    /** What one reload reads: the rows, and the current symbol. TARGET 1. */
    const RELOAD = { reloads: 1, walks: 0, reads: 2, partReads: 0 };

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", RECORDS)));
      h.loadBundle(drawBundle);
      const panel = await mountPanel(h, makeSymbolsPanel);
      for (let k = 0; k <= RECORDS; k++) {
        if (k > 0) {
          await drive(async () => {
            await h.host.selection.set([poly(`s${k - 1}`)]);
            const symbol = await applyDefineSymbol(h.host, {
              name: `Symbol ${k}`,
            });
            if (!symbol) throw new Error(`symbol ${k} was not defined`);
            const placed = await applyPlaceSymbolInstance(h.host, symbol.id, {
              x: 50 + (k - 1) * 110,
              y: 150,
            });
            if (placed.length !== 1)
              throw new Error(`symbol ${k} was not placed`);
            await h.host.selection.set([]);
          }, panel.work);
        }
        walksByRecords.push(
          (await panel.costOf(() => plainChange(h, k))).walks,
        );
      }
      unmountAll();
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the document is the one the budgets name", async () => {
      const rows = await readEngineSymbols(h.host);
      expect(rows).toHaveLength(RECORDS);
      expect(rows.flatMap((r) => r.instances)).toHaveLength(RECORDS);
    });

    it("NO walk at all, whatever the record count", () => {
      expect(walksByRecords).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("ONE reload, nothing selected = 2 reads", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(panel.cost()).toEqual({ events: 0, ...RELOAD });
      expect(await panel.costOf(() => plainChange(h, 0))).toEqual({
        events: 1,
        ...RELOAD,
      });
    });

    it("ONE reload with something selected = the same 2 reads", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(
        await panel.costOf(() => h.host.selection.set([plainId(0)])),
      ).toEqual({ events: 1, ...RELOAD });
    });

    it("a burst of 20 document changes = ONE reload", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(await documentBurst(h, panel)).toEqual({ events: 20, ...RELOAD });
    });

    it("a burst of 20 selection changes = ONE reload", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        events: 20,
        ...RELOAD,
      });
    });
  });

  describe("on the engine's symbols (document.symbols@1, engine ADR 1039)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", 3)));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("defines, places and breaks through the engine, one undo step each", async () => {
      covers("panel:media.paged.draw.panel.symbols");
      await h.host.selection.set([poly("s0")]);
      const panel = await mountPanel(h, makeSymbolsPanel);
      panel.reset();
      await panel.click("[data-draw-symbol-define]");
      // One wire op, the engine's; no container part is written.
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["createSymbol"]);
      expect(panel.work.count("parts.write")).toBe(0);
      expect(panel.attr(PANEL, "data-draw-symbols-panel")).toBe("1");
      const row = "[data-draw-symbol-row]";
      expect(panel.attr(row, "data-draw-symbol-instance-count")).toBe("0");

      panel.reset();
      await panel.click(`${row} [data-draw-symbol-place]`);
      expect(panel.work.mutations.map((m) => m.op)).toEqual([
        "placeSymbolInstance",
      ]);
      expect(panel.attr(row, "data-draw-symbol-instance-count")).toBe("1");
      expect(panel.disabled("[data-draw-symbol-break]")).toBe(false);
      expect(panel.get("[data-draw-symbols-note]").textContent).toContain(
        "kept by the document",
      );

      panel.reset();
      await panel.click("[data-draw-symbol-break]");
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
      expect(panel.attr(row, "data-draw-symbol-instance-count")).toBe("0");
      await h.host.document.undo();
    });

    it("an OPEN panel shows a symbol defined by the COMMAND, not only by its own button", async () => {
      await h.host.selection.set([poly("s1")]);
      const panel = await mountPanel(h, makeSymbolsPanel);
      const rows = panel.count("[data-draw-symbol-row]");
      panel.reset();
      await drive(async () => {
        if (!(await applyDefineSymbol(h.host))) throw new Error("not defined");
      }, panel.work);
      expect(panel.cost().reloads).toBe(1);
      expect(panel.count("[data-draw-symbol-row]")).toBe(rows + 1);
      await h.host.document.undo();
    });

    it("Delete drops the definition, after a confirm", async () => {
      await h.host.selection.set([poly("s0")]);
      const panel = await mountPanel(h, makeSymbolsPanel);
      const had = new Set((await readEngineSymbols(h.host)).map((r) => r.id));
      await panel.click("[data-draw-symbol-define]");
      const made = (await readEngineSymbols(h.host)).find(
        (r) => !had.has(r.id),
      )!;
      const del = `[data-draw-symbol-row="${made.id}"] [data-draw-symbol-delete]`;
      // The first click only arms the button.
      await panel.click(del);
      expect(panel.get(del).textContent).toBe("Confirm delete");
      await panel.click(del);
      expect(
        (await readEngineSymbols(h.host)).some((r) => r.id === made.id),
      ).toBe(false);
      expect(panel.count(`[data-draw-symbol-row="${made.id}"]`)).toBe(0);
    });

    // WP6.8 (draw ADR 365) — choose a symbol, Replace, Symbol Options.
    it("chooses a symbol, replaces the selected instance's symbol and applies its options, one step each", async () => {
      await h.host.selection.set([poly("s1")]);
      const panel = await mountPanel(h, makeSymbolsPanel);
      const ids = () =>
        panel
          .all("[data-draw-symbol-row]")
          .map((r) => r.getAttribute("data-draw-symbol-row"));
      const had = new Set(ids());
      await panel.click("[data-draw-symbol-define]");
      await h.host.selection.set([poly("s2")]);
      await panel.click("[data-draw-symbol-define]");
      const made = ids().filter((id) => !had.has(id));
      expect(made).toHaveLength(2);
      const [first, second] = made;
      await panel.click(
        `[data-draw-symbol-row="${first}"] [data-draw-symbol-place]`,
      );
      // Choosing the second row makes it the Sprayer's and Replace's.
      await panel.click(`[data-draw-symbol-choose="${second}"]`);
      expect(
        panel.attr(`[data-draw-symbol-choose="${second}"]`, "aria-pressed"),
      ).toBe("true");
      expect(
        panel.attr("[data-draw-symbol-options]", "data-draw-symbol-options"),
      ).toBe(second);
      // Replace — the placed instance (still selected) draws the second.
      panel.reset();
      await panel.click(
        `[data-draw-symbol-row="${second}"] [data-draw-symbol-replace]`,
      );
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
      expect(
        panel.attr(
          `[data-draw-symbol-row="${second}"]`,
          "data-draw-symbol-instance-count",
        ),
      ).toBe("1");
      // Options — a new name and 9-slice guides, one redefineSymbol.
      panel.change("[data-draw-symbol-option-name]", "Badge");
      await panel.click("[data-draw-symbol-option-guides]");
      panel.change('[data-draw-symbol-option-inset="0"]', "3");
      panel.reset();
      await panel.click("[data-draw-symbol-option-apply]");
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["redefineSymbol"]);
      const row = (await readEngineSymbols(h.host)).find(
        (r) => r.id === second,
      )!;
      expect(row.name).toBe("Badge");
      expect(row.nineSlice?.[0]).toBe(3);
      await h.host.document.undo();
      await h.host.document.undo();
    });
  });
});
