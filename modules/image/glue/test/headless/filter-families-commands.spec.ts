// The WP5.2 filter commands against the REAL canvas engine (the headless
// host): the integration twin of filter-families-commands.spec.ts. A
// dialog command opens its dialog, the GPU preview declines and the
// DOCUMENT receives nothing; a no-dialog filter refuses the same way; the
// Develop layer is one undo step in the image and reaches the document
// only through Commit.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import type { FilterId } from "../../src/filters";
import { bundleOnHeadless, C, imageShape } from "../command-kit";

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

async function refuses(suffix: string) {
  const k = await ingested();
  const before = imageShape(k.session);
  await k.run(`${C}.${suffix}`);
  expect(k.session.state().status).toMatch(/GPU-only/);
  expect(imageShape(k.session)).toEqual(before);
  expect(k.changes()).toBe(0);
  k.dispose();
}

describe("WP5.2 Filter ▸ … over the real document [image.editor.filter-dialogs]", () => {
  it("filterGallery", async () => {
    covers("command:media.paged.image.command.filterGallery");
    await opensAndDeclines("filterGallery", "filterGallery");
  });

  it("filterDisplace", async () => {
    covers("command:media.paged.image.command.filterDisplace");
    await opensAndDeclines("filterDisplace", "displace");
  });

  it("filterPolarCoordinates", async () => {
    covers("command:media.paged.image.command.filterPolarCoordinates");
    await opensAndDeclines("filterPolarCoordinates", "polarCoordinates");
  });

  it("filterRipple", async () => {
    covers("command:media.paged.image.command.filterRipple");
    await opensAndDeclines("filterRipple", "ripple");
  });

  it("filterShear", async () => {
    covers("command:media.paged.image.command.filterShear");
    await opensAndDeclines("filterShear", "shear");
  });

  it("filterZigzag", async () => {
    covers("command:media.paged.image.command.filterZigzag");
    await opensAndDeclines("filterZigzag", "zigzag");
  });

  it("filterClouds", async () => {
    covers("command:media.paged.image.command.filterClouds");
    await opensAndDeclines("filterClouds", "clouds");
  });

  it("filterDifferenceClouds", async () => {
    covers("command:media.paged.image.command.filterDifferenceClouds");
    await opensAndDeclines("filterDifferenceClouds", "differenceClouds");
  });

  it("filterFibers", async () => {
    covers("command:media.paged.image.command.filterFibers");
    await opensAndDeclines("filterFibers", "fibers");
  });

  it("filterLensFlare", async () => {
    covers("command:media.paged.image.command.filterLensFlare");
    await opensAndDeclines("filterLensFlare", "lensFlare");
  });

  it("filterLightingEffects", async () => {
    covers("command:media.paged.image.command.filterLightingEffects");
    await opensAndDeclines("filterLightingEffects", "lightingEffects");
  });

  it("filterWind", async () => {
    covers("command:media.paged.image.command.filterWind");
    await opensAndDeclines("filterWind", "wind");
  });

  it("filterExtrude", async () => {
    covers("command:media.paged.image.command.filterExtrude");
    await opensAndDeclines("filterExtrude", "extrude");
  });

  it("filterTiles", async () => {
    covers("command:media.paged.image.command.filterTiles");
    await opensAndDeclines("filterTiles", "tiles");
  });

  it("filterTraceContour", async () => {
    covers("command:media.paged.image.command.filterTraceContour");
    await opensAndDeclines("filterTraceContour", "traceContour");
  });

  it("filterCrystallize", async () => {
    covers("command:media.paged.image.command.filterCrystallize");
    await opensAndDeclines("filterCrystallize", "crystallize");
  });

  it("filterPointillize", async () => {
    covers("command:media.paged.image.command.filterPointillize");
    await opensAndDeclines("filterPointillize", "pointillize");
  });

  it("filterMezzotint", async () => {
    covers("command:media.paged.image.command.filterMezzotint");
    await opensAndDeclines("filterMezzotint", "mezzotint");
  });

  it("filterColorHalftone", async () => {
    covers("command:media.paged.image.command.filterColorHalftone");
    await opensAndDeclines("filterColorHalftone", "colorHalftone");
  });

  it("filterShadowsHighlights", async () => {
    covers("command:media.paged.image.command.filterShadowsHighlights");
    await opensAndDeclines("filterShadowsHighlights", "shadowsHighlights");
  });

  it("filterHdrToning", async () => {
    covers("command:media.paged.image.command.filterHdrToning");
    await opensAndDeclines("filterHdrToning", "hdrToning");
  });

  it("filterMatchColor", async () => {
    covers("command:media.paged.image.command.filterMatchColor");
    await opensAndDeclines("filterMatchColor", "matchColor");
  });

  it("filterReplaceColor", async () => {
    covers("command:media.paged.image.command.filterReplaceColor");
    await opensAndDeclines("filterReplaceColor", "replaceColor");
  });

  it("filterDevelop", async () => {
    covers("command:media.paged.image.command.filterDevelop");
    await opensAndDeclines("filterDevelop", "develop");
  });

  it("filterColoredPencil", async () => {
    covers("command:media.paged.image.command.filterColoredPencil");
    await opensAndDeclines("filterColoredPencil", "coloredPencil");
  });

  it("filterCutout", async () => {
    covers("command:media.paged.image.command.filterCutout");
    await opensAndDeclines("filterCutout", "cutout");
  });

  it("filterDryBrush", async () => {
    covers("command:media.paged.image.command.filterDryBrush");
    await opensAndDeclines("filterDryBrush", "dryBrush");
  });

  it("filterFresco", async () => {
    covers("command:media.paged.image.command.filterFresco");
    await opensAndDeclines("filterFresco", "fresco");
  });

  it("filterNeonGlow", async () => {
    covers("command:media.paged.image.command.filterNeonGlow");
    await opensAndDeclines("filterNeonGlow", "neonGlow");
  });

  it("filterPaletteKnife", async () => {
    covers("command:media.paged.image.command.filterPaletteKnife");
    await opensAndDeclines("filterPaletteKnife", "paletteKnife");
  });

  it("filterPlasticWrap", async () => {
    covers("command:media.paged.image.command.filterPlasticWrap");
    await opensAndDeclines("filterPlasticWrap", "plasticWrap");
  });

  it("filterRoughPastels", async () => {
    covers("command:media.paged.image.command.filterRoughPastels");
    await opensAndDeclines("filterRoughPastels", "roughPastels");
  });

  it("filterSmudgeStick", async () => {
    covers("command:media.paged.image.command.filterSmudgeStick");
    await opensAndDeclines("filterSmudgeStick", "smudgeStick");
  });

  it("filterSponge", async () => {
    covers("command:media.paged.image.command.filterSponge");
    await opensAndDeclines("filterSponge", "sponge");
  });

  it("filterUnderpainting", async () => {
    covers("command:media.paged.image.command.filterUnderpainting");
    await opensAndDeclines("filterUnderpainting", "underpainting");
  });

  it("filterWatercolor", async () => {
    covers("command:media.paged.image.command.filterWatercolor");
    await opensAndDeclines("filterWatercolor", "watercolor");
  });

  it("filterAccentedEdges", async () => {
    covers("command:media.paged.image.command.filterAccentedEdges");
    await opensAndDeclines("filterAccentedEdges", "accentedEdges");
  });

  it("filterAngledStrokes", async () => {
    covers("command:media.paged.image.command.filterAngledStrokes");
    await opensAndDeclines("filterAngledStrokes", "angledStrokes");
  });

  it("filterDarkStrokes", async () => {
    covers("command:media.paged.image.command.filterDarkStrokes");
    await opensAndDeclines("filterDarkStrokes", "darkStrokes");
  });

  it("filterInkOutlines", async () => {
    covers("command:media.paged.image.command.filterInkOutlines");
    await opensAndDeclines("filterInkOutlines", "inkOutlines");
  });

  it("filterSprayedStrokes", async () => {
    covers("command:media.paged.image.command.filterSprayedStrokes");
    await opensAndDeclines("filterSprayedStrokes", "sprayedStrokes");
  });

  it("filterSumiE", async () => {
    covers("command:media.paged.image.command.filterSumiE");
    await opensAndDeclines("filterSumiE", "sumiE");
  });

  it("filterDiffuseGlow", async () => {
    covers("command:media.paged.image.command.filterDiffuseGlow");
    await opensAndDeclines("filterDiffuseGlow", "diffuseGlow");
  });

  it("filterOceanRipple", async () => {
    covers("command:media.paged.image.command.filterOceanRipple");
    await opensAndDeclines("filterOceanRipple", "oceanRipple");
  });

  it("filterChalkCharcoal", async () => {
    covers("command:media.paged.image.command.filterChalkCharcoal");
    await opensAndDeclines("filterChalkCharcoal", "chalkCharcoal");
  });

  it("filterCharcoal", async () => {
    covers("command:media.paged.image.command.filterCharcoal");
    await opensAndDeclines("filterCharcoal", "charcoal");
  });

  it("filterChrome", async () => {
    covers("command:media.paged.image.command.filterChrome");
    await opensAndDeclines("filterChrome", "chrome");
  });

  it("filterConteCrayon", async () => {
    covers("command:media.paged.image.command.filterConteCrayon");
    await opensAndDeclines("filterConteCrayon", "conteCrayon");
  });

  it("filterGraphicPen", async () => {
    covers("command:media.paged.image.command.filterGraphicPen");
    await opensAndDeclines("filterGraphicPen", "graphicPen");
  });

  it("filterNotePaper", async () => {
    covers("command:media.paged.image.command.filterNotePaper");
    await opensAndDeclines("filterNotePaper", "notePaper");
  });

  it("filterPlaster", async () => {
    covers("command:media.paged.image.command.filterPlaster");
    await opensAndDeclines("filterPlaster", "plaster");
  });

  it("filterReticulation", async () => {
    covers("command:media.paged.image.command.filterReticulation");
    await opensAndDeclines("filterReticulation", "reticulation");
  });

  it("filterStamp", async () => {
    covers("command:media.paged.image.command.filterStamp");
    await opensAndDeclines("filterStamp", "stamp");
  });

  it("filterTornEdges", async () => {
    covers("command:media.paged.image.command.filterTornEdges");
    await opensAndDeclines("filterTornEdges", "tornEdges");
  });

  it("filterWaterPaper", async () => {
    covers("command:media.paged.image.command.filterWaterPaper");
    await opensAndDeclines("filterWaterPaper", "waterPaper");
  });

  it("filterCraquelure", async () => {
    covers("command:media.paged.image.command.filterCraquelure");
    await opensAndDeclines("filterCraquelure", "craquelure");
  });

  it("filterGrain", async () => {
    covers("command:media.paged.image.command.filterGrain");
    await opensAndDeclines("filterGrain", "grain");
  });

  it("filterMosaicTiles", async () => {
    covers("command:media.paged.image.command.filterMosaicTiles");
    await opensAndDeclines("filterMosaicTiles", "mosaicTiles");
  });

  it("filterPatchwork", async () => {
    covers("command:media.paged.image.command.filterPatchwork");
    await opensAndDeclines("filterPatchwork", "patchwork");
  });

  it("filterFieldBlur", async () => {
    covers("command:media.paged.image.command.filterFieldBlur");
    await opensAndDeclines("filterFieldBlur", "blurGallery");
  });

  it("filterIrisBlur", async () => {
    covers("command:media.paged.image.command.filterIrisBlur");
    await opensAndDeclines("filterIrisBlur", "blurGallery");
  });

  it("filterTiltShift", async () => {
    covers("command:media.paged.image.command.filterTiltShift");
    await opensAndDeclines("filterTiltShift", "blurGallery");
  });

  it("filterPathBlur", async () => {
    covers("command:media.paged.image.command.filterPathBlur");
    await opensAndDeclines("filterPathBlur", "blurGallery");
  });

  it("filterSpinBlur", async () => {
    covers("command:media.paged.image.command.filterSpinBlur");
    await opensAndDeclines("filterSpinBlur", "blurGallery");
  });

  it("solarize", async () => {
    covers("command:media.paged.image.command.solarize");
    await refuses("solarize");
  });

  it("facet", async () => {
    covers("command:media.paged.image.command.facet");
    await refuses("facet");
  });

  it("desaturate", async () => {
    covers("command:media.paged.image.command.desaturate");
    await refuses("desaturate");
  });

  it("equalize", async () => {
    covers("command:media.paged.image.command.equalize");
    await refuses("equalize");
  });

  it("newAdjustmentDevelop: one image step, nothing in the document until Commit", async () => {
    covers("command:media.paged.image.command.newAdjustmentDevelop");
    const k = await ingested();
    const n = k.session.state().layers.layers.length;
    await k.run(`${C}.newAdjustmentDevelop`);
    expect(k.session.state().layers.layers.length).toBe(n + 1);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("curvesTarget: arms on the composite curve, sends nothing", async () => {
    covers("command:media.paged.image.command.curvesTarget");
    const k = await ingested();
    await k.run(`${C}.curvesTarget`);
    expect(k.session.state().curvesTarget?.channel).toBe("rgb");
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});
