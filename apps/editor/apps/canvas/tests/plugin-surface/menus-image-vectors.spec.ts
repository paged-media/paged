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

// PLUGIN MENUS — paged.image's vector rows of WP5.11 (image ADR 476):
// Image ▸ Layer ▸ Vector mask (reveal all, hide all, current path,
// delete, enable or disable, invert, rasterize) and Image ▸ Paths (fill,
// stroke, save the work path). Same state and the same per-entry
// obligations as menus-image.spec.ts: greyed and inert without a
// document; with one (and no image open) a click runs exactly its
// command and changes nothing — Save work path also raises the Image
// panel, where the Paths section is.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickEntry, expectGreyedAndInert, openMenuPages } from "./menu-driver";

test.describe.serial(
  "plugin menus — paged.image vectors",
  { tag: ["@feat:image.paths.vectors"] },
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

    test("Image/Layer/Vector mask/Reveal all — runs vectorMaskRevealAll; with no image open it changes nothing", async () => {
      covers("menu:Image/Layer/Vector mask/Reveal all");
      await expectGreyedAndInert(bare, "Image/Layer/Vector mask/Reveal all");
      const out = await clickEntry(
        live,
        "Image/Layer/Vector mask/Reveal all",
        "media.paged.image.command.vectorMaskRevealAll",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Layer/Vector mask/Hide all — runs vectorMaskHideAll; with no image open it changes nothing", async () => {
      covers("menu:Image/Layer/Vector mask/Hide all");
      await expectGreyedAndInert(bare, "Image/Layer/Vector mask/Hide all");
      const out = await clickEntry(
        live,
        "Image/Layer/Vector mask/Hide all",
        "media.paged.image.command.vectorMaskHideAll",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Layer/Vector mask/Current path — runs vectorMaskCurrentPath; with no image open it changes nothing", async () => {
      covers("menu:Image/Layer/Vector mask/Current path");
      await expectGreyedAndInert(bare, "Image/Layer/Vector mask/Current path");
      const out = await clickEntry(
        live,
        "Image/Layer/Vector mask/Current path",
        "media.paged.image.command.vectorMaskCurrentPath",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Layer/Vector mask/Delete — runs vectorMaskDelete; with no image open it changes nothing", async () => {
      covers("menu:Image/Layer/Vector mask/Delete");
      await expectGreyedAndInert(bare, "Image/Layer/Vector mask/Delete");
      const out = await clickEntry(
        live,
        "Image/Layer/Vector mask/Delete",
        "media.paged.image.command.vectorMaskDelete",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Layer/Vector mask/Enable or disable — runs vectorMaskToggle; with no image open it changes nothing", async () => {
      covers("menu:Image/Layer/Vector mask/Enable or disable");
      await expectGreyedAndInert(
        bare,
        "Image/Layer/Vector mask/Enable or disable",
      );
      const out = await clickEntry(
        live,
        "Image/Layer/Vector mask/Enable or disable",
        "media.paged.image.command.vectorMaskToggle",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Layer/Vector mask/Invert — runs vectorMaskInvert; with no image open it changes nothing", async () => {
      covers("menu:Image/Layer/Vector mask/Invert");
      await expectGreyedAndInert(bare, "Image/Layer/Vector mask/Invert");
      const out = await clickEntry(
        live,
        "Image/Layer/Vector mask/Invert",
        "media.paged.image.command.vectorMaskInvert",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Layer/Vector mask/Rasterize — runs vectorMaskRasterize; with no image open it changes nothing", async () => {
      covers("menu:Image/Layer/Vector mask/Rasterize");
      await expectGreyedAndInert(bare, "Image/Layer/Vector mask/Rasterize");
      const out = await clickEntry(
        live,
        "Image/Layer/Vector mask/Rasterize",
        "media.paged.image.command.vectorMaskRasterize",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Paths/Fill path — runs fillPath; with no image open it changes nothing", async () => {
      covers("menu:Image/Paths/Fill path");
      await expectGreyedAndInert(bare, "Image/Paths/Fill path");
      const out = await clickEntry(
        live,
        "Image/Paths/Fill path",
        "media.paged.image.command.fillPath",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Paths/Stroke path — runs strokePath; with no image open it changes nothing", async () => {
      covers("menu:Image/Paths/Stroke path");
      await expectGreyedAndInert(bare, "Image/Paths/Stroke path");
      const out = await clickEntry(
        live,
        "Image/Paths/Stroke path",
        "media.paged.image.command.strokePath",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Paths/Save work path — runs saveWorkPath; with no image open it raises the Image panel", async () => {
      covers("menu:Image/Paths/Save work path");
      await expectGreyedAndInert(bare, "Image/Paths/Save work path");
      const out = await clickEntry(
        live,
        "Image/Paths/Save work path",
        "media.paged.image.command.saveWorkPath",
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
