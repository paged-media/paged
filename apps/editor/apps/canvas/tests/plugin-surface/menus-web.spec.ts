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

// PLUGIN MENUS — paged.web (modules/web/packages/web-bundle/src/menu.ts).
//
// Seven entries: Object ▸ Insert web frame… (filed under Insert ▸ Web
// frame…) and six under the Web menu, which the bar folds into Plugins ▸
// Web and also shows as a CONTEXT menu while a web frame is selected.
//
// The Insert test places a real web frame (and proves one Undo removes it);
// the frame is then put back and selected, and every Web verb runs against
// it. Rendering and baking need the Blitz engine, which this lane does not
// assert on; those verbs are asserted to run, which is the menu's part.
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

import { Designer } from "../journey/driver/designer";
import {
  clickEntry,
  contextRouteOf,
  expectGreyedAndInert,
  expectOneUndoRestores,
  openMenuPages,
  runCommand,
} from "./menu-driver";

test.describe.serial("plugin menus — paged.web", () => {
  let bare: Page;
  let live: Page;
  let close: () => Promise<void>;

  test.beforeAll(async ({ browser }, info) => {
    ({ bare, live, close } = await openMenuPages(browser, info.project.use));
  });
  test.afterAll(async () => {
    await close();
  });
  /** The web frame Insert ▸ Web frame… placed, selected again before each
   *  Web verb (a verb's own run may move the selection). */
  let webFrame: { kind: string; id: string } | null = null;
  const selectWebFrame = async () => {
    expect(webFrame, "the Insert test placed a web frame").not.toBeNull();
    await new Designer(live).selectElements([webFrame!]);
  };

  test("Object/Insert web frame… — Insert ▸ Web frame… places a web frame and raises its Source panel", async () => {
    covers("menu:Object/Insert web frame…");
    await expectGreyedAndInert(bare, "Object/Insert web frame…");
    const out = await clickEntry(
      live,
      "Object/Insert web frame…",
      "media.paged.web.command.insertWebFrame",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.web.panel.source" },
    ]);
    expect(out.after, "Object/Insert web frame… changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Object/Insert web frame…", out.before);
    // Put the frame back for the Web verbs below, and keep its id.
    await runCommand(live, "media.paged.web.command.insertWebFrame");
    await expect
      .poll(async () => (await new Designer(live).elementSelection()).length)
      .toBe(1);
    webFrame = (await new Designer(live).elementSelection())[0];
  });

  test("Web/Render frame — runs renderWebFrame on the selected web frame", async () => {
    covers("menu:Web/Render frame");
    await expectGreyedAndInert(bare, "Web/Render frame");
    await selectWebFrame();
    const out = await clickEntry(
      live,
      "Web/Render frame",
      "media.paged.web.command.renderWebFrame",
    );
    expect(out.shell).toEqual([]);
  });

  test("Web/Render flow across frames — runs renderWebFlow on the selected web frame", async () => {
    covers("menu:Web/Render flow across frames");
    await expectGreyedAndInert(bare, "Web/Render flow across frames");
    await selectWebFrame();
    const out = await clickEntry(
      live,
      "Web/Render flow across frames",
      "media.paged.web.command.renderWebFlow",
    );
    expect(out.shell).toEqual([]);
  });

  test("Web/Thread flow into frames — runs threadWebFlow on the selected web frame", async () => {
    covers("menu:Web/Thread flow into frames");
    await expectGreyedAndInert(bare, "Web/Thread flow into frames");
    await selectWebFrame();
    const out = await clickEntry(
      live,
      "Web/Thread flow into frames",
      "media.paged.web.command.threadWebFlow",
    );
    expect(out.shell).toEqual([]);
  });

  test("Web/Thread into named flow… — runs threadWebFlowNamed on the selected web frame", async () => {
    covers("menu:Web/Thread into named flow…");
    await expectGreyedAndInert(bare, "Web/Thread into named flow…");
    await selectWebFrame();
    const out = await clickEntry(
      live,
      "Web/Thread into named flow…",
      "media.paged.web.command.threadWebFlowNamed",
    );
    expect(out.shell).toEqual([]);
  });

  test("Web/Unthread flow — runs unthreadWebFlow on the selected web frame", async () => {
    covers("menu:Web/Unthread flow");
    await expectGreyedAndInert(bare, "Web/Unthread flow");
    await selectWebFrame();
    const out = await clickEntry(
      live,
      "Web/Unthread flow",
      "media.paged.web.command.unthreadWebFlow",
    );
    expect(out.shell).toEqual([]);
  });

  test("Web/Bake to document — runs bakeWebFrame on the selected web frame", async () => {
    covers("menu:Web/Bake to document");
    await expectGreyedAndInert(bare, "Web/Bake to document");
    await selectWebFrame();
    const out = await clickEntry(
      live,
      "Web/Bake to document",
      "media.paged.web.command.bakeWebFrame",
    );
    expect(out.shell).toEqual([]);
  });

  test("Web/Render frame — the Web CONTEXT menu sits on the bar while a web frame is selected, and runs the same command", async () => {
    covers("menu:Web/Render frame");
    await selectWebFrame();
    await expect(
      live.locator('nav[aria-label="Main menu"] [data-menu-trigger="Web"]'),
    ).toHaveAttribute("data-menu-context", "true");
    await clickEntry(
      live,
      "Web/Render frame",
      "media.paged.web.command.renderWebFrame",
      {
        route: contextRouteOf("Web/Render frame"),
      },
    );
    // Deselected, the context menu leaves the bar (Plugins ▸ Web stays).
    await new Designer(live).selectElements([]);
    await expect(
      live.locator('nav[aria-label="Main menu"] [data-menu-trigger="Web"]'),
    ).toHaveCount(0);
  });
});
