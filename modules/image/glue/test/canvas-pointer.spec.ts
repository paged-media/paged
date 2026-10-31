// The session's CANVAS POINTER (WP5.2): Curves' targeted adjustment and
// the Blur Gallery's pins, over the fake editor and the real image-js wasm
// (the tile readout and the curve LUT are CPU work, so Node runs them).

import { describe, expect, it } from "bun:test";

import { bundleOnFake } from "./command-kit";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}

describe("Curves ▸ targeted adjustment (I-55) [image.editor.filter-dialogs]", () => {
  it("a drag up on a pixel raises the curve at that pixel's tone, one point", async () => {
    const k = await ingested();
    const s = k.session;
    // Unarmed, the image tools keep the press.
    expect(s.canvasPointer("down", [0, 0])).toBe(false);
    s.armCurvesTarget("r", [
      [0, 0],
      [1, 1],
    ]);
    // Pixel (0, 0) is RED (200 / 255 on the red channel).
    expect(s.canvasPointer("down", [0.5, 0.5])).toBe(true);
    const placed = s.state().curvesTarget!.points;
    expect(placed).toHaveLength(3);
    const tone = 200 / 255;
    const i = placed.findIndex((p) => Math.abs(p[0] - tone) < 1e-6);
    expect(i).toBe(1);
    // The press alone leaves the curve where it was.
    expect(placed[1]![1]).toBeCloseTo(tone, 1);
    expect(s.canvasPointer("move", [0.5, -0.5])).toBe(true);
    expect(s.canvasPointer("up", [0.5, -0.5])).toBe(true);
    const moved = s.state().curvesTarget!.points;
    expect(moved[1]![0]).toBeCloseTo(tone, 5);
    expect(moved[1]![1]).toBeGreaterThan(placed[1]![1]);
    expect(s.state().params.curveLutRgb[0]).not.toBeNull();
    expect(s.state().status).toMatch(/Curve point 200 moved/);
    // A second press at the same tone moves that point, adds none.
    s.canvasPointer("down", [0.5, 0.5]);
    s.canvasPointer("up", [0.5, 0.5]);
    expect(s.state().curvesTarget!.points).toHaveLength(3);
    s.armCurvesTarget(null);
    expect(s.canvasPointer("down", [0.5, 0.5])).toBe(false);
    k.dispose();
  });

  it("a press outside the image takes nothing", async () => {
    const k = await ingested();
    k.session.armCurvesTarget("rgb");
    expect(k.session.canvasPointer("down", [-5, -5])).toBe(false);
    k.dispose();
  });
});

describe("the Blur Gallery's pins [image.editor.filter-dialogs]", () => {
  it("a press on a pin grabs it and the drag moves it (one value patch)", async () => {
    const k = await ingested();
    const s = k.session;
    expect(s.canvasPointer("down", [1, 1])).toBe(false);
    await s.openBlurGallery("field");
    const d0 = s.state().dialog;
    if (d0?.kind !== "filter") throw new Error("no dialog");
    expect(d0.filter.values.fieldPins).toEqual([0.5, 0.5, 15]);
    // On a 4×2 image the handle reach (3 px at least) covers the pin at
    // (2, 1); placing a pin on open canvas is filters-catalogue.spec.ts.
    expect(s.canvasPointer("down", [2.5, 1.5])).toBe(true);
    s.canvasPointer("move", [3, 1], {});
    s.canvasPointer("up", [3, 1]);
    const d1 = s.state().dialog;
    if (d1?.kind !== "filter") throw new Error("no dialog");
    expect(d1.filter.values.fieldPins).toEqual([0.75, 0.5, 15]);
    await s.cancelFilterDialog();
    expect(s.canvasPointer("down", [1, 1])).toBe(false);
    k.dispose();
  });

  it("an image parameter starts on the composite; a file needs a picker", async () => {
    const k = await ingested();
    const s = k.session;
    await s.openFilterDialog("displace");
    const d = s.state().dialog;
    if (d?.kind !== "filter") throw new Error("no dialog");
    expect(d.filter.values.map).toBe(0);
    expect(await s.chooseFilterImage("map", 0)).toBe(true);
    await s.cancelFilterDialog();
    k.dispose();
  });
});
