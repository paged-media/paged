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

// RECOLOR ARTWORK and the COLOR GUIDE (WP6.5) through the REAL engine:
// the colour group read off the selection, each recolour way applied as
// ONE batch that ONE undo takes back, a spot colour's tint kept as a tint,
// a gradient's stops recoloured into a new gradient (the original is left
// for the artwork outside the selection), appearance layers re-pointed,
// and the Color Guide's click painting the fill.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type {
  CommandContribution,
  ElementId,
  MutationInput,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import {
  appearanceOf,
  applyGuideColor,
  applyRecolorArtwork,
  drawBundle,
  rawGradientDetail,
  readArtworkColors,
  RECOLOR_ARTWORK_OPTIONS_COMMAND_ID,
} from "../../src";
import { packageWithSpread } from "../fixtures/build-idml";
import { squareItem } from "../panels/panel-document";
import { openHost } from "./host";

const P = (id: string) => ({ kind: "polygon", id }) as ElementId;
const A = P("ca");
const B = P("cb");
const C = P("cc");
const OUTSIDE = P("cx");

const doc = () =>
  packageWithSpread(
    squareItem("ca", 40, 40, 60) +
      squareItem("cb", 140, 40, 60) +
      squareItem("cc", 240, 40, 60) +
      squareItem("cx", 340, 40, 60),
  );

const swatch = (
  selfId: string,
  name: string,
  value: number[],
  model?: string,
): MutationInput => ({
  op: "createSwatch",
  args: {
    spec: { selfId, name, space: "RGB", value, ...(model ? { model } : {}) },
  },
});
const fill = (id: ElementId, ref: string): MutationInput => ({
  op: "setElementProperty",
  args: {
    elementId: id,
    path: "frameFillColor",
    value: { type: "colorRef", value: ref },
  },
});
const stroke = (id: ElementId, ref: string): MutationInput => ({
  op: "setElementProperty",
  args: {
    elementId: id,
    path: "frameStrokeColor",
    value: { type: "colorRef", value: ref },
  },
});

async function refOf(
  h: HeadlessHost,
  id: ElementId,
  path: string,
): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  return props?.entries.find((e) => e.path === path)?.value?.value ?? null;
}

async function seed(h: HeadlessHost): Promise<void> {
  await h.load(doc());
  const outcome = await h.host.document.mutate({
    op: "batch",
    args: {
      ops: [
        swatch("Color/ured", "#ff0000", [255, 0, 0]),
        swatch("Color/ured2", "#e01010", [224, 16, 16]),
        swatch("Color/ublue", "#0000ff", [0, 0, 255]),
        swatch("Color/uspot", "Brand green", [0, 128, 64], "Spot"),
        {
          op: "createGradient",
          args: {
            spec: {
              selfId: "Gradient/ugrad",
              name: "Red to blue",
              kind: "Linear",
              stops: [
                { stopColor: "Color/ured", locationPct: 0 },
                { stopColor: "Color/ublue", locationPct: 100 },
              ],
            },
          },
        },
        fill(A, "Color/ured"),
        stroke(A, "Color/ublue"),
        fill(B, "Color/uspot"),
        {
          op: "setElementProperty",
          args: {
            elementId: B,
            path: "frameFillTint",
            value: { type: "length", value: 40 },
          },
        },
        fill(C, "Gradient/ugrad"),
        fill(OUTSIDE, "Color/ured"),
      ] as never,
    },
  });
  expect(outcome.applied).toBe(true);
}

describe("draw conformance — RECOLOR ARTWORK (WP6.5)", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(doc());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await seed(h);
    await h.host.selection.set([A, B, C]);
  });

  it("reads the colour group: fills, strokes and gradient stops, heaviest first, at their display colours", async () => {
    const read = await readArtworkColors(h.host);
    const refs = read.colors.map((c) => c.ref);
    expect(new Set(refs)).toEqual(
      new Set(["Color/ured", "Color/ublue", "Color/uspot"]),
    );
    // Red: A's fill + a stop; blue: A's stroke + a stop; the spot: B.
    expect(read.colors.find((c) => c.ref === "Color/ured")?.weight).toBe(2);
    expect(read.colors.find((c) => c.ref === "Color/uspot")?.model).toBe(
      "spot",
    );
    expect(read.colors.find((c) => c.ref === "Color/ured")?.rgb).toEqual([
      255, 0, 0,
    ]);
    expect(read.gradients.has("Gradient/ugrad")).toBe(true);
  });

  it("HARMONY: one batch re-points the selection; the artwork OUTSIDE it keeps its colour; ONE undo takes it back", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    const swatchesBefore = (await h.host.document.collection("swatches"))
      .length;
    const out = await applyRecolorArtwork(h.host, {
      mode: "harmony",
      rule: "triadic",
      base: "#00a0ff",
    });
    expect(out.applied).toBe(true);
    expect(out.changed).toBeGreaterThan(0);
    const aFill = await refOf(h, A, "frameFillColor");
    expect(aFill).not.toBe("Color/ured");
    expect(await refOf(h, OUTSIDE, "frameFillColor")).toBe("Color/ured");
    // The gradient was recoloured into a NEW gradient; the old one stays.
    const cFill = String(await refOf(h, C, "frameFillColor"));
    expect(cFill).not.toBe("Gradient/ugrad");
    expect(cFill.startsWith("Gradient/")).toBe(true);
    const detail = await rawGradientDetail(h.host, cFill);
    expect(detail?.stops.map((s) => s.stopColorRef)).not.toContain(
      "Color/ured",
    );
    expect(await rawGradientDetail(h.host, "Gradient/ugrad")).not.toBeNull();
    // ONE undo.
    await h.host.document.undo();
    expect(await refOf(h, A, "frameFillColor")).toBe("Color/ured");
    expect(await refOf(h, C, "frameFillColor")).toBe("Gradient/ugrad");
    expect((await h.host.document.collection("swatches")).length).toBe(
      swatchesBefore,
    );
  });

  it("a SPOT colour's tint stays a tint, and its replacement is a spot", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    await h.host.selection.set([B]);
    const out = await applyRecolorArtwork(h.host, {
      mode: "map",
      map: { "Color/uspot": "#aa00cc" },
    });
    expect(out.applied).toBe(true);
    const ref = String(await refOf(h, B, "frameFillColor"));
    expect(ref).not.toBe("Color/uspot");
    expect(await refOf(h, B, "frameFillTint")).toBe(40);
    const display = await h.host.document.swatchDisplay([ref]);
    expect(display[0]?.model.toLowerCase()).toBe("spot");
    expect(display[0]?.rgbHex.toLowerCase()).toBe("#aa00cc");
  });

  it("REDUCE: colours merge onto the heaviest existing colour of their cluster — no swatch minted", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    await h.host.document.mutate(fill(B, "Color/ured2"));
    await h.host.selection.set([A, B]);
    const swatchesBefore = (await h.host.document.collection("swatches"))
      .length;
    const out = await applyRecolorArtwork(h.host, { mode: "reduce", count: 2 });
    expect(out.applied).toBe(true);
    expect(out.created).toBe(0);
    expect(await refOf(h, B, "frameFillColor")).toBe("Color/ured");
    expect((await h.host.document.collection("swatches")).length).toBe(
      swatchesBefore,
    );
  });

  it("LIBRARY: each colour becomes the nearest swatch of a colour group", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          swatch("Color/uorange", "#ff8000", [255, 128, 0]),
          swatch("Color/unavy", "#000080", [0, 0, 128]),
          {
            op: "createColorGroup",
            args: {
              spec: {
                selfId: "ColorGroup/ulib",
                name: "Lib",
                members: ["Color/uorange", "Color/unavy"],
              },
            },
          },
        ] as never,
      },
    });
    await h.host.selection.set([A]);
    const out = await applyRecolorArtwork(h.host, {
      mode: "library",
      colorGroup: "ColorGroup/ulib",
    });
    expect(out.applied).toBe(true);
    expect(await refOf(h, A, "frameFillColor")).toBe("Color/uorange");
    expect(await refOf(h, A, "frameStrokeColor")).toBe("Color/unavy");
  });

  it("APPEARANCE layers are colours of the group and are re-pointed in their stack", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    await h.host.selection.set([OUTSIDE]);
    await h.host.document.mutate({
      op: "setPluginMetadata",
      args: {
        elementId: OUTSIDE,
        key: "x-paged:media.paged.draw",
        value: JSON.stringify({
          v: 1,
          data: {
            appearance: { fills: [{ color: "Color/ublue" }], strokes: [] },
          },
        }),
        caller: "media.paged.draw",
      },
    } as never);
    const read = await readArtworkColors(h.host);
    expect(read.colors.map((c) => c.ref)).toContain("Color/ublue");
    const out = await applyRecolorArtwork(h.host, {
      mode: "map",
      map: { "Color/ublue": "#123456" },
    });
    expect(out.applied).toBe(true);
    const stack = appearanceOf(await h.host.document.getMetadata(OUTSIDE));
    expect(stack.fills[0]?.color).not.toBe("Color/ublue");
  });

  it("nothing recolourable selected is a refusal that writes nothing", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    await h.host.selection.set([]);
    expect((await applyRecolorArtwork(h.host, {})).applied).toBe(false);
  });

  it("the options row applies the default recolour on a host with no panel door (one undo)", async () => {
    covers("command:media.paged.draw.command.recolorArtworkOptions");
    await h.host.selection.set([A]);
    const rec = h.contributions.find(
      (c) =>
        c.kind === "command" && c.id === RECOLOR_ARTWORK_OPTIONS_COMMAND_ID,
    );
    expect(rec).toBeDefined();
    await (rec!.value as CommandContribution).handler(undefined, undefined);
    // Complementary on red: red (the heaviest) keeps the base, the blue
    // stroke takes the complement.
    expect(await refOf(h, A, "frameFillColor")).toBe("Color/ured");
    expect(await refOf(h, A, "frameStrokeColor")).not.toBe("Color/ublue");
    await h.host.document.undo();
    expect(await refOf(h, A, "frameStrokeColor")).toBe("Color/ublue");
  });
});

describe("draw conformance — the COLOR GUIDE's apply (WP6.5)", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(doc());
    h.loadBundle(drawBundle);
    await seed(h);
  });
  afterAll(() => h?.dispose());

  it("paints the selection's fill (or stroke) in ONE undo step, reusing a swatch of that name", async () => {
    covers("command:media.paged.draw.command.applyGuideColor");
    await h.host.selection.set([A, B]);
    expect(await applyGuideColor(h.host, { hex: "#ff0000" })).toBe(true);
    // "#ff0000" names an existing swatch: reused.
    expect(await refOf(h, B, "frameFillColor")).toBe("Color/ured");
    expect(
      await applyGuideColor(h.host, { hex: "#336699", stroke: true }),
    ).toBe(true);
    const ref = String(await refOf(h, A, "frameStrokeColor"));
    expect(
      (await h.host.document.swatchDisplay([ref]))[0]?.rgbHex.toLowerCase(),
    ).toBe("#336699");
    await h.host.document.undo();
    expect(await refOf(h, A, "frameStrokeColor")).toBe("Color/ublue");
    expect(await applyGuideColor(h.host, {})).toBe(false);
  });
});
