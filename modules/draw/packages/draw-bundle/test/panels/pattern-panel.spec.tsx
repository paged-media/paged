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

// The PATTERN OPTIONS panel, RENDERED (jsdom) against the real engine:
// behaviour first (empty state, records, buttons asserted on the
// DOCUMENT), then its reload budgets as counts at the host doors — the
// perf-budgets.spec.ts rules: MEASURED, target beside it, only lowered.
//
// WHAT WAS MEASURED, in one line: TWO walks of the whole document per
// reload, whatever the record count — this panel does NOT walk per
// record (`patternLinks` is called once, unfiltered, and tallied).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyMakePattern,
  applyReleasePattern,
  makePatternPanel,
  patternSourceOf,
  patternTileOf,
  readPatternLibrary,
  PATTERN_PANEL_ID,
  PATTERN_PANEL_NOTE,
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

const PANEL = "[data-draw-pattern-panel]";

describe("Pattern options panel — rendered against the engine", () => {
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
      const panel = await mountContributed(h, PATTERN_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-pattern-panel")).toBe("0");
      expect(panel.attr(PANEL, "data-draw-pattern-portable")).toBe("true");
      expect(panel.text()).toContain("Pattern fields (0)");
      expect(panel.text()).toContain(
        "No pattern fields yet — select artwork and bake one.",
      );
      expect(panel.count("[data-draw-pattern-row]")).toBe(0);
      expect(panel.disabled("[data-draw-pattern-make]")).toBe(true);
      // The not-a-swatch boundary is on screen, verbatim.
      expect(panel.get("[data-draw-pattern-note]").textContent).toBe(
        PATTERN_PANEL_NOTE,
      );
      // No v0 tiles in this document, so no legacy line.
      expect(panel.count("[data-draw-pattern-legacy]")).toBe(0);
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      // TWO tree reads — the resolve's walk and the tally's — and the
      // library twice, for a document with nothing in it. TARGET 1 and 1.
      expect(panel.cost()).toEqual({
        reloads: 0,
        walks: 2,
        reads: 2,
        partReads: 2,
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

    it("+ From selection bakes, through the engine, what the form holds", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      await drive(() => h.host.selection.set([poly("s0")]), panel.work);
      expect(panel.disabled("[data-draw-pattern-make]")).toBe(false);
      panel.change('[data-draw-pattern-field="columns"]', "2");
      panel.change('[data-draw-pattern-field="rows"]', "1");

      panel.reset();
      await panel.click("[data-draw-pattern-make]");

      // THE DOCUMENT: one tile, linked both ways, the recipe saved.
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);
      const library = await readPatternLibrary(h.host);
      expect(
        library.fields.map((f) => [f.id, f.params.layout, f.params.columns, f.params.rows]),
      ).toEqual([["pat-1", "grid", 2, 1]]);
      expect(patternSourceOf(await h.host.document.getMetadata(poly("s0")))?.pattern).toBe(
        "pat-1",
      );
      const tiles = [];
      for (const id of await leafIds(h)) {
        const tile = patternTileOf(await h.host.document.getMetadata(id));
        if (tile) tiles.push(tile.pattern);
      }
      expect(tiles).toEqual(["pat-1"]);
      // TWO batches — the note's "Baking and re-planning are TWO undo
      // steps each" — and no refusal.
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch", "batch"]);
      expect(panel.work.count("log.warn")).toBe(0);

      // THE PANEL followed.
      expect(panel.attr(PANEL, "data-draw-pattern-panel")).toBe("1");
      expect(panel.attr(PANEL, "data-draw-pattern-active")).toBe("pat-1");
      expect(panel.text()).toContain("Pattern 1");
      expect(panel.text()).toContain("grid · 2 × 1 (1 copy requested, 1 placed)");
    });

    it("Re-plan rebuilds the field with the options above it", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      panel.change('[data-draw-pattern-field="columns"]', "3");
      await panel.click("[data-draw-pattern-replan]");

      expect((await readPatternLibrary(h.host)).fields[0]!.params.columns).toBe(3);
      expect(await leafIds(h)).toHaveLength(PRISTINE + 2);
      expect(panel.text()).toContain("grid · 3 × 1 (2 copies requested, 2 placed)");
    });

    // BUG (measured) — the same one blend-panel.spec.tsx pins, in this
    // panel's copy of the code. With EXACTLY ONE field in the library
    // `resolvePatternField` answers that field whatever is selected, and
    // every reload ends in `if (saved) setDraft(saved.params)`: the
    // selection change a bake REQUIRES throws away what was typed. Flip
    // to `it` when the reload stops overwriting a draft the user is
    // editing.
    it.fails(
      "typed options survive the selection change that a bake needs (one field in the library)",
      async () => {
        expect((await readPatternLibrary(h.host)).fields).toHaveLength(1);
        const panel = await mountPanel(h, makePatternPanel);
        const columns = () =>
          panel.get<HTMLInputElement>('[data-draw-pattern-field="columns"]').value;
        await drive(() => h.host.selection.set([]), panel.work);
        panel.change('[data-draw-pattern-field="columns"]', "7");
        expect(columns()).toBe("7");
        await drive(() => h.host.selection.set([poly("s1")]), panel.work);
        // MEASURED "3": the saved options of the only field in the library.
        expect(columns()).toBe("7");
      },
    );

    it("Delete tiles un-bakes: the copies and the recipe go, the source stays", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      await panel.click("[data-draw-pattern-unbake]");

      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect((await readPatternLibrary(h.host)).fields).toEqual([]);
      expect(patternSourceOf(await h.host.document.getMetadata(poly("s0")))).toBeNull();
      expect(panel.count("[data-draw-pattern-row]")).toBe(0);
      expect(panel.attr(PANEL, "data-draw-pattern-panel")).toBe("0");
    });

    it("Release drops the recipe and the links, and keeps the artwork", async () => {
      await h.host.selection.set([poly("s2")]);
      const tiles = await applyMakePattern(h.host, { columns: 2, rows: 1 });
      expect(tiles).toHaveLength(1);
      const panel = await mountPanel(h, makePatternPanel);
      expect(panel.count("[data-draw-pattern-row]")).toBe(1);

      await panel.click("[data-draw-pattern-release]");

      expect((await readPatternLibrary(h.host)).fields).toEqual([]);
      expect(patternSourceOf(await h.host.document.getMetadata(poly("s2")))).toBeNull();
      expect(patternTileOf(await h.host.document.getMetadata(tiles[0]!))).toBeNull();
      // The copy is ordinary artwork now — it is still there.
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);
      expect(panel.count("[data-draw-pattern-row]")).toBe(0);
    });

    // BUG (measured) — the one blend-panel.spec.tsx explains, seen from
    // the other end: a recipe write is not an event. A BAKE happens to be
    // followed (`applyMakePattern` saves the recipe before it emits), but
    // `applyReleasePattern` drops the recipe AFTER its last mutation, so
    // the reload that mutation triggers still reads the field. The
    // panel's own Release button hides it behind its trailing reload; the
    // same command from the menu or Cmd+K leaves an open panel showing a
    // field that no longer exists. Flip to `it` when a recipe write
    // reaches the panel.
    it.fails(
      "an OPEN panel drops a field released by the COMMAND, not only by its own button",
      async () => {
        await h.host.selection.set([poly("s1")]);
        expect(await applyMakePattern(h.host, { columns: 2, rows: 1 })).toHaveLength(1);
        const panel = await mountPanel(h, makePatternPanel);
        expect(panel.count("[data-draw-pattern-row]")).toBe(1);
        const field = (await readPatternLibrary(h.host)).fields[0]!.id;

        await drive(() => applyReleasePattern(h.host, { patternId: field }), panel.work);

        // The document has let go of it…
        expect((await readPatternLibrary(h.host)).fields).toEqual([]);
        // …MEASURED 1: the panel has not.
        expect(panel.count("[data-draw-pattern-row]")).toBe(0);
      },
    );
  });

  // COVERS: `reload()` on a document with R = 5 fields among L = 40 plain
  // leaves. Each field is one source and one tile (a 2 × 1 grid), so the
  // document is 40 + 5 × 2 = 50 leaves. Nothing is selected unless a line
  // says so.
  describe("reload budgets (R = 5 fields, L = 40 plain leaves, 50 leaves in all)", () => {
    let h: HeadlessHost;
    /** Walks one reload costs with 0, 1, … RECORDS fields in the document. */
    const walksByRecords: number[] = [];

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", RECORDS)));
      h.loadBundle(drawBundle);
      const panel = await mountPanel(h, makePatternPanel);
      for (let k = 0; k <= RECORDS; k++) {
        if (k > 0) {
          await drive(async () => {
            await h.host.selection.set([poly(`s${k - 1}`)]);
            const made = await applyMakePattern(h.host, { columns: 2, rows: 1 });
            if (made.length !== 1) throw new Error(`field ${k} was not baked`);
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
      expect((await readPatternLibrary(h.host)).fields).toHaveLength(RECORDS);
    });

    it("NO per-record walk here: two walks per reload, whatever the record count", () => {
      // Index = fields in the document. `resolvePatternField` walks once
      // to find "the only field the document carries" (skipped when the
      // library holds exactly one — hence the 1), then ONE unfiltered
      // `patternLinks` walk is tallied for every field at once.
      // TARGET [1, 1, 1, 1, 1, 1] — the two walks read the same leaves.
      expect(walksByRecords).toEqual([2, 1, 2, 2, 2, 2]);
    });

    it("ONE reload = 2 walks = 102 reads", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      expect(panel.cost()).toEqual({ reloads: 0, walks: 2, reads: 102, partReads: 2 });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        reloads: 1,
        // The resolve's walk, then the tally's. TARGET 1 per document
        // revision, shared.
        walks: 2,
        // 2 × (1 tree + 50 getMetadata). TARGET 51.
        reads: 102,
        // The library is read twice (the panel, then the resolve). TARGET 1.
        partReads: 2,
      });
      expect(panel.work.count("document.getMetadata")).toBe(100);
    });

    it("a burst of 20 document changes = 20 reloads = 2040 reads", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      expect(await documentBurst(h, panel)).toEqual({
        // No debounce, no cancellation. TARGET 1 (O(1) per burst).
        reloads: 20,
        walks: 40,
        // 20 × 102. TARGET 51 — one walk for the revision the burst ends on.
        reads: 2040,
        partReads: 40,
      });
    });

    it("a burst of 20 selection changes = 20 reloads = 2060 reads", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        // TARGET 1.
        reloads: 20,
        // The DOCUMENT did not change once during this burst. TARGET 0.
        walks: 40,
        // 20 × (102 + 1 read of the selected leaf's own link). TARGET 1.
        reads: 2060,
        partReads: 40,
      });
    });

    // BUG (measured) — the last reload to FINISH wins, not the last to
    // start; see blend-panel.spec.tsx for the mechanism. Flip to `it`
    // when a stale reload is dropped.
    it.fails(
      "the panel ends on the LATEST selection when a slower, older reload is still in flight",
      async () => {
        const panel = await mountPanel(h, makePatternPanel);
        expect(panel.attr(PANEL, "data-draw-pattern-active")).toBe("");
        await selectDuringWalk(h, panel, [poly("s0")]);
        // MEASURED "".
        expect(panel.attr(PANEL, "data-draw-pattern-active")).toBe("pat-1");
      },
    );
  });
});
