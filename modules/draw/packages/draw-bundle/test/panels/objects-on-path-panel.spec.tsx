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

// The OBJECTS ON PATH panel, RENDERED (jsdom) against the real engine:
// behaviour first (empty state, records, buttons asserted on the
// DOCUMENT), then its reload budgets as counts at the host doors — the
// perf-budgets.spec.ts rules: MEASURED, target beside it, only lowered.
//
// WHAT WAS MEASURED, in one line: one walk of the whole document PER
// RECORD per reload.
//
// WHAT IT IS NOW (the history is beside each budget): one reload per
// burst, one walk per document REVISION out of the shared link index
// (`src/link-index.ts`), one part read per reload, the newest reload
// wins.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyMakeObjectsOnPath,
  applyReleaseObjectsOnPath,
  makeObjectsOnPathPanel,
  onPathObjectOf,
  onPathSpineOf,
  readObjectsOnPathLibrary,
  OBJECTS_ON_PATH_PANEL_ID,
  OBJECTS_ON_PATH_PANEL_NOTE,
} from "../../src";
import { openHost } from "../conformance/host";
import {
  documentBurst,
  drive,
  emptyDocument,
  leafIds,
  lineItem,
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

/** `count` trios: two objects `o<i>` / `q<i>` and, 100 pt below them, the
 *  60 pt open path `l<i>` they are put on. */
const trios = (count: number): string => {
  let lines = "";
  for (let i = 0; i < count; i++) {
    lines += lineItem(`l${i}`, 50 + i * 110, 140, 110 + i * 110, 140);
  }
  return seedRow("o", count) + seedRow("q", count, { x: 70 }) + lines;
};

const trio = (i: number): ElementId[] => [
  poly(`o${i}`),
  poly(`q${i}`),
  poly(`l${i}`), // the PATH goes last
];

const PANEL = "[data-draw-onpath-panel]";

describe("Objects on path panel — rendered against the engine", () => {
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
      const panel = await mountContributed(h, OBJECTS_ON_PATH_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-onpath-panel")).toBe("0");
      expect(panel.attr(PANEL, "data-draw-onpath-portable")).toBe("true");
      expect(panel.text()).toContain("Objects on Path (0)");
      expect(panel.text()).toContain(
        "Nothing on a path yet — select some objects, then the path.",
      );
      expect(panel.count("[data-draw-onpath-row]")).toBe(0);
      // Fewer than two selected items: there is no object AND path.
      expect(panel.disabled("[data-draw-onpath-make]")).toBe(true);
      expect(panel.get("[data-draw-onpath-note]").textContent).toBe(
        OBJECTS_ON_PATH_PANEL_NOTE,
      );
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      // The mount's own reload: one tree read (the link index, with no
      // leaf under it) and the library once. As found: the library twice
      // (the panel, then the resolve).
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        reads: 1,
        partReads: 1,
      });
    });
  });

  describe("behaviour (2 trios + 40 plain leaves)", () => {
    let h: HeadlessHost;
    const PRISTINE = 6 + PLAIN_LEAVES;
    const transformOf = async (id: ElementId) =>
      (await h.host.document.elementGeometry([id]))[0]?.itemTransform ?? null;
    let home: unknown;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(trios(2)));
      h.loadBundle(drawBundle);
      home = await transformOf(poly("o0"));
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the Spacing field appears only for the spacing distribution", async () => {
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      const fields = () =>
        panel
          .all("[data-draw-onpath-field]")
          .map((el) => el.getAttribute("data-draw-onpath-field"));
      expect(fields()).toEqual(["startOffsetPt"]);
      panel.change("[data-draw-onpath-distribute]", "spacing");
      expect(fields()).toEqual(["spacingPt", "startOffsetPt"]);
    });

    it("+ On path MOVES the selected objects onto the path, through the engine", async () => {
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      await drive(() => h.host.selection.set(trio(0)), panel.work);

      panel.reset();
      await panel.click("[data-draw-onpath-make]");

      // THE DOCUMENT: nothing was created, the objects moved, everything
      // is linked and the recipe is saved.
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect(await transformOf(poly("o0"))).not.toEqual(home);
      const library = await readObjectsOnPathLibrary(h.host);
      expect(
        library.associations.map((r) => [r.id, r.path?.id, r.objects.map((o) => o.id)]),
      ).toEqual([["op-1", "l0", ["o0", "q0"]]]);
      expect(onPathObjectOf(await h.host.document.getMetadata(poly("o0")))?.onPath).toBe(
        "op-1",
      );
      expect(onPathSpineOf(await h.host.document.getMetadata(poly("l0")))?.onPath).toBe(
        "op-1",
      );
      // ONE batch (the note's "ONE undo step"), and no refusal.
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
      expect(panel.work.count("log.warn")).toBe(0);

      // THE PANEL followed.
      expect(panel.attr(PANEL, "data-draw-onpath-panel")).toBe("1");
      expect(panel.attr(PANEL, "data-draw-onpath-active")).toBe("op-1");
      expect(panel.text()).toContain("On path 1");
      expect(panel.text()).toContain(
        "2 even · aligned · pivot center (2 objects on the path)",
      );
    });

    it("Update re-distributes with the options above it", async () => {
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      const before = await transformOf(poly("o0"));
      panel.change('[data-draw-onpath-field="startOffsetPt"]', "10");
      await panel.click("[data-draw-onpath-update]");

      const record = (await readObjectsOnPathLibrary(h.host)).associations[0]!;
      expect(record.params.startOffsetPt).toBe(10);
      expect(await transformOf(poly("o0"))).not.toEqual(before);
      expect(panel.text()).toContain("offset 10 pt");
    });

    // WAS A BUG (measured, then fixed) — the same one blend-panel.spec.tsx
    // pins, in this panel's copy of the code. With EXACTLY ONE record in
    // the library `resolveObjectsOnPath` answers that record whatever is
    // selected, and every reload ended in `if (saved)
    // setDraft(saved.params)`: the selection change a Make REQUIRES threw
    // away what was typed (the field read "10", the only record's saved
    // value). The form now follows the record (`useFollowedDraft`) and
    // takes its options only when the record, or what is saved for it,
    // changes.
    it(
      "typed options survive the selection change that + On path needs (one record in the library)",
      async () => {
        expect((await readObjectsOnPathLibrary(h.host)).associations).toHaveLength(1);
        const panel = await mountPanel(h, makeObjectsOnPathPanel);
        const offset = () =>
          panel.get<HTMLInputElement>('[data-draw-onpath-field="startOffsetPt"]')
            .value;
        await drive(() => h.host.selection.set([]), panel.work);
        panel.change('[data-draw-onpath-field="startOffsetPt"]', "25");
        expect(offset()).toBe("25");
        await drive(() => h.host.selection.set(trio(1)), panel.work);
        expect(offset()).toBe("25");
      },
    );

    it("Release puts every object back EXACTLY where it was", async () => {
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      await panel.click("[data-draw-onpath-release]");

      expect((await readObjectsOnPathLibrary(h.host)).associations).toEqual([]);
      expect(await transformOf(poly("o0"))).toEqual(home);
      expect(onPathObjectOf(await h.host.document.getMetadata(poly("o0")))).toBeNull();
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect(panel.count("[data-draw-onpath-row]")).toBe(0);
    });

    it("an OPEN panel follows the COMMAND too, not only its own buttons", async () => {
      // The contrast case, as it was found. Five of this panel's siblings
      // went stale when a record was made or removed by the command
      // instead of the panel's button (a recipe write is not an event —
      // see blend-panel.spec.tsx). This one was followed both ways even
      // then, because both verbs end in a selection change that lands
      // AFTER the recipe write. A recipe write announces itself now, so
      // it no longer depends on that — pinned so it stays true.
      await h.host.selection.set(trio(1));
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      await drive(() => applyMakeObjectsOnPath(h.host, {}), panel.work);
      expect(panel.count("[data-draw-onpath-row]")).toBe(1);
      const id = (await readObjectsOnPathLibrary(h.host)).associations[0]!.id;

      await drive(() => applyReleaseObjectsOnPath(h.host, { onPathId: id }), panel.work);
      expect((await readObjectsOnPathLibrary(h.host)).associations).toEqual([]);
      expect(panel.count("[data-draw-onpath-row]")).toBe(0);
    });
  });

  // COVERS: `reload()` on a document with R = 5 associations among L = 40
  // plain leaves. Each association is two objects and one path, so the
  // document is 40 + 5 × 3 = 55 leaves. Nothing is selected unless a line
  // says so.
  describe("reload budgets (R = 5 associations, L = 40 plain leaves, 55 leaves in all)", () => {
    let h: HeadlessHost;
    /** Walks one reload costs with 0, 1, … RECORDS associations. */
    const walksByRecords: number[] = [];

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(trios(RECORDS)));
      h.loadBundle(drawBundle);
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      for (let k = 0; k <= RECORDS; k++) {
        if (k > 0) {
          await drive(async () => {
            await h.host.selection.set(trio(k - 1));
            const made = await applyMakeObjectsOnPath(h.host, {});
            if (made.length !== 2) throw new Error(`association ${k} was not built`);
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
      expect((await readObjectsOnPathLibrary(h.host)).associations).toHaveLength(
        RECORDS,
      );
    });

    it("ONE WALK PER RELOAD, whatever the record count", () => {
      // Index = records in the document. One unfiltered
      // `objectsOnPathLinks`, out of the link index, is tallied for every
      // record at once. As found: [1, 1, 3, 4, 5, 6] —
      // `resolveObjectsOnPath` walked once to find "the only association
      // the document carries" (skipped when the library holds exactly
      // one), then `objectsOnPathLinks(host, record.id)` walked the WHOLE
      // document again for each record.
      expect(walksByRecords).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it("ONE reload = 1 walk = 56 reads", async () => {
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        reads: 56,
        partReads: 1,
      });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        events: 1,
        reloads: 1,
        // One walk per document REVISION, shared. As found: 6 — (R + 1).
        walks: 1,
        // 1 tree + 55 getMetadata, in parallel. As found: 336. TARGET 2 —
        // a tree and ONE bulk metadata read (RFI C-65).
        reads: 56,
        // As found: 2 (the panel, then the resolve).
        partReads: 1,
      });
      expect(panel.work.count("document.getMetadata")).toBe(55);
    });

    it("a burst of 20 document changes = ONE reload = 56 reads", async () => {
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      expect(await documentBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20 — no debounce, no cancellation.
        reloads: 1,
        // As found: 120.
        walks: 1,
        // One walk, of the revision the burst ends on. As found: 6 720.
        reads: 56,
        // As found: 40.
        partReads: 1,
      });
    });

    it("a burst of 20 selection changes = ONE reload = 0 reads", async () => {
      const panel = await mountPanel(h, makeObjectsOnPathPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20.
        reloads: 1,
        // The DOCUMENT did not change once during this burst. As found:
        // 120.
        walks: 0,
        // The selected leaf's own link is in the walk the mount read.
        // As found: 6 740.
        reads: 0,
        // As found: 40.
        partReads: 1,
      });
    });

    // WAS A BUG (measured, then fixed) — the last reload to FINISH won,
    // not the last to start, and the panel showed "" with an object of
    // op-1 selected; see blend-panel.spec.tsx for the mechanism.
    it(
      "the panel ends on the LATEST selection when a slower, older reload is still in flight",
      async () => {
        const panel = await mountPanel(h, makeObjectsOnPathPanel);
        expect(panel.attr(PANEL, "data-draw-onpath-active")).toBe("");
        await selectDuringWalk(h, panel, [poly("o0")]);
        expect(panel.attr(PANEL, "data-draw-onpath-active")).toBe("op-1");
        expect(panel.cost()).toMatchObject({ reloads: 2, walks: 1 });
      },
    );
  });
});
