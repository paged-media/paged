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

// Wave 2 conformance — the Eyedropper: (1) the exact batch wire shape
// the apply emits (per-target supported-path intersection — the
// probed engine truth: a GraphicLine rejects FrameFillColor/Tint/
// Opacity writes), (2) the LIVE click handler sampling a real element
// through hitTest + the B-19 typed-property door and re-styling the
// selection in ONE batch (one undo round-trip), (3) Alt+click
// sampling WITHOUT applying, (4) a plain click on empty canvas as a
// no-op. The tool samples element PROPERTIES, not composited pixels
// (the handler's honest scope) — asserted here only through property
// reads.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CanvasPointerEvent,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  createEyedropperHandler,
  sampledStyleFrom,
  applyStyleMutationFor,
  getEyedropperSample,
  clearEyedropperSample,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: "urect" } as ElementId;
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const RED = "Color/ured";

function click(
  pageId: string,
  point: [number, number],
  alt = false,
): CanvasPointerEvent {
  return {
    pageId,
    pagePoint: point,
    docPoint: point,
    modifiers: { shift: false, alt, cmd: false, ctrl: false },
    maxDelta: 0,
    button: 0,
    target: null,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    pointerType: "mouse",
  };
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 4));
  }
  throw new Error("timed out waiting for the eyedropper to land");
}

async function fillRefOf(
  h: HeadlessHost,
  id: ElementId,
): Promise<string | null | undefined> {
  const props = await h.host.document.elementProperties(id);
  for (const entry of props?.entries ?? []) {
    if (entry.path === "frameFillColor" && entry.value?.type === "colorRef") {
      return entry.value.value;
    }
  }
  return undefined;
}

describe("draw conformance — eyedropper (wave 2)", () => {
  it("applyStyleMutationFor: ONE batch, per-target supported-path intersection", () => {
    const full = new Set([
      "frameFillColor",
      "frameStrokeColor",
      "frameStrokeWeight",
    ]);
    const strokesOnly = new Set(["frameStrokeColor", "frameStrokeWeight"]);
    const LINE = { kind: "graphicLine", id: "uline" } as ElementId;
    const m = applyStyleMutationFor(
      [
        { id: RECT, supports: full },
        { id: LINE, supports: strokesOnly },
      ],
      { fillColor: "Color/Black", strokeWeight: 2, fillTint: null, opacity: null },
    ) as Extract<Mutation, { op: "batch" }>;
    expect(m).toEqual({
      op: "batch",
      args: {
        ops: [
          {
            op: "setElementProperty",
            args: {
              elementId: RECT,
              path: "frameFillColor",
              value: { type: "colorRef", value: "Color/Black" },
            },
          },
          {
            op: "setElementProperty",
            args: {
              elementId: RECT,
              path: "frameStrokeWeight",
              value: { type: "length", value: 2 },
            },
          },
          // The line target gets NO fill op (unsupported path) and no
          // tint/opacity (null = no information — the skip that also
          // sidesteps the Polygon tint read≠write asymmetry).
          {
            op: "setElementProperty",
            args: {
              elementId: LINE,
              path: "frameStrokeWeight",
              value: { type: "length", value: 2 },
            },
          },
        ],
      },
    });
    // Nothing readable / no targets → nothing to write.
    expect(applyStyleMutationFor([{ id: RECT, supports: full }], {})).toBeNull();
    expect(applyStyleMutationFor([], { fillColor: "Color/Black" })).toBeNull();
  });

  describe("against the real engine (F1)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
      // Give the rectangle a DISTINCT red fill so the transfer onto the
      // (already black) polygon is observable.
      const sw = await h.host.document.mutate({
        op: "createSwatch",
        args: {
          spec: { selfId: RED, name: "#ff0000", space: "RGB", value: [255, 0, 0] },
        },
      });
      if (!sw.applied) throw new Error("createSwatch failed");
      const set = await h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameFillColor",
          value: { type: "colorRef", value: RED },
        },
      });
      if (!set.applied) throw new Error("fill seed failed");
    });
    afterAll(() => h?.dispose());

    it("sampledStyleFrom reads the fixture rectangle's real snapshot", async () => {
      const props = await h.host.document.elementProperties(RECT);
      const style = sampledStyleFrom(props);
      expect(style).not.toBeNull();
      expect(style!.fillColor).toBe(RED);
    });

    it("click on the rectangle applies its fill to the selected polygon (one undo)", async () => {
      clearEyedropperSample();
      expect(await fillRefOf(h, POLY)).toBe("Color/Black");
      await h.host.selection.set([POLY]);
      const handler = createEyedropperHandler(h.host);
      handler.onActivate(undefined as never);
      // (200, 200) is inside the rectangle (100..300 square).
      handler.onPointerUp(click(F1_MULTI_SHAPE.pageId, [200, 200]));
      await until(async () => (await fillRefOf(h, POLY)) === RED);
      // The sample was stored too.
      expect(getEyedropperSample()?.fillColor).toBe(RED);
      // ONE batch = ONE undo step returns the polygon's previous fill.
      await h.host.document.undo();
      await until(async () => (await fillRefOf(h, POLY)) === "Color/Black");
      handler.onDeactivate("switch");
    });

    it("Alt+click samples ONLY — the selection keeps its style", async () => {
      clearEyedropperSample();
      await h.host.selection.set([POLY]);
      const handler = createEyedropperHandler(h.host);
      handler.onActivate(undefined as never);
      handler.onPointerUp(click(F1_MULTI_SHAPE.pageId, [200, 200], true));
      await until(async () => getEyedropperSample() !== null);
      expect(getEyedropperSample()?.fillColor).toBe(RED);
      // Ample settle time, then: the polygon is untouched.
      await new Promise((r) => setTimeout(r, 100));
      expect(await fillRefOf(h, POLY)).toBe("Color/Black");
      handler.onDeactivate("switch");
    });

    it("a plain click on empty canvas is a no-op", async () => {
      clearEyedropperSample();
      await h.host.selection.set([POLY]);
      const handler = createEyedropperHandler(h.host);
      handler.onActivate(undefined as never);
      // (550, 700) hits nothing in F1.
      handler.onPointerUp(click(F1_MULTI_SHAPE.pageId, [550, 700]));
      await new Promise((r) => setTimeout(r, 100));
      expect(getEyedropperSample()).toBeNull();
      expect(await fillRefOf(h, POLY)).toBe("Color/Black");
      handler.onDeactivate("switch");
    });
  });
});
