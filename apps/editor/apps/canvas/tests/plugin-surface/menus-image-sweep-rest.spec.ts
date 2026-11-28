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
// THIS FILE: the sweep, part 3: the rest of the Image menu and the Edit entries (44 entries), every one of them
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
  "plugin menus — paged.image, sweep: the rest",
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

    test("Image/Selection/From luminosity channel — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Selection/From luminosity channel");
      await expectGreyedAndInert(
        bare,
        "Image/Selection/From luminosity channel",
      );
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

    test("Image/Fill/Foreground color — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Fill/Foreground color");
      await expectGreyedAndInert(bare, "Image/Fill/Foreground color");
      const out = await clickEntry(
        live,
        "Image/Fill/Foreground color",
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

    test("Image/Mode/Greyscale — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/Greyscale");
      await expectGreyedAndInert(bare, "Image/Mode/Greyscale");
      const out = await clickEntry(
        live,
        "Image/Mode/Greyscale",
        "media.paged.image.command.modeGray",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Mode/RGB color — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/RGB color");
      await expectGreyedAndInert(bare, "Image/Mode/RGB color");
      const out = await clickEntry(
        live,
        "Image/Mode/RGB color",
        "media.paged.image.command.modeRgb",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Mode/CMYK color — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/CMYK color");
      await expectGreyedAndInert(bare, "Image/Mode/CMYK color");
      const out = await clickEntry(
        live,
        "Image/Mode/CMYK color",
        "media.paged.image.command.modeCmyk",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Mode/Lab color — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/Lab color");
      await expectGreyedAndInert(bare, "Image/Mode/Lab color");
      const out = await clickEntry(
        live,
        "Image/Mode/Lab color",
        "media.paged.image.command.modeLab",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Mode/Indexed color… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/Indexed color…");
      await expectGreyedAndInert(bare, "Image/Mode/Indexed color…");
      const out = await clickEntry(
        live,
        "Image/Mode/Indexed color…",
        "media.paged.image.command.modeIndexed",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Mode/Multichannel — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/Multichannel");
      await expectGreyedAndInert(bare, "Image/Mode/Multichannel");
      const out = await clickEntry(
        live,
        "Image/Mode/Multichannel",
        "media.paged.image.command.modeMultichannel",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Mode/8 bits per channel — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/8 bits per channel");
      await expectGreyedAndInert(bare, "Image/Mode/8 bits per channel");
      const out = await clickEntry(
        live,
        "Image/Mode/8 bits per channel",
        "media.paged.image.command.modeBits8",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Mode/16 bits per channel — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/16 bits per channel");
      await expectGreyedAndInert(bare, "Image/Mode/16 bits per channel");
      const out = await clickEntry(
        live,
        "Image/Mode/16 bits per channel",
        "media.paged.image.command.modeBits16",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Mode/32 bits per channel — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Mode/32 bits per channel");
      await expectGreyedAndInert(bare, "Image/Mode/32 bits per channel");
      const out = await clickEntry(
        live,
        "Image/Mode/32 bits per channel",
        "media.paged.image.command.modeBits32",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Proof/Proof colors — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Proof/Proof colors");
      await expectGreyedAndInert(bare, "Image/Proof/Proof colors");
      const out = await clickEntry(
        live,
        "Image/Proof/Proof colors",
        "media.paged.image.command.proofColors",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Proof/Gamut warning — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Proof/Gamut warning");
      await expectGreyedAndInert(bare, "Image/Proof/Gamut warning");
      const out = await clickEntry(
        live,
        "Image/Proof/Gamut warning",
        "media.paged.image.command.gamutWarning",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Proof/Working CMYK — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Proof/Working CMYK");
      await expectGreyedAndInert(bare, "Image/Proof/Working CMYK");
      const out = await clickEntry(
        live,
        "Image/Proof/Working CMYK",
        "media.paged.image.command.proofSetupCmyk",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
        out.before,
      );
    });

    test("Image/Proof/Working grey — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Proof/Working grey");
      await expectGreyedAndInert(bare, "Image/Proof/Working grey");
      const out = await clickEntry(
        live,
        "Image/Proof/Working grey",
        "media.paged.image.command.proofSetupGray",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image, the document is untouched").toBe(
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

    // WP5.10 — type layers. Like the Layer menu's verbs each raises the Image
    // panel (Warp text's controls live there); with no image there is no type
    // layer to act on.
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

    test("Image/File/Export as… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/File/Export as…");
      await expectGreyedAndInert(bare, "Image/File/Export as…");
      const out = await clickEntry(
        live,
        "Image/File/Export as…",
        "media.paged.image.command.exportAs",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Edit/Free transform — with no image open, raises the Image panel @feat:image.editor.transform-warp", async () => {
      covers("menu:Edit/Free transform");
      covers("command:media.paged.image.command.freeTransform");
      await expectGreyedAndInert(bare, "Edit/Free transform");
      const out = await clickEntry(
        live,
        "Edit/Free transform",
        "media.paged.image.command.freeTransform",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Edit/Transform/Free distort — with no image open, raises the Image panel @feat:image.editor.transform-warp", async () => {
      covers("menu:Edit/Transform/Free distort");
      covers("command:media.paged.image.command.transformDistort");
      await expectGreyedAndInert(bare, "Edit/Transform/Free distort");
      const out = await clickEntry(
        live,
        "Edit/Transform/Free distort",
        "media.paged.image.command.transformDistort",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Edit/Transform/Perspective — with no image open, raises the Image panel @feat:image.editor.transform-warp", async () => {
      covers("menu:Edit/Transform/Perspective");
      covers("command:media.paged.image.command.transformPerspective");
      await expectGreyedAndInert(bare, "Edit/Transform/Perspective");
      const out = await clickEntry(
        live,
        "Edit/Transform/Perspective",
        "media.paged.image.command.transformPerspective",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Edit/Transform/Warp… — with no image open, raises the Image panel @feat:image.editor.transform-warp", async () => {
      covers("menu:Edit/Transform/Warp…");
      covers("command:media.paged.image.command.transformWarp");
      await expectGreyedAndInert(bare, "Edit/Transform/Warp…");
      const out = await clickEntry(
        live,
        "Edit/Transform/Warp…",
        "media.paged.image.command.transformWarp",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Edit/Puppet warp… — with no image open, raises the Image panel @feat:image.editor.transform-warp", async () => {
      covers("menu:Edit/Puppet warp…");
      covers("command:media.paged.image.command.puppetWarp");
      await expectGreyedAndInert(bare, "Edit/Puppet warp…");
      const out = await clickEntry(
        live,
        "Edit/Puppet warp…",
        "media.paged.image.command.puppetWarp",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Edit/Content-aware scale… — with no image open, raises the Image panel @feat:image.editor.transform-warp", async () => {
      covers("menu:Edit/Content-aware scale…");
      covers("command:media.paged.image.command.contentAwareScale");
      await expectGreyedAndInert(bare, "Edit/Content-aware scale…");
      const out = await clickEntry(
        live,
        "Edit/Content-aware scale…",
        "media.paged.image.command.contentAwareScale",
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

    // ── the brush engine (WP5.7) ──────────────────────────────────────

    test("Edit/Content-aware fill… — with no image open, raises the Image panel", async () => {
      covers("menu:Edit/Content-aware fill…");
      await expectGreyedAndInert(bare, "Edit/Content-aware fill…");
      const out = await clickEntry(
        live,
        "Edit/Content-aware fill…",
        "media.paged.image.command.contentAwareFillWorkspace",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });
  },
);
