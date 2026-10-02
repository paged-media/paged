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

// The GRAPHIC STYLES panel, RENDERED (jsdom) against the real engine:
// behaviour first (empty state, records, buttons asserted on the
// DOCUMENT), then its reload budgets as counts at the host doors — the
// perf-budgets.spec.ts rules: MEASURED, target beside it, only lowered.
//
// WHAT WAS MEASURED, in one line: ONE walk per reload, whatever the
// record count — but TWO engine reads per leaf on it, and both are the
// same request (`getMetadata` is `requestElementProperties` underneath).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyDeleteGraphicStyle,
  applySaveGraphicStyle,
  graphicStyleRefOf,
  makeGraphicStylesPanel,
  readGraphicStyleLibrary,
  GRAPHIC_STYLES_NOTE,
  GRAPHIC_STYLES_PANEL_ID,
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
  propertyOf,
  seedRow,
  selectionBurst,
  teardownPanels,
  unmountAll,
  PLAIN_LEAVES,
  RECORDS,
} from "./harness";

const PANEL = "[data-draw-graphic-styles-panel]";
const ROW = '[data-draw-graphic-style-row="gs-1"]';

describe("Graphic styles panel — rendered against the engine", () => {
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
      const panel = await mountContributed(h, GRAPHIC_STYLES_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-graphic-styles-panel")).toBe("0");
      expect(panel.attr(PANEL, "data-draw-graphic-styles-portable")).toBe("true");
      expect(panel.text()).toContain("Graphic styles (0)");
      expect(panel.text()).toContain(
        "No graphic styles yet — select an object and save its appearance.",
      );
      expect(panel.text()).toContain("Select an object to link it to a style");
      expect(panel.count("[data-draw-graphic-style-row]")).toBe(0);
      expect(panel.disabled("[data-draw-graphic-style-save]")).toBe(true);
      expect(panel.disabled("[data-draw-graphic-style-break]")).toBe(true);
      expect(panel.get("[data-draw-graphic-styles-note]").textContent).toBe(
        GRAPHIC_STYLES_NOTE,
      );
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      // One tree read and the library once: this is the shape the target
      // has, before there is a leaf to read twice.
      expect(panel.cost()).toEqual({
        events: 0,
        walks: 1,
        reads: 1,
        partReads: 1,
      });
    });
  });

  describe("behaviour (3 objects + 40 plain leaves)", () => {
    let h: HeadlessHost;
    const refOf = async (id: Parameters<typeof propertyOf>[1]) =>
      graphicStyleRefOf(await h.host.document.getMetadata(id))?.id ?? null;

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", 3)));
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("+ From selection saves a style and LINKS the selection to it", async () => {
      await h.host.selection.set([poly("s0")]);
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      panel.reset();
      await panel.click("[data-draw-graphic-style-save]");

      // THE DOCUMENT: the library holds the style, the element its link.
      const library = await readGraphicStyleLibrary(h.host);
      expect(library.styles.map((s) => [s.id, s.name])).toEqual([
        ["gs-1", "Graphic style 1"],
      ]);
      expect(await refOf(poly("s0"))).toBe("gs-1");
      expect(panel.work.mutations.map((m) => m.op)).toEqual(["batch"]);
      expect(panel.work.count("log.warn")).toBe(0);

      // THE PANEL followed: the row, its blast radius, the link.
      expect(panel.attr(PANEL, "data-draw-graphic-styles-panel")).toBe("1");
      expect(panel.attr(PANEL, "data-draw-graphic-style-linked")).toBe("gs-1");
      expect(panel.attr(ROW, "data-draw-graphic-style-linked-count")).toBe("1");
      expect(panel.get("[data-draw-graphic-style-selection]").textContent).toBe(
        "Selection follows Graphic style 1",
      );
      expect(panel.get(ROW).textContent).toContain("linked");
    });

    it("Apply links another object, and the row's count follows", async () => {
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      await drive(() => h.host.selection.set([plainId(0)]), panel.work);
      expect(panel.attr(PANEL, "data-draw-graphic-style-linked")).toBe("");

      await panel.click(`${ROW} [data-draw-graphic-style-apply]`);

      expect(await refOf(plainId(0))).toBe("gs-1");
      expect(panel.attr(PANEL, "data-draw-graphic-style-linked")).toBe("gs-1");
      expect(panel.attr(ROW, "data-draw-graphic-style-linked-count")).toBe("2");
    });

    it("a direct appearance edit shows as OVERRIDDEN without breaking the link", async () => {
      await h.host.selection.set([plainId(0)]);
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      expect(panel.attr(PANEL, "data-draw-graphic-style-overridden")).toBe("false");

      // A foreign edit: nothing here goes through the panel or a graphic-
      // style command. `plainChange` writes p0's stroke weight.
      await drive(() => plainChange(h, 4), panel.work);

      expect(await refOf(plainId(0))).toBe("gs-1");
      expect(panel.attr(PANEL, "data-draw-graphic-style-overridden")).toBe("true");
      expect(panel.get("[data-draw-graphic-style-selection]").textContent).toContain(
        "overridden",
      );
    });

    it("Redefine takes the selection's appearance and propagates it to every link", async () => {
      await h.host.selection.set([plainId(0)]);
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      expect(panel.attr(PANEL, "data-draw-graphic-style-overridden")).toBe("true");
      const edited = await propertyOf(h, plainId(0), "frameStrokeWeight");
      expect(await propertyOf(h, poly("s0"), "frameStrokeWeight")).not.toEqual(edited);

      await panel.click(`${ROW} [data-draw-graphic-style-redefine]`);

      // The OTHER linked object now carries the redefined stroke weight.
      expect(await propertyOf(h, poly("s0"), "frameStrokeWeight")).toEqual(edited);
      expect(panel.attr(PANEL, "data-draw-graphic-style-overridden")).toBe("false");
      expect(panel.attr(ROW, "data-draw-graphic-style-linked-count")).toBe("2");
    });

    it("Break link drops the reference and keeps the appearance", async () => {
      await h.host.selection.set([plainId(0)]);
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      const weight = await propertyOf(h, plainId(0), "frameStrokeWeight");
      await panel.click("[data-draw-graphic-style-break]");

      expect(await refOf(plainId(0))).toBeNull();
      expect(await propertyOf(h, plainId(0), "frameStrokeWeight")).toEqual(weight);
      expect(panel.attr(PANEL, "data-draw-graphic-style-linked")).toBe("");
      expect(panel.attr(ROW, "data-draw-graphic-style-linked-count")).toBe("1");
    });

    it("Delete unlinks every follower, then drops the style", async () => {
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      await panel.click(`${ROW} [data-draw-graphic-style-delete]`);

      expect((await readGraphicStyleLibrary(h.host)).styles).toEqual([]);
      expect(await refOf(poly("s0"))).toBeNull();
      expect(panel.count("[data-draw-graphic-style-row]")).toBe(0);
      expect(panel.attr(PANEL, "data-draw-graphic-styles-panel")).toBe("0");
    });

    // BUG (measured). The panel reloads on document events, selection
    // events and its own buttons (each ends in `void reload()`) — and a
    // `.paged` container-part write is none of those. A SAVE happens to
    // be followed (the library is written before the link batch), but
    // `applyDeleteGraphicStyle` unlinks the followers first and drops the
    // style LAST, so the reload the unlink triggers still reads it. The
    // panel's own Delete button hides this behind its trailing reload;
    // the same command from the menu or Cmd+K leaves an open panel
    // offering Apply / Redefine on a style that no longer exists. (Rename
    // is library-only: no event at all.) Flip to `it` when a library
    // write reaches the panel.
    it.fails(
      "an OPEN panel drops a style deleted by the COMMAND, not only by its own button",
      async () => {
        await h.host.selection.set([poly("s1")]);
        const style = await applySaveGraphicStyle(h.host);
        expect(style).not.toBeNull();
        const panel = await mountPanel(h, makeGraphicStylesPanel);
        expect(panel.count("[data-draw-graphic-style-row]")).toBe(1);

        await drive(() => applyDeleteGraphicStyle(h.host, style!.id), panel.work);

        // The document has let go of it…
        expect((await readGraphicStyleLibrary(h.host)).styles).toEqual([]);
        // …MEASURED 1: the panel has not.
        expect(panel.count("[data-draw-graphic-style-row]")).toBe(0);
      },
    );
  });

  // COVERS: `reload()` on a document with R = 5 styles among L = 40 plain
  // leaves. Each style has ONE linked object (the one it was saved from),
  // so the document is 40 + 5 = 45 leaves. Nothing is selected unless a
  // line says so.
  describe("reload budgets (R = 5 styles, L = 40 plain leaves, 45 leaves in all)", () => {
    let h: HeadlessHost;
    /** Reads one reload costs with 0, 1, … RECORDS styles in the library. */
    const readsByRecords: number[] = [];

    beforeAll(async () => {
      h = await openHost();
      await h.load(panelDocument(seedRow("s", RECORDS)));
      h.loadBundle(drawBundle);
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      for (let k = 0; k <= RECORDS; k++) {
        if (k > 0) {
          await drive(async () => {
            await h.host.selection.set([poly(`s${k - 1}`)]);
            const made = await applySaveGraphicStyle(h.host, { name: `Style ${k}` });
            if (!made) throw new Error(`style ${k} was not saved`);
            await h.host.selection.set([]);
          }, panel.work);
        }
        readsByRecords.push((await panel.costOf(() => plainChange(h, k))).reads);
      }
      unmountAll();
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the document is the one the budgets name", async () => {
      expect(await leafIds(h)).toHaveLength(PLAIN_LEAVES + RECORDS);
      expect((await readGraphicStyleLibrary(h.host)).styles).toHaveLength(RECORDS);
    });

    it("NO per-record walk here: a reload costs the same whatever the record count", () => {
      // Index = styles in the library. One `graphicStyleLinks` walk is
      // tallied for every style at once.
      expect(readsByRecords).toEqual([91, 91, 91, 91, 91, 91]);
    });

    it("ONE reload = 1 walk = 91 reads — two per leaf", async () => {
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      expect(panel.cost()).toEqual({ events: 0, walks: 1, reads: 91, partReads: 1 });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        events: 1,
        // One walk per reload. TARGET 1 per document REVISION, shared by
        // every panel that needs the links.
        walks: 1,
        // 1 tree + 45 × (getMetadata + elementProperties). The two are
        // ONE engine request asked twice — `getMetadata` is a
        // `requestElementProperties` filtered to this plugin's key.
        // TARGET 46.
        reads: 91,
        partReads: 1,
      });
      expect(panel.work.count("document.getMetadata")).toBe(45);
      expect(panel.work.count("document.elementProperties")).toBe(45);
    });

    it("a burst of 20 document changes = 20 reloads = 1820 reads", async () => {
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      expect(await documentBurst(h, panel)).toEqual({
        // No debounce, no cancellation. TARGET 1 (O(1) per burst).
        events: 20,
        walks: 20,
        // 20 × 91. TARGET 46 — one walk for the revision the burst ends on.
        reads: 1820,
        partReads: 20,
      });
    });

    it("a burst of 20 selection changes = 20 reloads = 1880 reads", async () => {
      const panel = await mountPanel(h, makeGraphicStylesPanel);
      expect(await selectionBurst(h, panel)).toEqual({
        // TARGET 1.
        events: 20,
        // The DOCUMENT did not change once during this burst. TARGET 0.
        walks: 20,
        // 20 × (91 + 3 reads of the selected leaf: its carrier, its
        // metadata, its properties — the same request three times).
        // TARGET 1.
        reads: 1880,
        partReads: 20,
      });
    });
  });
});
