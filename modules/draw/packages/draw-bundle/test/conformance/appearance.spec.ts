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

// Phase 9 (Tier B) conformance — Appearance model (multiple fills/
// strokes as metadata + baked top layer). Asserts:
//   (1) the stack ↔ envelope round-trip helpers (appearanceOf /
//       withAppearance) preserve other draw metadata + clear cleanly;
//   (2) the EXACT bake wire shape `bakeAppearanceMutations` emits — the
//       FRONT-MOST (last) fill + stroke lowered to the frame's real
//       frameFillColor / frameFillTint / frameStrokeColor /
//       frameStrokeWeight;
//   (3) against the REAL engine on the F1 rectangle: a committed stack
//       round-trips through getMetadata AND its top layer bakes to the
//       frame (read back through elementProperties); undo unwinds.
//
// LIMITATION ASSERTED (gap B-24): the bake lowers the TOP layer only (the
// engine has one fill/stroke slot per frame); a multi-layer composite is
// not produced — `bakeAppearanceMutations` writes the last fill, not a
// blend of all fills. The test pins that contract so a future engine
// multi-paint model fails it loudly.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  appearanceOf,
  withAppearance,
  bakeAppearanceMutations,
  commitAppearance,
  type AppearanceStack,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as ElementId;

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

describe("draw conformance — Appearance model (Phase 9 Tier B)", () => {
  describe("stack ↔ envelope round-trip", () => {
    it("appearanceOf reads the stack out of an envelope (empty when absent)", () => {
      expect(appearanceOf(null)).toEqual({ fills: [], strokes: [] });
      expect(appearanceOf({ v: 1, data: {} })).toEqual({ fills: [], strokes: [] });
      const env = { v: 1, data: { appearance: { fills: [{ color: "Color/Black" }], strokes: [] } } };
      expect(appearanceOf(env)).toEqual({ fills: [{ color: "Color/Black" }], strokes: [] });
    });

    it("withAppearance merges the stack, preserving other draw metadata", () => {
      const prev = { v: 1, data: { tool: "addAnchor" } };
      const stack: AppearanceStack = {
        fills: [{ color: "Color/Black", tint: 100 }],
        strokes: [{ color: "Color/Paper", weight: 2 }],
      };
      expect(withAppearance(prev, stack)).toEqual({
        v: 1,
        data: { tool: "addAnchor", appearance: stack },
      });
    });

    it("an empty stack drops the key (and clears to null when alone)", () => {
      const withOther = { v: 1, data: { tool: "x", appearance: { fills: [{ color: "C" }], strokes: [] } } };
      expect(withAppearance(withOther, { fills: [], strokes: [] })).toEqual({ v: 1, data: { tool: "x" } });
      const alone = { v: 1, data: { appearance: { fills: [{ color: "C" }], strokes: [] } } };
      expect(withAppearance(alone, { fills: [], strokes: [] })).toBeNull();
    });
  });

  describe("bakeAppearanceMutations — the top-layer bake (gap B-24)", () => {
    it("lowers the FRONT-MOST fill + stroke to the frame's real attributes", () => {
      const stack: AppearanceStack = {
        // Two fills: only the LAST (front-most) bakes (one-fill engine).
        fills: [
          { color: "Color/Black", tint: 50 },
          { color: "Color/Paper", tint: 80 },
        ],
        strokes: [{ color: "Color/Black", weight: 3 }],
      };
      const ops = bakeAppearanceMutations(RECT, stack) as Extract<
        Mutation,
        { op: "setElementProperty" }
      >[];
      expect(ops).toEqual([
        {
          op: "setElementProperty",
          args: { elementId: RECT, path: "frameFillColor", value: { type: "colorRef", value: "Color/Paper" } },
        },
        {
          op: "setElementProperty",
          args: { elementId: RECT, path: "frameFillTint", value: { type: "length", value: 80 } },
        },
        {
          op: "setElementProperty",
          args: { elementId: RECT, path: "frameStrokeColor", value: { type: "colorRef", value: "Color/Black" } },
        },
        {
          op: "setElementProperty",
          args: { elementId: RECT, path: "frameStrokeWeight", value: { type: "length", value: 3 } },
        },
      ]);
    });

    it("an empty stack bakes nothing (the frame keeps its own paint)", () => {
      expect(bakeAppearanceMutations(RECT, { fills: [], strokes: [] })).toEqual([]);
    });

    it("a fill with no tint omits the frameFillTint write", () => {
      const ops = bakeAppearanceMutations(RECT, {
        fills: [{ color: "Color/Black" }],
        strokes: [],
      });
      expect(ops).toHaveLength(1);
      expect((ops[0] as { args: { path: string } }).args.path).toBe("frameFillColor");
    });
  });

  describe("against the real engine (F1 rectangle metadata + bake round-trip)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("commitAppearance persists the stack AND bakes the top layer", async () => {
      const stack: AppearanceStack = {
        fills: [{ color: "Color/Black", tint: 100 }, { color: "Color/Paper", tint: 100 }],
        strokes: [{ color: "Color/Black", weight: 2 }],
      };
      const prev = await h.host.document.getMetadata(RECT);
      const outcome = await commitAppearance(h.host, RECT, stack, prev);
      expect(outcome.applied).toBe(true);

      // The full stack round-trips through metadata (both fills present).
      const env = await h.host.document.getMetadata(RECT);
      expect(appearanceOf(env)).toEqual(stack);

      // The TOP layer baked to the frame (the front-most fill = Paper).
      expect(await readProp(h, RECT, "frameFillColor")).toEqual({
        type: "colorRef",
        value: "Color/Paper",
      });
      expect(await readProp(h, RECT, "frameStrokeWeight")).toEqual({
        type: "length",
        value: 2,
      });

      // Unwind: the bake batch, then the metadata write.
      await h.host.document.undo(); // bake batch
      await h.host.document.undo(); // metadata
      expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual({
        fills: [],
        strokes: [],
      });
      await h.host.document.setMetadata(RECT, null);
    });

    it("the recorded Add fill command stacks a layer on the selected element", async () => {
      await h.host.selection.set([RECT]);
      const rec = h.contributions.find(
        (c) => c.kind === "command" && c.id === "media.paged.draw.command.appearanceAddFill",
      );
      expect(rec).toBeDefined();
      await (rec!.value as { handler: (p?: unknown) => unknown }).handler(undefined);

      const env = await h.host.document.getMetadata(RECT);
      expect(appearanceOf(env).fills.length).toBe(1);

      // Clear via the Clear command, then wipe metadata for the next test.
      const clear = h.contributions.find(
        (c) => c.kind === "command" && c.id === "media.paged.draw.command.appearanceClear",
      );
      await (clear!.value as { handler: (p?: unknown) => unknown }).handler(undefined);
      await h.host.document.setMetadata(RECT, null);
      expect(await h.host.document.getMetadata(RECT)).toBeNull();
    });
  });
});
