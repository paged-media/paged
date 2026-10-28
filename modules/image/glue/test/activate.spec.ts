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

// Registration wiring against the real in-process host adapter over the
// fake editor: the M0 honesty smoke test ("dispose leaves the shell
// exactly as found") extended with the M4 contributions — the second
// command and the K-2 raster importer. The ingest loop itself is
// session.spec.ts (real engine wasm).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "bun:test";

import { loadBundle } from "@paged-media/plugin-sdk";

import { imageBundle, PANEL_ID } from "../src";
import {
  makeFakeEditor,
  mapBacking,
  shellStub,
  silentConsole,
} from "./helpers";

function load(
  fake: ReturnType<typeof makeFakeEditor>,
  shell: ReturnType<typeof shellStub> = shellStub(),
) {
  return loadBundle(() => fake.editor, imageBundle, {
    console: silentConsole,
    storage: mapBacking(),
    shell,
  });
}

describe("imageBundle.activate", () => {
  it("registers the panel, the commands, the tools, and the raster importer", () => {
    const fake = makeFakeEditor();
    load(fake);
    expect(fake.panels.ids()).toEqual([
      PANEL_ID,
      // WP5.8 — the Clone Source panel.
      "media.paged.image.panel.cloneSource",
      "media.paged.image.panel.brushSettings",
      "media.paged.image.panel.brushPresets",
      "media.paged.image.panel.properties",
    ]);
    expect(fake.commands.ids()).toEqual([
      "media.paged.image.command.openImage",
      "media.paged.image.command.adjustSelected",
      "media.paged.image.command.autoEnhance",
      "media.paged.image.command.claimTiles",
      "media.paged.image.command.commitCrop",
      "media.paged.image.command.fillSelection",
      "media.paged.image.command.fillNoise",
      // The LAYER GRAPH's command-palette reach (the panel carries the
      // full palette).
      "media.paged.image.command.addLayer",
      // Add Layer Mask, reveal-all and hide-all.
      "media.paged.image.command.addLayerMask",
      "media.paged.image.command.addLayerMaskHideAll",
      "media.paged.image.command.bakeAdjustToLayer",
      "media.paged.image.command.undo",
      "media.paged.image.command.redo",
      // Filters and canvas verbs (Median/Maximum/Minimum, fill with the
      // foreground, rotate/flip).
      "media.paged.image.command.median",
      "media.paged.image.command.maximum",
      "media.paged.image.command.minimum",
      "media.paged.image.command.fillForeground",
      "media.paged.image.command.rotateCw",
      "media.paged.image.command.rotateCcw",
      "media.paged.image.command.rotate180",
      "media.paged.image.command.flipHorizontal",
      "media.paged.image.command.flipVertical",
      "media.paged.image.command.filterBoxBlur",
      "media.paged.image.command.filterSurfaceBlur",
      "media.paged.image.command.filterMotionBlur",
      "media.paged.image.command.filterRadialBlur",
      "media.paged.image.command.filterLensBlur",
      "media.paged.image.command.filterAddNoise",
      "media.paged.image.command.filterDespeckle",
      "media.paged.image.command.filterDustScratches",
      "media.paged.image.command.filterMedian",
      "media.paged.image.command.filterReduceNoise",
      "media.paged.image.command.filterHighPass",
      "media.paged.image.command.filterMaximum",
      "media.paged.image.command.filterMinimum",
      "media.paged.image.command.filterOffset",
      "media.paged.image.command.filterSmartSharpen",
      "media.paged.image.command.filterEmboss",
      "media.paged.image.command.filterFindEdges",
      "media.paged.image.command.filterGlowingEdges",
      "media.paged.image.command.filterMosaic",
      "media.paged.image.command.filterHalftone",
      "media.paged.image.command.filterPaintDaubs",
      "media.paged.image.command.filterPosterEdges",
      "media.paged.image.command.filterFilmGrain",
      "media.paged.image.command.filterSpatter",
      "media.paged.image.command.filterCrosshatch",
      "media.paged.image.command.filterBasRelief",
      "media.paged.image.command.filterPhotocopy",
      "media.paged.image.command.filterStainedGlass",
      "media.paged.image.command.filterGlass",
      "media.paged.image.command.filterTexturizer",
      "media.paged.image.command.filterGradientMap",
      "media.paged.image.command.filterSelectiveColour",
      "media.paged.image.command.filterGallery",
      "media.paged.image.command.filterDisplace",
      "media.paged.image.command.filterPolarCoordinates",
      "media.paged.image.command.filterRipple",
      "media.paged.image.command.filterShear",
      "media.paged.image.command.filterZigzag",
      "media.paged.image.command.filterClouds",
      "media.paged.image.command.filterDifferenceClouds",
      "media.paged.image.command.filterFibers",
      "media.paged.image.command.filterLensFlare",
      "media.paged.image.command.filterLightingEffects",
      "media.paged.image.command.filterWind",
      "media.paged.image.command.filterExtrude",
      "media.paged.image.command.filterTiles",
      "media.paged.image.command.filterTraceContour",
      "media.paged.image.command.filterCrystallize",
      "media.paged.image.command.filterPointillize",
      "media.paged.image.command.filterMezzotint",
      "media.paged.image.command.filterColorHalftone",
      "media.paged.image.command.filterShadowsHighlights",
      "media.paged.image.command.filterHdrToning",
      "media.paged.image.command.filterMatchColor",
      "media.paged.image.command.filterReplaceColor",
      "media.paged.image.command.filterDevelop",
      "media.paged.image.command.filterColoredPencil",
      "media.paged.image.command.filterCutout",
      "media.paged.image.command.filterDryBrush",
      "media.paged.image.command.filterFresco",
      "media.paged.image.command.filterNeonGlow",
      "media.paged.image.command.filterPaletteKnife",
      "media.paged.image.command.filterPlasticWrap",
      "media.paged.image.command.filterRoughPastels",
      "media.paged.image.command.filterSmudgeStick",
      "media.paged.image.command.filterSponge",
      "media.paged.image.command.filterUnderpainting",
      "media.paged.image.command.filterWatercolor",
      "media.paged.image.command.filterAccentedEdges",
      "media.paged.image.command.filterAngledStrokes",
      "media.paged.image.command.filterDarkStrokes",
      "media.paged.image.command.filterInkOutlines",
      "media.paged.image.command.filterSprayedStrokes",
      "media.paged.image.command.filterSumiE",
      "media.paged.image.command.filterDiffuseGlow",
      "media.paged.image.command.filterOceanRipple",
      "media.paged.image.command.filterChalkCharcoal",
      "media.paged.image.command.filterCharcoal",
      "media.paged.image.command.filterChrome",
      "media.paged.image.command.filterConteCrayon",
      "media.paged.image.command.filterGraphicPen",
      "media.paged.image.command.filterNotePaper",
      "media.paged.image.command.filterPlaster",
      "media.paged.image.command.filterReticulation",
      "media.paged.image.command.filterStamp",
      "media.paged.image.command.filterTornEdges",
      "media.paged.image.command.filterWaterPaper",
      "media.paged.image.command.filterCraquelure",
      "media.paged.image.command.filterGrain",
      "media.paged.image.command.filterMosaicTiles",
      "media.paged.image.command.filterPatchwork",
      "media.paged.image.command.filterFieldBlur",
      "media.paged.image.command.filterIrisBlur",
      "media.paged.image.command.filterTiltShift",
      "media.paged.image.command.filterPathBlur",
      "media.paged.image.command.filterSpinBlur",
      "media.paged.image.command.solarize",
      "media.paged.image.command.facet",
      "media.paged.image.command.desaturate",
      "media.paged.image.command.equalize",
      "media.paged.image.command.curvesTarget",
      "media.paged.image.command.average",
      "media.paged.image.command.imageSize",
      "media.paged.image.command.trim",
      "media.paged.image.command.rotateArbitrary",
      // Photoshop's Layer menu (WP5.3).
      "media.paged.image.command.newFillSolid",
      "media.paged.image.command.newFillGradient",
      "media.paged.image.command.newFillPattern",
      "media.paged.image.command.blendingOptions",
      "media.paged.image.command.rasterizeLayer",
      "media.paged.image.command.layerViaCopy",
      "media.paged.image.command.layerViaCut",
      "media.paged.image.command.mergeDown",
      "media.paged.image.command.mergeVisible",
      "media.paged.image.command.mergeGroup",
      "media.paged.image.command.stampVisible",
      "media.paged.image.command.flattenImage",
      "media.paged.image.command.alignLeft",
      "media.paged.image.command.alignHCenter",
      "media.paged.image.command.alignRight",
      "media.paged.image.command.alignTop",
      "media.paged.image.command.alignVCenter",
      "media.paged.image.command.alignBottom",
      "media.paged.image.command.distributeHorizontal",
      "media.paged.image.command.distributeVertical",
      "media.paged.image.command.linkLayers",
      "media.paged.image.command.unlinkLayer",
      "media.paged.image.command.newLayerComp",
      "media.paged.image.command.layerStyleBevel",
      "media.paged.image.command.layerStyleStroke",
      "media.paged.image.command.layerStyleInnerShadow",
      "media.paged.image.command.layerStyleInnerGlow",
      "media.paged.image.command.layerStyleSatin",
      "media.paged.image.command.layerStyleColorOverlay",
      "media.paged.image.command.layerStyleGradientOverlay",
      "media.paged.image.command.layerStylePatternOverlay",
      "media.paged.image.command.layerStyleOuterGlow",
      "media.paged.image.command.layerStyleDropShadow",
      "media.paged.image.command.copyLayerStyle",
      "media.paged.image.command.pasteLayerStyle",
      "media.paged.image.command.clearLayerStyle",
      "media.paged.image.command.globalLight",
      "media.paged.image.command.toggleEffects",
      "media.paged.image.command.scaleEffects",
      "media.paged.image.command.newAdjustmentBrightnessContrast",
      "media.paged.image.command.newAdjustmentLevels",
      "media.paged.image.command.newAdjustmentCurves",
      "media.paged.image.command.newAdjustmentExposure",
      "media.paged.image.command.newAdjustmentVibrance",
      "media.paged.image.command.newAdjustmentHueSaturation",
      "media.paged.image.command.newAdjustmentColorBalance",
      "media.paged.image.command.newAdjustmentBlackWhite",
      "media.paged.image.command.newAdjustmentPhotoFilter",
      "media.paged.image.command.newAdjustmentChannelMixer",
      "media.paged.image.command.newAdjustmentColorLookup",
      "media.paged.image.command.newAdjustmentInvert",
      "media.paged.image.command.newAdjustmentPosterize",
      "media.paged.image.command.newAdjustmentThreshold",
      "media.paged.image.command.newAdjustmentGradientMap",
      "media.paged.image.command.newAdjustmentSelectiveColor",
      "media.paged.image.command.newAdjustmentDevelop",
      // Commit the image's layers into the document.
      "media.paged.image.command.commitImage",
      // Built long before anything reached them: smart objects, pattern
      // fill (with Define pattern), shape blur.
      "media.paged.image.command.convertLayerToSmart",
      "media.paged.image.command.definePattern",
      "media.paged.image.command.fillPattern",
      "media.paged.image.command.shapeBlur",
      "media.paged.image.command.applyToFile",
      "media.paged.image.command.exportAs",
      "media.paged.image.command.saveToFile",
      "media.paged.image.command.loadBrushLibrary",
      // The brush engine's panels and preset verbs (WP5.7).
      "media.paged.image.command.openBrushSettings",
      "media.paged.image.command.openBrushPresets",
      "media.paged.image.command.defineBrushPreset",
      "media.paged.image.command.importBrushPresets",
      "media.paged.image.command.exportBrushPresetsAbr",
      "media.paged.image.command.exportBrushPresetsJson",
      "media.paged.image.command.toggleLockTransparent",
      // The raster↔vector bridge + the luminosity mask.
      "media.paged.image.command.selectionToPath",
      "media.paged.image.command.pathToSelection",
      "media.paged.image.command.channelToSelection",
      "media.paged.image.command.setType",
      "media.paged.image.command.contentAwareFill",
      // WP5.8 — Edit ▸ Content-Aware Fill… and the Clone Source panel.
      "media.paged.image.command.contentAwareFillWorkspace",
      "media.paged.image.command.openCloneSource",
      "media.paged.image.command.selectAll",
      "media.paged.image.command.deselect",
      "media.paged.image.command.invertSelection",
      "media.paged.image.command.featherSelection",
      // Selection and masking (WP5.5, ADR 470).
      "media.paged.image.command.colorRange",
      "media.paged.image.command.selectAndMask",
      "media.paged.image.command.quickMask",
      "media.paged.image.command.grow",
      "media.paged.image.command.similar",
      "media.paged.image.command.focusArea",
      "media.paged.image.command.saveSelection",
      "media.paged.image.command.loadSelection",
      "media.paged.image.command.makeWorkPath",
    ]);
    expect(fake.tools.ids()).toEqual([
      "media.paged.image.tool.crop",
      // Raster Move shares the crop slot (no shortcut: "v" is the host's).
      "media.paged.image.tool.move",
      // The paint bucket (registered with the move tool; it shares the
      // brush's rail slot).
      "media.paged.image.tool.bucket",
      "media.paged.image.tool.gradient",
      "media.paged.image.tool.redEye",
      "media.paged.image.tool.eyedropper",
      "media.paged.image.tool.colorSampler",
      "media.paged.image.tool.marqueeRect",
      "media.paged.image.tool.marqueeEllipse",
      "media.paged.image.tool.lasso",
      // The POLYGONAL lasso shares the lasso SLOT (same group): a
      // designer picks one or the other for a given edge, and neither
      // wants both on the rail at once. Click-driven where the freehand
      // one is drag-driven.
      "media.paged.image.tool.polygonal-lasso",
      "media.paged.image.tool.magicWand",
      "media.paged.image.tool.quickSelect",
      "media.paged.image.tool.brush",
      "media.paged.image.tool.pencil",
      "media.paged.image.tool.eraser",
      // The retouching pair — the brush with a sampled paint layer.
      "media.paged.image.tool.clone",
      "media.paged.image.tool.heal",
      // The toning tools share the clone stamp's slot.
      "media.paged.image.tool.dodge",
      "media.paged.image.tool.burn",
      "media.paged.image.tool.sponge",
      "media.paged.image.tool.blur",
      "media.paged.image.tool.sharpen",
      // The brush engine's tools (WP5.7).
      "media.paged.image.tool.smudge",
      "media.paged.image.tool.mixerBrush",
      "media.paged.image.tool.colorReplacement",
      "media.paged.image.tool.historyBrush",
      "media.paged.image.tool.artHistoryBrush",
      "media.paged.image.tool.backgroundEraser",
      "media.paged.image.tool.magicEraser",
      "media.paged.image.tool.spotHeal",
      "media.paged.image.tool.patch",
      // WP5.8 — Content-Aware Move, Remove, the CAF sampling brush.
      "media.paged.image.tool.contentAwareMove",
      "media.paged.image.tool.remove",
      "media.paged.image.tool.cafSampling",
      "media.paged.image.tool.type",
      // The Magnetic Lasso (lasso slot) and the Refine Edge brush (quick
      // selection slot), WP5.5.
      "media.paged.image.tool.magneticLasso",
      "media.paged.image.tool.refineEdge",
    ]);
    expect(fake.importers.ids()).toEqual(["media.paged.image.importer.raster"]);
  });

  it("[image.codec.core-codecs] imports every paged-raster format and exports TIFF and WebP", () => {
    const fake = makeFakeEditor();
    load(fake);
    const importer = fake.importers.get("media.paged.image.importer.raster") as
      { extensions: string[]; mimeTypes: string[] } | undefined;
    for (const ext of [
      ".tif",
      ".tiff",
      ".webp",
      ".gif",
      ".bmp",
      ".avif",
      ".jxl",
      ".dng",
      ".exr",
      ".hdr",
    ])
      expect(importer?.extensions).toContain(ext);
    expect(importer?.mimeTypes).toContain("image/tiff");
    expect(fake.exporters.ids()).toEqual([
      "media.paged.image.exporter.psd",
      "media.paged.image.exporter.png",
      "media.paged.image.exporter.jpeg",
      "media.paged.image.exporter.tiff",
      "media.paged.image.exporter.webp",
    ]);
    expect(
      fake.commands.get("media.paged.image.command.exportAs"),
    ).toBeDefined();
  });

  it("the open command routes through host.shell.openPanel", () => {
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    load(fake, shellStub(openPanel));
    const cmd = fake.commands.get(
      "media.paged.image.command.openImage",
    ) as unknown as { handler: () => void };
    cmd.handler();
    expect(openPanel).toHaveBeenCalledWith(PANEL_ID);
  });

  it("the adjust command raises the panel before ingesting", () => {
    const fake = makeFakeEditor();
    const openPanel = vi.fn();
    load(fake, shellStub(openPanel));
    const cmd = fake.commands.get(
      "media.paged.image.command.adjustSelected",
    ) as unknown as { handler: () => void };
    cmd.handler();
    expect(openPanel).toHaveBeenCalledWith(PANEL_ID);
  });

  it("dispose leaves the shell exactly as found (honesty smoke test)", () => {
    const fake = makeFakeEditor();
    const loaded = load(fake);
    loaded.dispose();
    expect(fake.panels.ids()).toHaveLength(0);
    expect(fake.commands.ids()).toHaveLength(0);
    expect(fake.tools.ids()).toHaveLength(0);
    expect(fake.importers.ids()).toHaveLength(0);
  });
});

// ── the two manifests must be ONE manifest ───────────────────────────
//
// `manifest/manifest.json` is what `pnpm validate:manifest` checks and
// what the packaged bundle declares; `glue/manifest.json` is the COPY
// the bundle actually imports at build time. They are two tracked files
// with no sync step between them, so a capability declared in one and
// not the other produces a `PluginCapabilityError` at activate — which
// is exactly what happened when the `.abr` command was added. This is
// the guard that turns that into a one-line failure instead of a
// mystery.
describe("the manifest copy", () => {
  it("is byte-identical to the validated manifest", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const declared = readFileSync(
      `${here}../../manifest/manifest.json`,
      "utf8",
    );
    const embedded = readFileSync(`${here}../manifest.json`, "utf8");
    expect(embedded).toBe(declared);
  });
});
