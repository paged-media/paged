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

// PLUGIN MENUS — paged.image's Select-menu rows of WP5.5 (selection and
// masking, image ADR 470): Color range…, Focus area…, Select and mask…,
// Quick mask, Grow, Similar, Save selection, Load selection… and Make
// work path, under Image ▸ Selection. Same state and the same per-entry
// obligations as menus-image.spec.ts: greyed and inert without a
// document; with one (and no image open) a click runs exactly its
// command, the dialog verbs raise the Image panel (where the bundle says
// an image is needed), the others change nothing.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickEntry, expectGreyedAndInert, openMenuPages } from "./menu-driver";

test.describe.serial(
  "plugin menus — paged.image selection and masking",
  { tag: ["@feat:image.selection.select-and-mask"] },
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

    test("Image/Selection/Color range… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Selection/Color range…");
      await expectGreyedAndInert(bare, "Image/Selection/Color range…");
      const out = await clickEntry(
        live,
        "Image/Selection/Color range…",
        "media.paged.image.command.colorRange",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Image/Selection/Focus area… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Selection/Focus area…");
      await expectGreyedAndInert(bare, "Image/Selection/Focus area…");
      const out = await clickEntry(
        live,
        "Image/Selection/Focus area…",
        "media.paged.image.command.focusArea",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Image/Selection/Select and mask… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Selection/Select and mask…");
      await expectGreyedAndInert(bare, "Image/Selection/Select and mask…");
      const out = await clickEntry(
        live,
        "Image/Selection/Select and mask…",
        "media.paged.image.command.selectAndMask",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Image/Selection/Quick mask — runs quickMask; with no image open it changes nothing", async () => {
      covers("menu:Image/Selection/Quick mask");
      await expectGreyedAndInert(bare, "Image/Selection/Quick mask");
      const out = await clickEntry(
        live,
        "Image/Selection/Quick mask",
        "media.paged.image.command.quickMask",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Selection/Grow — runs grow; with no image open it changes nothing", async () => {
      covers("menu:Image/Selection/Grow");
      await expectGreyedAndInert(bare, "Image/Selection/Grow");
      const out = await clickEntry(
        live,
        "Image/Selection/Grow",
        "media.paged.image.command.grow",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Selection/Similar — runs similar; with no image open it changes nothing", async () => {
      covers("menu:Image/Selection/Similar");
      await expectGreyedAndInert(bare, "Image/Selection/Similar");
      const out = await clickEntry(
        live,
        "Image/Selection/Similar",
        "media.paged.image.command.similar",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Selection/Save selection — runs saveSelection; with no image open it changes nothing", async () => {
      covers("menu:Image/Selection/Save selection");
      await expectGreyedAndInert(bare, "Image/Selection/Save selection");
      const out = await clickEntry(
        live,
        "Image/Selection/Save selection",
        "media.paged.image.command.saveSelection",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Selection/Load selection… — with no image open, raises the Image panel", async () => {
      covers("menu:Image/Selection/Load selection…");
      await expectGreyedAndInert(bare, "Image/Selection/Load selection…");
      const out = await clickEntry(
        live,
        "Image/Selection/Load selection…",
        "media.paged.image.command.loadSelection",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "opening a panel leaves the document alone").toBe(
        out.before,
      );
    });

    test("Image/Selection/Make work path — runs makeWorkPath; with no image open it changes nothing", async () => {
      covers("menu:Image/Selection/Make work path");
      await expectGreyedAndInert(bare, "Image/Selection/Make work path");
      const out = await clickEntry(
        live,
        "Image/Selection/Make work path",
        "media.paged.image.command.makeWorkPath",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });
  },
);
