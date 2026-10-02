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

// @vitest-environment jsdom

// The SYMBOLS panel, RENDERED (jsdom) against the real engine: behaviour
// first (empty state, records, buttons asserted on the DOCUMENT), then
// its reload budgets as counts at the host doors — the
// perf-budgets.spec.ts rules: MEASURED, target beside it, only lowered.
//
// WHAT WAS MEASURED, in one line: one walk per reload with nothing
// selected, whatever the record count — and the SAME walk run TWICE as
// soon as anything at all is selected.
//
// WHAT IT IS NOW (the history is beside each budget): one reload per
// burst, one walk per document REVISION out of the shared link index
// (`src/link-index.ts`) — and a selection is a lookup in that walk.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyDefineSymbol,
  applyPlaceSymbolInstance,
  makeSymbolsPanel,
  readSymbolLibrary,
  symbolInstanceOf,
  symbolInstances,
  SYMBOLS_NOTE,
  SYMBOLS_PANEL_ID,
} from "../../src";
import { openHost } from "../conformance/host";
import {
  documentBurst,
  drive,
  emptyDocument,
  leafIds,
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
  PLAIN_LEAVES,
  RECORDS,
} from "./harness";

const PANEL = "[data-draw-symbols-panel]";
const ROW = '[data-draw-symbol-row="sym-1"]';

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
      expect(panel.attr(PANEL, "data-draw-symbols-portable")).toBe("true");
      expect(panel.text()).toContain("Symbols (0)");
      expect(panel.text()).toContain(
        "No symbols yet — select artwork and capture its definition.",
      );
      expect(panel.text()).toContain("Select artwork to capture it as a symbol");
      expect(panel.count("[data-draw-symbol-row]")).toBe(0);
      expect(panel.disabled("[data-draw-symbol-define]")).toBe(true);
      expect(panel.disabled("[data-draw-symbol-reset]")).toBe(true);
      expect(panel.disabled("[data-draw-symbol-break]")).toBe(true);
      expect(panel.get("[data-draw-symbols-note]").textContent).toBe(SYMBOLS_NOTE);
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      // The mount's own reload: one tree read and the library once.
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        reads: 1,
        partReads: 1,
      });
    });
  });

  describe("behaviour (3 objects + 40 plain leaves)", () => {
    let h: HeadlessHost;
    const PRISTINE = 3 + PLAIN_LEAVES;
    /** The leaves of the one instance in the document. */
    const instanceLeaves = async (): Promise<ElementId[]> =>
      (await symbolInstances(h.host)).flatMap((i) => i.leaves);

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", 3)));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("+ From selection captures a definition and leaves the document alone", async () => {
      await h.host.selection.set([poly("s0")]);
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(panel.disabled("[data-draw-symbol-define]")).toBe(false);
      // A plain object is selected — not an instance.
      expect(panel.disabled("[data-draw-symbol-reset]")).toBe(true);

      panel.reset();
      await panel.click("[data-draw-symbol-define]");

      const library = await readSymbolLibrary(h.host);
      expect(library.symbols.map((s) => [s.id, s.name, s.pieces.length])).toEqual([
        ["sym-1", "Symbol 1", 1],
      ]);
      // A definition is a container write: ZERO mutations, zero undo steps.
      expect(panel.work.mutations).toEqual([]);
      expect(panel.work.count("parts.write")).toBe(1);
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect(panel.work.count("log.warn")).toBe(0);

      expect(panel.attr(PANEL, "data-draw-symbols-panel")).toBe("1");
      expect(panel.attr(ROW, "data-draw-symbol-instance-count")).toBe("0");
      expect(panel.get(ROW).textContent).toContain("Symbol 1");
    });

    it("Place re-emits the artwork as a LINKED instance, through the engine", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      panel.reset();
      await panel.click(`${ROW} [data-draw-symbol-place]`);

      // THE DOCUMENT: one new leaf, carrying the link back to sym-1.
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);
      const leaves = await instanceLeaves();
      expect(leaves).toHaveLength(1);
      expect(
        symbolInstanceOf(await h.host.document.getMetadata(leaves[0]!))?.symbol,
      ).toBe("sym-1");
      // ONE batch: the insert is named, and the paint and link follow it
      // in the same mutation. (It was two — insert, then paint + link.)
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
      expect(panel.work.count("log.warn")).toBe(0);

      // THE PANEL followed: the command selects what it placed, so the
      // row is tagged and the two instance verbs come alive.
      expect(panel.attr(ROW, "data-draw-symbol-instance-count")).toBe("1");
      expect(panel.attr(PANEL, "data-draw-symbol-selected")).toBe("sym-1");
      expect(panel.get(ROW).textContent).toContain("instance");
      expect(panel.disabled("[data-draw-symbol-reset]")).toBe(false);
      expect(panel.disabled("[data-draw-symbol-break]")).toBe(false);
    });

    it("Reset transform REBUILDS the selected instance (a new element id)", async () => {
      const before = await instanceLeaves();
      await h.host.selection.set(before);
      const panel = await mountPanel(h, makeSymbolsPanel);
      await panel.click("[data-draw-symbol-reset]");

      const after = await instanceLeaves();
      expect(after).toHaveLength(1);
      expect(after[0]!.id).not.toBe(before[0]!.id);
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);
      expect(panel.attr(ROW, "data-draw-symbol-instance-count")).toBe("1");
    });

    it("Break link keeps the artwork and drops the reference", async () => {
      const leaves = await instanceLeaves();
      await h.host.selection.set(leaves);
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(panel.attr(PANEL, "data-draw-symbol-selected")).toBe("sym-1");

      await panel.click("[data-draw-symbol-break]");

      expect(symbolInstanceOf(await h.host.document.getMetadata(leaves[0]!))).toBeNull();
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);
      expect(panel.attr(ROW, "data-draw-symbol-instance-count")).toBe("0");
      expect(panel.attr(PANEL, "data-draw-symbol-selected")).toBe("");
      expect(panel.disabled("[data-draw-symbol-break]")).toBe(true);
    });

    it("Delete drops the definition", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      await panel.click(`${ROW} [data-draw-symbol-delete]`);

      expect((await readSymbolLibrary(h.host)).symbols).toEqual([]);
      expect(panel.count("[data-draw-symbol-row]")).toBe(0);
      expect(panel.attr(PANEL, "data-draw-symbols-panel")).toBe("0");
    });

    // WAS A BUG (measured, then fixed). The panel reloaded on document
    // events, selection events and its own buttons (each ended in `void
    // reload()`) — and a `.paged` container-part write is none of those.
    // DEFINE is the pure case: it writes the library and touches nothing
    // else, so it emits no event AT ALL. The panel's own "+ From
    // selection" hid this behind its trailing reload; the same command
    // from the menu or Cmd+K left an open panel with no row for the new
    // symbol (0 rows) — nothing to Place — until some unrelated selection
    // or document change came along. (Rename was the same; Delete drops
    // the definition after its last unlink, so its row stayed up.)
    // `writeSymbolLibrary` now announces the write, and the panel reloads
    // on that.
    //
    // No timing can make this one pass by luck: with no document event
    // and no selection event, the announcement is the ONLY thing that
    // tells the panel.
    it(
      "an OPEN panel shows a symbol defined by the COMMAND, not only by its own button",
      async () => {
        await h.host.selection.set([poly("s1")]);
        const panel = await mountPanel(h, makeSymbolsPanel);
        panel.reset();
        await drive(async () => {
          if (!(await applyDefineSymbol(h.host))) throw new Error("not defined");
        }, panel.work);

        // The document has it, and the host delivered NO event for it —
        // not a document change, not a selection change…
        expect((await readSymbolLibrary(h.host)).symbols).toHaveLength(1);
        expect(panel.cost().events).toBe(0);
        // …and the panel reloaded all the same, once, and shows it.
        expect(panel.cost().reloads).toBe(1);
        expect(panel.count("[data-draw-symbol-row]")).toBe(1);
      },
    );
  });

  // COVERS: `reload()` on a document with R = 5 symbols among L = 40 plain
  // leaves. Each symbol was captured from one object and has ONE placed
  // instance, so the document is 40 + 5 + 5 = 50 leaves.
  describe("reload budgets (R = 5 symbols, L = 40 plain leaves, 50 leaves in all)", () => {
    let h: HeadlessHost;
    /** Walks one reload costs with 0, 1, … RECORDS symbols, nothing selected. */
    const walksByRecords: number[] = [];

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", RECORDS)));
      h.loadBundle(drawBundle);
      const panel = await mountPanel(h, makeSymbolsPanel);
      for (let k = 0; k <= RECORDS; k++) {
        if (k > 0) {
          await drive(async () => {
            await h.host.selection.set([poly(`s${k - 1}`)]);
            const symbol = await applyDefineSymbol(h.host, { name: `Symbol ${k}` });
            if (!symbol) throw new Error(`symbol ${k} was not defined`);
            const placed = await applyPlaceSymbolInstance(h.host, symbol.id, {
              x: 50 + (k - 1) * 110,
              y: 150,
            });
            if (placed.length !== 1) throw new Error(`symbol ${k} was not placed`);
            await h.host.selection.set([]);
          }, panel.work);
        }
        walksByRecords.push((await panel.costOf(() => plainChange(h, k))).walks);
      }
      unmountAll();
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the document is the one the budgets name", async () => {
      expect(await leafIds(h)).toHaveLength(PLAIN_LEAVES + RECORDS * 2);
      expect((await readSymbolLibrary(h.host)).symbols).toHaveLength(RECORDS);
      expect(await symbolInstances(h.host)).toHaveLength(RECORDS);
    });

    it("NO per-record walk here: one walk per reload, whatever the record count", () => {
      // Index = symbols in the library. One `symbolInstances` walk is
      // tallied for every symbol at once.
      expect(walksByRecords).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it("ONE reload, nothing selected = 1 walk = 51 reads", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        reads: 51,
        partReads: 1,
      });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        events: 1,
        reloads: 1,
        // One walk per document REVISION, shared by every panel and
        // every command on this host.
        walks: 1,
        // 1 tree + 50 getMetadata, in parallel. TARGET 2 — a tree and
        // ONE bulk metadata read (RFI C-65).
        reads: 51,
        partReads: 1,
      });
    });

    it("ONE reload with ANYTHING selected = no walk at all, 0 reads", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      // A plain leaf: not an instance, not a symbol's source.
      const selected = await panel.costOf(() => h.host.selection.set([plainId(0)]));
      expect(selected).toEqual({
        events: 1,
        reloads: 1,
        // The document did not change: the links, and the tree the
        // selection is expanded against, are the ones the mount read.
        // As found: 3 — `symbolInstances` for the counts, a tree read to
        // expand the selection, then `selectedSymbolInstances` calling
        // `symbolInstances` AGAIN.
        walks: 0,
        // Which instances the selection touches is a lookup in the walk
        // the index already has. As found: 103.
        reads: 0,
        partReads: 1,
      });
    });

    it("a burst of 20 document changes = ONE reload = 51 reads", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(await documentBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20 — no debounce, no cancellation.
        reloads: 1,
        // As found: 20.
        walks: 1,
        // One walk, of the revision the burst ends on. As found: 1 020.
        reads: 51,
        // As found: 20.
        partReads: 1,
      });
    });

    it("a burst of 20 selection changes = ONE reload = 0 reads", async () => {
      const panel = await mountPanel(h, makeSymbolsPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20.
        reloads: 1,
        // The DOCUMENT did not change once during this burst. As found:
        // 60.
        walks: 0,
        // As found: 2 060.
        reads: 0,
        // As found: 20.
        partReads: 1,
      });
    });
  });
});
