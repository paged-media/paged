// paged.image's WP5.2 filter commands — the families (Distort, Render,
// Stylize, Pixelate, Adjust), the Filter Gallery's breadth and workspace,
// the Blur Gallery, the no-dialog filters, the Develop adjustment layer and
// Curves' targeted adjustment — one test each, through the registered
// handler over the fake editor and the real image-js wasm in Node.
//
// Node has no WebGPU: a dialog opens at its defaults and its preview
// declines honestly (the status names the GPU), Cancel leaves the image
// and its journal as they were; a no-dialog filter refuses the same way.
// What the kernels compute is proved in Rust (image-conformance
// `filters_*.rs`); the dialog flow over a stand-in kernel is
// filter-dialog.spec.ts.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";
import { t } from "@paged-media/strings";

import { filterDef, filterDefaults, type FilterId } from "../src/filters";
import { BLUR_KINDS, type BlurKind } from "../src/filters-blur-gallery";
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

/** The command opens `id`'s dialog at its defaults (refusing without an
 *  image), the GPU preview declines, Cancel leaves the image as it was. */
async function opensTheDialog(suffix: string, id: FilterId) {
  const label = t(filterDef(id).label);
  const none = await bundleOnFake({ select: false });
  await none.run(`${C}.${suffix}`);
  expect(none.session.state().dialog).toBeNull();
  expect(none.session.state().status).toContain(label);
  expect(none.fake.mutations).toEqual([]);
  none.dispose();

  const k = await ingested();
  const before = imageShape(k.session);
  const pixels = await sourcePixels(k.session);
  k.opened.length = 0;
  await k.run(`${C}.${suffix}`);
  expect(k.opened).toEqual([PANEL_ID]);
  const d = k.session.state().dialog;
  if (d?.kind !== "filter") throw new Error("no filter dialog");
  expect(d.filter.id).toBe(id);
  expect(d.filter.values).toEqual(filterDefaults(filterDef(id)));
  expect(d.filter.applied).toBe(false);
  expect(k.session.state().status).toMatch(/GPU-only/);
  expect(await sourcePixels(k.session)).toEqual(pixels);
  expect(await k.session.cancelFilterDialog()).toBe(true);
  expect(k.session.state().dialog).toBeNull();
  expect(imageShape(k.session)).toEqual(before);
  expect(k.docOps()).toEqual([]);
  k.dispose();
}

/** The Blur Gallery command opens the workspace with only `kind` on. */
async function opensTheBlurGallery(suffix: string, kind: BlurKind) {
  const k = await ingested();
  const before = imageShape(k.session);
  await k.run(`${C}.${suffix}`);
  expect(k.opened).toContain(PANEL_ID);
  const d = k.session.state().dialog;
  if (d?.kind !== "filter") throw new Error("no filter dialog");
  expect(d.filter.id).toBe("blurGallery");
  for (const b of BLUR_KINDS) expect(d.filter.values[b]).toBe(b === kind);
  expect(k.session.state().status).toMatch(/GPU-only/);
  expect(await k.session.cancelFilterDialog()).toBe(true);
  expect(imageShape(k.session)).toEqual(before);
  expect(k.docOps()).toEqual([]);
  k.dispose();
}

/** A no-dialog filter: without an image it says so; with one, no GPU
 *  here, it refuses and changes nothing (no undo step). */
async function refusesWithoutGpu(suffix: string) {
  const none = await bundleOnFake({ select: false });
  await none.run(`${C}.${suffix}`);
  expect(none.session.state().status).toMatch(/Open an image/);
  none.dispose();
  const k = await ingested();
  const pixels = await sourcePixels(k.session);
  const steps = k.session.state().history?.undoSteps ?? [];
  await k.run(`${C}.${suffix}`);
  expect(k.session.state().status).toMatch(/GPU-only/);
  expect(await sourcePixels(k.session)).toEqual(pixels);
  expect(k.session.state().history?.undoSteps ?? []).toEqual(steps);
  expect(k.docOps()).toEqual([]);
  k.dispose();
}

describe("WP5.2 Filter ▸ … opens the Filter dialog [image.editor.filter-dialogs]", () => {
  it("filterGallery opens the filterGallery dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterGallery");
    await opensTheDialog("filterGallery", "filterGallery");
  });

  it("filterDisplace opens the displace dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterDisplace");
    await opensTheDialog("filterDisplace", "displace");
  });

  it("filterPolarCoordinates opens the polarCoordinates dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPolarCoordinates");
    await opensTheDialog("filterPolarCoordinates", "polarCoordinates");
  });

  it("filterRipple opens the ripple dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterRipple");
    await opensTheDialog("filterRipple", "ripple");
  });

  it("filterShear opens the shear dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterShear");
    await opensTheDialog("filterShear", "shear");
  });

  it("filterZigzag opens the zigzag dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterZigzag");
    await opensTheDialog("filterZigzag", "zigzag");
  });

  it("filterClouds opens the clouds dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterClouds");
    await opensTheDialog("filterClouds", "clouds");
  });

  it("filterDifferenceClouds opens the differenceClouds dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterDifferenceClouds");
    await opensTheDialog("filterDifferenceClouds", "differenceClouds");
  });

  it("filterFibers opens the fibers dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterFibers");
    await opensTheDialog("filterFibers", "fibers");
  });

  it("filterLensFlare opens the lensFlare dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterLensFlare");
    await opensTheDialog("filterLensFlare", "lensFlare");
  });

  it("filterLightingEffects opens the lightingEffects dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterLightingEffects");
    await opensTheDialog("filterLightingEffects", "lightingEffects");
  });

  it("filterWind opens the wind dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterWind");
    await opensTheDialog("filterWind", "wind");
  });

  it("filterExtrude opens the extrude dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterExtrude");
    await opensTheDialog("filterExtrude", "extrude");
  });

  it("filterTiles opens the tiles dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterTiles");
    await opensTheDialog("filterTiles", "tiles");
  });

  it("filterTraceContour opens the traceContour dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterTraceContour");
    await opensTheDialog("filterTraceContour", "traceContour");
  });

  it("filterCrystallize opens the crystallize dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterCrystallize");
    await opensTheDialog("filterCrystallize", "crystallize");
  });

  it("filterPointillize opens the pointillize dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPointillize");
    await opensTheDialog("filterPointillize", "pointillize");
  });

  it("filterMezzotint opens the mezzotint dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterMezzotint");
    await opensTheDialog("filterMezzotint", "mezzotint");
  });

  it("filterColorHalftone opens the colorHalftone dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterColorHalftone");
    await opensTheDialog("filterColorHalftone", "colorHalftone");
  });

  it("filterShadowsHighlights opens the shadowsHighlights dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterShadowsHighlights");
    await opensTheDialog("filterShadowsHighlights", "shadowsHighlights");
  });

  it("filterHdrToning opens the hdrToning dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterHdrToning");
    await opensTheDialog("filterHdrToning", "hdrToning");
  });

  it("filterMatchColor opens the matchColor dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterMatchColor");
    await opensTheDialog("filterMatchColor", "matchColor");
  });

  it("filterReplaceColor opens the replaceColor dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterReplaceColor");
    await opensTheDialog("filterReplaceColor", "replaceColor");
  });

  it("filterDevelop opens the develop dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterDevelop");
    await opensTheDialog("filterDevelop", "develop");
  });

  it("filterColoredPencil opens the coloredPencil dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterColoredPencil");
    await opensTheDialog("filterColoredPencil", "coloredPencil");
  });

  it("filterCutout opens the cutout dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterCutout");
    await opensTheDialog("filterCutout", "cutout");
  });

  it("filterDryBrush opens the dryBrush dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterDryBrush");
    await opensTheDialog("filterDryBrush", "dryBrush");
  });

  it("filterFresco opens the fresco dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterFresco");
    await opensTheDialog("filterFresco", "fresco");
  });

  it("filterNeonGlow opens the neonGlow dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterNeonGlow");
    await opensTheDialog("filterNeonGlow", "neonGlow");
  });

  it("filterPaletteKnife opens the paletteKnife dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPaletteKnife");
    await opensTheDialog("filterPaletteKnife", "paletteKnife");
  });

  it("filterPlasticWrap opens the plasticWrap dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPlasticWrap");
    await opensTheDialog("filterPlasticWrap", "plasticWrap");
  });

  it("filterRoughPastels opens the roughPastels dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterRoughPastels");
    await opensTheDialog("filterRoughPastels", "roughPastels");
  });

  it("filterSmudgeStick opens the smudgeStick dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterSmudgeStick");
    await opensTheDialog("filterSmudgeStick", "smudgeStick");
  });

  it("filterSponge opens the sponge dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterSponge");
    await opensTheDialog("filterSponge", "sponge");
  });

  it("filterUnderpainting opens the underpainting dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterUnderpainting");
    await opensTheDialog("filterUnderpainting", "underpainting");
  });

  it("filterWatercolor opens the watercolor dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterWatercolor");
    await opensTheDialog("filterWatercolor", "watercolor");
  });

  it("filterAccentedEdges opens the accentedEdges dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterAccentedEdges");
    await opensTheDialog("filterAccentedEdges", "accentedEdges");
  });

  it("filterAngledStrokes opens the angledStrokes dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterAngledStrokes");
    await opensTheDialog("filterAngledStrokes", "angledStrokes");
  });

  it("filterDarkStrokes opens the darkStrokes dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterDarkStrokes");
    await opensTheDialog("filterDarkStrokes", "darkStrokes");
  });

  it("filterInkOutlines opens the inkOutlines dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterInkOutlines");
    await opensTheDialog("filterInkOutlines", "inkOutlines");
  });

  it("filterSprayedStrokes opens the sprayedStrokes dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterSprayedStrokes");
    await opensTheDialog("filterSprayedStrokes", "sprayedStrokes");
  });

  it("filterSumiE opens the sumiE dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterSumiE");
    await opensTheDialog("filterSumiE", "sumiE");
  });

  it("filterDiffuseGlow opens the diffuseGlow dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterDiffuseGlow");
    await opensTheDialog("filterDiffuseGlow", "diffuseGlow");
  });

  it("filterOceanRipple opens the oceanRipple dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterOceanRipple");
    await opensTheDialog("filterOceanRipple", "oceanRipple");
  });

  it("filterChalkCharcoal opens the chalkCharcoal dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterChalkCharcoal");
    await opensTheDialog("filterChalkCharcoal", "chalkCharcoal");
  });

  it("filterCharcoal opens the charcoal dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterCharcoal");
    await opensTheDialog("filterCharcoal", "charcoal");
  });

  it("filterChrome opens the chrome dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterChrome");
    await opensTheDialog("filterChrome", "chrome");
  });

  it("filterConteCrayon opens the conteCrayon dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterConteCrayon");
    await opensTheDialog("filterConteCrayon", "conteCrayon");
  });

  it("filterGraphicPen opens the graphicPen dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterGraphicPen");
    await opensTheDialog("filterGraphicPen", "graphicPen");
  });

  it("filterNotePaper opens the notePaper dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterNotePaper");
    await opensTheDialog("filterNotePaper", "notePaper");
  });

  it("filterPlaster opens the plaster dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPlaster");
    await opensTheDialog("filterPlaster", "plaster");
  });

  it("filterReticulation opens the reticulation dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterReticulation");
    await opensTheDialog("filterReticulation", "reticulation");
  });

  it("filterStamp opens the stamp dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterStamp");
    await opensTheDialog("filterStamp", "stamp");
  });

  it("filterTornEdges opens the tornEdges dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterTornEdges");
    await opensTheDialog("filterTornEdges", "tornEdges");
  });

  it("filterWaterPaper opens the waterPaper dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterWaterPaper");
    await opensTheDialog("filterWaterPaper", "waterPaper");
  });

  it("filterCraquelure opens the craquelure dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterCraquelure");
    await opensTheDialog("filterCraquelure", "craquelure");
  });

  it("filterGrain opens the grain dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterGrain");
    await opensTheDialog("filterGrain", "grain");
  });

  it("filterMosaicTiles opens the mosaicTiles dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterMosaicTiles");
    await opensTheDialog("filterMosaicTiles", "mosaicTiles");
  });

  it("filterPatchwork opens the patchwork dialog at its defaults", async () => {
    covers("command:media.paged.image.command.filterPatchwork");
    await opensTheDialog("filterPatchwork", "patchwork");
  });
});

describe("Filter ▸ Blur Gallery ▸ … [image.editor.filter-dialogs]", () => {
  it("filterFieldBlur opens the Blur Gallery with field on", async () => {
    covers("command:media.paged.image.command.filterFieldBlur");
    await opensTheBlurGallery("filterFieldBlur", "field");
  });

  it("filterIrisBlur opens the Blur Gallery with iris on", async () => {
    covers("command:media.paged.image.command.filterIrisBlur");
    await opensTheBlurGallery("filterIrisBlur", "iris");
  });

  it("filterTiltShift opens the Blur Gallery with tilt on", async () => {
    covers("command:media.paged.image.command.filterTiltShift");
    await opensTheBlurGallery("filterTiltShift", "tilt");
  });

  it("filterPathBlur opens the Blur Gallery with path on", async () => {
    covers("command:media.paged.image.command.filterPathBlur");
    await opensTheBlurGallery("filterPathBlur", "path");
  });

  it("filterSpinBlur opens the Blur Gallery with spin on", async () => {
    covers("command:media.paged.image.command.filterSpinBlur");
    await opensTheBlurGallery("filterSpinBlur", "spin");
  });
});

describe("the no-dialog filters [image.editor.filter-dialogs]", () => {
  it("solarize refuses without WebGPU and changes nothing", async () => {
    covers("command:media.paged.image.command.solarize");
    await refusesWithoutGpu("solarize");
  });

  it("facet refuses without WebGPU and changes nothing", async () => {
    covers("command:media.paged.image.command.facet");
    await refusesWithoutGpu("facet");
  });

  it("desaturate refuses without WebGPU and changes nothing", async () => {
    covers("command:media.paged.image.command.desaturate");
    await refusesWithoutGpu("desaturate");
  });

  it("equalize refuses without WebGPU and changes nothing", async () => {
    covers("command:media.paged.image.command.equalize");
    await refusesWithoutGpu("equalize");
  });
});

describe("Layer ▸ New adjustment layer ▸ Develop…, Curves ▸ targeted adjustment [image.editor.filter-dialogs]", () => {
  it("newAdjustmentDevelop stacks a Develop layer at the identity, one undo step", async () => {
    covers("command:media.paged.image.command.newAdjustmentDevelop");
    const k = await ingested();
    const n = k.session.state().layers.layers.length;
    await k.run(`${C}.newAdjustmentDevelop`);
    const layers = k.session.state().layers.layers;
    expect(layers.length).toBe(n + 1);
    expect(layers.some((l) => l.adjustKind === "develop")).toBe(true);
    await k.session.undo();
    expect(k.session.state().layers.layers.length).toBe(n);
    k.dispose();
  });

  it("curvesTarget arms the targeted adjustment on the composite curve", async () => {
    covers("command:media.paged.image.command.curvesTarget");
    const k = await ingested();
    expect(k.session.state().curvesTarget).toBeNull();
    await k.run(`${C}.curvesTarget`);
    expect(k.session.state().curvesTarget).toEqual({
      channel: "rgb",
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    k.session.armCurvesTarget(null);
    expect(k.session.state().curvesTarget).toBeNull();
    k.dispose();
  });
});
