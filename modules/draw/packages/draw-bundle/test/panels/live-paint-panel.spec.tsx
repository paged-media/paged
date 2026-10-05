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

// The LIVE PAINT panel, RENDERED (jsdom) against the real engine:
// behaviour first (empty state, records, buttons asserted on the
// DOCUMENT), then its reload budgets as counts at the host doors — the
// perf-budgets.spec.ts rules: MEASURED, target beside it, only lowered.
//
// WHAT WAS MEASURED, in one line: ONE walk per reload, whatever the
// record count, plus the swatch collection — re-read on every selection
// change, which cannot have changed it.
//
// WHAT IT IS NOW (the history is beside each budget): one reload per
// burst; the links (out of the shared link index, `src/link-index.ts`)
// and the swatch collection once per document REVISION, so a selection
// change reads neither; one part read per reload.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { metadataReadsPerLeaf } from "../engine-reads";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyDeleteLivePaintFace,
  applyFillLivePaintFace,
  applyMakeLivePaintGroup,
  getLivePaintFill,
  livePaintFillOf,
  livePaintMemberOf,
  makeLivePaintPanel,
  readLivePaintLibrary,
  setLivePaintFill,
  LIVE_PAINT_DEFAULT_FILL,
  LIVE_PAINT_NOTE,
  LIVE_PAINT_PANEL_ID,
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
  selectionBurst,
  slowRecipeWrites,
  teardownPanels,
  unmountAll,
  PLAIN_LEAVES,
  RECORDS,
} from "./harness";

/** `count` overlapping pairs: a 40 pt square `a<i>` and `b<i>`, the same
 *  square shifted 20 pt right and down — three faces per pair. */
const overlapPairs = (count: number): string =>
  seedRow("a", count, { size: 40 }) +
  seedRow("b", count, { x: 60, y: 60, size: 40 });

const pair = (i: number): ElementId[] => [poly(`a${i}`), poly(`b${i}`)];

const PANEL = "[data-draw-live-paint-panel]";
const ROW = '[data-draw-live-paint-row="lp-1"]';


/** Per-leaf `getMetadata` one link walk costs on this engine (RFI C-65:
 *  1 before tree rows carried metadata, 0 after), and what a walk over
 *  this file's 50 leaves therefore reads besides the tree. */
let perLeaf: 0 | 1 = 1;
const leafReads = (): number => 50 * perLeaf;

describe("Live paint panel — rendered against the engine", () => {
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
      const panel = await mountContributed(h, LIVE_PAINT_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-live-paint-panel")).toBe("0");
      expect(panel.attr(PANEL, "data-draw-live-paint-portable")).toBe("true");
      expect(panel.text()).toContain("Live Paint (0)");
      expect(panel.text()).toContain(
        "No Live Paint groups yet — select two or more overlapping paths and record them.",
      );
      expect(panel.count("[data-draw-live-paint-row]")).toBe(0);
      expect(panel.disabled("[data-draw-live-paint-make]")).toBe(true);
      expect(panel.get("[data-draw-live-paint-note]").textContent).toBe(
        LIVE_PAINT_NOTE,
      );
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      // The mount's own reload: one tree read (the link index, with no
      // leaf under it), the swatch collection, and the recipe once. As
      // found: the recipe twice (the panel, then
      // `selectedLivePaintGroup`).
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        reads: 2,
        partReads: 1,
      });
    });
  });

  describe("behaviour (3 overlapping pairs + 40 plain leaves)", () => {
    let h: HeadlessHost;
    const PRISTINE = 6 + PLAIN_LEAVES;
    /** Every leaf carrying a painted-face link, with the face it paints. */
    const fills = async (): Promise<{ id: ElementId; face: string }[]> => {
      const out: { id: ElementId; face: string }[] = [];
      for (const id of await leafIds(h)) {
        const fill = livePaintFillOf(await h.host.document.getMetadata(id));
        if (fill) out.push({ id, face: fill.face });
      }
      return out;
    };
    /** Paint lp-1's overlap face through the bundle's own command — the
     *  lane the bucket tool rides. */
    const paintOverlap = (): Promise<string[]> =>
      applyFillLivePaintFace(h.host, { groupId: "lp-1", x: 70, y: 70 });

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(overlapPairs(3)));
      h.loadBundle(drawBundle);
    });
    afterAll(() => {
      setLivePaintFill(LIVE_PAINT_DEFAULT_FILL);
      h?.dispose();
    });
    afterEach(() => teardownPanels(h));

    it("the bucket-fill select lists the document's swatches and drives the tool's fill", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      const options = Array.from(
        panel.get<HTMLSelectElement>("[data-draw-live-paint-fill]").options,
      ).map((o) => o.value);
      // "(none)" first, then every swatch the engine reports.
      expect(options[0]).toBe("");
      expect(options).toContain("Color/Black");

      // The select is the ONLY writer of the bucket tool's fill (module
      // state in handlers/live-paint.ts) — no document door is involved.
      panel.reset();
      panel.change("[data-draw-live-paint-fill]", "");
      expect(getLivePaintFill()).toBeNull();
      panel.change("[data-draw-live-paint-fill]", "Color/Black");
      expect(getLivePaintFill()).toBe("Color/Black");
      expect(panel.work.calls).toEqual({});
    });

    it("+ From selection records the selected paths as a recipe, through the engine", async () => {
      await h.host.selection.set(pair(0));
      const panel = await mountPanel(h, makeLivePaintPanel);
      panel.reset();
      await panel.click("[data-draw-live-paint-make]");

      // THE DOCUMENT: nothing is created — the members are stamped and
      // the recipe is saved.
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      const library = await readLivePaintLibrary(h.host);
      expect(
        library.groups.map((g) => [g.id, g.name, g.inputs.length, g.faces.length]),
      ).toEqual([["lp-1", "Live Paint 1", 2, 0]]);
      for (const member of pair(0)) {
        expect(
          livePaintMemberOf(await h.host.document.getMetadata(member))?.group,
        ).toBe("lp-1");
      }
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
      expect(panel.work.count("log.warn")).toBe(0);

      // THE PANEL followed.
      expect(panel.attr(PANEL, "data-draw-live-paint-panel")).toBe("1");
      expect(panel.attr(PANEL, "data-draw-live-paint-active")).toBe("lp-1");
      expect(panel.get(ROW).textContent).toContain("Live Paint 1");
      expect(panel.get(ROW).textContent).toContain("2 members · 0 painted faces");
      expect(panel.count("[data-draw-live-paint-face]")).toBe(0);
    });

    it("a face painted by the bundle's own command is a face row", async () => {
      // The overlap of a0 (40..80) and b0 (60..100) — the point (70, 70).
      // Painted BEFORE the mount: the two "an OPEN panel…" cases below
      // are what an already-open panel does with the same command.
      expect(await paintOverlap()).toHaveLength(1);
      const panel = await mountPanel(h, makeLivePaintPanel);

      const recipe = (await readLivePaintLibrary(h.host)).groups[0]!;
      expect(recipe.faces).toHaveLength(1);
      const face = recipe.faces[0]!.face;
      expect(await fills()).toEqual([{ id: expect.anything(), face }]);
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);

      const rows = panel.all("[data-draw-live-paint-face]");
      expect(rows.map((r) => r.getAttribute("data-draw-live-paint-face"))).toEqual([
        face,
      ]);
      // "materialised" = the recipe's face has real artwork on the page.
      expect(rows[0]!.getAttribute("data-draw-live-paint-face-materialised")).toBe(
        "true",
      );
      expect(rows[0]!.textContent).toContain("Color/Black");
      expect(panel.get(ROW).textContent).toContain("2 members · 1 painted face");
    });

    it("a face row's Select selects that face's artwork", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      await panel.click("[data-draw-live-paint-face-select]");
      const [fill] = await fills();
      expect(h.host.selection.get().map((e) => e.id)).toEqual([fill!.id.id]);
    });

    it("Regenerate re-derives the arrangement and REPLACES the painted face", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      const [before] = await fills();
      await panel.click(`${ROW} [data-draw-live-paint-regenerate]`);

      const after = await fills();
      expect(after).toHaveLength(1);
      expect(after[0]!.face).toBe(before!.face);
      // New artwork, not the old artwork patched.
      expect(after[0]!.id.id).not.toBe(before!.id.id);
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);
      expect(panel.count("[data-draw-live-paint-face]")).toBe(1);
    });

    it("a face row's Delete removes the artwork and forgets the paint", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      await panel.click("[data-draw-live-paint-face-delete]");

      expect(await fills()).toEqual([]);
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect((await readLivePaintLibrary(h.host)).groups[0]!.faces).toEqual([]);
      expect(panel.count("[data-draw-live-paint-face]")).toBe(0);
      expect(panel.get(ROW).textContent).toContain("2 members · 0 painted faces");
    });

    // WAS A BUG (measured, then fixed). The panel reloaded on document
    // events, selection events and its own buttons — and a `.paged`
    // container-part write is none of those. `fillLivePaintFaces` (the
    // command AND the bucket tool) inserts the artwork first and writes
    // the recipe LAST, so the reload the insert triggered read the recipe
    // BEFORE the face was in it, and nothing reloaded afterwards. An open
    // panel therefore showed no face row (0) for a face the bucket had
    // just painted, until some unrelated selection or document change
    // came along. (Release through the command left the released group's
    // row up the same way.) `writeLivePaintLibrary` now announces the
    // write, and the panel reloads on that.
    it("an OPEN panel shows the face the bucket's command just painted", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      expect(panel.count("[data-draw-live-paint-face]")).toBe(0);
      await drive(async () => {
        if ((await paintOverlap()).length !== 1) throw new Error("not painted");
      }, panel.work);
      // The document has it…
      expect(await fills()).toHaveLength(1);
      // …and so does the panel.
      expect(panel.count("[data-draw-live-paint-face]")).toBe(1);
    });

    // The same, in the order the EDITOR has (see blend-panel.spec.tsx):
    // the recipe write lands a task after the reload the insert started.
    // This is the case that fails without the announcement.
    it("…and when the recipe write lands AFTER the reload its insert started", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      expect(panel.count("[data-draw-live-paint-face]")).toBe(1);
      const facesOf = async () =>
        (await readLivePaintLibrary(h.host)).groups[0]!.faces.map((f) => f.face);
      const before = await facesOf();

      // A SECOND face: a0 alone, at (45, 45).
      await drive(async () => {
        const painted = await applyFillLivePaintFace(slowRecipeWrites(h.host), {
          groupId: "lp-1",
          x: 45,
          y: 45,
        });
        if (painted.length !== 1) throw new Error("not painted");
      }, panel.work);
      const added = (await facesOf()).filter((face) => !before.includes(face));
      expect(added).toHaveLength(1);
      expect(await fills()).toHaveLength(2);
      expect(panel.count("[data-draw-live-paint-face]")).toBe(2);

      // Taken off again, so the cases below see the document they expect
      // — and the panel follows that too.
      await drive(
        () => applyDeleteLivePaintFace(h.host, { groupId: "lp-1", face: added[0] }),
        panel.work,
      );
      expect(await fills()).toHaveLength(1);
      expect(panel.count("[data-draw-live-paint-face]")).toBe(1);
    });

    it("Release drops the recipe and every link, and keeps the artwork", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      await panel.click(`${ROW} [data-draw-live-paint-release]`);

      expect((await readLivePaintLibrary(h.host)).groups).toEqual([]);
      for (const member of pair(0)) {
        expect(
          livePaintMemberOf(await h.host.document.getMetadata(member)),
        ).toBeNull();
      }
      // The face painted just above is ordinary artwork now: still on the
      // page, no longer linked.
      expect(await leafIds(h)).toHaveLength(PRISTINE + 1);
      expect(await fills()).toEqual([]);
      expect(panel.count("[data-draw-live-paint-row]")).toBe(0);
    });
  });

  // COVERS: `reload()` on a document with R = 5 groups among L = 40 plain
  // leaves. Each group is two member paths and no painted face, so the
  // document is 40 + 5 × 2 = 50 leaves. Nothing is selected unless a line
  // says so.
  describe("reload budgets (R = 5 groups, L = 40 plain leaves, 50 leaves in all)", () => {
    let h: HeadlessHost;
    /** Walks one reload costs with 0, 1, … RECORDS groups in the library. */
    const walksByRecords: number[] = [];

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(overlapPairs(RECORDS)));
      h.loadBundle(drawBundle);
      perLeaf = await metadataReadsPerLeaf(h.host);
      const panel = await mountPanel(h, makeLivePaintPanel);
      for (let k = 0; k <= RECORDS; k++) {
        if (k > 0) {
          await drive(async () => {
            await h.host.selection.set(pair(k - 1));
            const made = await applyMakeLivePaintGroup(h.host, { name: `Group ${k}` });
            if (!made) throw new Error(`group ${k} was not recorded`);
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
      expect((await readLivePaintLibrary(h.host)).groups).toHaveLength(RECORDS);
    });

    it("NO per-record walk here: one walk per reload, whatever the record count", () => {
      // Index = groups in the library. One unfiltered `livePaintLinks`
      // walk is tallied for every group at once.
      expect(walksByRecords).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it("ONE reload = 1 walk = 52 reads", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      expect(panel.cost()).toEqual({
        events: 0,
        reloads: 1,
        walks: 1,
        reads: 2 + leafReads(),
        partReads: 1,
      });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        events: 1,
        reloads: 1,
        // One walk per document REVISION, shared by every panel and
        // every command on this host.
        walks: 1,
        // 1 tree + 50 getMetadata (in parallel) + the swatch collection.
        // TARGET 3 — a tree, ONE bulk metadata read (RFI C-65) and the
        // collection.
        reads: 2 + leafReads(),
        // As found: 2 (the panel, then `selectedLivePaintGroup`).
        partReads: 1,
      });
      expect(panel.work.count("document.collection")).toBe(1);
    });

    it("a burst of 20 document changes = ONE reload = 52 reads", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      expect(await documentBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20 — no debounce, no cancellation.
        reloads: 1,
        // As found: 20.
        walks: 1,
        // One walk, of the revision the burst ends on. As found: 1 040.
        reads: 2 + leafReads(),
        // As found: 40.
        partReads: 1,
      });
    });

    it("a burst of 20 selection changes = ONE reload = 0 reads", async () => {
      const panel = await mountPanel(h, makeLivePaintPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        events: 20,
        // As found: 20.
        reloads: 1,
        // The DOCUMENT did not change once during this burst. As found:
        // 20.
        walks: 0,
        // Neither the links nor the swatches are read again: both are
        // kept per document revision. As found: 1 060.
        reads: 0,
        // As found: 40.
        partReads: 1,
      });
      // As found: 20 — once per selection change, which cannot have
      // changed it.
      expect(panel.work.count("document.collection")).toBe(0);
    });
  });
});
