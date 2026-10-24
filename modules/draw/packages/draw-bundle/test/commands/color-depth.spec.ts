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

// RECOLOR ARTWORK, the COLOR GUIDE and the IMAGE TRACE presets / re-trace
// (WP6.5, WP6.6) with NO ENGINE: what each command DECIDES and SENDS —
// which mutations, aimed at what, as how many undo steps — and the pure
// halves (the request parser, the targets, the batch, the presets).

import { describe, expect, it } from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import {
  presetMatching,
  recolorBatchFor,
  recolorRequestFrom,
  recolorTargetsFor,
  tracePresetFrom,
  tracePresetOptions,
  traceOptionsFrom,
  RECOLOR_PANEL_ID,
  TRACE_DEFAULTS,
  TRACE_PRESET_IDS,
  type ArtworkColor,
  type ArtworkRead,
} from "../../src";
import { pngBytes } from "../fixtures/build-idml";
import { ringPixels } from "../fixtures/corpus";
import { installPngRealm } from "../headless/raster-realm";
import { rectEl, unitRig, type FakeElement } from "./unit-kit";

const C = "media.paged.draw.command";
const A = { kind: "polygon", id: "ua" } as ElementId;
const B = { kind: "polygon", id: "ub" } as ElementId;

const ref = (value: string) => ({ type: "colorRef", value });
const SWATCHES = [
  { selfId: "Color/ured", name: "#ff0000", kind: "process" },
  { selfId: "Color/ublue", name: "#0000ff", kind: "process" },
  { selfId: "Color/uorange", name: "#ff8000", kind: "process" },
];
const doc = (): FakeElement[] => [
  rectEl("polygon", "ua", [100, 100, 200, 200], {
    frameFillColor: ref("Color/ured"),
    frameStrokeColor: ref("Color/ublue"),
  }),
  rectEl("polygon", "ub", [300, 100, 400, 200], {
    frameFillColor: ref("Color/ured"),
    frameFillTint: { type: "length", value: 40 },
  }),
];
const rig = (selection: ElementId[] = [A, B], shell = false) =>
  unitRig(doc(), { selection, shell, collections: { swatches: SWATCHES } });

const ops = (sent: Mutation[], op: string) =>
  sent.filter((m) => m.op === op) as {
    op: string;
    args: Record<string, unknown>;
  }[];

describe("paged.draw commands, no engine — Recolor Artwork", () => {
  it("a harmony recolour is ONE batch: the new swatch, then the refs re-pointed; the tint is never written", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    const r = rig();
    await r.run(`${C}.recolorArtwork`, {
      mode: "map",
      map: { "Color/ured": "#00ff00" },
    });
    expect(r.steps()).toBe(1);
    const leaves = r.leaves();
    expect(ops(leaves, "createSwatch")).toHaveLength(1);
    const writes = ops(leaves, "setElementProperty");
    expect(writes.map((w) => w.args.path)).toEqual([
      "frameFillColor",
      "frameFillColor",
    ]);
    expect(writes.some((w) => w.args.path === "frameFillTint")).toBe(false);
  });

  it("reduce re-points onto an EXISTING colour and mints nothing", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    const r = rig([A]);
    await r.run(`${C}.recolorArtwork`, { mode: "reduce", count: 1 });
    expect(r.steps()).toBe(1);
    expect(ops(r.leaves(), "createSwatch")).toHaveLength(0);
    const w = ops(r.leaves(), "setElementProperty");
    expect(w).toHaveLength(1);
    expect((w[0]!.args.value as { value: string }).value).toBe("Color/ured");
  });

  it("a selection with no colour is refused and sends nothing", async () => {
    covers("command:media.paged.draw.command.recolorArtwork");
    const r = rig([]);
    await r.run(`${C}.recolorArtwork`, {});
    expect(r.sent()).toEqual([]);
    expect(r.logs.join("\n")).toContain("no colour to recolour");
  });

  it("the “…” row raises the Recolor Artwork panel and writes nothing", async () => {
    covers("command:media.paged.draw.command.recolorArtworkOptions");
    const r = rig([A], true);
    await r.run(`${C}.recolorArtworkOptions`);
    expect(r.opened).toEqual([RECOLOR_PANEL_ID]);
    expect(r.sent()).toEqual([]);
  });

  it("the Color Guide's apply fills the selection in one batch, reusing a swatch named for the colour", async () => {
    covers("command:media.paged.draw.command.applyGuideColor");
    const r = rig();
    await r.run(`${C}.applyGuideColor`, { hex: "#0000ff" });
    expect(r.steps()).toBe(1);
    expect(ops(r.leaves(), "createSwatch")).toHaveLength(0);
    const w = ops(r.leaves(), "setElementProperty");
    expect(w.map((x) => (x.args.value as { value: string }).value)).toEqual([
      "Color/ublue",
      "Color/ublue",
    ]);
    r.reset();
    await r.run(`${C}.applyGuideColor`, { hex: "#123456", stroke: true });
    expect(ops(r.leaves(), "createSwatch")).toHaveLength(1);
    expect(ops(r.leaves(), "setElementProperty")[0]!.args.path).toBe(
      "frameStrokeColor",
    );
    r.reset();
    await r.run(`${C}.applyGuideColor`, {});
    expect(r.sent()).toEqual([]);
  });
});

describe("Recolor Artwork — the pure halves", () => {
  const colors: ArtworkColor[] = [
    {
      ref: "Color/ured",
      name: "#ff0000",
      rgb: [255, 0, 0],
      model: "process",
      weight: 3,
    },
    {
      ref: "Color/uspot",
      name: "Spot",
      rgb: [0, 128, 64],
      model: "spot",
      weight: 1,
    },
  ];
  const read: ArtworkRead = {
    colors,
    slots: [
      { element: A, kind: "fill", ref: "Color/ured" },
      { element: B, kind: "fill", ref: "Color/uspot" },
      { element: B, kind: "appearanceFill", layer: 0, ref: "Color/ured" },
    ],
    gradients: new Map(),
    envelopes: new Map([
      [
        "polygon:ub",
        {
          v: 1,
          data: {
            appearance: {
              fills: [{ color: "Color/ured", tint: 30 }],
              strokes: [],
            },
          },
        },
      ],
    ]),
    swatches: [],
    leaves: [A, B],
  };
  let n = 0;
  const mint = {
    swatch: () => `Color/m${n++}`,
    gradient: () => `Gradient/m${n++}`,
  };

  it("the request parser takes a record or the twin's list as the map", () => {
    expect(
      recolorRequestFrom({ map: [{ from: "a", to: "#fff" }] }),
    ).toMatchObject({
      mode: "map",
      map: { a: "#fff" },
    });
    expect(recolorRequestFrom({ mode: "reduce", count: 2.7 }).count).toBe(2);
    expect(recolorRequestFrom({ rule: "nope" }).rule).toBe("complementary");
  });

  it("a spot colour's replacement is minted as a spot; an appearance layer keeps its tint", () => {
    const targets = recolorTargetsFor(
      colors,
      recolorRequestFrom({
        map: { "Color/uspot": "#aa00cc", "Color/ured": "#00aa00" },
      }),
    );
    const plan = recolorBatchFor(read, targets, mint);
    const created = plan.created.map((c) => c.model);
    expect(created.sort()).toEqual(["process", "spot"]);
    const children = (plan.batch as { args: { ops: Mutation[] } }).args.ops;
    const stamp = children.find((m) => m.op === "setPluginMetadata") as {
      args: { value: string };
    };
    const env = JSON.parse(stamp.args.value);
    expect(env.data.appearance.fills[0].tint).toBe(30);
    expect(env.data.appearance.fills[0].color).not.toBe("Color/ured");
    expect(plan.rewritten).toBe(3);
  });

  it("targets are deterministic and only name colours that change", () => {
    const req = recolorRequestFrom({
      mode: "harmony",
      rule: "triadic",
      base: "#ff0000",
    });
    const a = recolorTargetsFor(colors, req);
    const b = recolorTargetsFor(colors, req);
    expect([...a]).toEqual([...b]);
    // Red is the heaviest and IS the base: unchanged.
    expect(a.has("Color/ured")).toBe(false);
  });
});

describe("Image Trace presets (WP6.6) — the mapping", () => {
  it("every preset is a full option set; the named ones map to their modes", () => {
    for (const id of TRACE_PRESET_IDS) {
      const o = tracePresetOptions(id);
      expect(Object.keys(o).sort()).toEqual(Object.keys(TRACE_DEFAULTS).sort());
      expect(presetMatching(o)).toBe(id);
    }
    expect(tracePresetOptions("lineArt").mode).toBe("centerline");
    expect(tracePresetOptions("technicalDrawing")).toMatchObject({
      mode: "centerline",
      pathMode: "polygon",
    });
    expect(tracePresetOptions("colors3").maxColors).toBe(3);
    expect(tracePresetOptions("colors6").maxColors).toBe(6);
    expect(tracePresetOptions("colors16").maxColors).toBe(16);
    expect(tracePresetOptions("shadesOfGray")).toMatchObject({
      grayscale: true,
      maxColors: 8,
    });
    expect(tracePresetOptions("silhouettes").mode).toBe("bw");
    expect(tracePresetOptions("highFidelityPhoto").colorPrecision).toBe(8);
    expect(tracePresetOptions("default")).toEqual(TRACE_DEFAULTS);
  });

  it("a payload's preset is the base its other keys override", () => {
    const o = traceOptionsFrom({ preset: "colors6", maxColors: 5 });
    expect(o.maxColors).toBe(5);
    expect(o.colorPrecision).toBe(8);
    expect(tracePresetFrom({ preset: "colors6" })).toBe("colors6");
    expect(tracePresetFrom({ preset: "x" })).toBeNull();
    expect(presetMatching(o)).toBeNull();
    // Without a preset the record's options are the base (a re-trace).
    expect(
      traceOptionsFrom({ filterSpeckle: 9 }, tracePresetOptions("lineArt"))
        .mode,
    ).toBe("centerline");
  });
});

describe("paged.draw commands, no engine — Image Trace options and Re-trace", () => {
  const IMAGE = { kind: "rectangle", id: "uimg" } as ElementId;
  const PNG = pngBytes(48, 48, ringPixels(48));
  const image: FakeElement = rectEl("rectangle", "uimg", [100, 100, 196, 196]);
  const bytesReply = (m: { kind: string }) =>
    m.kind === "requestPlacedAssetBytes"
      ? {
          kind: "placedAssetBytes",
          payload: {
            elementId: "uimg",
            found: true,
            uri: "file:ring-48.png",
            width: 48,
            height: 48,
            encoded: Array.from(PNG),
          },
        }
      : undefined;

  it("the “…” row raises the Image Trace panel and writes nothing", async () => {
    covers("command:media.paged.draw.command.imageTraceOptions");
    const r = unitRig([image], { selection: [IMAGE], shell: true });
    await r.run(`${C}.imageTraceOptions`);
    expect(r.opened).toEqual(["media.paged.draw.panel.imageTrace"]);
    expect(r.sent()).toEqual([]);
  });

  it("Re-trace refuses an image that was never traced, and replaces a trace in ONE batch", async () => {
    covers("command:media.paged.draw.command.retraceImage");
    const uninstall = installPngRealm();
    try {
      const r = unitRig([image], {
        selection: [IMAGE],
        reply: bytesReply as never,
      });
      const geometry = r.fake.editor.client.elementGeometry.bind(
        r.fake.editor.client,
      );
      (r.fake.editor.client as { elementGeometry: unknown }).elementGeometry =
        async (ids: ElementId[]) =>
          (await geometry(ids)).map((g) => ({ ...g, hasImage: true }));
      await r.run(`${C}.retraceImage`);
      expect(r.sent()).toEqual([]);
      expect(r.logs.join("\n")).toContain("has not been traced yet");
      await r.run(`${C}.imageTrace`, { preset: "blackAndWhiteLogo" });
      expect(r.steps()).toBe(1);
      r.reset();
      r.fake.setSelection([IMAGE]);
      await r.run(`${C}.retraceImage`, { preset: "lineArt" });
      expect(r.steps()).toBe(1);
      expect(r.sent()).toHaveLength(1);
      const leaves = r.leaves();
      expect(ops(leaves, "insertPath").length).toBeGreaterThan(0);
      expect(ops(leaves, "deleteFrame").length).toBeGreaterThan(0);
      // Centreline strokes (the ring is a drawn LOOP, so its one stroke is
      // closed): a stroke weight, and no fill.
      const writes = ops(leaves, "setElementProperty");
      expect(writes.some((w) => w.args.path === "frameStrokeWeight")).toBe(
        true,
      );
      expect(
        writes
          .filter((w) => w.args.path === "frameFillColor")
          .every((w) => (w.args.value as { value: unknown }).value === null),
      ).toBe(true);
    } finally {
      uninstall();
    }
  });
});
