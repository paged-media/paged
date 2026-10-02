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

// The BLEND OPTIONS panel, RENDERED (jsdom) against the real engine.
//
// Three parts, a host each:
//   · AN EMPTY DOCUMENT — the component the bundle contributed, mounted
//     against a page with nothing on it.
//   · BEHAVIOUR — the records the bundle's own command created, and the
//     buttons calling through to the engine (asserted on the DOCUMENT,
//     never on a mock).
//   · RELOAD BUDGETS — what one reload, and a burst of them, costs at the
//     host doors. The rules are perf-budgets.spec.ts's: a budget is a
//     COUNT, written down as MEASURED with its target beside it, and only
//     ever lowered.
//
// WHAT WAS MEASURED, in one line: this panel walks the whole document
// ONCE PER RECORD, on every reload, and it reloads on every selection
// change and every document change with no debounce and no cancellation.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyMakeBlend,
  blendKeyOf,
  blendStepOf,
  makeBlendPanel,
  readBlendLibrary,
  BLEND_DEFAULTS,
  BLEND_PANEL_ID,
  BLEND_PANEL_NOTE,
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

/** `count` key pairs: `a<i>` and, 60 pt to its right, `b<i>`. */
const keyPairs = (count: number): string =>
  seedRow("a", count) + seedRow("b", count, { x: 100 });

const PANEL = "[data-draw-blend-panel]";

describe("Blend options panel — rendered against the engine", () => {
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
      const panel = await mountContributed(h, BLEND_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-blend-panel")).toBe("0");
      expect(panel.attr(PANEL, "data-draw-blend-portable")).toBe("true");
      expect(panel.attr(PANEL, "data-draw-blend-active")).toBe("");
      expect(panel.text()).toContain("Blends (0)");
      expect(panel.text()).toContain(
        "No blends yet — select two matching paths and build one.",
      );
      expect(panel.count("[data-draw-blend-row]")).toBe(0);
      // Nothing is selected, so there is nothing to blend.
      expect(panel.disabled("[data-draw-blend-make]")).toBe(true);
      // The honesty note is on screen, verbatim.
      expect(panel.get("[data-draw-blend-note]").textContent).toBe(
        BLEND_PANEL_NOTE,
      );
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      // One tree read (the resolve looking for "the only blend") and the
      // library twice. TARGET 1 tree per document revision, 1 part read.
      expect(panel.cost()).toEqual({
        reloads: 0,
        walks: 1,
        reads: 1,
        partReads: 2,
      });
    });
  });

  describe("behaviour (3 key pairs + 40 plain leaves)", () => {
    let h: HeadlessHost;
    const PRISTINE = 6 + PLAIN_LEAVES;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(keyPairs(3)));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the form previews the PLAN as it is typed, and writes nothing", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      expect(panel.attr("[data-draw-blend-preview]", "data-draw-blend-preview")).toBe(
        String(BLEND_DEFAULTS.steps),
      );
      panel.reset();
      panel.change('[data-draw-blend-field="steps"]', "7");
      expect(panel.attr("[data-draw-blend-preview]", "data-draw-blend-preview")).toBe(
        "7",
      );
      // Specified Distance swaps the Steps field for a distance one.
      panel.change("[data-draw-blend-spacing]", "distance");
      expect(panel.count('[data-draw-blend-field="steps"]')).toBe(0);
      expect(panel.count('[data-draw-blend-field="distancePt"]')).toBe(1);
      // Typing is local state: no door was touched, the document least of
      // all (the catalog's "live preview" is a preview of the plan).
      expect(panel.work.calls).toEqual({});
      expect(await leafIds(h)).toHaveLength(PRISTINE);
    });

    it("+ Blend builds, through the engine, what the form holds", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      await drive(() => h.host.selection.set([poly("a0"), poly("b0")]), panel.work);
      expect(panel.disabled("[data-draw-blend-make]")).toBe(false);
      panel.change('[data-draw-blend-field="steps"]', "2");

      panel.reset();
      await panel.click("[data-draw-blend-make]");

      // THE DOCUMENT: two intermediates, the keys linked, the recipe saved.
      expect(await leafIds(h)).toHaveLength(PRISTINE + 2);
      const library = await readBlendLibrary(h.host);
      expect(library.blends.map((b) => [b.id, b.params.steps, b.steps.length])).toEqual(
        [["bl-1", 2, 2]],
      );
      expect(blendKeyOf(await h.host.document.getMetadata(poly("a0")))?.blend).toBe(
        "bl-1",
      );
      for (const step of library.blends[0]!.steps) {
        expect(
          blendStepOf(await h.host.document.getMetadata(poly(step.id)))?.blend,
        ).toBe("bl-1");
      }
      // ONE batch (the panel note's "ONE undo step"), and no refusal.
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
      expect(panel.work.count("log.warn")).toBe(0);

      // THE PANEL followed.
      expect(panel.attr(PANEL, "data-draw-blend-panel")).toBe("1");
      expect(panel.count("[data-draw-blend-row]")).toBe(1);
      expect(panel.text()).toContain("Blend 1");
      expect(panel.text()).toContain("2 steps (2 intermediates placed)");

      // MEASURED: one click is THREE reloads — the batch's document event,
      // the selection the command sets, and the button's own trailing
      // `void reload()` (not an event, so not in this count). TARGET 1.
      expect(panel.cost().reloads).toBe(2);
    });

    it("Update rebuilds the record with the options above it", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      panel.change('[data-draw-blend-field="steps"]', "4");
      await panel.click("[data-draw-blend-update]");

      const library = await readBlendLibrary(h.host);
      expect(library.blends[0]!.params.steps).toBe(4);
      expect(library.blends[0]!.steps).toHaveLength(4);
      expect(await leafIds(h)).toHaveLength(PRISTINE + 4);
      expect(panel.text()).toContain("4 steps (4 intermediates placed)");
    });

    // BUG (measured). With EXACTLY ONE record in the library `resolveBlend`
    // answers that record whatever is selected, and every reload ends in
    // `if (saved) setDraft(saved.params)` — so every selection change and
    // every document change throws away what was typed into the form. The
    // selection change here is the one "+ Blend" REQUIRES (it needs two
    // selected objects), so a second blend cannot be built with options
    // typed beforehand: the form shows the first blend's again, and that
    // is what gets built. With zero records, or with two or more, the
    // form survives. Flip to `it` when the reload stops overwriting a
    // draft the user is editing.
    it.fails(
      "typed options survive the selection change that + Blend needs (one record in the library)",
      async () => {
        expect((await readBlendLibrary(h.host)).blends).toHaveLength(1);
        const panel = await mountPanel(h, makeBlendPanel);
        const steps = () =>
          panel.get<HTMLInputElement>('[data-draw-blend-field="steps"]').value;
        await drive(() => h.host.selection.set([]), panel.work);
        panel.change('[data-draw-blend-field="steps"]', "9");
        expect(steps()).toBe("9");
        await drive(() => h.host.selection.set([poly("a1"), poly("b1")]), panel.work);
        // MEASURED "4": the saved options of the only blend in the library.
        expect(steps()).toBe("9");
      },
    );

    it("Release removes the intermediates and the record, and keeps the keys", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      await panel.click("[data-draw-blend-release]");

      expect((await readBlendLibrary(h.host)).blends).toEqual([]);
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect(blendKeyOf(await h.host.document.getMetadata(poly("a0")))).toBeNull();
      expect(panel.count("[data-draw-blend-row]")).toBe(0);
      expect(panel.attr(PANEL, "data-draw-blend-panel")).toBe("0");
    });

    // BUG (measured). The panel reloads on document events, selection
    // events and its own buttons (each ends in `void reload()`) — and a
    // `.paged` container-part write is none of those. `applyMakeBlend`
    // builds the artwork first and saves the recipe LAST, so the reload
    // the batch triggers reads the library BEFORE the record is in it,
    // and nothing reloads afterwards. The "+ Blend" button hides this
    // behind its trailing reload; the SAME command run from the menu or
    // Cmd+K leaves an open panel showing no blend, until some unrelated
    // selection or document change comes along. Flip to `it` when a
    // recipe write reaches the panel.
    it.fails(
      "an OPEN panel shows a blend built by the COMMAND, not only by its own button",
      async () => {
        await h.host.selection.set([poly("a2"), poly("b2")]);
        const panel = await mountPanel(h, makeBlendPanel);
        await drive(async () => {
          const made = await applyMakeBlend(h.host, { spacing: "steps", steps: 1 });
          if (made.length !== 1) throw new Error("the blend was not built");
        }, panel.work);
        // The document has it…
        expect((await readBlendLibrary(h.host)).blends).toHaveLength(1);
        // …MEASURED 0: the panel does not.
        expect(panel.count("[data-draw-blend-row]")).toBe(1);
      },
    );
  });

  // COVERS: `reload()` on a document with R = 5 blends among L = 40 plain
  // leaves. Each blend is two keys and one intermediate, so the document
  // is 40 + 5 × 3 = 55 leaves. Nothing is selected unless a line says so.
  describe("reload budgets (R = 5 blends, L = 40 plain leaves, 55 leaves in all)", () => {
    let h: HeadlessHost;
    /** Walks one reload costs with 0, 1, … RECORDS blends in the document. */
    const walksByRecords: number[] = [];

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(keyPairs(RECORDS)));
      h.loadBundle(drawBundle);
      const panel = await mountPanel(h, makeBlendPanel);
      for (let k = 0; k <= RECORDS; k++) {
        if (k > 0) {
          await drive(async () => {
            await h.host.selection.set([poly(`a${k - 1}`), poly(`b${k - 1}`)]);
            const made = await applyMakeBlend(h.host, { spacing: "steps", steps: 1 });
            if (made.length !== 1) throw new Error(`blend ${k} was not built`);
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
      expect(await leafIds(h)).toHaveLength(PLAIN_LEAVES + RECORDS * 3);
      expect((await readBlendLibrary(h.host)).blends).toHaveLength(RECORDS);
    });

    it("THE PER-RECORD WALK IS REAL: walks per reload grow with the record count", () => {
      // Index = records in the document. `resolveBlend` walks once to find
      // "the only blend the document carries" (skipped when the library
      // holds exactly one), then `blendLinks(host, record.id)` walks the
      // WHOLE document again for each record, to count three links.
      // TARGET [1, 1, 1, 1, 1, 1] — one walk, whatever R is.
      expect(walksByRecords).toEqual([1, 1, 3, 4, 5, 6]);
    });

    it("ONE reload = 6 walks = 336 reads", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      // The mount reload and an event-driven one cost the same.
      expect(panel.cost()).toEqual({ reloads: 0, walks: 6, reads: 336, partReads: 2 });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        reloads: 1,
        // (R + 1) walks. TARGET 1 per document revision, shared by every
        // panel that needs the links.
        walks: 6,
        // 6 × (1 tree + 55 getMetadata). TARGET 56.
        reads: 336,
        // The library is read twice (the panel, then `resolveBlend`).
        // TARGET 1.
        partReads: 2,
      });
      expect(panel.work.count("document.getMetadata")).toBe(330);
    });

    it("a burst of 20 document changes = 20 reloads = 6720 reads", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      expect(await documentBurst(h, panel)).toEqual({
        // No debounce, no cancellation: every change starts a reload and
        // every reload runs to the end. TARGET 1 (O(1) per burst).
        reloads: 20,
        walks: 120,
        // 20 × 336. TARGET 56 — one walk for the revision the burst ends on.
        reads: 6720,
        partReads: 40,
      });
    });

    it("a burst of 20 selection changes = 20 reloads = 6740 reads", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        // TARGET 1.
        reloads: 20,
        // The DOCUMENT did not change once during this burst. TARGET 0.
        walks: 120,
        // 20 × (336 + 1 read of the selected leaf's own link). TARGET 1 —
        // the one read the final selection needs.
        reads: 6740,
        partReads: 40,
      });
    });

    // BUG (measured). Reloads are not cancelled and not sequenced, so the
    // LAST ONE TO FINISH wins rather than the last one to start. A reload
    // that began with nothing selected spends a whole walk inside
    // `resolveBlend` before it calls `setActive(null)`; one that began
    // later, with a blend's key selected, resolves in ONE read — and is
    // then overwritten by the older reload when that finally lands. The
    // panel says "no active blend" while a key of bl-1 is selected, and
    // keeps saying it until something else triggers a reload. In the
    // editor every read is a worker round trip, so the window is the
    // walk's duration. Flip to `it` when a stale reload is dropped.
    it.fails(
      "the panel ends on the LATEST selection when a slower, older reload is still in flight",
      async () => {
        const panel = await mountPanel(h, makeBlendPanel);
        expect(panel.attr(PANEL, "data-draw-blend-active")).toBe("");
        // Reload A (nothing selected) is walking when a key of bl-1 is
        // selected and reload B starts.
        await selectDuringWalk(h, panel, [poly("a0")]);
        // MEASURED "": reload A's `setActive(null)` landed last.
        expect(panel.attr(PANEL, "data-draw-blend-active")).toBe("bl-1");
      },
    );
  });
});
