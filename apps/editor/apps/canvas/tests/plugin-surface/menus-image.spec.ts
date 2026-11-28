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
// THIS FILE: the pass every push runs. One entry of the common kind (the
// 221 that raise the Image panel when no image is open) and every entry
// that does something else: 23 in all. The other 220 are asserted the same
// way in menus-image-sweep-{layer,filter,rest}.spec.ts, tagged @nightly.

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

  test("Image/Type/Warp text… — raises the Image panel (its Warp text section)", async () => {
    covers("menu:Image/Type/Warp text…");
    covers("command:media.paged.image.command.warpText");
    await expectGreyedAndInert(bare, "Image/Type/Warp text…");
    const out = await clickEntry(
      live,
      "Image/Type/Warp text…",
      "media.paged.image.command.warpText",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Image/Type/Rasterize type layer — raises the Image panel; with no type layer it changes nothing", async () => {
    covers("menu:Image/Type/Rasterize type layer");
    covers("command:media.paged.image.command.rasterizeType");
    await expectGreyedAndInert(bare, "Image/Type/Rasterize type layer");
    const out = await clickEntry(
      live,
      "Image/Type/Rasterize type layer",
      "media.paged.image.command.rasterizeType",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image open there is nothing to act on").toBe(
      out.before,
    );
  });

  test("Image/Type/Paint text into layer — raises the Image panel; with no image open it changes nothing", async () => {
    covers("menu:Image/Type/Paint text into layer");
    covers("command:media.paged.image.command.paintTextIntoLayer");
    await expectGreyedAndInert(bare, "Image/Type/Paint text into layer");
    const out = await clickEntry(
      live,
      "Image/Type/Paint text into layer",
      "media.paged.image.command.paintTextIntoLayer",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after, "with no image open there is nothing to act on").toBe(
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

  // Image ADR 477 — snapshots, History Options and the Preset Manager.
  test("Image/History/New snapshot — with no image open, takes none and leaves the document alone", async () => {
    covers("menu:Image/History/New snapshot");
    await expectGreyedAndInert(bare, "Image/History/New snapshot");
    const out = await clickEntry(
      live,
      "Image/History/New snapshot",
      "media.paged.image.command.newSnapshot",
    );
    expect(out.shell).toEqual([]);
    expect(out.after).toBe(out.before);
  });

  test("Image/History/History options… — raises the Image panel, where the dialog opens", async () => {
    covers("menu:Image/History/History options…");
    await expectGreyedAndInert(bare, "Image/History/History options…");
    const out = await clickEntry(
      live,
      "Image/History/History options…",
      "media.paged.image.command.historyOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
    ]);
    expect(out.after).toBe(out.before);
  });

  test("Image/Presets/Preset manager… — raises the Image panel, where the dialog opens", async () => {
    covers("menu:Image/Presets/Preset manager…");
    await expectGreyedAndInert(bare, "Image/Presets/Preset manager…");
    const out = await clickEntry(
      live,
      "Image/Presets/Preset manager…",
      "media.paged.image.command.presetManager",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
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

  test("Image/Apply perspective crop — runs commitPerspectiveCrop; with no quad drawn it changes nothing @feat:image.editor.transform-warp", async () => {
    covers("menu:Image/Apply perspective crop");
    covers("command:media.paged.image.command.commitPerspectiveCrop");
    await expectGreyedAndInert(bare, "Image/Apply perspective crop");
    const out = await clickEntry(
      live,
      "Image/Apply perspective crop",
      "media.paged.image.command.commitPerspectiveCrop",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "with no quad there is nothing to act on").toBe(
      out.before,
    );
  });

  test("Image/Brush/Brush settings — raises the Brush Settings panel", async () => {
    covers("menu:Image/Brush/Brush settings");
    await expectGreyedAndInert(bare, "Image/Brush/Brush settings");
    const out = await clickEntry(
      live,
      "Image/Brush/Brush settings",
      "media.paged.image.command.openBrushSettings",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.brushSettings" },
    ]);
    expect(out.after).toBe(out.before);
  });

  test("Image/Brush/Brush presets — raises the Brush Presets panel", async () => {
    covers("menu:Image/Brush/Brush presets");
    await expectGreyedAndInert(bare, "Image/Brush/Brush presets");
    const out = await clickEntry(
      live,
      "Image/Brush/Brush presets",
      "media.paged.image.command.openBrushPresets",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.brushPresets" },
    ]);
    expect(out.after).toBe(out.before);
  });

  test("Image/Brush/Define brush preset… — with no image open, raises the presets panel and defines nothing", async () => {
    covers("menu:Image/Brush/Define brush preset…");
    await expectGreyedAndInert(bare, "Image/Brush/Define brush preset…");
    const out = await clickEntry(
      live,
      "Image/Brush/Define brush preset…",
      "media.paged.image.command.defineBrushPreset",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.brushPresets" },
    ]);
    expect(out.after).toBe(out.before);
  });

  test("Image/Brush/Import brush presets… — raises the presets panel and asks for an .abr or .json", async () => {
    covers("menu:Image/Brush/Import brush presets…");
    await expectGreyedAndInert(bare, "Image/Brush/Import brush presets…");
    const out = await clickEntry(
      live,
      "Image/Brush/Import brush presets…",
      "media.paged.image.command.importBrushPresets",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.brushPresets" },
      { door: "pickFile", arg: '{"accept":[".abr",".json"]}' },
    ]);
    expect(out.after).toBe(out.before);
  });

  test("Image/Brush/Export brush presets (.abr)… — saves brush-presets.abr", async () => {
    covers("menu:Image/Brush/Export brush presets (.abr)…");
    await expectGreyedAndInert(
      bare,
      "Image/Brush/Export brush presets (.abr)…",
    );
    const out = await clickEntry(
      live,
      "Image/Brush/Export brush presets (.abr)…",
      "media.paged.image.command.exportBrushPresetsAbr",
    );
    expect(out.shell).toEqual([
      { door: "saveFile", arg: '{"suggestedName":"brush-presets.abr"}' },
    ]);
    expect(out.after).toBe(out.before);
  });

  test("Image/Brush/Export brush presets (.json)… — saves brush-presets.json", async () => {
    covers("menu:Image/Brush/Export brush presets (.json)…");
    await expectGreyedAndInert(
      bare,
      "Image/Brush/Export brush presets (.json)…",
    );
    const out = await clickEntry(
      live,
      "Image/Brush/Export brush presets (.json)…",
      "media.paged.image.command.exportBrushPresetsJson",
    );
    expect(out.shell).toEqual([
      { door: "saveFile", arg: '{"suggestedName":"brush-presets.json"}' },
    ]);
    expect(out.after).toBe(out.before);
  });

  test("Image/Brush/Lock transparent pixels — runs toggleLockTransparent and leaves the document alone", async () => {
    covers("menu:Image/Brush/Lock transparent pixels");
    await expectGreyedAndInert(bare, "Image/Brush/Lock transparent pixels");
    const out = await clickEntry(
      live,
      "Image/Brush/Lock transparent pixels",
      "media.paged.image.command.toggleLockTransparent",
    );
    expect(out.shell).toEqual([]);
    expect(out.after).toBe(out.before);
  });

  // WP5.8 — Edit ▸ Content-Aware Fill… and Image ▸ Clone source.
  test("Image/Clone source — raises the Clone Source panel", async () => {
    covers("menu:Image/Clone source");
    await expectGreyedAndInert(bare, "Image/Clone source");
    const out = await clickEntry(
      live,
      "Image/Clone source",
      "media.paged.image.command.openCloneSource",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.image.panel.cloneSource" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });
});
