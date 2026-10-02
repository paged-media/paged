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

// The APPEARANCE panel, RENDERED (jsdom) against the real engine:
// behaviour first (empty state, the stack, buttons asserted on the
// DOCUMENT), then its reload budgets as counts at the host doors — the
// perf-budgets.spec.ts rules: MEASURED, target beside it, only lowered.
//
// THE ODD ONE OUT. This panel's "records" are the LAYERS of the selected
// object's stack, so its reload reads the selection and nothing else: it
// does NOT walk the document, and its cost does not depend on how many
// leaves there are. What it does do is read the selection SYNCHRONOUSLY
// inside a selection listener — and that is one selection behind.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  appearanceBakeOf,
  appearanceOf,
  commitAppearance,
  makeAppearancePanel,
  APPEARANCE_BAKE_NOTE,
  APPEARANCE_PANEL_ID,
  type AppearanceStack,
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
  propertyOf,
  rectItem,
  selectionBurst,
  teardownPanels,
  PLAIN_LEAVES,
  RECORDS,
} from "./harness";

const R0 = { kind: "rectangle", id: "r0" } as ElementId;
const R1 = { kind: "rectangle", id: "r1" } as ElementId;

/** R = 5 layers: three fills and two strokes, BOTTOM-to-TOP. */
const STACK: AppearanceStack = {
  fills: [
    { color: "Color/Black", tint: 20 },
    { color: "Color/Black", tint: 60 },
    { color: "Color/Black", tint: 100 },
  ],
  strokes: [
    { color: "Color/Black", weight: 1 },
    { color: "Color/Black", weight: 3 },
  ],
};

const twoRects = (): Uint8Array =>
  panelDocument(rectItem("r0", 40, 40) + rectItem("r1", 140, 40));

const PANEL = "[data-draw-appearance-panel]";

describe("Appearance panel — rendered against the engine", () => {
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
      const panel = await mountContributed(h, APPEARANCE_PANEL_ID);
      expect(panel.attr(PANEL, "data-draw-appearance-panel")).toBe("0");
      expect(panel.attr(PANEL, "data-draw-appearance-baked")).toBe("false");
      expect(panel.text()).toContain("Appearance (0)");
      expect(panel.text()).toContain("Select an object to see its appearance stack.");
      expect(panel.count("[data-draw-appearance-row]")).toBe(0);
      for (const button of ["add-fill", "add-stroke", "clear", "bake", "release"]) {
        expect(panel.disabled(`[data-draw-appearance-${button}]`)).toBe(true);
      }
      // The B-24 note is on screen, verbatim.
      expect(panel.get("[data-draw-appearance-note]").textContent).toBe(
        APPEARANCE_BAKE_NOTE,
      );
    });

    it("THE FLOOR: what a reload costs before the document holds anything", async () => {
      const panel = await mountPanel(h, makeAppearancePanel);
      // Nothing is selected, so the reload reads nothing at all.
      expect(panel.cost()).toEqual({
        reloads: 0,
        walks: 0,
        reads: 0,
        partReads: 0,
      });
    });
  });

  describe("behaviour (2 rectangles + 40 plain leaves)", () => {
    let h: HeadlessHost;
    const PRISTINE = 2 + PLAIN_LEAVES;
    const stackOf = async (id: ElementId) =>
      appearanceOf(await h.host.document.getMetadata(id));
    const rowsOf = (panel: Awaited<ReturnType<typeof mountPanel>>) =>
      panel
        .all("[data-draw-appearance-row]")
        .map((r) => r.getAttribute("data-draw-appearance-row"));

    beforeAll(async () => {
      h = await openHost();
      await h.load(twoRects());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("a selected object with no stack says what renders instead", async () => {
      await h.host.selection.set([R1]);
      const panel = await mountPanel(h, makeAppearancePanel);
      expect(panel.text()).not.toContain("Select an object");
      expect(panel.text()).toContain(
        "No extra fill layers — the frame's own fill is what renders.",
      );
      expect(panel.text()).toContain(
        "No extra stroke layers — the frame's own stroke is what renders.",
      );
      expect(panel.disabled("[data-draw-appearance-add-fill]")).toBe(false);
      // Nothing to clear, nothing to bake.
      expect(panel.disabled("[data-draw-appearance-clear]")).toBe(true);
      expect(panel.disabled("[data-draw-appearance-bake]")).toBe(true);
    });

    it("shows the selection's stack FRONT-MOST FIRST, and marks what bakes", async () => {
      const out = await commitAppearance(
        h.host,
        R0,
        STACK,
        await h.host.document.getMetadata(R0),
      );
      expect(out.applied).toBe(true);
      await h.host.selection.set([R0]);
      const panel = await mountPanel(h, makeAppearancePanel);

      expect(panel.attr(PANEL, "data-draw-appearance-panel")).toBe(String(RECORDS));
      expect(panel.text()).toContain("Appearance (5)");
      // The model is bottom-to-top; the view reverses it per kind.
      expect(rowsOf(panel)).toEqual([
        "fill:2",
        "fill:1",
        "fill:0",
        "stroke:1",
        "stroke:0",
      ]);
      // UNBAKED: only the front-most fill and stroke reach the document.
      expect(
        panel
          .all("[data-draw-appearance-row]")
          .map((r) => r.getAttribute("data-draw-appearance-bakes")),
      ).toEqual(["true", "false", "false", "true", "false"]);
      expect(panel.get('[data-draw-appearance-row="fill:2"]').textContent).toContain(
        "Color/Black · 100%",
      );
      expect(panel.get('[data-draw-appearance-row="stroke:1"]').textContent).toContain(
        "Color/Black · 3 pt",
      );
      // The front-most row cannot go further up, the bottom one further down.
      const front = '[data-draw-appearance-row="fill:2"]';
      const bottom = '[data-draw-appearance-row="fill:0"]';
      expect(panel.disabled(`${front} [data-draw-appearance-up]`)).toBe(true);
      expect(panel.disabled(`${bottom} [data-draw-appearance-down]`)).toBe(true);
    });

    it("Up reorders the stack in the document, and the bake follows the new front", async () => {
      await h.host.selection.set([R0]);
      const panel = await mountPanel(h, makeAppearancePanel);
      expect(await propertyOf(h, R0, "frameFillTint")).toEqual({
        type: "length",
        value: 100,
      });

      // The 60% fill moves in front of the 100% one.
      await panel.click('[data-draw-appearance-row="fill:1"] [data-draw-appearance-up]');

      expect((await stackOf(R0)).fills.map((f) => f.tint)).toEqual([20, 100, 60]);
      expect(await propertyOf(h, R0, "frameFillTint")).toEqual({
        type: "length",
        value: 60,
      });
      expect(panel.get('[data-draw-appearance-row="fill:2"]').textContent).toContain(
        "Color/Black · 60%",
      );
    });

    it("Remove drops one layer; + Fill and + Stroke add one", async () => {
      await h.host.selection.set([R0]);
      const panel = await mountPanel(h, makeAppearancePanel);

      await panel.click(
        '[data-draw-appearance-row="fill:0"] [data-draw-appearance-remove]',
      );
      expect((await stackOf(R0)).fills.map((f) => f.tint)).toEqual([100, 60]);
      expect(panel.attr(PANEL, "data-draw-appearance-panel")).toBe("4");

      await panel.click("[data-draw-appearance-add-fill]");
      await panel.click("[data-draw-appearance-add-stroke]");
      const stack = await stackOf(R0);
      expect(stack.fills).toHaveLength(3);
      expect(stack.strokes).toHaveLength(3);
      expect(panel.attr(PANEL, "data-draw-appearance-panel")).toBe("6");
      expect(rowsOf(panel)).toHaveLength(6);
    });

    it("Bake lowers the stack onto real page items; Release takes it back", async () => {
      await h.host.selection.set([R0]);
      const panel = await mountPanel(h, makeAppearancePanel);
      expect(panel.disabled("[data-draw-appearance-release]")).toBe(true);

      await panel.click("[data-draw-appearance-bake]");

      // THE DOCUMENT: one derived path per layer joins the carrier.
      expect(appearanceBakeOf(await h.host.document.getMetadata(R0))).not.toBeNull();
      expect(await leafIds(h)).toHaveLength(PRISTINE + 6);
      // THE PANEL: every row is a real item now, and only Release is live.
      expect(panel.attr(PANEL, "data-draw-appearance-baked")).toBe("true");
      expect(
        panel
          .all("[data-draw-appearance-row]")
          .every((r) => r.getAttribute("data-draw-appearance-bakes") === "true"),
      ).toBe(true);
      expect(panel.disabled("[data-draw-appearance-bake]")).toBe(true);

      await panel.click("[data-draw-appearance-release]");

      expect(appearanceBakeOf(await h.host.document.getMetadata(R0))).toBeNull();
      expect(await leafIds(h)).toHaveLength(PRISTINE);
      expect(panel.attr(PANEL, "data-draw-appearance-baked")).toBe("false");
      // The stack itself survived the round trip.
      expect(panel.attr(PANEL, "data-draw-appearance-panel")).toBe("6");
    });

    it("Clear empties the stack", async () => {
      await h.host.selection.set([R0]);
      const panel = await mountPanel(h, makeAppearancePanel);
      await panel.click("[data-draw-appearance-clear]");

      expect(await stackOf(R0)).toEqual({ fills: [], strokes: [] });
      expect(panel.attr(PANEL, "data-draw-appearance-panel")).toBe("0");
      expect(panel.count("[data-draw-appearance-row]")).toBe(0);
    });

    // BUG (measured). The panel's selection listener is `() => void
    // reload()`: it throws away the ids the host hands it and re-reads
    // `host.selection.get()` — synchronously, as reload's FIRST statement.
    // The SDK adapter's `host.selection.set` awaits the engine, the
    // `elementSelectionApplied` subscribers fire INSIDE that call, and
    // only afterwards does the adapter store the new selection — so the
    // reload sees the PREVIOUS one. The panel is one selection behind
    // after every selection made through `host.selection.set` (Select
    // Same, Place symbol, a face's Select, …) until a document change
    // makes it reload again. That adapter is the same code in the editor;
    // what a user's own CLICK does there goes through the editor's
    // selection context and is NOT measured here. The other seven panels
    // read the selection after an `await` and get away with it. Flip to
    // `it` when the panel uses the ids it is given.
    it.fails("follows a selection change (it is one selection behind)", async () => {
      await commitAppearance(h.host, R0, STACK, await h.host.document.getMetadata(R0));
      const panel = await mountPanel(h, makeAppearancePanel);
      expect(panel.text()).toContain("Select an object");

      await drive(() => h.host.selection.set([R0]), panel.work);

      expect(h.host.selection.get()).toEqual([R0]);
      // MEASURED "0", and still "Select an object…": the reload read the
      // empty selection that R0 replaced.
      expect(panel.attr(PANEL, "data-draw-appearance-panel")).toBe("5");
    });
  });

  // COVERS: `reload()` on a document with L = 40 plain leaves and one
  // rectangle carrying R = 5 layers (42 leaves in all). The rectangle is
  // selected unless a line says otherwise — with nothing selected a
  // reload reads nothing at all.
  describe("reload budgets (R = 5 layers on the selection, L = 40 plain leaves)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(twoRects());
      h.loadBundle(drawBundle);
      const out = await commitAppearance(h.host, R0, STACK, null);
      if (!out.applied) throw new Error("the stack was not written");
    });
    afterAll(() => h?.dispose());
    afterEach(() => teardownPanels(h));

    it("the document is the one the budgets name", async () => {
      expect(await leafIds(h)).toHaveLength(PLAIN_LEAVES + 2);
      const stack = appearanceOf(await h.host.document.getMetadata(R0));
      expect(stack.fills.length + stack.strokes.length).toBe(RECORDS);
    });

    it("NO walk at all: one reload = 2 reads, whatever the document holds", async () => {
      await h.host.selection.set([R0]);
      const panel = await mountPanel(h, makeAppearancePanel);
      expect(panel.cost()).toEqual({ reloads: 0, walks: 0, reads: 2, partReads: 0 });

      const one = await panel.costOf(() => plainChange(h, 0));
      expect(one).toEqual({
        reloads: 1,
        walks: 0,
        // The SAME element's metadata, twice: once to resolve the carrier
        // of a baked layer, once to read the stack. TARGET 1.
        reads: 2,
        partReads: 0,
      });
      expect(panel.work.count("document.getMetadata")).toBe(2);
    });

    it("with nothing selected a reload reads nothing", async () => {
      const panel = await mountPanel(h, makeAppearancePanel);
      expect(await panel.costOf(() => plainChange(h, 0))).toEqual({
        reloads: 1,
        walks: 0,
        reads: 0,
        partReads: 0,
      });
    });

    it("a burst of 20 document changes = 20 reloads = 40 reads", async () => {
      await h.host.selection.set([R0]);
      const panel = await mountPanel(h, makeAppearancePanel);
      expect(await documentBurst(h, panel)).toEqual({
        // No debounce, no cancellation. TARGET 1 (O(1) per burst).
        reloads: 20,
        walks: 0,
        // 20 × 2. TARGET 1 — the selection's stack at the revision the
        // burst ends on.
        reads: 40,
        partReads: 0,
      });
    });

    it("a burst of 20 selection changes = 20 reloads = 40 reads — of the PREVIOUS selections", async () => {
      await h.host.selection.set([R0]);
      const panel = await mountPanel(h, makeAppearancePanel);
      expect(await selectionBurst(h, panel)).toEqual({
        // TARGET 1.
        reloads: 20,
        walks: 0,
        // 20 × 2 — but each reload read the selection it REPLACED (the
        // `it.fails` above): R0, then p1 … p19. The last one, p20, was
        // never read. TARGET 1, and of p20.
        reads: 40,
        partReads: 0,
      });
      // The proof it is the previous selection: the panel still shows a
      // target while its own count attribute says p20 has no layers — it
      // is showing p19's (empty) stack.
      expect(panel.text()).not.toContain("Select an object");
    });
  });
});
