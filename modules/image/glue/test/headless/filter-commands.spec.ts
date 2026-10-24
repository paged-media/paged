// The FILTER-DIALOG and Image-dialog commands against the REAL canvas
// engine (the headless host): the integration twin of
// filter-commands.spec.ts. A filter command opens its dialog; with no
// WebGPU the preview declines and the DOCUMENT receives nothing. Trim and
// Arbitrary rotation (a quarter turn, exact, no GPU) run over the layers
// and reach the document only through Commit, which the document's own
// undo takes back.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import type { FilterId } from "../../src/filters";
import { at, BLUE, bundleOnHeadless, C, imageShape, RED } from "../command-kit";

async function ingested() {
  const k = await bundleOnHeadless();
  await k.ingest();
  return k;
}

async function opensAndDeclines(suffix: string, id: FilterId) {
  const k = await ingested();
  const before = imageShape(k.session);
  await k.run(`${C}.${suffix}`);
  const d = k.session.state().dialog;
  expect(d?.kind === "filter" && d.filter.id).toBe(id);
  expect(k.session.state().status).toMatch(/GPU-only/);
  expect(await k.session.cancelFilterDialog()).toBe(true);
  expect(imageShape(k.session)).toEqual(before);
  expect(k.changes()).toBe(0);
  k.dispose();
}

describe("Filter ▸ … over the real document", () => {
  it("filterBoxBlur", async () => {
    covers("command:media.paged.image.command.filterBoxBlur");
    await opensAndDeclines("filterBoxBlur", "boxBlur");
  });

  it("filterSurfaceBlur", async () => {
    covers("command:media.paged.image.command.filterSurfaceBlur");
    await opensAndDeclines("filterSurfaceBlur", "surfaceBlur");
  });

  it("filterMotionBlur", async () => {
    covers("command:media.paged.image.command.filterMotionBlur");
    await opensAndDeclines("filterMotionBlur", "motionBlur");
  });

  it("filterRadialBlur", async () => {
    covers("command:media.paged.image.command.filterRadialBlur");
    await opensAndDeclines("filterRadialBlur", "radialBlur");
  });

  it("filterLensBlur", async () => {
    covers("command:media.paged.image.command.filterLensBlur");
    await opensAndDeclines("filterLensBlur", "lensBlur");
  });

  it("filterAddNoise", async () => {
    covers("command:media.paged.image.command.filterAddNoise");
    await opensAndDeclines("filterAddNoise", "addNoise");
  });

  it("filterDespeckle", async () => {
    covers("command:media.paged.image.command.filterDespeckle");
    await opensAndDeclines("filterDespeckle", "despeckle");
  });

  it("filterDustScratches", async () => {
    covers("command:media.paged.image.command.filterDustScratches");
    await opensAndDeclines("filterDustScratches", "dustScratches");
  });

  it("filterMedian", async () => {
    covers("command:media.paged.image.command.filterMedian");
    await opensAndDeclines("filterMedian", "median");
  });

  it("filterReduceNoise", async () => {
    covers("command:media.paged.image.command.filterReduceNoise");
    await opensAndDeclines("filterReduceNoise", "reduceNoise");
  });

  it("filterHighPass", async () => {
    covers("command:media.paged.image.command.filterHighPass");
    await opensAndDeclines("filterHighPass", "highPass");
  });

  it("filterMaximum", async () => {
    covers("command:media.paged.image.command.filterMaximum");
    await opensAndDeclines("filterMaximum", "maximum");
  });

  it("filterMinimum", async () => {
    covers("command:media.paged.image.command.filterMinimum");
    await opensAndDeclines("filterMinimum", "minimum");
  });

  it("filterOffset", async () => {
    covers("command:media.paged.image.command.filterOffset");
    await opensAndDeclines("filterOffset", "offset");
  });

  it("filterSmartSharpen", async () => {
    covers("command:media.paged.image.command.filterSmartSharpen");
    await opensAndDeclines("filterSmartSharpen", "smartSharpen");
  });

  it("filterEmboss", async () => {
    covers("command:media.paged.image.command.filterEmboss");
    await opensAndDeclines("filterEmboss", "emboss");
  });

  it("filterFindEdges", async () => {
    covers("command:media.paged.image.command.filterFindEdges");
    await opensAndDeclines("filterFindEdges", "findEdges");
  });

  it("filterGlowingEdges", async () => {
    covers("command:media.paged.image.command.filterGlowingEdges");
    await opensAndDeclines("filterGlowingEdges", "glowingEdges");
  });

  it("filterMosaic", async () => {
    covers("command:media.paged.image.command.filterMosaic");
    await opensAndDeclines("filterMosaic", "mosaic");
  });

  it("filterHalftone", async () => {
    covers("command:media.paged.image.command.filterHalftone");
    await opensAndDeclines("filterHalftone", "halftone");
  });

  it("filterPaintDaubs", async () => {
    covers("command:media.paged.image.command.filterPaintDaubs");
    await opensAndDeclines("filterPaintDaubs", "paintDaubs");
  });

  it("filterPosterEdges", async () => {
    covers("command:media.paged.image.command.filterPosterEdges");
    await opensAndDeclines("filterPosterEdges", "posterEdges");
  });

  it("filterFilmGrain", async () => {
    covers("command:media.paged.image.command.filterFilmGrain");
    await opensAndDeclines("filterFilmGrain", "filmGrain");
  });

  it("filterSpatter", async () => {
    covers("command:media.paged.image.command.filterSpatter");
    await opensAndDeclines("filterSpatter", "spatter");
  });

  it("filterCrosshatch", async () => {
    covers("command:media.paged.image.command.filterCrosshatch");
    await opensAndDeclines("filterCrosshatch", "crosshatch");
  });

  it("filterBasRelief", async () => {
    covers("command:media.paged.image.command.filterBasRelief");
    await opensAndDeclines("filterBasRelief", "basRelief");
  });

  it("filterPhotocopy", async () => {
    covers("command:media.paged.image.command.filterPhotocopy");
    await opensAndDeclines("filterPhotocopy", "photocopy");
  });

  it("filterStainedGlass", async () => {
    covers("command:media.paged.image.command.filterStainedGlass");
    await opensAndDeclines("filterStainedGlass", "stainedGlass");
  });

  it("filterGlass", async () => {
    covers("command:media.paged.image.command.filterGlass");
    await opensAndDeclines("filterGlass", "glass");
  });

  it("filterTexturizer", async () => {
    covers("command:media.paged.image.command.filterTexturizer");
    await opensAndDeclines("filterTexturizer", "texturizer");
  });

  it("filterGradientMap", async () => {
    covers("command:media.paged.image.command.filterGradientMap");
    await opensAndDeclines("filterGradientMap", "gradientMap");
  });

  it("filterSelectiveColour", async () => {
    covers("command:media.paged.image.command.filterSelectiveColour");
    await opensAndDeclines("filterSelectiveColour", "selectiveColour");
  });

  it("average", async () => {
    covers("command:media.paged.image.command.average");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.average`);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});

describe("Image ▸ Trim / Image rotation / Image size over the real document", () => {
  it("trim: the dialog, then Trim by the top-left colour, commits and undoes", async () => {
    covers("command:media.paged.image.command.trim");
    const k = await ingested();
    await k.run(`${C}.trim`);
    expect(k.session.state().dialog).toEqual({ kind: "trim" });
    expect(k.changes()).toBe(0);
    // The 4×2 image is red | blue: trimming the top-left (red) colour
    // leaves the blue half.
    expect(await k.session.trim("top-left")).toBe(true);
    expect(k.session.state().dialog).toBeNull();
    expect(k.session.state().history?.undoSteps).toEqual(["Crop"]);
    expect(k.changes()).toBe(0);
    await k.commit();
    const shown = await k.framePixels();
    expect([shown.w, shown.h]).toEqual([2, 2]);
    expect(at(shown, 0, 0)).toEqual([...BLUE]);
    await k.h.host.document.undo();
    const back = await k.framePixels();
    expect([back.w, back.h]).toEqual([4, 2]);
    expect(at(back, 0, 0)).toEqual([...RED]);
    k.dispose();
  });

  it("rotateArbitrary: the dialog, then a quarter turn (exact), commits", async () => {
    covers("command:media.paged.image.command.rotateArbitrary");
    const k = await ingested();
    await k.run(`${C}.rotateArbitrary`);
    expect(k.session.state().dialog).toEqual({ kind: "rotate" });
    expect(await k.session.rotateCanvas(-90)).toBe(true);
    expect(k.session.state().history?.undoSteps).toEqual([
      "Rotate 90° counter-clockwise",
    ]);
    // Any other angle resamples: GPU-only here, and nothing changes.
    const before = imageShape(k.session);
    expect(await k.session.rotateCanvas(30)).toBe(false);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(imageShape(k.session)).toEqual(before);
    await k.commit();
    const shown = await k.framePixels();
    expect([shown.w, shown.h]).toEqual([2, 4]);
    k.dispose();
  });

  it("imageSize: the dialog; a resolution change is metadata and sends nothing", async () => {
    covers("command:media.paged.image.command.imageSize");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.imageSize`);
    expect(k.session.state().dialog).toEqual({ kind: "imageSize" });
    k.session.setResolution(300);
    expect(k.session.state().ppi).toBe(300);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});
