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
// reload, whatever the record count — this panel did NOT walk per
// record (`patternLinks` is called once, unfiltered, and tallied).
//
// WHAT IT IS NOW (the history is beside each budget): one reload per
// burst, one walk per document REVISION out of the shared link index
// (`src/link-index.ts`), one part read per reload, the newest reload
// wins.

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
  slowRecipeWrites,
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
      // The mount's own reload: one tree read (the link index, with no
      // leaf under it) and the library once. As found: TWO tree reads —
      // the resolve's walk and the tally's — and the library twice, for
      // a document with nothing in it.
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        reads: 1,
        partReads: 1,
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
      // ONE batch, and no refusal. It was two until the bake named what
      // it inserted (`bindCreated`) — and the panel's own note still says
      // "Baking and re-planning are TWO undo steps each", which this
      // count has now overtaken: the NOTE is what is stale.
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
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

    // WAS A BUG (measured, then fixed) — the same one blend-panel.spec.tsx
    // pins, in this panel's copy of the code. With EXACTLY ONE field in
    // the library `resolvePatternField` answers that field whatever is
    // selected, and every reload ended in `if (saved)
    // setDraft(saved.params)`: the selection change a bake REQUIRES threw
    // away what was typed (the field read "3", the only field's saved
    // value). The form now follows the record (`useFollowedDraft`) and
    // takes its options only when the record, or what is saved for it,
    // changes.
    it(
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

    // WAS A BUG (measured, then fixed) — the one blend-panel.spec.tsx
    // explains, seen from the other end: a recipe write is not an event.
    // A BAKE happened to be followed (`applyMakePattern` saves the recipe
    // before it emits), but `applyReleasePattern` drops the recipe AFTER
    // its last mutation, so the reload that mutation triggered still read
    // the field. The panel's own Release button hid it behind its
    // trailing reload; the same command from the menu or Cmd+K left an
    // open panel showing a field that no longer existed (1 row).
    // `writePatternLibrary` now announces the write, and the panel
    // reloads on that.
    it(
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
        // …and so has the panel.
        expect(panel.count("[data-draw-pattern-row]")).toBe(0);
      },
    );

    // The same, in the order the EDITOR has (see blend-panel.spec.tsx):
    // the recipe write lands a task after the reload the mutation
    // started. This is the case that fails without the announcement —
    // with the headless engine's synchronous replies the whole command
    // is over before that reload starts.
    it("…and when the recipe write lands AFTER the reload its mutation started", async () => {
      await h.host.selection.set([poly("s1")]);
      expect(await applyMakePattern(h.host, { columns: 2, rows: 1 })).toHaveLength(1);
      const panel = await mountPanel(h, makePatternPanel);
      expect(panel.count("[data-draw-pattern-row]")).toBe(1);
      const field = (await readPatternLibrary(h.host)).fields[0]!.id;

      await drive(
        () => applyReleasePattern(slowRecipeWrites(h.host), { patternId: field }),
        panel.work,
      );

      expect((await readPatternLibrary(h.host)).fields).toEqual([]);
      expect(panel.count("[data-draw-pattern-row]")).toBe(0);
    });
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

    it("ONE WALK PER RELOAD, whatever the record count", () => {
      // Index = fields in the document. One unfiltered `patternLinks`,
      // out of the link index, serves the resolve and the tally both.
      // As found: [2, 1, 2, 2, 2, 2] — `resolvePatternField` walked once
      // to find "the only field the document carries" (skipped when the
      // library holds exactly one — hence the 1), then the tally walked
      // the same leaves again.
      expect(walksByRecords).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it("ONE reload = 1 walk = 51 reads", async () => {
      const panel = await mountPanel(h, makePatternPanel);
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
        // One walk per document REVISION, shared. As found: 2 — the
        // resolve's, then the tally's.
        walks: 1,
        // 1 tree + 50 getMetadata, in parallel. As found: 102. TARGET 2 —
        // a tree and ONE bulk metadata read (RFI C-65).
        reads: 51,
        // As found: 2 (the panel, then the resolve).
        partReads: 1,
      });
      expect(panel.work.count("document.getMetadata")).toBe(50);
    });

    it("a burst of 20 document changes = ONE reload = 51 reads", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      expect(await documentBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20 — no debounce, no cancellation.
        reloads: 1,
        // As found: 40.
        walks: 1,
        // One walk, of the revision the burst ends on. As found: 2 040.
        reads: 51,
        // As found: 40.
        partReads: 1,
      });
    });

    it("a burst of 20 selection changes = ONE reload = 0 reads", async () => {
      const panel = await mountPanel(h, makePatternPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20.
        reloads: 1,
        // The DOCUMENT did not change once during this burst. As found:
        // 40.
        walks: 0,
        // The selected leaf's own link is in the walk the mount read.
        // As found: 2 060.
        reads: 0,
        // As found: 40.
        partReads: 1,
      });
    });

    // WAS A BUG (measured, then fixed) — the last reload to FINISH won,
    // not the last to start, and the panel showed "" with a source of
    // pat-1 selected; see blend-panel.spec.tsx for the mechanism.
    it(
      "the panel ends on the LATEST selection when a slower, older reload is still in flight",
      async () => {
        const panel = await mountPanel(h, makePatternPanel);
        expect(panel.attr(PANEL, "data-draw-pattern-active")).toBe("");
        await selectDuringWalk(h, panel, [poly("s0")]);
        expect(panel.attr(PANEL, "data-draw-pattern-active")).toBe("pat-1");
        expect(panel.cost()).toMatchObject({ reloads: 2, walks: 1 });
      },
    );
  });
});
