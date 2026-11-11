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

// WP6.9 — Pattern Options save a field as an ENGINE PATTERN SWATCH
// (engine ADR 1041), through the real engine wasm. Pins: the pure
// mapping from a field's plan to the engine's pattern spec (grid, brick,
// hex, spacing, overlap, the tile origin, colours a tile can carry);
// the save as ONE undo step that lists the swatch and lets any frame
// take it as a fill; a second save updating the same swatch in place;
// Done removing the copies and keeping the sources; and the refusal on
// a host whose engine has no pattern paint.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyMakePattern,
  applySavePatternSwatch,
  patternLinks,
  patternSwatchIdFor,
  patternSwatchSpecFor,
  readPatternLibrary,
  writePatternLibrary,
  HEX_ROW_FACTOR,
  PATTERN_DEFAULTS,
  PATTERN_LIBRARY_VERSION,
  SAVE_PATTERN_SWATCH_COMMAND_ID,
  type PatternParams,
  type PatternPlan,
} from "../../src";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

const poly = (id: string): ElementId => ({ kind: "polygon", id }) as ElementId;
const OUTER = poly(F6_RING_PAIR.ids.polygon!);
/** The 100 pt inner ring: its copies land on the page. */
const INNER = poly(F6_RING_PAIR.innerId);

const square = (x: number, y: number, s: number) => ({
  anchors: [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ].map(([px, py]) => ({
    anchor: [px!, py!] as [number, number],
    left: [px!, py!] as [number, number],
    right: [px!, py!] as [number, number],
  })),
  subpathStarts: [0],
});

const plan = (
  params: Partial<PatternParams>,
  fill: string | null = "Color/Red",
): Pick<PatternPlan, "params" | "bounds" | "sources"> => ({
  params: { ...PATTERN_DEFAULTS, ...params },
  bounds: { left: 100, top: 50, right: 120, bottom: 70 },
  sources: [
    {
      id: OUTER,
      table: square(100, 50, 20),
      paint: { fill, stroke: "Color/Black", weight: 2 },
    },
  ],
});

describe("[plugin-draw.pattern-bake] WP6.9 — the field's plan as an engine pattern spec", () => {
  it("a grid field maps tile, spacing, overlap and moves the items to the tile origin", () => {
    const spec = patternSwatchSpecFor(
      plan({
        layout: "grid",
        spacing: [4, 6],
        overlap: { horizontal: "leftInFront", vertical: "topInFront" },
      }),
    )!;
    expect(spec.width).toBe(20);
    expect(spec.height).toBe(20);
    expect(spec.tileType).toBe("Grid");
    expect(spec.hSpacing).toBe(4);
    expect(spec.vSpacing).toBe(6);
    expect(spec.hOverlap).toBe("LeftInFront");
    expect(spec.vOverlap).toBe("TopInFront");
    expect(spec.items).toHaveLength(1);
    expect(spec.items[0]!.anchors[0]!.anchor).toEqual([0, 0]);
    expect(spec.items[0]!.anchors[2]!.anchor).toEqual([20, 20]);
    expect(spec.items[0]!.fill).toEqual({ swatch: "Color/Red" });
    expect(spec.items[0]!.stroke?.swatch).toBe("Color/Black");
    expect(spec.items[0]!.strokeWeight).toBe(2);
  });

  it("brick keeps the row shift; hex keeps the preview's row pitch", () => {
    const brick = patternSwatchSpecFor(
      plan({ layout: "brick", offset: 0.5, spacing: [0, 0] }),
    )!;
    expect(brick.tileType).toBe("BrickByRow");
    expect(brick.brickOffset).toBe(0.5);
    expect(brick.vSpacing).toBe(0);
    const hex = patternSwatchSpecFor(
      plan({ layout: "hex", offset: 0.5, spacing: [0, 0] }),
    )!;
    expect(hex.tileType).toBe("BrickByRow");
    // The preview's rows are (20 + 0) × √3/2 apart: the swatch's pitch.
    expect(hex.height + hex.vSpacing!).toBeCloseTo(20 * HEX_ROW_FACTOR, 6);
  });

  it("an explicit tile size wins over the artwork's bounds", () => {
    const spec = patternSwatchSpecFor(plan({ tile: [30, 25] }))!;
    expect([spec.width, spec.height]).toEqual([30, 25]);
  });

  it("a gradient or None fill is not a tile colour; with nothing to paint there is no spec", () => {
    const g = patternSwatchSpecFor(plan({}, "Gradient/Ramp"))!;
    expect(g.items[0]!.fill).toBeUndefined();
    expect(g.items[0]!.stroke?.swatch).toBe("Color/Black");
    const none = plan({}, "Swatch/None");
    none.sources[0]!.paint.weight = 0;
    expect(patternSwatchSpecFor(none)).toBeNull();
  });

  it("swatch ids are slugs, never taken", () => {
    expect(patternSwatchIdFor("Dots & Stripes", new Set())).toBe(
      "Pattern/dots-stripes",
    );
    expect(
      patternSwatchIdFor("Dots", new Set(["Pattern/dots", "Pattern/dots-2"])),
    ).toBe("Pattern/dots-3");
  });
});

describe("[plugin-draw.pattern-bake] WP6.9 — Save swatch through the real engine", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F6_RING_PAIR.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  beforeEach(async () => {
    await h.host.selection.set([]);
    await writePatternLibrary(h.host, {
      v: PATTERN_LIBRARY_VERSION,
      fields: [],
    });
  });

  const swatchIds = async () =>
    (
      (await h.host.document.collection("swatches")) as {
        selfId: string;
        kind: string;
      }[]
    )
      .filter((s) => s.kind === "pattern")
      .map((s) => s.selfId);

  it("saves the field as one swatch in one undo step, updates it in place, and a frame takes it", async () => {
    await h.host.selection.set([INNER]);
    const tiles = await applyMakePattern(h.host, {
      name: "Rings",
      columns: 2,
      rows: 1,
    });
    expect(tiles.length).toBeGreaterThan(0);
    const before = await swatchIds();
    const field = (await readPatternLibrary(h.host)).fields[0]!.id;

    const id = await applySavePatternSwatch(h.host, { patternId: field });
    expect(id).toBe("Pattern/rings");
    expect(await swatchIds()).toEqual([...before, "Pattern/rings"]);
    const saved = (await readPatternLibrary(h.host)).fields[0]!;
    expect(saved.swatch).toBe("Pattern/rings");

    // A frame takes it as its fill, by the same colorRef a colour uses.
    const out = await h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: INNER,
        path: "frameFillColor",
        value: { type: "colorRef", value: "Pattern/rings" },
      },
    });
    expect(out.applied).toBe(true);
    await h.host.document.undo();

    // A second save with other options updates the same swatch.
    const again = await applySavePatternSwatch(h.host, {
      patternId: field,
      layout: "brick",
    });
    expect(again).toBe("Pattern/rings");
    expect(await swatchIds()).toEqual([...before, "Pattern/rings"]);

    // One undo step per save: two undos remove the edit, then the swatch.
    await h.host.document.undo();
    await h.host.document.undo();
    expect(await swatchIds()).toEqual(before);
  });

  it("Done saves the swatch and removes the preview copies, keeping the sources", async () => {
    await h.host.selection.set([INNER]);
    await applyMakePattern(h.host, { name: "Done", columns: 3, rows: 1 });
    const field = (await readPatternLibrary(h.host)).fields[0]!.id;
    expect((await patternLinks(h.host, field)).tiles.length).toBeGreaterThan(0);
    const id = await applySavePatternSwatch(h.host, {
      patternId: field,
      exit: true,
    });
    expect(id).toBe("Pattern/done");
    expect(await swatchIds()).toContain("Pattern/done");
    expect((await patternLinks(h.host, field)).tiles).toHaveLength(0);
    const props = await h.host.document.elementProperties(INNER);
    expect(props).not.toBeNull();
  });

  it("the command is registered and refuses without a field", async () => {
    const cmd = h.contributions.find(
      (c) => c.kind === "command" && c.id === SAVE_PATTERN_SWATCH_COMMAND_ID,
    );
    expect(cmd).toBeDefined();
    expect(await applySavePatternSwatch(h.host, {})).toBeNull();
  });
});
