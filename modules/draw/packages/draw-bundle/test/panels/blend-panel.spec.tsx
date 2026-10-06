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
// WHAT WAS MEASURED, in one line: this panel walked the whole document
// ONCE PER RECORD, on every reload, and it reloaded on every selection
// change and every document change with no debounce and no cancellation.
//
// WHAT IT IS NOW (the history is beside each budget): one reload per
// burst, one walk per document REVISION out of the shared link index
// (`src/link-index.ts`), and the newest reload wins.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { metadataReadsPerLeaf } from "../engine-reads";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyMakeBlend,
  applyReleaseBlend,
  applyUpdateBlend,
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
  slowRecipeWrites,
  teardownPanels,
  unmountAll,
  PLAIN_LEAVES,
  RECORDS,
} from "./harness";

/** `count` key pairs: `a<i>` and, 60 pt to its right, `b<i>`. */
const keyPairs = (count: number): string =>
  seedRow("a", count) + seedRow("b", count, { x: 100 });

const PANEL = "[data-draw-blend-panel]";


/** Per-leaf `getMetadata` one link walk costs on this engine (RFI C-65:
 *  1 before tree rows carried metadata, 0 after), and what a walk over
 *  this file's 55 leaves therefore reads besides the tree. */
let perLeaf: 0 | 1 = 1;
const leafReads = (): number => 55 * perLeaf;

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
      // The mount's own reload: one tree read (the link index, with no
      // leaf under it) and the library once. As found: the library twice
      // (the panel, then `resolveBlend`).
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        // +1 since the object model (ADR 323/559): with NO library part the
        // read asks the DOCUMENT LABEL, which carries the library after an
        // InDesign save drops every part (src/recipe-store.ts).
        reads: 2,
        partReads: 1,
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

      // ONE reload for the click. As found it was three: the batch's
      // document event, the selection the command sets, and the button's
      // own trailing reload each started one. They are still three
      // requests (four with the recipe write's) — and one reload.
      expect(panel.cost().events).toBe(2);
      expect(panel.cost().reloads).toBe(1);
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

    // WAS A BUG (measured, then fixed). With EXACTLY ONE record in the
    // library `resolveBlend` answers that record whatever is selected, and
    // every reload ended in `if (saved) setDraft(saved.params)` — so every
    // selection change and every document change threw away what was
    // typed into the form. The selection change here is the one "+ Blend"
    // REQUIRES (it needs two selected objects), so a second blend could
    // not be built with options typed beforehand: the form showed the
    // first blend's again ("4"), and that is what got built. The form now
    // FOLLOWS the record (`useFollowedDraft`): it takes the saved options
    // when the record it follows, or what is saved for it, changes — not
    // on every reload.
    it(
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
        expect(steps()).toBe("9");
        // A document change that touches no record leaves it alone too.
        await drive(() => plainChange(h, 3), panel.work);
        expect(steps()).toBe("9");
      },
    );

    it("the form still takes the saved options when what is SAVED changes", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      const steps = () =>
        panel.get<HTMLInputElement>('[data-draw-blend-field="steps"]').value;
      expect(steps()).toBe("4");
      // An update from OUTSIDE the panel — the command, with its own
      // options — is a change to the record this form follows.
      await drive(
        () => applyUpdateBlend(h.host, { blendId: "bl-1", steps: 3 }),
        panel.work,
      );
      expect((await readBlendLibrary(h.host)).blends[0]!.params.steps).toBe(3);
      expect(steps()).toBe("3");
      await drive(
        () => applyUpdateBlend(h.host, { blendId: "bl-1", steps: 4 }),
        panel.work,
      );
      expect(steps()).toBe("4");
    });

    it("Release removes the intermediates and the record, and keeps the keys", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      await panel.click("[data-draw-blend-release]");

      expect((await readBlendLibrary(h.host)).blends).toEqual([]);
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect(blendKeyOf(await h.host.document.getMetadata(poly("a0")))).toBeNull();
      expect(panel.count("[data-draw-blend-row]")).toBe(0);
      expect(panel.attr(PANEL, "data-draw-blend-panel")).toBe("0");
    });

    // WAS A BUG (measured, then fixed). The panel reloaded on document
    // events, selection events and its own buttons (each ended in `void
    // reload()`) — and a `.paged` container-part write is none of those.
    // `applyMakeBlend` builds the artwork first and saves the recipe LAST,
    // so the reload the batch triggered read the library BEFORE the
    // record was in it, and nothing reloaded afterwards. The "+ Blend"
    // button hid this behind its trailing reload; the SAME command run
    // from the menu or Cmd+K left an open panel showing no blend (0
    // rows), until some unrelated selection or document change came
    // along. A recipe write now ANNOUNCES itself (`announceRecipeChange`,
    // called by `writeBlendLibrary`), and the panel reloads on that as it
    // does on a document event.
    it(
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
        // …and so does the panel.
        expect(panel.count("[data-draw-blend-row]")).toBe(1);
      },
    );

    // The case above cannot tell the announcement from luck: the headless
    // engine answers synchronously, so the whole command — recipe write
    // included — finishes before the reload its batch requested starts.
    // In the editor every door is a worker round trip, and that reload
    // starts (and reads the library) while the write is still out. This
    // is that ordering, made on purpose: the recipe write is held for a
    // task. Without the announcement the panel ends on the row count it
    // read too early.
    it("…and when the recipe write lands AFTER the reload its batch started", async () => {
      await drive(() => applyReleaseBlend(h.host, { blendId: "bl-1" }));
      expect((await readBlendLibrary(h.host)).blends).toEqual([]);
      await h.host.selection.set([poly("a2"), poly("b2")]);
      const panel = await mountPanel(h, makeBlendPanel);
      expect(panel.count("[data-draw-blend-row]")).toBe(0);

      panel.reset();
      await drive(async () => {
        const made = await applyMakeBlend(slowRecipeWrites(h.host), {
          spacing: "steps",
          steps: 1,
        });
        if (made.length !== 1) throw new Error("the blend was not built");
      }, panel.work);

      // TWO reloads, and that is the point: the one the batch started
      // read an empty library, the one the write announced read the
      // record.
      expect(panel.cost().reloads).toBe(2);
      expect(panel.count("[data-draw-blend-row]")).toBe(1);
    });
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
      perLeaf = await metadataReadsPerLeaf(h.host);
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

    it("ONE WALK PER RELOAD, whatever the record count", () => {
      // Index = records in the document. One unfiltered `blendLinks`,
      // out of the link index, is tallied for every record at once.
      // As found: [1, 1, 3, 4, 5, 6] — `resolveBlend` walked once to find
      // "the only blend the document carries" (skipped when the library
      // holds exactly one), then `blendLinks(host, record.id)` walked the
      // WHOLE document again for each record, to count three links.
      expect(walksByRecords).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it("ONE reload = 1 walk = 56 reads", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      // The mount reload and an event-driven one cost the same.
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        reads: 1 + leafReads(),
        partReads: 1,
      });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        events: 1,
        reloads: 1,
        // One walk per document REVISION, shared by every panel and every
        // command on this host. As found: 6 — (R + 1) per reload.
        walks: 1,
        // 1 tree + 55 getMetadata: one read per leaf, in parallel. As
        // found: 336. TARGET 2 — a tree and ONE bulk metadata read; the
        // 55 are the engine gap (RFI C-65), not the panel's.
        reads: 1 + leafReads(),
        // As found: 2 (the panel, then `resolveBlend`).
        partReads: 1,
      });
      expect(panel.work.count("document.getMetadata")).toBe(leafReads());
    });

    it("a burst of 20 document changes = ONE reload = 56 reads", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      expect(await documentBurst(h, panel)).toEqual({
        events: 20,
        // Twenty requests, one reload: they all arrive before the task
        // the first one armed. As found: 20 reloads, every one run to
        // the end.
        reloads: 1,
        // As found: 120.
        walks: 1,
        // One walk, of the revision the burst ends on. As found: 6 720.
        reads: 1 + leafReads(),
        // As found: 40.
        partReads: 1,
      });
    });

    it("a burst of 20 selection changes = ONE reload = 0 reads", async () => {
      const panel = await mountPanel(h, makeBlendPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20.
        reloads: 1,
        // The DOCUMENT did not change once during this burst, so the
        // links the mount read are still the links. As found: 120.
        walks: 0,
        // Not even the selected leaf's own link — it is in that walk.
        // As found: 6 740.
        reads: 0,
        // As found: 40.
        partReads: 1,
      });
    });

    // WAS A BUG (measured, then fixed). Reloads were not cancelled and not
    // sequenced, so the LAST ONE TO FINISH won rather than the last one to
    // start. A reload that began with nothing selected spent a whole walk
    // inside `resolveBlend` before it called `setActive(null)`; one that
    // began later, with a blend's key selected, resolved in ONE read — and
    // was then overwritten by the older reload when that finally landed.
    // The panel said "no active blend" ("") while a key of bl-1 was
    // selected, and kept saying it until something else triggered a
    // reload. In the editor every read is a worker round trip, so the
    // window is the walk's duration. A reload now holds a ticket and shows
    // nothing once a newer one has started (`src/panels/reload.ts`).
    it(
      "the panel ends on the LATEST selection when a slower, older reload is still in flight",
      async () => {
        const panel = await mountPanel(h, makeBlendPanel);
        expect(panel.attr(PANEL, "data-draw-blend-active")).toBe("");
        // Reload A (nothing selected) is walking when a key of bl-1 is
        // selected and reload B starts.
        await selectDuringWalk(h, panel, [poly("a0")]);
        expect(panel.attr(PANEL, "data-draw-blend-active")).toBe("bl-1");
        // Both reloads started, and they shared ONE walk: B asked for the
        // links while A's walk was out, and got the same one.
        expect(panel.cost()).toMatchObject({ reloads: 2, walks: 1 });
      },
    );
  });
});
