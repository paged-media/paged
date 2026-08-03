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

// Appearance PANEL conformance — the panel's command surface (the panel
// itself is a React view over exactly these appliers, so testing the
// surface tests the panel's every button without a DOM). Pins:
//   (1) the pure stack transforms the rows drive (remove / reorder,
//       including the out-of-range no-ops a stale row can produce);
//   (2) the row LABEL the view renders per layer;
//   (3) the honesty NOTE's wording — the one-fill/one-stroke limit must
//       stay NAMED in the UI, so an edit that quietly drops it fails
//       here;
//   (4) the panel's registration (id / title / dock) through the real
//       headless host;
//   (5) the round-trip through the REAL engine: reorder + remove change
//       BOTH the metadata stack AND the baked front-most layer read back
//       off the frame.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { CommandContribution, ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  appearanceOf,
  appearanceRowLabel,
  commitAppearance,
  moveAppearanceLayer,
  removeAppearanceLayer,
  APPEARANCE_BAKE_NOTE,
  APPEARANCE_PANEL_ID,
  APPEARANCE_CLEAR_COMMAND_ID,
  APPEARANCE_MOVE_LAYER_COMMAND_ID,
  APPEARANCE_REMOVE_LAYER_COMMAND_ID,
  type AppearanceStack,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as ElementId;

const STACK: AppearanceStack = {
  fills: [
    { color: "Color/Black", tint: 100 },
    { color: "Color/Paper", tint: 100 },
  ],
  strokes: [{ color: "Color/Black", weight: 2 }],
};

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function readProp(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  for (const e of props?.entries ?? []) {
    if (e.path === path) return e.value;
  }
  return undefined;
}

describe("draw conformance — Appearance panel", () => {
  describe("the pure stack transforms (the panel's row buttons)", () => {
    it("removeAppearanceLayer drops one layer and leaves the input alone", () => {
      const next = removeAppearanceLayer(STACK, "fill", 0);
      expect(next.fills).toEqual([{ color: "Color/Paper", tint: 100 }]);
      expect(next.strokes).toEqual(STACK.strokes);
      // Immutability: the caller's stack is untouched (the panel keeps
      // rendering the old one until the reload lands).
      expect(STACK.fills).toHaveLength(2);
    });

    it("an out-of-range remove is an honest no-op (a stale row cannot corrupt)", () => {
      expect(removeAppearanceLayer(STACK, "fill", 7)).toEqual(STACK);
      expect(removeAppearanceLayer(STACK, "stroke", -1)).toEqual(STACK);
    });

    it("moveAppearanceLayer walks a layer toward the front (+1) or the back (−1)", () => {
      // The stack is BOTTOM-to-TOP: +1 on index 0 makes it the front-most
      // (the one that bakes).
      expect(moveAppearanceLayer(STACK, "fill", 0, 1).fills).toEqual([
        { color: "Color/Paper", tint: 100 },
        { color: "Color/Black", tint: 100 },
      ]);
      expect(moveAppearanceLayer(STACK, "fill", 1, -1).fills).toEqual([
        { color: "Color/Paper", tint: 100 },
        { color: "Color/Black", tint: 100 },
      ]);
    });

    it("a move off either end is a no-op", () => {
      expect(moveAppearanceLayer(STACK, "fill", 1, 1)).toEqual(STACK);
      expect(moveAppearanceLayer(STACK, "fill", 0, -1)).toEqual(STACK);
      expect(moveAppearanceLayer(STACK, "stroke", 0, 1)).toEqual(STACK);
    });
  });

  it("the row label carries the numeric the model actually has", () => {
    expect(appearanceRowLabel("fill", { color: "Color/Black", tint: 40 })).toBe(
      "Color/Black · 40%",
    );
    expect(appearanceRowLabel("fill", { color: "Color/Black" })).toBe(
      "Color/Black",
    );
    expect(
      appearanceRowLabel("stroke", { color: "Color/Paper", weight: 1.5 }),
    ).toBe("Color/Paper · 1.5 pt");
  });

  it("the inline note NAMES the one-fill/one-stroke limit (gap B-24)", () => {
    expect(APPEARANCE_BAKE_NOTE).toContain("front-most");
    expect(APPEARANCE_BAKE_NOTE).toContain("one fill slot and one stroke slot");
    expect(APPEARANCE_BAKE_NOTE).toContain("metadata");
    expect(APPEARANCE_BAKE_NOTE).toContain("IDML or PDF export");
    expect(APPEARANCE_BAKE_NOTE).toContain("B-24");
  });

  describe("against the real engine (F1 rectangle)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("registers as a right-docked panel with an honest title", () => {
      const panel = h
        .panelsContributed()
        .find((p) => p.id === APPEARANCE_PANEL_ID);
      expect(panel).toBeDefined();
      expect(panel!.title).toBe("Appearance (draw)");
      expect(panel!.defaultDock).toBe("right");
      expect(typeof panel!.component).toBe("function");
    });

    it("reorder + remove round-trip through metadata AND move the bake", async () => {
      const prev = await h.host.document.getMetadata(RECT);
      expect((await commitAppearance(h.host, RECT, STACK, prev)).applied).toBe(
        true,
      );
      // Front-most fill = Paper (the last entry) — that is what baked.
      expect(await readProp(h, RECT, "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Paper",
      });

      await h.host.selection.set([RECT]);

      // The panel's "move toward the front" on the BOTTOM fill row.
      await commandFor(h, APPEARANCE_MOVE_LAYER_COMMAND_ID).handler(undefined, {
        kind: "fill",
        index: 0,
        direction: "up",
      });
      expect(
        appearanceOf(await h.host.document.getMetadata(RECT)).fills,
      ).toEqual([
        { color: "Color/Paper", tint: 100 },
        { color: "Color/Black", tint: 100 },
      ]);
      // The bake followed the new front-most layer.
      expect(await readProp(h, RECT, "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Black",
      });

      // A stale row (out-of-range index) changes nothing.
      await commandFor(h, APPEARANCE_MOVE_LAYER_COMMAND_ID).handler(undefined, {
        kind: "fill",
        index: 9,
        direction: "up",
      });
      expect(
        appearanceOf(await h.host.document.getMetadata(RECT)).fills,
      ).toHaveLength(2);

      // The panel's "remove" on the (now) front-most fill row.
      await commandFor(h, APPEARANCE_REMOVE_LAYER_COMMAND_ID).handler(
        undefined,
        { kind: "fill", index: 1 },
      );
      const afterRemove = appearanceOf(await h.host.document.getMetadata(RECT));
      expect(afterRemove.fills).toEqual([{ color: "Color/Paper", tint: 100 }]);
      expect(afterRemove.strokes).toEqual(STACK.strokes);
      expect(await readProp(h, RECT, "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Paper",
      });

      // Clear empties the stack (the frame keeps the last baked paint —
      // the documented one-slot reality, not a hidden restore).
      await commandFor(h, APPEARANCE_CLEAR_COMMAND_ID).handler(undefined);
      expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual({
        fills: [],
        strokes: [],
      });
      await h.host.document.setMetadata(RECT, null);
    });

    it("an edit with NO selection is a no-op (the panel's empty state)", async () => {
      await h.host.selection.set([]);
      await expect(
        commandFor(h, APPEARANCE_REMOVE_LAYER_COMMAND_ID).handler(undefined, {
          kind: "fill",
          index: 0,
        }),
      ).resolves.toBeUndefined();
      expect(await h.host.document.getMetadata(RECT)).toBeNull();
    });
  });
});
