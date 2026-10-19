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
// Thirty-six entries: thirty-four under the Image menu (folded into
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

  test("Image/Filter/Median — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Median");
    await expectGreyedAndInert(bare, "Image/Filter/Median");
    const out = await clickEntry(
      live,
      "Image/Filter/Median",
      "media.paged.image.command.median",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Filter/Maximum — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Maximum");
    await expectGreyedAndInert(bare, "Image/Filter/Maximum");
    const out = await clickEntry(
      live,
      "Image/Filter/Maximum",
      "media.paged.image.command.maximum",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Filter/Minimum — with no image open, raises the Image panel", async () => {
    covers("menu:Image/Filter/Minimum");
    await expectGreyedAndInert(bare, "Image/Filter/Minimum");
    const out = await clickEntry(
      live,
      "Image/Filter/Minimum",
      "media.paged.image.command.minimum",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
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
