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

// PLUGIN MENUS — paged.data (modules/data/packages/data-bundle/src/menu.ts).
//
// Seven entries: Object ▸ Insert data binding… (filed under Insert ▸ Data
// binding…) and six under the Data menu, which the bar folds into
// Plugins ▸ Data. The document here has no data source, so the three verbs
// that act on one (refresh, place, capture) are asserted to run and nothing
// more; their effect on a bound document is the data suite's.
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

test.describe.serial("plugin menus — paged.data", () => {
  let bare: Page;
  let live: Page;
  let close: () => Promise<void>;

  test.beforeAll(async ({ browser }, info) => {
    ({ bare, live, close } = await openMenuPages(browser, info.project.use));
  });
  test.afterAll(async () => {
    await close();
  });

  test("Object/Insert data binding… — Insert ▸ Data binding… raises the Bindings panel", async () => {
    covers("menu:Object/Insert data binding…");
    await expectGreyedAndInert(bare, "Object/Insert data binding…");
    const out = await clickEntry(
      live,
      "Object/Insert data binding…",
      "media.paged.data.command.defineBinding",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.data.panel.bindings" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Data/Data query… — raises the Query panel", async () => {
    covers("menu:Data/Data query…");
    await expectGreyedAndInert(bare, "Data/Data query…");
    const out = await clickEntry(
      live,
      "Data/Data query…",
      "media.paged.data.command.editQuery",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.data.panel.query" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Data/Refresh from sources — runs resolveBindings", async () => {
    covers("menu:Data/Refresh from sources");
    await expectGreyedAndInert(bare, "Data/Refresh from sources");
    const out = await clickEntry(
      live,
      "Data/Refresh from sources",
      "media.paged.data.command.resolveBindings",
    );
    expect(out.shell).toEqual([]);
  });

  test("Data/Place bindings on the page — runs lowerBinding", async () => {
    covers("menu:Data/Place bindings on the page");
    await expectGreyedAndInert(bare, "Data/Place bindings on the page");
    const out = await clickEntry(
      live,
      "Data/Place bindings on the page",
      "media.paged.data.command.lowerBinding",
    );
    expect(out.shell).toEqual([]);
  });

  test("Data/Merge records into the document — raises the Bindings panel to set the merge up", async () => {
    covers("menu:Data/Merge records into the document");
    await expectGreyedAndInert(bare, "Data/Merge records into the document");
    const out = await clickEntry(
      live,
      "Data/Merge records into the document",
      "media.paged.data.command.mergeRecords",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.data.panel.bindings" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Data/Capture current values as a data set — runs captureDataSet", async () => {
    covers("menu:Data/Capture current values as a data set");
    await expectGreyedAndInert(
      bare,
      "Data/Capture current values as a data set",
    );
    const out = await clickEntry(
      live,
      "Data/Capture current values as a data set",
      "media.paged.data.command.captureDataSet",
    );
    expect(out.shell).toEqual([]);
  });

  test("Data/Apply a data set… — raises the Data sets panel", async () => {
    covers("menu:Data/Apply a data set…");
    await expectGreyedAndInert(bare, "Data/Apply a data set…");
    const out = await clickEntry(
      live,
      "Data/Apply a data set…",
      "media.paged.data.command.applyDataSet",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.data.panel.dataset" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });
});
