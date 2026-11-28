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
// THIS FILE: the sweep, part 2: Image ▸ Filter (105 entries), every one of them
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
  "plugin menus — paged.image, sweep: Filter",
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

    test("Image/Filter/Convert for smart filters — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Convert for smart filters");
      covers("command:media.paged.image.command.convertForSmartFilters");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Convert for smart filters",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Convert for smart filters",
        "media.paged.image.command.convertForSmartFilters",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image there is no layer to convert").toBe(
        out.before,
      );
    });

    test("Image/Filter/Blur/Gaussian blur… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Blur/Gaussian blur…");
      covers("command:media.paged.image.command.filterGaussianBlur");
      await expectGreyedAndInert(bare, "Image/Filter/Blur/Gaussian blur…");
      const out = await clickEntry(
        live,
        "Image/Filter/Blur/Gaussian blur…",
        "media.paged.image.command.filterGaussianBlur",
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

    test("Image/Filter/Pixelate/Color halftone… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Pixelate/Color halftone…");
      await expectGreyedAndInert(bare, "Image/Filter/Pixelate/Color halftone…");
      const out = await clickEntry(
        live,
        "Image/Filter/Pixelate/Color halftone…",
        "media.paged.image.command.filterColorHalftone",
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
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Film grain…",
      );
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
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Crosshatch…",
      );
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
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Bas relief…",
      );
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
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Photocopy…",
      );
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
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Texturizer…",
      );
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

    test("Image/Filter/Adjust/Selective color… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Adjust/Selective color…");
      await expectGreyedAndInert(bare, "Image/Filter/Adjust/Selective color…");
      const out = await clickEntry(
        live,
        "Image/Filter/Adjust/Selective color…",
        "media.paged.image.command.filterSelectiveColour",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Liquify… — with no image open, raises the Image panel @feat:image.editor.transform-warp", async () => {
      covers("menu:Image/Filter/Liquify…");
      covers("command:media.paged.image.command.filterLiquify");
      await expectGreyedAndInert(bare, "Image/Filter/Liquify…");
      const out = await clickEntry(
        live,
        "Image/Filter/Liquify…",
        "media.paged.image.command.filterLiquify",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter gallery… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter gallery…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter gallery…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter gallery…",
        "media.paged.image.command.filterGallery",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Distort/Displace… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Distort/Displace…");
      await expectGreyedAndInert(bare, "Image/Filter/Distort/Displace…");
      const out = await clickEntry(
        live,
        "Image/Filter/Distort/Displace…",
        "media.paged.image.command.filterDisplace",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Distort/Polar coordinates… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Distort/Polar coordinates…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Distort/Polar coordinates…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Distort/Polar coordinates…",
        "media.paged.image.command.filterPolarCoordinates",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Distort/Ripple… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Distort/Ripple…");
      await expectGreyedAndInert(bare, "Image/Filter/Distort/Ripple…");
      const out = await clickEntry(
        live,
        "Image/Filter/Distort/Ripple…",
        "media.paged.image.command.filterRipple",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Distort/Shear… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Distort/Shear…");
      await expectGreyedAndInert(bare, "Image/Filter/Distort/Shear…");
      const out = await clickEntry(
        live,
        "Image/Filter/Distort/Shear…",
        "media.paged.image.command.filterShear",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Distort/ZigZag… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Distort/ZigZag…");
      await expectGreyedAndInert(bare, "Image/Filter/Distort/ZigZag…");
      const out = await clickEntry(
        live,
        "Image/Filter/Distort/ZigZag…",
        "media.paged.image.command.filterZigzag",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Render/Clouds… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Render/Clouds…");
      await expectGreyedAndInert(bare, "Image/Filter/Render/Clouds…");
      const out = await clickEntry(
        live,
        "Image/Filter/Render/Clouds…",
        "media.paged.image.command.filterClouds",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Render/Difference clouds… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Render/Difference clouds…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Render/Difference clouds…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Render/Difference clouds…",
        "media.paged.image.command.filterDifferenceClouds",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Render/Fibers… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Render/Fibers…");
      await expectGreyedAndInert(bare, "Image/Filter/Render/Fibers…");
      const out = await clickEntry(
        live,
        "Image/Filter/Render/Fibers…",
        "media.paged.image.command.filterFibers",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Render/Lens flare… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Render/Lens flare…");
      await expectGreyedAndInert(bare, "Image/Filter/Render/Lens flare…");
      const out = await clickEntry(
        live,
        "Image/Filter/Render/Lens flare…",
        "media.paged.image.command.filterLensFlare",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Render/Lighting effects… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Render/Lighting effects…");
      await expectGreyedAndInert(bare, "Image/Filter/Render/Lighting effects…");
      const out = await clickEntry(
        live,
        "Image/Filter/Render/Lighting effects…",
        "media.paged.image.command.filterLightingEffects",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Stylize/Wind… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Stylize/Wind…");
      await expectGreyedAndInert(bare, "Image/Filter/Stylize/Wind…");
      const out = await clickEntry(
        live,
        "Image/Filter/Stylize/Wind…",
        "media.paged.image.command.filterWind",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Stylize/Extrude… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Stylize/Extrude…");
      await expectGreyedAndInert(bare, "Image/Filter/Stylize/Extrude…");
      const out = await clickEntry(
        live,
        "Image/Filter/Stylize/Extrude…",
        "media.paged.image.command.filterExtrude",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Stylize/Tiles… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Stylize/Tiles…");
      await expectGreyedAndInert(bare, "Image/Filter/Stylize/Tiles…");
      const out = await clickEntry(
        live,
        "Image/Filter/Stylize/Tiles…",
        "media.paged.image.command.filterTiles",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Stylize/Trace contour… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Stylize/Trace contour…");
      await expectGreyedAndInert(bare, "Image/Filter/Stylize/Trace contour…");
      const out = await clickEntry(
        live,
        "Image/Filter/Stylize/Trace contour…",
        "media.paged.image.command.filterTraceContour",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Pixelate/Crystallize… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Pixelate/Crystallize…");
      await expectGreyedAndInert(bare, "Image/Filter/Pixelate/Crystallize…");
      const out = await clickEntry(
        live,
        "Image/Filter/Pixelate/Crystallize…",
        "media.paged.image.command.filterCrystallize",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Pixelate/Pointillize… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Pixelate/Pointillize…");
      await expectGreyedAndInert(bare, "Image/Filter/Pixelate/Pointillize…");
      const out = await clickEntry(
        live,
        "Image/Filter/Pixelate/Pointillize…",
        "media.paged.image.command.filterPointillize",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Pixelate/Mezzotint… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Pixelate/Mezzotint…");
      await expectGreyedAndInert(bare, "Image/Filter/Pixelate/Mezzotint…");
      const out = await clickEntry(
        live,
        "Image/Filter/Pixelate/Mezzotint…",
        "media.paged.image.command.filterMezzotint",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Adjust/Shadows–highlights… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Adjust/Shadows–highlights…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Adjust/Shadows–highlights…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Adjust/Shadows–highlights…",
        "media.paged.image.command.filterShadowsHighlights",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Adjust/HDR toning… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Adjust/HDR toning…");
      await expectGreyedAndInert(bare, "Image/Filter/Adjust/HDR toning…");
      const out = await clickEntry(
        live,
        "Image/Filter/Adjust/HDR toning…",
        "media.paged.image.command.filterHdrToning",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Adjust/Match color… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Adjust/Match color…");
      await expectGreyedAndInert(bare, "Image/Filter/Adjust/Match color…");
      const out = await clickEntry(
        live,
        "Image/Filter/Adjust/Match color…",
        "media.paged.image.command.filterMatchColor",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Adjust/Replace color… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Adjust/Replace color…");
      await expectGreyedAndInert(bare, "Image/Filter/Adjust/Replace color…");
      const out = await clickEntry(
        live,
        "Image/Filter/Adjust/Replace color…",
        "media.paged.image.command.filterReplaceColor",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Adjust/Develop… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Adjust/Develop…");
      await expectGreyedAndInert(bare, "Image/Filter/Adjust/Develop…");
      const out = await clickEntry(
        live,
        "Image/Filter/Adjust/Develop…",
        "media.paged.image.command.filterDevelop",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Colored pencil… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Colored pencil…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Colored pencil…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Colored pencil…",
        "media.paged.image.command.filterColoredPencil",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Cutout… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Cutout…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Cutout…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Cutout…",
        "media.paged.image.command.filterCutout",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Dry brush… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Dry brush…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Dry brush…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Dry brush…",
        "media.paged.image.command.filterDryBrush",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Fresco… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Fresco…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Fresco…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Fresco…",
        "media.paged.image.command.filterFresco",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Neon glow… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Neon glow…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Neon glow…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Neon glow…",
        "media.paged.image.command.filterNeonGlow",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Palette knife… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Palette knife…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Palette knife…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Palette knife…",
        "media.paged.image.command.filterPaletteKnife",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Plastic wrap… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Plastic wrap…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Plastic wrap…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Plastic wrap…",
        "media.paged.image.command.filterPlasticWrap",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Rough pastels… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Rough pastels…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Rough pastels…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Rough pastels…",
        "media.paged.image.command.filterRoughPastels",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Smudge stick… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Smudge stick…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Smudge stick…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Smudge stick…",
        "media.paged.image.command.filterSmudgeStick",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Sponge… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Sponge…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Sponge…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Sponge…",
        "media.paged.image.command.filterSponge",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Underpainting… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Underpainting…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Underpainting…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Underpainting…",
        "media.paged.image.command.filterUnderpainting",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Watercolor… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Watercolor…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Watercolor…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Watercolor…",
        "media.paged.image.command.filterWatercolor",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Accented edges… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Accented edges…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Accented edges…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Accented edges…",
        "media.paged.image.command.filterAccentedEdges",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Angled strokes… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Angled strokes…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Angled strokes…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Angled strokes…",
        "media.paged.image.command.filterAngledStrokes",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Dark strokes… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Dark strokes…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Dark strokes…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Dark strokes…",
        "media.paged.image.command.filterDarkStrokes",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Ink outlines… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Ink outlines…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Ink outlines…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Ink outlines…",
        "media.paged.image.command.filterInkOutlines",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Sprayed strokes… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Sprayed strokes…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Sprayed strokes…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Sprayed strokes…",
        "media.paged.image.command.filterSprayedStrokes",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Sumi-e… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Sumi-e…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Sumi-e…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Sumi-e…",
        "media.paged.image.command.filterSumiE",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Diffuse glow… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Diffuse glow…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Diffuse glow…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Diffuse glow…",
        "media.paged.image.command.filterDiffuseGlow",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Ocean ripple… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Ocean ripple…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Ocean ripple…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Ocean ripple…",
        "media.paged.image.command.filterOceanRipple",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Chalk & charcoal… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Chalk & charcoal…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Chalk & charcoal…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Chalk & charcoal…",
        "media.paged.image.command.filterChalkCharcoal",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Charcoal… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Charcoal…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Charcoal…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Charcoal…",
        "media.paged.image.command.filterCharcoal",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Chrome… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Chrome…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Chrome…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Chrome…",
        "media.paged.image.command.filterChrome",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Conté crayon… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Conté crayon…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Conté crayon…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Conté crayon…",
        "media.paged.image.command.filterConteCrayon",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Graphic pen… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Graphic pen…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Graphic pen…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Graphic pen…",
        "media.paged.image.command.filterGraphicPen",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Note paper… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Note paper…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Note paper…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Note paper…",
        "media.paged.image.command.filterNotePaper",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Plaster… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Plaster…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Plaster…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Plaster…",
        "media.paged.image.command.filterPlaster",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Reticulation… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Reticulation…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Reticulation…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Reticulation…",
        "media.paged.image.command.filterReticulation",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Stamp… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Stamp…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Stamp…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Stamp…",
        "media.paged.image.command.filterStamp",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Torn edges… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Torn edges…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Torn edges…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Torn edges…",
        "media.paged.image.command.filterTornEdges",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Water paper… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Water paper…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Water paper…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Water paper…",
        "media.paged.image.command.filterWaterPaper",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Craquelure… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Craquelure…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Craquelure…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Craquelure…",
        "media.paged.image.command.filterCraquelure",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Grain… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Grain…");
      await expectGreyedAndInert(bare, "Image/Filter/Filter Gallery/Grain…");
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Grain…",
        "media.paged.image.command.filterGrain",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Mosaic tiles… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Mosaic tiles…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Mosaic tiles…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Mosaic tiles…",
        "media.paged.image.command.filterMosaicTiles",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Patchwork… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Patchwork…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Patchwork…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Patchwork…",
        "media.paged.image.command.filterPatchwork",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Blur gallery/Field blur… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Blur gallery/Field blur…");
      await expectGreyedAndInert(bare, "Image/Filter/Blur gallery/Field blur…");
      const out = await clickEntry(
        live,
        "Image/Filter/Blur gallery/Field blur…",
        "media.paged.image.command.filterFieldBlur",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Blur gallery/Iris blur… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Blur gallery/Iris blur…");
      await expectGreyedAndInert(bare, "Image/Filter/Blur gallery/Iris blur…");
      const out = await clickEntry(
        live,
        "Image/Filter/Blur gallery/Iris blur…",
        "media.paged.image.command.filterIrisBlur",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Blur gallery/Tilt-shift… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Blur gallery/Tilt-shift…");
      await expectGreyedAndInert(bare, "Image/Filter/Blur gallery/Tilt-shift…");
      const out = await clickEntry(
        live,
        "Image/Filter/Blur gallery/Tilt-shift…",
        "media.paged.image.command.filterTiltShift",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Blur gallery/Path blur… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Blur gallery/Path blur…");
      await expectGreyedAndInert(bare, "Image/Filter/Blur gallery/Path blur…");
      const out = await clickEntry(
        live,
        "Image/Filter/Blur gallery/Path blur…",
        "media.paged.image.command.filterPathBlur",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Blur gallery/Spin blur… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Blur gallery/Spin blur…");
      await expectGreyedAndInert(bare, "Image/Filter/Blur gallery/Spin blur…");
      const out = await clickEntry(
        live,
        "Image/Filter/Blur gallery/Spin blur…",
        "media.paged.image.command.filterSpinBlur",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Stylize/Solarize — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Stylize/Solarize");
      await expectGreyedAndInert(bare, "Image/Filter/Stylize/Solarize");
      const out = await clickEntry(
        live,
        "Image/Filter/Stylize/Solarize",
        "media.paged.image.command.solarize",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the filter changes nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Pixelate/Facet — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Pixelate/Facet");
      await expectGreyedAndInert(bare, "Image/Filter/Pixelate/Facet");
      const out = await clickEntry(
        live,
        "Image/Filter/Pixelate/Facet",
        "media.paged.image.command.facet",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the filter changes nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Adjust/Desaturate — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Adjust/Desaturate");
      await expectGreyedAndInert(bare, "Image/Filter/Adjust/Desaturate");
      const out = await clickEntry(
        live,
        "Image/Filter/Adjust/Desaturate",
        "media.paged.image.command.desaturate",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the filter changes nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Adjust/Equalize — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Adjust/Equalize");
      await expectGreyedAndInert(bare, "Image/Filter/Adjust/Equalize");
      const out = await clickEntry(
        live,
        "Image/Filter/Adjust/Equalize",
        "media.paged.image.command.equalize",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the filter changes nothing").toBe(
        out.before,
      );
    });

    test("Image/Filter/Filter Gallery/Halftone pattern… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Filter/Filter Gallery/Halftone pattern…");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Filter Gallery/Halftone pattern…",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Filter Gallery/Halftone pattern…",
        "media.paged.image.command.filterHalftone",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image the dialog opens nothing").toBe(
        out.before,
      );
    });
  },
);
