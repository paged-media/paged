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

// The REPEAT OPTIONS panel, RENDERED (jsdom) against the real engine:
// behaviour first (empty state, records, buttons asserted on the
// DOCUMENT), then its reload budgets as counts at the host doors — the
// perf-budgets.spec.ts rules: MEASURED, target beside it, only lowered.
//
// WHAT WAS MEASURED, in one line: one walk of the whole document PER
// RECORD per reload, plus a container-part read per record on top.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyMakeRepeat,
  makeRepeatPanel,
  readRepeatLibrary,
  repeatInstanceOf,
  repeatSourceOf,
  REPEAT_PANEL_ID,
  REPEAT_PANEL_NOTE,
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
  poly,
  seedRow,
  selectDuringWalk,
  selectionBurst,
  teardownPanels,
  unmountAll,
  PLAIN_LEAVES,
  RECORDS,
} from "./harness";

const PANEL = "[data-draw-repeat-panel]";

describe("Repeat options panel — rendered against the engine", () => {
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
      const panel = await mountContributed(h, REPEAT_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-repeat-panel")).toBe("0");
      expect(panel.attr(PANEL, "data-draw-repeat-portable")).toBe("true");
      expect(panel.text()).toContain("Repeats (0)");
      expect(panel.text()).toContain(
        "No repeats yet — select artwork and build one.",
      );
      expect(panel.count("[data-draw-repeat-row]")).toBe(0);
      // Three make verbs, all waiting for a selection.
      const makes = panel.all("[data-draw-repeat-make]") as HTMLButtonElement[];
      expect(makes.map((b) => b.getAttribute("data-draw-repeat-make"))).toEqual([
        "radial",
        "grid",
        "mirror",
      ]);
      expect(makes.every((b) => b.disabled)).toBe(true);
      expect(panel.get("[data-draw-repeat-note]").textContent).toBe(
        REPEAT_PANEL_NOTE,
      );
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makeRepeatPanel);
      // One tree read and the recipe THREE times (the panel, the resolve,
      // and the resolve's `repeatLinks`). TARGET 1 part read.
      expect(panel.cost()).toEqual({
        events: 0,
        walks: 1,
        reads: 1,
        partReads: 3,
      });
    });
  });

  describe("behaviour (3 sources + 40 plain leaves)", () => {
    let h: HeadlessHost;
    const PRISTINE = 3 + PLAIN_LEAVES;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", 3)));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the form shows the fields of the chosen kind only", async () => {
      const panel = await mountPanel(h, makeRepeatPanel);
      const fields = () =>
        panel
          .all("[data-draw-repeat-field]")
          .map((el) => el.getAttribute("data-draw-repeat-field"));
      expect(fields()).toEqual(["count", "radiusPt", "startDeg", "sweepDeg"]);
      panel.change("[data-draw-repeat-kind]", "grid");
      expect(fields()).toEqual(["columns", "rows", "spacingX", "spacingY"]);
      panel.change("[data-draw-repeat-kind]", "mirror");
      expect(fields()).toEqual(["angleDeg", "offsetPt"]);
    });

    it("+ grid builds, through the engine, what the form holds", async () => {
      const panel = await mountPanel(h, makeRepeatPanel);
      await drive(() => h.host.selection.set([poly("s0")]), panel.work);
      panel.change("[data-draw-repeat-kind]", "grid");
      panel.change('[data-draw-repeat-field="columns"]', "2");
      panel.change('[data-draw-repeat-field="rows"]', "1");

      panel.reset();
      await panel.click('[data-draw-repeat-make="grid"]');

      // THE DOCUMENT: one instance, linked both ways, the recipe saved.
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);
      const library = await readRepeatLibrary(h.host);
      expect(
        library.repeats.map((r) => [
          r.id,
          r.params.kind,
          r.params.columns,
          r.params.rows,
          r.instances.length,
        ]),
      ).toEqual([["rep-1", "grid", 2, 1, 1]]);
      expect(repeatSourceOf(await h.host.document.getMetadata(poly("s0")))?.repeat).toBe(
        "rep-1",
      );
      const instance = library.repeats[0]!.instances[0]!;
      expect(
        repeatInstanceOf(await h.host.document.getMetadata(poly(instance.id)))?.repeat,
      ).toBe("rep-1");
      // ONE batch (the note's "ONE undo step"), and no refusal.
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
      expect(panel.work.count("log.warn")).toBe(0);

      // THE PANEL followed.
      expect(panel.attr(PANEL, "data-draw-repeat-panel")).toBe("1");
      expect(panel.attr(PANEL, "data-draw-repeat-active")).toBe("rep-1");
      expect(panel.text()).toContain("Grid repeat 1");
      expect(panel.text()).toContain("grid · 2 × 1 (1 instance placed)");
    });

    it("Update rebuilds the record with the options above it", async () => {
      const panel = await mountPanel(h, makeRepeatPanel);
      panel.change('[data-draw-repeat-field="columns"]', "3");
      await panel.click("[data-draw-repeat-update]");

      const library = await readRepeatLibrary(h.host);
      expect(library.repeats[0]!.params.columns).toBe(3);
      expect(library.repeats[0]!.instances).toHaveLength(2);
      expect(await leafIds(h)).toHaveLength(PRISTINE + 2);
      expect(panel.text()).toContain("grid · 3 × 1 (2 instances placed)");
    });

    // BUG (measured) — the same one blend-panel.spec.tsx pins, in this
    // panel's copy of the code. With EXACTLY ONE record in the library
    // `resolveRepeat` answers that record whatever is selected, and every
    // reload ends in `if (saved) setDraft(saved.params)`: the selection
    // change a Make REQUIRES throws away what was typed. Flip to `it`
    // when the reload stops overwriting a draft the user is editing.
    it.fails(
      "typed options survive the selection change that a Make needs (one record in the library)",
      async () => {
        expect((await readRepeatLibrary(h.host)).repeats).toHaveLength(1);
        const panel = await mountPanel(h, makeRepeatPanel);
        const columns = () =>
          panel.get<HTMLInputElement>('[data-draw-repeat-field="columns"]').value;
        await drive(() => h.host.selection.set([]), panel.work);
        panel.change('[data-draw-repeat-field="columns"]', "7");
        expect(columns()).toBe("7");
        await drive(() => h.host.selection.set([poly("s1")]), panel.work);
        // MEASURED "3": the saved options of the only repeat in the library.
        expect(columns()).toBe("7");
      },
    );

    it("Release removes the instances and the record, and keeps the source", async () => {
      const panel = await mountPanel(h, makeRepeatPanel);
      await panel.click("[data-draw-repeat-release]");

      expect((await readRepeatLibrary(h.host)).repeats).toEqual([]);
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect(repeatSourceOf(await h.host.document.getMetadata(poly("s0")))).toBeNull();
      expect(panel.count("[data-draw-repeat-row]")).toBe(0);
    });

    // BUG (measured) — the one blend-panel.spec.tsx explains: a recipe
    // write is not an event, and `applyMakeRepeat` saves the recipe AFTER
    // its batch, so the reload the batch triggers reads the library too
    // early. The panel's own make buttons hide it behind their trailing
    // reload; the same command from the menu, Cmd+K or the REPEAT TOOL
    // leaves an open panel showing no repeat. Flip to `it` when a recipe
    // write reaches the panel.
    it.fails(
      "an OPEN panel shows a repeat built by the COMMAND, not only by its own button",
      async () => {
        await h.host.selection.set([poly("s2")]);
        const panel = await mountPanel(h, makeRepeatPanel);
        await drive(async () => {
          const made = await applyMakeRepeat(h.host, "grid", { columns: 2, rows: 1 });
          if (made.length !== 1) throw new Error("the repeat was not built");
        }, panel.work);
        // The document has it…
        expect((await readRepeatLibrary(h.host)).repeats).toHaveLength(1);
        // …MEASURED 0: the panel does not.
        expect(panel.count("[data-draw-repeat-row]")).toBe(1);
      },
    );
  });

  // COVERS: `reload()` on a document with R = 5 repeats among L = 40 plain
  // leaves. Each repeat is one source and one instance (a 2 × 1 grid), so
  // the document is 40 + 5 × 2 = 50 leaves. Nothing is selected unless a
  // line says so.
  describe("reload budgets (R = 5 repeats, L = 40 plain leaves, 50 leaves in all)", () => {
    let h: HeadlessHost;
    /** Walks one reload costs with 0, 1, … RECORDS repeats in the document. */
    const walksByRecords: number[] = [];

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", RECORDS)));
      h.loadBundle(drawBundle);
      const panel = await mountPanel(h, makeRepeatPanel);
      for (let k = 0; k <= RECORDS; k++) {
        if (k > 0) {
          await drive(async () => {
            await h.host.selection.set([poly(`s${k - 1}`)]);
            const made = await applyMakeRepeat(h.host, "grid", { columns: 2, rows: 1 });
            if (made.length !== 1) throw new Error(`repeat ${k} was not built`);
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
      expect((await readRepeatLibrary(h.host)).repeats).toHaveLength(RECORDS);
    });

    it("THE PER-RECORD WALK IS REAL: walks per reload grow with the record count", () => {
      // Index = records in the document. `resolveRepeat` walks once to
      // find "the only repeat the document carries" (skipped when the
      // library holds exactly one), then `repeatLinks(host, record.id)`
      // walks the WHOLE document again for each record.
      // TARGET [1, 1, 1, 1, 1, 1] — one walk, whatever R is.
      expect(walksByRecords).toEqual([1, 1, 3, 4, 5, 6]);
    });

    it("ONE reload = 6 walks = 306 reads + 8 part reads", async () => {
      const panel = await mountPanel(h, makeRepeatPanel);
      expect(panel.cost()).toEqual({ events: 0, walks: 6, reads: 306, partReads: 8 });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        events: 1,
        // (R + 1) walks. TARGET 1 per document revision, shared.
        walks: 6,
        // 6 × (1 tree + 50 getMetadata). TARGET 51.
        reads: 306,
        // The recipe is re-read by the panel, by `resolveRepeat`, and by
        // EVERY `repeatLinks` call (it is the only index of a clipped
        // instance): 2 + (R + 1). TARGET 1.
        partReads: 8,
      });
      expect(panel.work.count("document.getMetadata")).toBe(300);
    });

    it("a burst of 20 document changes = 20 reloads = 6120 reads", async () => {
      const panel = await mountPanel(h, makeRepeatPanel);
      expect(await documentBurst(h, panel)).toEqual({
        // No debounce, no cancellation. TARGET 1 (O(1) per burst).
        events: 20,
        walks: 120,
        // 20 × 306. TARGET 51 — one walk for the revision the burst ends on.
        reads: 6120,
        partReads: 160,
      });
    });

    it("a burst of 20 selection changes = 20 reloads = 6140 reads", async () => {
      const panel = await mountPanel(h, makeRepeatPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        // TARGET 1.
        events: 20,
        // The DOCUMENT did not change once during this burst. TARGET 0.
        walks: 120,
        // 20 × (306 + 1 read of the selected leaf's own link). TARGET 1.
        reads: 6140,
        partReads: 160,
      });
    });

    // BUG (measured) — the last reload to FINISH wins, not the last to
    // start; see blend-panel.spec.tsx for the mechanism. Here the older
    // reload's `setActive(null)` lands after the newer one resolved the
    // selected source to rep-1. Flip to `it` when a stale reload is
    // dropped.
    it.fails(
      "the panel ends on the LATEST selection when a slower, older reload is still in flight",
      async () => {
        const panel = await mountPanel(h, makeRepeatPanel);
        expect(panel.attr(PANEL, "data-draw-repeat-active")).toBe("");
        await selectDuringWalk(h, panel, [poly("s0")]);
        // MEASURED "".
        expect(panel.attr(PANEL, "data-draw-repeat-active")).toBe("rep-1");
      },
    );
  });
});
