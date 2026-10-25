/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// PLUGIN MENUS — paged.image (modules/image/glue/src/menu.ts).
//
// A hundred and twenty-four entries: a hundred and twenty-two under the Image menu (folded into
// Plugins ▸ Image; shown as a context menu inside a raster frame) and two
// under the host's Edit menu (Edit ▸ Selection to path, Edit ▸ Path to
// selection).
//
// THE STATE IS A DOCUMENT WITH NO IMAGE OPEN, deliberately: paged.image's
// kernels are WebGPU-only and this lane's Chromium has no adapter, so an
// image session's pixel work cannot be asserted here (the journeys-gpu lane
// and the bundle's own suite do that). What the menu owes in this state is
// still observable and is pinned per entry: the verbs that need an image
// raise the Image panel, which is where the bundle says what is missing;
// the selection, crop and commit verbs run and change nothing; the brush
// library entry asks for an .abr file.
//
// WHAT EVERY ENTRY OWES, asserted per entry through the real menu bar
// (menu-driver.ts says where an entry shows and how a click is observed):
//
//   · without a document it is GREYED and a click runs nothing (the SDK
//     scopes every plugin entry to "a document is open");
//   · with one it is enabled, and a click runs exactly its command, once,
//     with no payload, and the handler settles without throwing;
//   · what the click then does, where the editor can see it: the panel it
//     raises (`host.shell.openPanel`), the file it asks for
//     (`host.shell.pickFile`, answered "cancelled"), the document it changes
//     (an IDML export digest) and that ONE Undo takes that change back.
//
// What a command does to a richer document than the one set up here is
// the command's own suite (the bundle's unit and headless tests); this file
// is about the menu entry: reachable, gated, wired to its command.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickEntry, expectGreyedAndInert, openMenuPages } from "./menu-driver";

test.describe.serial("plugin menus — paged.image", () => {
  let bare: Page;
  let live: Page;
  let close: () => Promise<void>;

  test.beforeAll(async ({ browser }, info) => {
    ({ bare, live, close } = await openMenuPages(browser, info.project.use));
  });
  test.afterAll(async () => {
    await close();
  });

  test("Image/Open image panel — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Open image panel");
    await expectGreyedAndInert(bare, "Image/Open image panel");
    const out = await clickEntry(
      live,
      "Image/Open image panel",
      "media.paged.image.command.openImage",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Adjust… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Adjust…");
    await expectGreyedAndInert(bare, "Image/Adjust…");
    const out = await clickEntry(
      live,
      "Image/Adjust…",
      "media.paged.image.command.adjustSelected",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Auto-enhance — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Auto-enhance");
    await expectGreyedAndInert(bare, "Image/Auto-enhance");
    const out = await clickEntry(
      live,
      "Image/Auto-enhance",
      "media.paged.image.command.autoEnhance",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Bake adjustments into layer — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Bake adjustments into layer");
    await expectGreyedAndInert(bare, "Image/Bake adjustments into layer");
    const out = await clickEntry(
      live,
      "Image/Bake adjustments into layer",
      "media.paged.image.command.bakeAdjustToLayer",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Rotate 90° clockwise — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Rotate 90° clockwise");
    await expectGreyedAndInert(bare, "Image/Rotate 90° clockwise");
    const out = await clickEntry(
      live,
      "Image/Rotate 90° clockwise",
      "media.paged.image.command.rotateCw",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Rotate 90° counter-clockwise — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Rotate 90° counter-clockwise");
    await expectGreyedAndInert(bare, "Image/Rotate 90° counter-clockwise");
    const out = await clickEntry(
      live,
      "Image/Rotate 90° counter-clockwise",
      "media.paged.image.command.rotateCcw",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Rotate 180° — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Rotate 180°");
    await expectGreyedAndInert(bare, "Image/Rotate 180°");
    const out = await clickEntry(
      live,
      "Image/Rotate 180°",
      "media.paged.image.command.rotate180",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Flip horizontal — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Flip horizontal");
    await expectGreyedAndInert(bare, "Image/Flip horizontal");
    const out = await clickEntry(
      live,
      "Image/Flip horizontal",
      "media.paged.image.command.flipHorizontal",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Flip vertical — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Flip vertical");
    await expectGreyedAndInert(bare, "Image/Flip vertical");
    const out = await clickEntry(
      live,
      "Image/Flip vertical",
      "media.paged.image.command.flipVertical",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Layer/Add — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Add");
    await expectGreyedAndInert(bare, "Image/Layer/Add");
    const out = await clickEntry(
      live,
      "Image/Layer/Add",
      "media.paged.image.command.addLayer",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Layer/Add mask (reveal all) — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Add mask (reveal all)");
    await expectGreyedAndInert(bare, "Image/Layer/Add mask (reveal all)");
    const out = await clickEntry(
      live,
      "Image/Layer/Add mask (reveal all)",
      "media.paged.image.command.addLayerMask",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Layer/Add mask (hide all) — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Add mask (hide all)");
    await expectGreyedAndInert(bare, "Image/Layer/Add mask (hide all)");
    const out = await clickEntry(
      live,
      "Image/Layer/Add mask (hide all)",
      "media.paged.image.command.addLayerMaskHideAll",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Layer/Convert to smart object — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Convert to smart object");
    await expectGreyedAndInert(bare, "Image/Layer/Convert to smart object");
    const out = await clickEntry(
      live,
      "Image/Layer/Convert to smart object",
      "media.paged.image.command.convertLayerToSmart",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Layer/New/Layer via copy — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New/Layer via copy");
    await expectGreyedAndInert(bare, "Image/Layer/New/Layer via copy");
    const out = await clickEntry(
      live,
      "Image/Layer/New/Layer via copy",
      "media.paged.image.command.layerViaCopy",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New/Layer via cut — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New/Layer via cut");
    await expectGreyedAndInert(bare, "Image/Layer/New/Layer via cut");
    const out = await clickEntry(
      live,
      "Image/Layer/New/Layer via cut",
      "media.paged.image.command.layerViaCut",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New fill layer/Solid colour… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New fill layer/Solid colour…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New fill layer/Solid colour…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New fill layer/Solid colour…",
      "media.paged.image.command.newFillSolid",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New fill layer/Gradient… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New fill layer/Gradient…");
    await expectGreyedAndInert(bare, "Image/Layer/New fill layer/Gradient…");
    const out = await clickEntry(
      live,
      "Image/Layer/New fill layer/Gradient…",
      "media.paged.image.command.newFillGradient",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New fill layer/Pattern… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New fill layer/Pattern…");
    await expectGreyedAndInert(bare, "Image/Layer/New fill layer/Pattern…");
    const out = await clickEntry(
      live,
      "Image/Layer/New fill layer/Pattern…",
      "media.paged.image.command.newFillPattern",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Brightness–contrast… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Brightness–contrast…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Brightness–contrast…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Brightness–contrast…",
      "media.paged.image.command.newAdjustmentBrightnessContrast",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Levels… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Levels…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Levels…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Levels…",
      "media.paged.image.command.newAdjustmentLevels",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Curves… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Curves…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Curves…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Curves…",
      "media.paged.image.command.newAdjustmentCurves",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Exposure… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Exposure…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Exposure…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Exposure…",
      "media.paged.image.command.newAdjustmentExposure",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Vibrance… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Vibrance…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Vibrance…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Vibrance…",
      "media.paged.image.command.newAdjustmentVibrance",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Hue–saturation… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Hue–saturation…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Hue–saturation…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Hue–saturation…",
      "media.paged.image.command.newAdjustmentHueSaturation",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Colour balance… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Colour balance…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Colour balance…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Colour balance…",
      "media.paged.image.command.newAdjustmentColorBalance",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Black & white… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Black & white…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Black & white…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Black & white…",
      "media.paged.image.command.newAdjustmentBlackWhite",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Photo filter… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Photo filter…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Photo filter…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Photo filter…",
      "media.paged.image.command.newAdjustmentPhotoFilter",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Channel mixer… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Channel mixer…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Channel mixer…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Channel mixer…",
      "media.paged.image.command.newAdjustmentChannelMixer",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Colour lookup… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Colour lookup…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Colour lookup…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Colour lookup…",
      "media.paged.image.command.newAdjustmentColorLookup",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Invert — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Invert");
    await expectGreyedAndInert(bare, "Image/Layer/New adjustment layer/Invert");
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Invert",
      "media.paged.image.command.newAdjustmentInvert",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Posterize… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Posterize…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Posterize…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Posterize…",
      "media.paged.image.command.newAdjustmentPosterize",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Threshold… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Threshold…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Threshold…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Threshold…",
      "media.paged.image.command.newAdjustmentThreshold",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Gradient map… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Gradient map…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Gradient map…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Gradient map…",
      "media.paged.image.command.newAdjustmentGradientMap",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/New adjustment layer/Selective colour… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/New adjustment layer/Selective colour…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/New adjustment layer/Selective colour…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/New adjustment layer/Selective colour…",
      "media.paged.image.command.newAdjustmentSelectiveColor",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Blending options… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Blending options…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Layer style/Blending options…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Blending options…",
      "media.paged.image.command.blendingOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Bevel and emboss… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Bevel and emboss…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Layer style/Bevel and emboss…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Bevel and emboss…",
      "media.paged.image.command.layerStyleBevel",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Stroke… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Stroke…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Stroke…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Stroke…",
      "media.paged.image.command.layerStyleStroke",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Inner shadow… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Inner shadow…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Inner shadow…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Inner shadow…",
      "media.paged.image.command.layerStyleInnerShadow",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Inner glow… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Inner glow…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Inner glow…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Inner glow…",
      "media.paged.image.command.layerStyleInnerGlow",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Satin… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Satin…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Satin…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Satin…",
      "media.paged.image.command.layerStyleSatin",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Colour overlay… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Colour overlay…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Colour overlay…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Colour overlay…",
      "media.paged.image.command.layerStyleColorOverlay",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Gradient overlay… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Gradient overlay…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Layer style/Gradient overlay…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Gradient overlay…",
      "media.paged.image.command.layerStyleGradientOverlay",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Pattern overlay… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Pattern overlay…");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Layer style/Pattern overlay…",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Pattern overlay…",
      "media.paged.image.command.layerStylePatternOverlay",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Outer glow… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Outer glow…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Outer glow…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Outer glow…",
      "media.paged.image.command.layerStyleOuterGlow",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Drop shadow… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Drop shadow…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Drop shadow…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Drop shadow…",
      "media.paged.image.command.layerStyleDropShadow",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Copy layer style — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Copy layer style");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Layer style/Copy layer style",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Copy layer style",
      "media.paged.image.command.copyLayerStyle",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Paste layer style — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Paste layer style");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Layer style/Paste layer style",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Paste layer style",
      "media.paged.image.command.pasteLayerStyle",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Clear layer style — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Clear layer style");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Layer style/Clear layer style",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Clear layer style",
      "media.paged.image.command.clearLayerStyle",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Global light… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Global light…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Global light…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Global light…",
      "media.paged.image.command.globalLight",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Hide all effects — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Hide all effects");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Layer style/Hide all effects",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Hide all effects",
      "media.paged.image.command.toggleEffects",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer style/Scale effects… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer style/Scale effects…");
    await expectGreyedAndInert(bare, "Image/Layer/Layer style/Scale effects…");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer style/Scale effects…",
      "media.paged.image.command.scaleEffects",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Rasterize — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Rasterize");
    await expectGreyedAndInert(bare, "Image/Layer/Rasterize");
    const out = await clickEntry(
      live,
      "Image/Layer/Rasterize",
      "media.paged.image.command.rasterizeLayer",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Link with layer below — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Link with layer below");
    await expectGreyedAndInert(bare, "Image/Layer/Link with layer below");
    const out = await clickEntry(
      live,
      "Image/Layer/Link with layer below",
      "media.paged.image.command.linkLayers",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Unlink — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Unlink");
    await expectGreyedAndInert(bare, "Image/Layer/Unlink");
    const out = await clickEntry(
      live,
      "Image/Layer/Unlink",
      "media.paged.image.command.unlinkLayer",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Align/Left edges — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Align/Left edges");
    await expectGreyedAndInert(bare, "Image/Layer/Align/Left edges");
    const out = await clickEntry(
      live,
      "Image/Layer/Align/Left edges",
      "media.paged.image.command.alignLeft",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Align/Horizontal centres — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Align/Horizontal centres");
    await expectGreyedAndInert(bare, "Image/Layer/Align/Horizontal centres");
    const out = await clickEntry(
      live,
      "Image/Layer/Align/Horizontal centres",
      "media.paged.image.command.alignHCenter",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Align/Right edges — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Align/Right edges");
    await expectGreyedAndInert(bare, "Image/Layer/Align/Right edges");
    const out = await clickEntry(
      live,
      "Image/Layer/Align/Right edges",
      "media.paged.image.command.alignRight",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Align/Top edges — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Align/Top edges");
    await expectGreyedAndInert(bare, "Image/Layer/Align/Top edges");
    const out = await clickEntry(
      live,
      "Image/Layer/Align/Top edges",
      "media.paged.image.command.alignTop",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Align/Vertical centres — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Align/Vertical centres");
    await expectGreyedAndInert(bare, "Image/Layer/Align/Vertical centres");
    const out = await clickEntry(
      live,
      "Image/Layer/Align/Vertical centres",
      "media.paged.image.command.alignVCenter",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Align/Bottom edges — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Align/Bottom edges");
    await expectGreyedAndInert(bare, "Image/Layer/Align/Bottom edges");
    const out = await clickEntry(
      live,
      "Image/Layer/Align/Bottom edges",
      "media.paged.image.command.alignBottom",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Distribute/Horizontal centres — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Distribute/Horizontal centres");
    await expectGreyedAndInert(
      bare,
      "Image/Layer/Distribute/Horizontal centres",
    );
    const out = await clickEntry(
      live,
      "Image/Layer/Distribute/Horizontal centres",
      "media.paged.image.command.distributeHorizontal",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Distribute/Vertical centres — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Distribute/Vertical centres");
    await expectGreyedAndInert(bare, "Image/Layer/Distribute/Vertical centres");
    const out = await clickEntry(
      live,
      "Image/Layer/Distribute/Vertical centres",
      "media.paged.image.command.distributeVertical",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Layer comps/New layer comp — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Layer comps/New layer comp");
    await expectGreyedAndInert(bare, "Image/Layer/Layer comps/New layer comp");
    const out = await clickEntry(
      live,
      "Image/Layer/Layer comps/New layer comp",
      "media.paged.image.command.newLayerComp",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Merge down — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Merge down");
    await expectGreyedAndInert(bare, "Image/Layer/Merge down");
    const out = await clickEntry(
      live,
      "Image/Layer/Merge down",
      "media.paged.image.command.mergeDown",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Merge group — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Merge group");
    await expectGreyedAndInert(bare, "Image/Layer/Merge group");
    const out = await clickEntry(
      live,
      "Image/Layer/Merge group",
      "media.paged.image.command.mergeGroup",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Merge visible — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Merge visible");
    await expectGreyedAndInert(bare, "Image/Layer/Merge visible");
    const out = await clickEntry(
      live,
      "Image/Layer/Merge visible",
      "media.paged.image.command.mergeVisible",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Stamp visible — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Stamp visible");
    await expectGreyedAndInert(bare, "Image/Layer/Stamp visible");
    const out = await clickEntry(
      live,
      "Image/Layer/Stamp visible",
      "media.paged.image.command.stampVisible",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Layer/Flatten image — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Layer/Flatten image");
    await expectGreyedAndInert(bare, "Image/Layer/Flatten image");
    const out = await clickEntry(
      live,
      "Image/Layer/Flatten image",
      "media.paged.image.command.flattenImage",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the layer stack is untouched").toBe(
      out.before,
    );
  });

  test("Image/Selection/Select all — runs selectAll; with no image open it changes nothing", async () => {
    covers("menu:Image/Selection/Select all");
    await expectGreyedAndInert(bare, "Image/Selection/Select all");
    const out = await clickEntry(
      live,
      "Image/Selection/Select all",
      "media.paged.image.command.selectAll",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "with no image open there is nothing to act on").toBe(
      out.before,
    );
  });

  test("Image/Selection/Deselect — runs deselect; with no image open it changes nothing", async () => {
    covers("menu:Image/Selection/Deselect");
    await expectGreyedAndInert(bare, "Image/Selection/Deselect");
    const out = await clickEntry(
      live,
      "Image/Selection/Deselect",
      "media.paged.image.command.deselect",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "with no image open there is nothing to act on").toBe(
      out.before,
    );
  });

  test("Image/Selection/Invert — runs invertSelection; with no image open it changes nothing", async () => {
    covers("menu:Image/Selection/Invert");
    await expectGreyedAndInert(bare, "Image/Selection/Invert");
    const out = await clickEntry(
      live,
      "Image/Selection/Invert",
      "media.paged.image.command.invertSelection",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "with no image open there is nothing to act on").toBe(
      out.before,
    );
  });

  test("Image/Selection/Feather… — runs featherSelection; with no image open it changes nothing", async () => {
    covers("menu:Image/Selection/Feather…");
    await expectGreyedAndInert(bare, "Image/Selection/Feather…");
    const out = await clickEntry(
      live,
      "Image/Selection/Feather…",
      "media.paged.image.command.featherSelection",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "with no image open there is nothing to act on").toBe(
      out.before,
    );
  });

  test("Image/Selection/From luminosity channel — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Selection/From luminosity channel");
    await expectGreyedAndInert(bare, "Image/Selection/From luminosity channel");
    const out = await clickEntry(
      live,
      "Image/Selection/From luminosity channel",
      "media.paged.image.command.channelToSelection",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Fill/Gradient… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Fill/Gradient…");
    await expectGreyedAndInert(bare, "Image/Fill/Gradient…");
    const out = await clickEntry(
      live,
      "Image/Fill/Gradient…",
      "media.paged.image.command.fillSelection",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Fill/Noise… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Fill/Noise…");
    await expectGreyedAndInert(bare, "Image/Fill/Noise…");
    const out = await clickEntry(
      live,
      "Image/Fill/Noise…",
      "media.paged.image.command.fillNoise",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Fill/Content-aware — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Fill/Content-aware");
    await expectGreyedAndInert(bare, "Image/Fill/Content-aware");
    const out = await clickEntry(
      live,
      "Image/Fill/Content-aware",
      "media.paged.image.command.contentAwareFill",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Fill/Foreground colour — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Fill/Foreground colour");
    await expectGreyedAndInert(bare, "Image/Fill/Foreground colour");
    const out = await clickEntry(
      live,
      "Image/Fill/Foreground colour",
      "media.paged.image.command.fillForeground",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Fill/Define pattern — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Fill/Define pattern");
    await expectGreyedAndInert(bare, "Image/Fill/Define pattern");
    const out = await clickEntry(
      live,
      "Image/Fill/Define pattern",
      "media.paged.image.command.definePattern",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Fill/Pattern — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Fill/Pattern");
    await expectGreyedAndInert(bare, "Image/Fill/Pattern");
    const out = await clickEntry(
      live,
      "Image/Fill/Pattern",
      "media.paged.image.command.fillPattern",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Filter/Shape blur — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Shape blur");
    await expectGreyedAndInert(bare, "Image/Filter/Shape blur");
    const out = await clickEntry(
      live,
      "Image/Filter/Shape blur",
      "media.paged.image.command.shapeBlur",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Image rotation/Arbitrary… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Image rotation/Arbitrary…");
    await expectGreyedAndInert(bare, "Image/Image rotation/Arbitrary…");
    const out = await clickEntry(
      live,
      "Image/Image rotation/Arbitrary…",
      "media.paged.image.command.rotateArbitrary",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Image size… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Image size…");
    await expectGreyedAndInert(bare, "Image/Image size…");
    const out = await clickEntry(
      live,
      "Image/Image size…",
      "media.paged.image.command.imageSize",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Trim… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Trim…");
    await expectGreyedAndInert(bare, "Image/Trim…");
    const out = await clickEntry(
      live,
      "Image/Trim…",
      "media.paged.image.command.trim",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Blur/Box blur… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Blur/Box blur…");
    await expectGreyedAndInert(bare, "Image/Filter/Blur/Box blur…");
    const out = await clickEntry(
      live,
      "Image/Filter/Blur/Box blur…",
      "media.paged.image.command.filterBoxBlur",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Blur/Average — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Blur/Average");
    await expectGreyedAndInert(bare, "Image/Filter/Blur/Average");
    const out = await clickEntry(
      live,
      "Image/Filter/Blur/Average",
      "media.paged.image.command.average",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Blur/Surface blur… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Blur/Surface blur…");
    await expectGreyedAndInert(bare, "Image/Filter/Blur/Surface blur…");
    const out = await clickEntry(
      live,
      "Image/Filter/Blur/Surface blur…",
      "media.paged.image.command.filterSurfaceBlur",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Blur/Motion blur… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Blur/Motion blur…");
    await expectGreyedAndInert(bare, "Image/Filter/Blur/Motion blur…");
    const out = await clickEntry(
      live,
      "Image/Filter/Blur/Motion blur…",
      "media.paged.image.command.filterMotionBlur",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Blur/Radial blur… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Blur/Radial blur…");
    await expectGreyedAndInert(bare, "Image/Filter/Blur/Radial blur…");
    const out = await clickEntry(
      live,
      "Image/Filter/Blur/Radial blur…",
      "media.paged.image.command.filterRadialBlur",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Blur/Lens blur… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Blur/Lens blur…");
    await expectGreyedAndInert(bare, "Image/Filter/Blur/Lens blur…");
    const out = await clickEntry(
      live,
      "Image/Filter/Blur/Lens blur…",
      "media.paged.image.command.filterLensBlur",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Noise/Add noise… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Noise/Add noise…");
    await expectGreyedAndInert(bare, "Image/Filter/Noise/Add noise…");
    const out = await clickEntry(
      live,
      "Image/Filter/Noise/Add noise…",
      "media.paged.image.command.filterAddNoise",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Noise/Despeckle… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Noise/Despeckle…");
    await expectGreyedAndInert(bare, "Image/Filter/Noise/Despeckle…");
    const out = await clickEntry(
      live,
      "Image/Filter/Noise/Despeckle…",
      "media.paged.image.command.filterDespeckle",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Noise/Dust & scratches… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Noise/Dust & scratches…");
    await expectGreyedAndInert(bare, "Image/Filter/Noise/Dust & scratches…");
    const out = await clickEntry(
      live,
      "Image/Filter/Noise/Dust & scratches…",
      "media.paged.image.command.filterDustScratches",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Noise/Median… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Noise/Median…");
    await expectGreyedAndInert(bare, "Image/Filter/Noise/Median…");
    const out = await clickEntry(
      live,
      "Image/Filter/Noise/Median…",
      "media.paged.image.command.filterMedian",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Noise/Reduce noise… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Noise/Reduce noise…");
    await expectGreyedAndInert(bare, "Image/Filter/Noise/Reduce noise…");
    const out = await clickEntry(
      live,
      "Image/Filter/Noise/Reduce noise…",
      "media.paged.image.command.filterReduceNoise",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Other/High pass… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Other/High pass…");
    await expectGreyedAndInert(bare, "Image/Filter/Other/High pass…");
    const out = await clickEntry(
      live,
      "Image/Filter/Other/High pass…",
      "media.paged.image.command.filterHighPass",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Other/Maximum… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Other/Maximum…");
    await expectGreyedAndInert(bare, "Image/Filter/Other/Maximum…");
    const out = await clickEntry(
      live,
      "Image/Filter/Other/Maximum…",
      "media.paged.image.command.filterMaximum",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Other/Minimum… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Other/Minimum…");
    await expectGreyedAndInert(bare, "Image/Filter/Other/Minimum…");
    const out = await clickEntry(
      live,
      "Image/Filter/Other/Minimum…",
      "media.paged.image.command.filterMinimum",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Other/Offset… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Other/Offset…");
    await expectGreyedAndInert(bare, "Image/Filter/Other/Offset…");
    const out = await clickEntry(
      live,
      "Image/Filter/Other/Offset…",
      "media.paged.image.command.filterOffset",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Sharpen/Smart sharpen… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Sharpen/Smart sharpen…");
    await expectGreyedAndInert(bare, "Image/Filter/Sharpen/Smart sharpen…");
    const out = await clickEntry(
      live,
      "Image/Filter/Sharpen/Smart sharpen…",
      "media.paged.image.command.filterSmartSharpen",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Stylize/Emboss… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Stylize/Emboss…");
    await expectGreyedAndInert(bare, "Image/Filter/Stylize/Emboss…");
    const out = await clickEntry(
      live,
      "Image/Filter/Stylize/Emboss…",
      "media.paged.image.command.filterEmboss",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Stylize/Find edges… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Stylize/Find edges…");
    await expectGreyedAndInert(bare, "Image/Filter/Stylize/Find edges…");
    const out = await clickEntry(
      live,
      "Image/Filter/Stylize/Find edges…",
      "media.paged.image.command.filterFindEdges",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Stylize/Glowing edges… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Stylize/Glowing edges…");
    await expectGreyedAndInert(bare, "Image/Filter/Stylize/Glowing edges…");
    const out = await clickEntry(
      live,
      "Image/Filter/Stylize/Glowing edges…",
      "media.paged.image.command.filterGlowingEdges",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Pixelate/Mosaic… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Pixelate/Mosaic…");
    await expectGreyedAndInert(bare, "Image/Filter/Pixelate/Mosaic…");
    const out = await clickEntry(
      live,
      "Image/Filter/Pixelate/Mosaic…",
      "media.paged.image.command.filterMosaic",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Pixelate/Colour halftone… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Pixelate/Colour halftone…");
    await expectGreyedAndInert(bare, "Image/Filter/Pixelate/Colour halftone…");
    const out = await clickEntry(
      live,
      "Image/Filter/Pixelate/Colour halftone…",
      "media.paged.image.command.filterHalftone",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Paint daubs… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Paint daubs…");
    await expectGreyedAndInert(
      bare,
      "Image/Filter/Filter Gallery/Paint daubs…",
    );
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Paint daubs…",
      "media.paged.image.command.filterPaintDaubs",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Poster edges… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Poster edges…");
    await expectGreyedAndInert(
      bare,
      "Image/Filter/Filter Gallery/Poster edges…",
    );
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Poster edges…",
      "media.paged.image.command.filterPosterEdges",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Film grain… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Film grain…");
    await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Film grain…");
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Film grain…",
      "media.paged.image.command.filterFilmGrain",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Spatter… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Spatter…");
    await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Spatter…");
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Spatter…",
      "media.paged.image.command.filterSpatter",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Crosshatch… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Crosshatch…");
    await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Crosshatch…");
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Crosshatch…",
      "media.paged.image.command.filterCrosshatch",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Bas relief… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Bas relief…");
    await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Bas relief…");
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Bas relief…",
      "media.paged.image.command.filterBasRelief",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Photocopy… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Photocopy…");
    await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Photocopy…");
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Photocopy…",
      "media.paged.image.command.filterPhotocopy",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Stained glass… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Stained glass…");
    await expectGreyedAndInert(
      bare,
      "Image/Filter/Filter Gallery/Stained glass…",
    );
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Stained glass…",
      "media.paged.image.command.filterStainedGlass",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Glass… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Glass…");
    await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Glass…");
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Glass…",
      "media.paged.image.command.filterGlass",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Filter Gallery/Texturizer… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Filter Gallery/Texturizer…");
    await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Texturizer…");
    const out = await clickEntry(
      live,
      "Image/Filter/Filter Gallery/Texturizer…",
      "media.paged.image.command.filterTexturizer",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Adjust/Gradient map… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Adjust/Gradient map…");
    await expectGreyedAndInert(bare, "Image/Filter/Adjust/Gradient map…");
    const out = await clickEntry(
      live,
      "Image/Filter/Adjust/Gradient map…",
      "media.paged.image.command.filterGradientMap",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Filter/Adjust/Selective colour… — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Adjust/Selective colour…");
    await expectGreyedAndInert(bare, "Image/Filter/Adjust/Selective colour…");
    const out = await clickEntry(
      live,
      "Image/Filter/Adjust/Selective colour…",
      "media.paged.image.command.filterSelectiveColour",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image the dialog opens nothing").toBe(
      out.before,
    );
  });

  test("Image/Apply crop — runs commitCrop; with no image open it changes nothing", async () => {
    covers("menu:Image/Apply crop");
    await expectGreyedAndInert(bare, "Image/Apply crop");
    const out = await clickEntry(
      live,
      "Image/Apply crop",
      "media.paged.image.command.commitCrop",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "with no image open there is nothing to act on").toBe(
      out.before,
    );
  });

  test("Image/Set type — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Set type");
    await expectGreyedAndInert(bare, "Image/Set type");
    const out = await clickEntry(
      live,
      "Image/Set type",
      "media.paged.image.command.setType",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Load brush library (.abr)… — raises the Image panel and asks for an .abr file", async () => {
    covers("menu:Image/Load brush library (.abr)…");
    await expectGreyedAndInert(bare, "Image/Load brush library (.abr)…");
    const out = await clickEntry(
      live,
      "Image/Load brush library (.abr)…",
      "media.paged.image.command.loadBrushLibrary",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      { door: "pickFile", arg: '{"accept":[".abr"]}' },
    ]);
    expect(out.after).toBe(out.before);
  });

  test("Image/Commit edits to the document — runs commitImage; with no image open it changes nothing", async () => {
    covers("menu:Image/Commit edits to the document");
    await expectGreyedAndInert(bare, "Image/Commit edits to the document");
    const out = await clickEntry(
      live,
      "Image/Commit edits to the document",
      "media.paged.image.command.commitImage",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "with no image open there is nothing to act on").toBe(
      out.before,
    );
  });

  test("Image/File/Apply adjustments to the file — with no image open, raises the Image panel", async () => {
    covers("menu:Image/File/Apply adjustments to the file");
    await expectGreyedAndInert(
      bare,
      "Image/File/Apply adjustments to the file",
    );
    const out = await clickEntry(
      live,
      "Image/File/Apply adjustments to the file",
      "media.paged.image.command.applyToFile",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/File/Save the adjusted file — with no image open, raises the Image panel", async () => {
    covers("menu:Image/File/Save the adjusted file");
    await expectGreyedAndInert(bare, "Image/File/Save the adjusted file");
    const out = await clickEntry(
      live,
      "Image/File/Save the adjusted file",
      "media.paged.image.command.saveToFile",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Edit/Selection to path — with no image open, raises the Image panel", async () => {
    covers("menu:Edit/Selection to path");
    await expectGreyedAndInert(bare, "Edit/Selection to path");
    const out = await clickEntry(
      live,
      "Edit/Selection to path",
      "media.paged.image.command.selectionToPath",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Edit/Path to selection — with no image open, raises the Image panel", async () => {
    covers("menu:Edit/Path to selection");
    await expectGreyedAndInert(bare, "Edit/Path to selection");
    const out = await clickEntry(
      live,
      "Edit/Path to selection",
      "media.paged.image.command.pathToSelection",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });
});
