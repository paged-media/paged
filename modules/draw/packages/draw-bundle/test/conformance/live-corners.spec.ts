// Phase 9 (Tier B) conformance — Live Corners (the frameCornerOption* /
// frameCornerRadius* wire consumers). Asserts:
//   (1) the EXACT batch-of-eight wire shape `cornerStyleMutationFor`
//       emits per preset (four option Text writes + four radius Length
//       writes), with None clearing the option to empty text + 0 radius;
//   (2) the per-corner builder `cornerRadiiMutationFor`;
//   (3) the preset applied at the REAL engine on the F1 rectangle — the
//       corner option + radius round-trip through elementProperties, and
//       undo restores the prior corners;
//   (4) the §13.3 "live" metadata marker round-trips (write → read →
//       undo), merged into the envelope alongside other draw metadata;
//   (5) the Rectangle-only gap (B-23): a polygon is not a live-corner
//       target.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  LIVE_CORNER_PRESETS,
  DEFAULT_CORNER_RADIUS_PT,
  cornerStyleMutationFor,
  cornerRadiiMutationFor,
  withLiveCornerMarker,
  supportsLiveCorners,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as ElementId;
const POLY = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! } as ElementId;

const OPTION_PATHS = [
  "frameCornerOptionTopLeft",
  "frameCornerOptionTopRight",
  "frameCornerOptionBottomRight",
  "frameCornerOptionBottomLeft",
];
const RADIUS_PATHS = [
  "frameCornerRadiusTopLeft",
  "frameCornerRadiusTopRight",
  "frameCornerRadiusBottomRight",
  "frameCornerRadiusBottomLeft",
];

/** Read one PropertyPath's value off the element's typed snapshot. */
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

describe("draw conformance — Live Corners (Phase 9 Tier B)", () => {
  describe("cornerStyleMutationFor — the exact batched wire shape", () => {
    it("Rounded → batch of 4 option Text + 4 radius Length writes", () => {
      const rounded = LIVE_CORNER_PRESETS.find((p) => p.style === "RoundedCorner")!;
      const m = cornerStyleMutationFor(RECT, rounded) as Extract<
        Mutation,
        { op: "batch" }
      >;
      expect(m.op).toBe("batch");
      expect(m.args.ops).toHaveLength(8);
      // The four option writes carry the IDML token verbatim.
      OPTION_PATHS.forEach((path, i) => {
        expect(m.args.ops[i]).toEqual({
          op: "setElementProperty",
          args: { elementId: RECT, path, value: { type: "text", value: "RoundedCorner" } },
        });
      });
      // The four radius writes carry the uniform radius in pt.
      RADIUS_PATHS.forEach((path, i) => {
        expect(m.args.ops[4 + i]).toEqual({
          op: "setElementProperty",
          args: {
            elementId: RECT,
            path,
            value: { type: "length", value: DEFAULT_CORNER_RADIUS_PT },
          },
        });
      });
    });

    it("None clears the option to empty text and a 0 radius", () => {
      const none = LIVE_CORNER_PRESETS.find((p) => p.style === "None")!;
      const m = cornerStyleMutationFor(RECT, none) as Extract<
        Mutation,
        { op: "batch" }
      >;
      expect(m.args.ops[0]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameCornerOptionTopLeft",
          value: { type: "text", value: "" },
        },
      });
      expect(m.args.ops[4]).toEqual({
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameCornerRadiusTopLeft",
          value: { type: "length", value: 0 },
        },
      });
    });

    it("the five presets cover Rounded / Inverse / Bevel / Fancy / None", () => {
      expect(LIVE_CORNER_PRESETS.map((p) => p.style)).toEqual([
        "RoundedCorner",
        "InverseRoundedCorner",
        "BeveledCorner",
        "FancyCorner",
        "None",
      ]);
    });
  });

  describe("cornerRadiiMutationFor — a single corner (the on-canvas-handle path)", () => {
    it("writes one corner's option + radius in a batch", () => {
      const m = cornerRadiiMutationFor(RECT, 2, "BeveledCorner", 8) as Extract<
        Mutation,
        { op: "batch" }
      >;
      expect(m.args.ops).toEqual([
        {
          op: "setElementProperty",
          args: {
            elementId: RECT,
            path: "frameCornerOptionBottomRight",
            value: { type: "text", value: "BeveledCorner" },
          },
        },
        {
          op: "setElementProperty",
          args: {
            elementId: RECT,
            path: "frameCornerRadiusBottomRight",
            value: { type: "length", value: 8 },
          },
        },
      ]);
    });
  });

  describe("withLiveCornerMarker — the §13.3 live metadata marker", () => {
    it("stamps liveCorners alongside existing draw metadata", () => {
      const prev = { v: 1, data: { tool: "addAnchor" } };
      const rounded = LIVE_CORNER_PRESETS[0];
      const next = withLiveCornerMarker(prev, rounded);
      expect(next).toEqual({
        v: 1,
        data: {
          tool: "addAnchor",
          liveCorners: { style: "RoundedCorner", radius: DEFAULT_CORNER_RADIUS_PT },
        },
      });
    });

    it("None drops the marker but keeps other metadata", () => {
      const prev = { v: 1, data: { tool: "addAnchor", liveCorners: { style: "RoundedCorner", radius: 12 } } };
      const none = LIVE_CORNER_PRESETS.find((p) => p.style === "None")!;
      expect(withLiveCornerMarker(prev, none)).toEqual({ v: 1, data: { tool: "addAnchor" } });
    });

    it("None on a marker-only envelope clears it to null", () => {
      const prev = { v: 1, data: { liveCorners: { style: "RoundedCorner", radius: 12 } } };
      const none = LIVE_CORNER_PRESETS.find((p) => p.style === "None")!;
      expect(withLiveCornerMarker(prev, none)).toBeNull();
    });
  });

  describe("Rectangle-only gap (B-23)", () => {
    it("rectangles support live corners; polygons do not", () => {
      expect(supportsLiveCorners(RECT)).toBe(true);
      expect(supportsLiveCorners(POLY)).toBe(false);
    });
  });

  describe("against the real engine (the F1 rectangle round-trips + undo)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("a Rounded preset writes the option + radius; read-back + undo restore", async () => {
      const rounded = LIVE_CORNER_PRESETS.find((p) => p.style === "RoundedCorner")!;
      const beforeOption = await readProp(h, RECT, "frameCornerOptionTopLeft");
      const beforeRadius = await readProp(h, RECT, "frameCornerRadiusTopLeft");

      const outcome = await h.host.document.mutate(cornerStyleMutationFor(RECT, rounded));
      expect(outcome.applied).toBe(true);

      // The engine reads back the rounded option + the uniform radius.
      expect(await readProp(h, RECT, "frameCornerOptionTopLeft")).toEqual({
        type: "text",
        value: "RoundedCorner",
      });
      expect(await readProp(h, RECT, "frameCornerRadiusTopLeft")).toEqual({
        type: "length",
        value: DEFAULT_CORNER_RADIUS_PT,
      });

      // One batch = one undo step restores the prior corners.
      await h.host.document.undo();
      expect(await readProp(h, RECT, "frameCornerOptionTopLeft")).toEqual(beforeOption);
      expect(await readProp(h, RECT, "frameCornerRadiusTopLeft")).toEqual(beforeRadius);
    });

    it("the recorded preset command applies on the selected rectangle + stamps the live marker", async () => {
      await h.host.selection.set([RECT]);
      const rec = h.contributions.find(
        (c) => c.kind === "command" && c.id === "media.paged.draw.command.cornersBevel",
      );
      expect(rec).toBeDefined();
      await (rec!.value as { handler: (p?: unknown) => unknown }).handler(undefined);

      // Geometry landed.
      expect(await readProp(h, RECT, "frameCornerOptionTopLeft")).toEqual({
        type: "text",
        value: "BeveledCorner",
      });
      // The §13.3 live marker is on the envelope.
      const env = await h.host.document.getMetadata(RECT);
      expect((env?.data as { liveCorners?: unknown })?.liveCorners).toEqual({
        style: "BeveledCorner",
        radius: DEFAULT_CORNER_RADIUS_PT,
      });

      // Restore: undo the metadata stamp, then the geometry batch.
      await h.host.document.undo(); // metadata marker
      await h.host.document.undo(); // corner batch
      await h.host.document.setMetadata(RECT, null);
    });

    it("with no rectangle selected the command is a no-op (no throw)", async () => {
      await h.host.selection.set([POLY]);
      const rec = h.contributions.find(
        (c) => c.kind === "command" && c.id === "media.paged.draw.command.cornersRounded",
      );
      await expect(
        (rec!.value as { handler: (p?: unknown) => unknown }).handler(undefined),
      ).resolves.toBeUndefined();
    });
  });
});
