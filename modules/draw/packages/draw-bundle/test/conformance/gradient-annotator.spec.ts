// Phase 4c conformance — the Gradient Annotator's axis commit (the
// B-03 angle/length lane, on-canvas). Asserts (1) the EXACT batch wire
// sequence `gradientAxisMutationFor` emits (the same builder the live
// drag sends), and (2) the batch applied at the REAL engine over a
// gradient-filled frame (assigned through the bundle's own
// fillGradientMutationsFor — the proven Phase 2d path), the angle
// readable back through the typed property door, and ONE undo
// restoring both scalars.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  gradientAxisMutationFor,
  fillGradientMutationsFor,
  FILL_GRADIENT_PRESETS,
  mintFillGradientIds,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as ElementId;

async function axisOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<{ angle: number | null; length: number | null }> {
  const props = await h.host.document.elementProperties(id);
  let angle: number | null = null;
  let length: number | null = null;
  for (const entry of props?.entries ?? []) {
    const v = entry.value;
    if (!v || v.type !== "length") continue;
    if (entry.path === "frameGradientFillAngle") angle = v.value;
    if (entry.path === "frameGradientFillLength") length = v.value;
  }
  return { angle, length };
}

describe("draw conformance — gradient annotator axis (Phase 4c)", () => {
  it("gradientAxisMutationFor emits ONE batch of angle+length setElementProperty per target", () => {
    const m = gradientAxisMutationFor([RECT], 45, 120) as Extract<
      Mutation,
      { op: "batch" }
    >;
    expect(m).toEqual({
      op: "batch",
      args: {
        ops: [
          {
            op: "setElementProperty",
            args: {
              elementId: RECT,
              path: "frameGradientFillAngle",
              value: { type: "length", value: 45 },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: RECT,
              path: "frameGradientFillLength",
              value: { type: "length", value: 120 },
            },
          },
        ],
      },
    });
  });

  describe("against the real engine", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
      // Gradient-fill the rectangle through the bundle's own Phase 2d
      // mutation sequence (the engine-proven assignment path).
      const mutations = fillGradientMutationsFor(
        [RECT],
        FILL_GRADIENT_PRESETS[0],
        mintFillGradientIds("axisspec"),
      );
      for (const mutation of mutations) {
        const outcome = await h.host.document.mutate(mutation);
        if (!outcome.applied) {
          throw new Error(`gradient assignment failed at ${mutation.op}`);
        }
      }
    });
    afterAll(() => h?.dispose());

    it("the axis batch applies, reads back through the typed door, and ONE undo restores both", async () => {
      const before = await axisOf(h, RECT);
      const outcome = await h.host.document.mutate(
        gradientAxisMutationFor([RECT], 30, 150),
      );
      expect(outcome.applied).toBe(true);
      const after = await axisOf(h, RECT);
      expect(after.angle).toBe(30);
      expect(after.length).toBe(150);
      // One batch = one undo step restores BOTH scalars.
      await h.host.document.undo();
      const restored = await axisOf(h, RECT);
      expect(restored.angle).toBe(before.angle);
      expect(restored.length).toBe(before.length);
    });
  });
});
