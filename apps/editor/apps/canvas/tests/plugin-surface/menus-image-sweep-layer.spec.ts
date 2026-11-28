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
// Two hundred and twenty-eight entries: two hundred and twenty-five under the Image menu (folded into
// Plugins ▸ Image; shown as a context menu inside a raster frame) and three
// under the host's Edit menu (Edit ▸ Selection to path, Edit ▸ Path to
// selection, Edit ▸ Content-aware fill…).
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
//
// THIS FILE: the sweep, part 1: Image ▸ Layer (71 entries), every one of them
// an entry that raises the Image panel when no image is open. Tagged
// @nightly: the scheduled run of editor / tests asserts every entry; a push
// runs menus-image.spec.ts, which has one entry of this kind and every entry
// that does something else (editor-tests.yml, "the nightly sweeps"). Three
// files, not one, so the sweep spreads over shards and workers; each is a
// serial group on its own pair of pages, and no entry depends on another.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickEntry, expectGreyedAndInert, openMenuPages } from "./menu-driver";

test.describe.serial(
  "plugin menus — paged.image, sweep: Layer",
  { tag: "@nightly" },
  () => {
    let bare: Page;
    let live: Page;
    let close: () => Promise<void>;

    test.beforeAll(async ({ browser }, info) => {
      ({ bare, live, close } = await openMenuPages(browser, info.project.use));
    });
    test.afterAll(async () => {
      await close();
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

    test("Image/Layer/Smart objects/Edit contents — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Edit contents");
      covers("command:media.paged.image.command.smartEditContents");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Edit contents",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Edit contents",
        "media.paged.image.command.smartEditContents",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Save and close contents — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Save and close contents");
      covers("command:media.paged.image.command.smartSaveContents");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Save and close contents",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Save and close contents",
        "media.paged.image.command.smartSaveContents",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Close contents without saving — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Close contents without saving");
      covers("command:media.paged.image.command.smartCloseContents");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Close contents without saving",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Close contents without saving",
        "media.paged.image.command.smartCloseContents",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Transform… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Transform…");
      covers("command:media.paged.image.command.smartTransform");
      await expectGreyedAndInert(bare, "Image/Layer/Smart objects/Transform…");
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Transform…",
        "media.paged.image.command.smartTransform",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Replace contents… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Replace contents…");
      covers("command:media.paged.image.command.smartReplaceContents");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Replace contents…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Replace contents…",
        "media.paged.image.command.smartReplaceContents",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Relink to file… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Relink to file…");
      covers("command:media.paged.image.command.smartRelink");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Relink to file…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Relink to file…",
        "media.paged.image.command.smartRelink",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Update from file… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Update from file…");
      covers("command:media.paged.image.command.smartUpdateLinked");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Update from file…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Update from file…",
        "media.paged.image.command.smartUpdateLinked",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Embed linked — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Embed linked");
      covers("command:media.paged.image.command.smartEmbed");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Embed linked",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Embed linked",
        "media.paged.image.command.smartEmbed",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Export contents… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Export contents…");
      covers("command:media.paged.image.command.smartExportContents");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Export contents…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Export contents…",
        "media.paged.image.command.smartExportContents",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Smart objects/Place selected page items — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Smart objects/Place selected page items");
      covers("command:media.paged.image.command.smartPlacePageItems");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Smart objects/Place selected page items",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Smart objects/Place selected page items",
        "media.paged.image.command.smartPlacePageItems",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no smart object to touch").toBe(
        out.before,
      );
    });

    test("Image/Layer/Place layers as frames — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Place layers as frames");
      covers("command:media.paged.image.command.placeLayersAsFrames");
      await expectGreyedAndInert(bare, "Image/Layer/Place layers as frames");
      const out = await clickEntry(
        live,
        "Image/Layer/Place layers as frames",
        "media.paged.image.command.placeLayersAsFrames",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no PSD open there are no layers to place").toBe(
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

    test("Image/Layer/New fill layer/Solid color… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/New fill layer/Solid color…");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/New fill layer/Solid color…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/New fill layer/Solid color…",
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

    test("Image/Layer/New adjustment layer/Color balance… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/New adjustment layer/Color balance…");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/New adjustment layer/Color balance…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/New adjustment layer/Color balance…",
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

    test("Image/Layer/New adjustment layer/Color lookup… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/New adjustment layer/Color lookup…");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/New adjustment layer/Color lookup…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/New adjustment layer/Color lookup…",
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
      await expectGreyedAndInert(
        bare,
        "Image/Layer/New adjustment layer/Invert",
      );
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

    test("Image/Layer/New adjustment layer/Selective color… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/New adjustment layer/Selective color…");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/New adjustment layer/Selective color…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/New adjustment layer/Selective color…",
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

    test("Image/Layer/Layer style/Color overlay… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/Layer style/Color overlay…");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Layer style/Color overlay…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Layer style/Color overlay…",
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
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Layer style/Scale effects…",
      );
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
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Distribute/Vertical centres",
      );
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
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Layer comps/New layer comp",
      );
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

    test("Image/Layer/New adjustment layer/Develop… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Layer/New adjustment layer/Develop…");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/New adjustment layer/Develop…",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/New adjustment layer/Develop…",
        "media.paged.image.command.newAdjustmentDevelop",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the layer stack is untouched").toBe(
        out.before,
      );
    });
  },
);
