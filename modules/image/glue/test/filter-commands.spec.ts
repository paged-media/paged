// paged.image's FILTER-DIALOG and Image-dialog commands (WP5.1, WP5.2),
// one test each, through the registered handler over the fake editor and
// the real image-js wasm in Node — the unit twin of
// headless/filter-commands.spec.ts.
//
// A filter command opens the generic Filter dialog on the Image panel with
// the filter's parameters at their defaults. Without an image it refuses
// and opens nothing. Node has no WebGPU, so the dialog's preview declines
// honestly (the status names the GPU) and the image and its journal stay
// as they were; Cancel closes the dialog and leaves them so. What the
// filters do to pixels is proved in Rust (image-conformance
// `filters_radius.rs` and the family suites); the dialog's preview, OK
// and Cancel flow over a stand-in kernel is filter-dialog.spec.ts.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { filterDef, filterDefaults, type FilterId } from "../src/filters";
import {
  bundleOnFake,
  C,
  imageShape,
  PANEL_ID,
  sourcePixels,
} from "./command-kit";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}

/** The filter command for `id`: refuses without an image; with one it
 *  opens the dialog at the defaults, declines the GPU preview, and
 *  Cancel leaves the image as it was. */
async function opensTheDialog(id: FilterId, label: RegExp) {
  const suffix = `filter${id[0]!.toUpperCase()}${id.slice(1)}`;
  // Disabled: nothing open — it says so and opens no dialog.
  const none = await bundleOnFake({ select: false });
  await none.run(`${C}.${suffix}`);
  expect(none.session.state().dialog).toBeNull();
  expect(none.session.state().status).toMatch(/Open an image to use/);
  expect(none.session.state().status).toMatch(label);
  expect(none.fake.mutations).toEqual([]);
  none.dispose();

  const k = await ingested();
  const before = imageShape(k.session);
  const pixels = await sourcePixels(k.session);
  k.opened.length = 0;
  await k.run(`${C}.${suffix}`);
  expect(k.opened).toEqual([PANEL_ID]);
  const d = k.session.state().dialog;
  expect(d?.kind).toBe("filter");
  if (d?.kind !== "filter") throw new Error("no filter dialog");
  expect(d.filter.id).toBe(id);
  expect(d.filter.values).toEqual(filterDefaults(filterDef(id)));
  expect(d.filter.applied).toBe(false);
  expect(k.session.state().status).toMatch(/GPU-only/);
  expect(imageShape(k.session)).toEqual(before);
  expect(await sourcePixels(k.session)).toEqual(pixels);
  expect(await k.session.commitFilterDialog()).toBe(false);
  expect(await k.session.cancelFilterDialog()).toBe(true);
  expect(k.session.state().dialog).toBeNull();
  expect(imageShape(k.session)).toEqual(before);
  expect(k.docOps()).toEqual([]);
  k.dispose();
}

describe("Filter ▸ … opens the Filter dialog", () => {
  it("filterBoxBlur opens the Box blur dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterBoxBlur");
    await opensTheDialog("boxBlur", /Box\sblur/);
  });

  it("filterSurfaceBlur opens the Surface blur dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterSurfaceBlur");
    await opensTheDialog("surfaceBlur", /Surface\sblur/);
  });

  it("filterMotionBlur opens the Motion blur dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterMotionBlur");
    await opensTheDialog("motionBlur", /Motion\sblur/);
  });

  it("filterRadialBlur opens the Radial blur dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterRadialBlur");
    await opensTheDialog("radialBlur", /Radial\sblur/);
  });

  it("filterLensBlur opens the Lens blur dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterLensBlur");
    await opensTheDialog("lensBlur", /Lens\sblur/);
  });

  it("filterAddNoise opens the Add noise dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterAddNoise");
    await opensTheDialog("addNoise", /Add\snoise/);
  });

  it("filterDespeckle opens the Despeckle dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterDespeckle");
    await opensTheDialog("despeckle", /Despeckle/);
  });

  it("filterDustScratches opens the Dust & scratches dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterDustScratches");
    await opensTheDialog("dustScratches", /Dust\s&\sscratches/);
  });

  it("filterMedian opens the Median dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterMedian");
    await opensTheDialog("median", /Median/);
  });

  it("filterReduceNoise opens the Reduce noise dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterReduceNoise");
    await opensTheDialog("reduceNoise", /Reduce\snoise/);
  });

  it("filterHighPass opens the High pass dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterHighPass");
    await opensTheDialog("highPass", /High\spass/);
  });

  it("filterMaximum opens the Maximum dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterMaximum");
    await opensTheDialog("maximum", /Maximum/);
  });

  it("filterMinimum opens the Minimum dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterMinimum");
    await opensTheDialog("minimum", /Minimum/);
  });

  it("filterOffset opens the Offset dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterOffset");
    await opensTheDialog("offset", /Offset/);
  });

  it("filterSmartSharpen opens the Smart sharpen dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterSmartSharpen");
    await opensTheDialog("smartSharpen", /Smart\ssharpen/);
  });

  it("filterEmboss opens the Emboss dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterEmboss");
    await opensTheDialog("emboss", /Emboss/);
  });

  it("filterFindEdges opens the Find edges dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterFindEdges");
    await opensTheDialog("findEdges", /Find\sedges/);
  });

  it("filterGlowingEdges opens the Glowing edges dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterGlowingEdges");
    await opensTheDialog("glowingEdges", /Glowing\sedges/);
  });

  it("filterMosaic opens the Mosaic dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterMosaic");
    await opensTheDialog("mosaic", /Mosaic/);
  });

  it("filterHalftone opens the Halftone pattern dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterHalftone");
    await opensTheDialog("halftone", /Halftone\spattern/);
  });

  it("filterPaintDaubs opens the Paint daubs dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPaintDaubs");
    await opensTheDialog("paintDaubs", /Paint\sdaubs/);
  });

  it("filterPosterEdges opens the Poster edges dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPosterEdges");
    await opensTheDialog("posterEdges", /Poster\sedges/);
  });

  it("filterFilmGrain opens the Film grain dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterFilmGrain");
    await opensTheDialog("filmGrain", /Film\sgrain/);
  });

  it("filterSpatter opens the Spatter dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterSpatter");
    await opensTheDialog("spatter", /Spatter/);
  });

  it("filterCrosshatch opens the Crosshatch dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterCrosshatch");
    await opensTheDialog("crosshatch", /Crosshatch/);
  });

  it("filterBasRelief opens the Bas relief dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterBasRelief");
    await opensTheDialog("basRelief", /Bas\srelief/);
  });

  it("filterPhotocopy opens the Photocopy dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPhotocopy");
    await opensTheDialog("photocopy", /Photocopy/);
  });

  it("filterStainedGlass opens the Stained glass dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterStainedGlass");
    await opensTheDialog("stainedGlass", /Stained\sglass/);
  });

  it("filterGlass opens the Glass dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterGlass");
    await opensTheDialog("glass", /Glass/);
  });

  it("filterTexturizer opens the Texturizer dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterTexturizer");
    await opensTheDialog("texturizer", /Texturizer/);
  });

  it("filterGradientMap opens the Gradient map dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterGradientMap");
    await opensTheDialog("gradientMap", /Gradient\smap/);
  });

  it("filterSelectiveColour opens the Selective colour dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterSelectiveColour");
    await opensTheDialog("selectiveColour", /Selective\scolour/);
  });
});

describe("Filter ▸ Blur ▸ Average", () => {
  it("average refuses without an image and is GPU-only", async () => {
    covers("command:media.paged.image.command.average");
    const none = await bundleOnFake({ select: false });
    await none.run(`${C}.average`);
    expect(none.session.state().status).toMatch(/Nothing ingested/);
    none.dispose();
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.average`);
    expect(k.session.state().status).toMatch(/Average is a GPU-only kernel/);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

/** An Image dialog command: refuses without an image, opens its dialog
 *  with one, changes nothing, and closes. */
async function opensImageDialog(
  suffix: string,
  kind: "imageSize" | "trim" | "rotate",
) {
  const none = await bundleOnFake({ select: false });
  await none.run(`${C}.${suffix}`);
  expect(none.session.state().dialog).toBeNull();
  expect(none.session.state().status).toMatch(/Nothing ingested/);
  none.dispose();
  const k = await ingested();
  const before = imageShape(k.session);
  k.opened.length = 0;
  await k.run(`${C}.${suffix}`);
  expect(k.opened).toEqual([PANEL_ID]);
  expect(k.session.state().dialog).toEqual({ kind });
  expect(imageShape(k.session)).toEqual(before);
  await k.session.closeDialog();
  expect(k.session.state().dialog).toBeNull();
  expect(k.docOps()).toEqual([]);
  k.dispose();
}

describe("Image ▸ Image size / Trim / Image rotation ▸ Arbitrary", () => {
  it("imageSize opens the Image Size dialog", async () => {
    covers("command:media.paged.image.command.imageSize");
    await opensImageDialog("imageSize", "imageSize");
  });
  it("trim opens the Trim dialog", async () => {
    covers("command:media.paged.image.command.trim");
    await opensImageDialog("trim", "trim");
  });
  it("rotateArbitrary opens the Arbitrary rotation dialog", async () => {
    covers("command:media.paged.image.command.rotateArbitrary");
    await opensImageDialog("rotateArbitrary", "rotate");
  });
});
