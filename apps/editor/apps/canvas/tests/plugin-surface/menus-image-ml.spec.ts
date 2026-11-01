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

// PLUGIN MENUS — paged.image's Generate rows and Neural filters of WP8.2
// (image ADR 485). Same state and obligations as menus-image-masking.spec.ts:
// greyed and inert without a document; with one (and no image open) a click
// runs exactly its command. The prompt-driven verbs (generate, fill,
// expand) raise the Image panel, where the prompt is typed; the others
// change nothing.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickEntry, expectGreyedAndInert, openMenuPages } from "./menu-driver";

test.describe.serial(
  "plugin menus — paged.image generate and neural filters",
  { tag: ["@feat:image.ml.generate-image"] },
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

    test("Image/Generate/Generate image… — raises the Image panel for the prompt", async () => {
      covers("menu:Image/Generate/Generate image…");
      await expectGreyedAndInert(bare, "Image/Generate/Generate image…");
      const out = await clickEntry(
        live,
        "Image/Generate/Generate image…",
        "media.paged.image.command.generateImage",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Generate/Generative fill… — raises the Image panel for the prompt", async () => {
      covers("menu:Image/Generate/Generative fill…");
      await expectGreyedAndInert(bare, "Image/Generate/Generative fill…");
      const out = await clickEntry(
        live,
        "Image/Generate/Generative fill…",
        "media.paged.image.command.generativeFill",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Generate/Generative expand… — raises the Image panel for the prompt", async () => {
      covers("menu:Image/Generate/Generative expand…");
      await expectGreyedAndInert(bare, "Image/Generate/Generative expand…");
      const out = await clickEntry(
        live,
        "Image/Generate/Generative expand…",
        "media.paged.image.command.generativeExpand",
      );
      expect(out.shell).toEqual([
        { door: "openPanel", arg: "media.paged.image.panel.adjustments" },
      ]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Generate/Remove selection — runs removeHq; with no image open it changes nothing", async () => {
      covers("menu:Image/Generate/Remove selection");
      await expectGreyedAndInert(bare, "Image/Generate/Remove selection");
      const out = await clickEntry(
        live,
        "Image/Generate/Remove selection",
        "media.paged.image.command.removeHq",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Generate/Remove background — runs removeBackground; with no image open it changes nothing", async () => {
      covers("menu:Image/Generate/Remove background");
      await expectGreyedAndInert(bare, "Image/Generate/Remove background");
      const out = await clickEntry(
        live,
        "Image/Generate/Remove background",
        "media.paged.image.command.removeBackground",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Generate/Sky replacement — runs skyReplacement; with no image open it changes nothing", async () => {
      covers("menu:Image/Generate/Sky replacement");
      await expectGreyedAndInert(bare, "Image/Generate/Sky replacement");
      const out = await clickEntry(
        live,
        "Image/Generate/Sky replacement",
        "media.paged.image.command.skyReplacement",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Generate/Colorize — runs colorize; with no image open it changes nothing", async () => {
      covers("menu:Image/Generate/Colorize");
      await expectGreyedAndInert(bare, "Image/Generate/Colorize");
      const out = await clickEntry(
        live,
        "Image/Generate/Colorize",
        "media.paged.image.command.colorize",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Generate/Skin smoothing — runs skinSmoothing; with no image open it changes nothing", async () => {
      covers("menu:Image/Generate/Skin smoothing");
      await expectGreyedAndInert(bare, "Image/Generate/Skin smoothing");
      const out = await clickEntry(
        live,
        "Image/Generate/Skin smoothing",
        "media.paged.image.command.skinSmoothing",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Filter/Neural filters/Super zoom — runs superZoom; with no image open it changes nothing", async () => {
      covers("menu:Image/Filter/Neural filters/Super zoom");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Neural filters/Super zoom",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Neural filters/Super zoom",
        "media.paged.image.command.superZoom",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });

    test("Image/Filter/Neural filters/JPEG artifact removal — runs jpegArtifacts; with no image open it changes nothing", async () => {
      covers("menu:Image/Filter/Neural filters/JPEG artifact removal");
      await expectGreyedAndInert(
        bare,
        "Image/Filter/Neural filters/JPEG artifact removal",
      );
      const out = await clickEntry(
        live,
        "Image/Filter/Neural filters/JPEG artifact removal",
        "media.paged.image.command.jpegArtifacts",
      );
      expect(out.shell).toEqual([]);
      expect(out.after, "with no image open there is nothing to act on").toBe(
        out.before,
      );
    });
  },
);
