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

// Phase 2d — FILL panel conformance (the B-03 consumer): the
// gradient section's published binding (`gradientControlsVisible`)
// derived from REAL document state on the REAL engine, and the
// gradient-fill preset commands (the dash precedent for flows above
// the scalar binding ceiling).
//
// The binding driver reads the first selected element's
// `frameFillColor` through `requestElementProperties` (the marked
// escape hatch — fill-panel.ts names the missing facade door / RFI
// gap) and recomputes on BOTH selection and document changes, so a
// gradient assignment (or its undo) flips the section without a
// selection change. That reactive loop is asserted here end-to-end.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
import {
  BIND_GRADIENT_CONTROLS_VISIBLE,
  FILL_GRADIENT_PRESETS,
  fillGradientMutationsFor,
  mintFillGradientIds,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: F1_MULTI_SHAPE.ids.rectangle! } as const;
const POLY = { kind: "polygon", id: F1_MULTI_SHAPE.ids.polygon! } as const;

/** Pull the `value` of a recorded command contribution by id. */
function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

/** Await a predicate (the binding recompute is async: a selection /
 *  document event, then an engine read, then the publish). */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) {
      throw new Error("waitFor: condition not reached");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("draw conformance — fill panel + gradient-fill commands (B-03)", () => {
  describe("fillGradientMutationsFor — the exact wire sequence per preset", () => {
    const IDS = {
      stopA: "Color/utestA",
      stopB: "Color/utestB",
      gradient: "Gradient/utestG",
    };

    it("emits stops → gradient → one frameFillColor ref per element", () => {
      const linear = FILL_GRADIENT_PRESETS[0];
      const ms = fillGradientMutationsFor(
        [RECT, POLY] as unknown as ElementId[],
        linear,
        IDS,
      );
      expect(ms.map((m) => m.op)).toEqual([
        "createSwatch",
        "createSwatch",
        "createGradient",
        "setElementProperty",
        "setElementProperty",
      ]);
      const grad = ms[2] as Extract<Mutation, { op: "createGradient" }>;
      expect(grad.args.spec.selfId).toBe(IDS.gradient);
      expect(grad.args.spec.kind).toBe("Linear");
      expect(grad.args.spec.stops).toEqual([
        { stopColor: IDS.stopA, locationPct: 0 },
        { stopColor: IDS.stopB, locationPct: 100 },
      ]);
      const fill = ms[3] as Extract<Mutation, { op: "setElementProperty" }>;
      expect(fill.args.elementId).toBe(RECT);
      expect(fill.args.path).toBe("frameFillColor");
      expect(fill.args.value).toEqual({
        type: "colorRef",
        value: IDS.gradient,
      });
    });

    it("the radial preset carries kind Radial", () => {
      const radial = FILL_GRADIENT_PRESETS[1];
      const ms = fillGradientMutationsFor(
        [RECT] as unknown as ElementId[],
        radial,
        IDS,
      );
      const grad = ms[2] as Extract<Mutation, { op: "createGradient" }>;
      expect(grad.args.spec.kind).toBe("Radial");
    });

    it("minted self-ids are unique per invocation (repeat commands must not collide)", () => {
      const a = mintFillGradientIds();
      const b = mintFillGradientIds();
      expect(a.gradient).not.toBe(b.gradient);
      expect(a.stopA).not.toBe(b.stopA);
      expect(a.stopB).not.toBe(b.stopB);
    });
  });

  describe("the published gradient binding + the live commands on the real engine", () => {
    let h: HeadlessHost;
    const bindingValue = () =>
      h.host.bindings.get(BIND_GRADIENT_CONTROLS_VISIBLE);

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("a solid-filled selection reads gradientControlsVisible=false", async () => {
      await h.host.selection.set([RECT] as never);
      await waitFor(() => bindingValue() === false);
      expect(bindingValue()).toBe(false);
    });

    it("assigning a gradient ref flips the binding true (document change, same selection); undo flips it back", async () => {
      // Build a gradient by hand (the gradient-fill.spec lane), then
      // point the SELECTED rect's fill at it — no selection change.
      // Stops reference the fixture's `Color/Black` (collection creates
      // report `createdId: null` — the pinned finding — so a created
      // stop swatch couldn't be addressed back anyway).
      const gid = "Gradient/ufillpanel";
      const created = await h.host.document.mutate({
        op: "createGradient",
        args: {
          spec: {
            selfId: gid,
            name: "FP Linear",
            kind: "Linear",
            stops: [
              { stopColor: "Color/Black", locationPct: 0 },
              { stopColor: "Color/Black", locationPct: 100 },
            ],
          },
        },
      } as never);
      expect(created.applied).toBe(true);

      await h.host.selection.set([RECT] as never);
      await waitFor(() => bindingValue() === false);

      const fill = await h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameFillColor",
          value: { type: "colorRef", value: gid },
        },
      } as never);
      expect(fill.applied).toBe(true);
      // The driver recomputes on the document change — the section gate
      // opens without any selection change.
      await waitFor(() => bindingValue() === true);

      // The axis scrubs the section exposes land at the engine.
      const angle = await h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameGradientFillAngle",
          value: { type: "length", value: 45 },
        },
      } as never);
      expect(angle.applied).toBe(true);
      const len = await h.host.document.mutate({
        op: "setElementProperty",
        args: {
          elementId: RECT,
          path: "frameGradientFillLength",
          value: { type: "length", value: 120 },
        },
      } as never);
      expect(len.applied).toBe(true);

      // Unwind: length, angle, fill — the fill is solid again and the
      // binding follows the undo (the reactive proof in reverse).
      await h.host.document.undo();
      await h.host.document.undo();
      await h.host.document.undo();
      await waitFor(() => bindingValue() === false);
      // Unwind the gradient too (pristine collections).
      await h.host.document.undo();
    });

    it("the Fill: Linear gradient command creates the ramp and assigns it (binding flips true)", async () => {
      // The RECT is the target: the engine supports `frameFillColor`
      // on rectangles; on a Polygon the property is `notImplemented`
      // ("property FrameFillColor is not supported on Polygon") — an
      // engine-side limit the command surfaces as a warn, not a throw.
      await h.host.selection.set([RECT] as never);
      await waitFor(() => bindingValue() === false);

      const cmd = commandFor(
        h,
        "media.paged.draw.command.fillGradientLinear",
      );
      await cmd.handler(undefined);

      // The minted gradient landed in the collection…
      const gradients = await h.host.document.collection("gradients");
      expect(JSON.stringify(gradients)).toContain("Gradient/udrawg");
      // …and the selected element's fill now references it (the driver
      // re-read the fill on the document change).
      await waitFor(() => bindingValue() === true);

      // Unwind the command's four mutations (fill, gradient, 2 stops).
      await h.host.document.undo();
      await h.host.document.undo();
      await h.host.document.undo();
      await h.host.document.undo();
      await waitFor(() => bindingValue() === false);
      expect(
        JSON.stringify(await h.host.document.collection("gradients")),
      ).not.toContain("Gradient/udrawg");
    });

    it("with NO selection the gradient command is a no-op and the binding reads false", async () => {
      await h.host.selection.set([]);
      await waitFor(() => bindingValue() === false);
      const cmd = commandFor(
        h,
        "media.paged.draw.command.fillGradientRadial",
      );
      await expect(cmd.handler(undefined)).resolves.toBeUndefined();
      expect(
        JSON.stringify(await h.host.document.collection("gradients")),
      ).not.toContain("Gradient/udrawg");
    });
  });
});
