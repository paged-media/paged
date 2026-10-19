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

// PLUGIN MENUS — paged.draw (modules/draw/packages/draw-bundle/src/menu.ts).
//
// Eighty-one entries: seventy under the Draw menu (folded into Plugins ▸
// Draw, and shown as a context menu while artwork is selected), four
// insert verbs filed under Insert (Arc…, Spiral…, Rectangular grid…, Polar
// grid…) and four under the host's Edit ▸ Select same.
//
// Every test starts from the same artwork, two overlapping filled
// rectangles with both selected (reloaded before each test), so each verb
// is judged on one known input:
//
//   · a verb that applies to it changes the document and ONE Undo takes the
//     change back (MNU-2 records the entries where it takes several);
//   · a "…" verb raises Path Options, where its parameters are set;
//   · a verb about something the artwork does not contain (a blend, a
//     repeat, a symbol instance, a pattern field, an appearance stack,
//     text) runs and changes nothing;
//   · the few whose effect on two plain rectangles is a judgement of the
//     draw suite (Blend ▸ Make, Repeat ▸ Mirror, Objects on path ▸ Make,
//     Outline stroke, Reverse path direction, Symbol ▸ Define, Select same)
//     are asserted to be reached and to run.
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
  undosToRestore,
} from "./menu-driver";

test.describe.serial("plugin menus — paged.draw", () => {
  let bare: Page;
  let live: Page;
  let close: () => Promise<void>;

  test.beforeAll(async ({ browser }, info) => {
    ({ bare, live, close } = await openMenuPages(browser, info.project.use));
    const designer = new Designer(live);
    const back = await designer.drawRectangle({
      x0: 120,
      y0: 120,
      x1: 300,
      y1: 240,
    });
    const front = await designer.drawRectangle({
      x0: 220,
      y0: 160,
      x1: 400,
      y1: 280,
    });
    await designer.applyFill("rectangle", back);
    await designer.applyFill("rectangle", front, "Color/Paper");
    pair = [
      { kind: "rectangle", id: back },
      { kind: "rectangle", id: front },
    ];
    artwork = await live.evaluate(async () =>
      Array.from(
        await (
          globalThis as unknown as {
            __canvas: { client: { exportIdml(): Promise<Uint8Array> } };
          }
        ).__canvas.client.exportIdml(),
      ),
    );
  });
  test.afterAll(async () => {
    await close();
  });
  /** The artwork most Draw verbs act on: two overlapping filled rectangles,
   *  the back one black, the front one paper. Built once through the real
   *  Rectangle tool, saved as IDML and loaded back (with both selected)
   *  before every test, so one verb's edit never becomes the next one's
   *  input. */
  let artwork: number[] = [];
  let pair: Array<{ kind: string; id: string }> = [];
  test.beforeEach(async () => {
    await live.evaluate(async (bytes) => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            registries: {
              importers: {
                resolve(name: string): {
                  import(f: {
                    name: string;
                    bytes: Uint8Array;
                    mimeType: string;
                  }): Promise<void>;
                } | null;
              };
            };
          };
        }
      ).__canvas;
      const importer = c.registries.importers.resolve("artwork.idml");
      if (!importer) throw new Error("no importer claims .idml");
      await importer.import({
        name: "artwork.idml",
        bytes: new Uint8Array(bytes),
        mimeType: "",
      });
    }, artwork);
    await live.waitForFunction(
      () =>
        (globalThis as unknown as { __canvas?: { ready?: boolean } }).__canvas
          ?.ready === true,
    );
    await new Designer(live).selectElements(pair);
  });

  test("Draw/Path/Outline stroke — runs outlineStroke", async () => {
    covers("menu:Draw/Path/Outline stroke");
    // What it does to two plain rectangles is the draw suite's concern; here: it is reached and runs.
    await expectGreyedAndInert(bare, "Draw/Path/Outline stroke");
    const out = await clickEntry(
      live,
      "Draw/Path/Outline stroke",
      "media.paged.draw.command.outlineStroke",
    );
    expect(out.shell).toEqual([]);
  });

  test("Draw/Path/Outline stroke options… — raises Path Options, where the outline is set up", async () => {
    covers("menu:Draw/Path/Outline stroke options…");
    await expectGreyedAndInert(bare, "Draw/Path/Outline stroke options…");
    const out = await clickEntry(
      live,
      "Draw/Path/Outline stroke options…",
      "media.paged.draw.command.outlineStrokeOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Draw/Path/Offset path… — raises Path Options, where the offset is set up", async () => {
    covers("menu:Draw/Path/Offset path…");
    await expectGreyedAndInert(bare, "Draw/Path/Offset path…");
    const out = await clickEntry(
      live,
      "Draw/Path/Offset path…",
      "media.paged.draw.command.offsetPathOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Draw/Path/Simplify… — raises Path Options, where the simplification is set up", async () => {
    covers("menu:Draw/Path/Simplify…");
    await expectGreyedAndInert(bare, "Draw/Path/Simplify…");
    const out = await clickEntry(
      live,
      "Draw/Path/Simplify…",
      "media.paged.draw.command.simplifyPathOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Draw/Path/Join endpoints — runs joinEndpoints; two closed rectangles have no open endpoints, so it changes nothing", async () => {
    covers("menu:Draw/Path/Join endpoints");
    await expectGreyedAndInert(bare, "Draw/Path/Join endpoints");
    const out = await clickEntry(
      live,
      "Draw/Path/Join endpoints",
      "media.paged.draw.command.joinEndpoints",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "two closed rectangles have no open endpoints").toBe(
      out.before,
    );
  });

  test("Draw/Path/Average endpoints — runs averageEndpoints; two closed rectangles have no open endpoints, so it changes nothing", async () => {
    covers("menu:Draw/Path/Average endpoints");
    await expectGreyedAndInert(bare, "Draw/Path/Average endpoints");
    const out = await clickEntry(
      live,
      "Draw/Path/Average endpoints",
      "media.paged.draw.command.averageEndpoints",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "two closed rectangles have no open endpoints").toBe(
      out.before,
    );
  });

  test("Draw/Path/Close path — runs closePath; both rectangles are already closed, so it changes nothing", async () => {
    covers("menu:Draw/Path/Close path");
    await expectGreyedAndInert(bare, "Draw/Path/Close path");
    const out = await clickEntry(
      live,
      "Draw/Path/Close path",
      "media.paged.draw.command.closePath",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "both rectangles are already closed").toBe(out.before);
  });

  test("Draw/Path/Reverse path direction — runs reversePathDirection", async () => {
    covers("menu:Draw/Path/Reverse path direction");
    // What it does to two plain rectangles is the draw suite's concern; here: it is reached and runs.
    await expectGreyedAndInert(bare, "Draw/Path/Reverse path direction");
    const out = await clickEntry(
      live,
      "Draw/Path/Reverse path direction",
      "media.paged.draw.command.reversePathDirection",
    );
    expect(out.shell).toEqual([]);
  });

  test("Draw/Transform/Reflect horizontally — reflects the selection, and one Undo takes it back", async () => {
    covers("menu:Draw/Transform/Reflect horizontally");
    await expectGreyedAndInert(bare, "Draw/Transform/Reflect horizontally");
    const out = await clickEntry(
      live,
      "Draw/Transform/Reflect horizontally",
      "media.paged.draw.command.reflectHorizontal",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Transform/Reflect horizontally changes the document",
    ).not.toBe(out.before);
    await expectOneUndoRestores(
      live,
      "Draw/Transform/Reflect horizontally",
      out.before,
    );
  });

  test("Draw/Transform/Reflect vertically — reflects the selection, and one Undo takes it back", async () => {
    covers("menu:Draw/Transform/Reflect vertically");
    await expectGreyedAndInert(bare, "Draw/Transform/Reflect vertically");
    const out = await clickEntry(
      live,
      "Draw/Transform/Reflect vertically",
      "media.paged.draw.command.reflectVertical",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Transform/Reflect vertically changes the document",
    ).not.toBe(out.before);
    await expectOneUndoRestores(
      live,
      "Draw/Transform/Reflect vertically",
      out.before,
    );
  });

  test("Draw/Transform/Reflect… — raises Path Options, where the axis is set", async () => {
    covers("menu:Draw/Transform/Reflect…");
    await expectGreyedAndInert(bare, "Draw/Transform/Reflect…");
    const out = await clickEntry(
      live,
      "Draw/Transform/Reflect…",
      "media.paged.draw.command.reflectOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Draw/Transform/Transform again — repeats the last transform on the selection, and one Undo takes the repeat back", async () => {
    covers("menu:Draw/Transform/Transform again");
    await expectGreyedAndInert(bare, "Draw/Transform/Transform again");
    // A transform to repeat: Transform again repeats the LAST one.
    await runCommand(live, "media.paged.draw.command.reflectHorizontal");
    const out = await clickEntry(
      live,
      "Draw/Transform/Transform again",
      "media.paged.draw.command.transformAgain",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Transform/Transform again changes the document",
    ).not.toBe(out.before);
    await expectOneUndoRestores(
      live,
      "Draw/Transform/Transform again",
      out.before,
    );
  });

  test("Draw/Stroke/Dashes… — raises Path Options, where the dashes are set", async () => {
    covers("menu:Draw/Stroke/Dashes…");
    await expectGreyedAndInert(bare, "Draw/Stroke/Dashes…");
    const out = await clickEntry(
      live,
      "Draw/Stroke/Dashes…",
      "media.paged.draw.command.strokeDashOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Draw/Pathfinder/Unite — unites the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Unite");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Unite");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Unite",
      "media.paged.draw.command.pathfinderUnite",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Pathfinder/Unite changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Pathfinder/Unite", out.before);
  });

  test("Draw/Pathfinder/Subtract — subtracts the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Subtract");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Subtract");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Subtract",
      "media.paged.draw.command.pathfinderSubtract",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Pathfinder/Subtract changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Pathfinder/Subtract", out.before);
  });

  test("Draw/Pathfinder/Intersect — intersects the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Intersect");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Intersect");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Intersect",
      "media.paged.draw.command.pathfinderIntersect",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Pathfinder/Intersect changes the document",
    ).not.toBe(out.before);
    await expectOneUndoRestores(live, "Draw/Pathfinder/Intersect", out.before);
  });

  test("Draw/Pathfinder/Exclude — excludes the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Exclude");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Exclude");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Exclude",
      "media.paged.draw.command.pathfinderExclude",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Pathfinder/Exclude changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Pathfinder/Exclude", out.before);
  });

  test("Draw/Pathfinder/Divide — divides the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Divide");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Divide");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Divide",
      "media.paged.draw.command.pathfinderDivide",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Pathfinder/Divide changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Pathfinder/Divide", out.before);
  });

  test("Draw/Pathfinder/Trim — trims the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Trim");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Trim");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Trim",
      "media.paged.draw.command.pathfinderTrim",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Pathfinder/Trim changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Pathfinder/Trim", out.before);
  });

  test("Draw/Pathfinder/Merge — merges the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Merge");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Merge");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Merge",
      "media.paged.draw.command.pathfinderMerge",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Pathfinder/Merge changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Pathfinder/Merge", out.before);
  });

  test("Draw/Pathfinder/Crop — crops the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Crop");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Crop");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Crop",
      "media.paged.draw.command.pathfinderCrop",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Pathfinder/Crop changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Pathfinder/Crop", out.before);
  });

  test("Draw/Pathfinder/Outline — outlines the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Outline");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Outline");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Outline",
      "media.paged.draw.command.pathfinderOutline",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Pathfinder/Outline changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Pathfinder/Outline", out.before);
  });

  test("Draw/Pathfinder/Minus back — minus backs the two rectangles, and one Undo takes it back", async () => {
    covers("menu:Draw/Pathfinder/Minus back");
    await expectGreyedAndInert(bare, "Draw/Pathfinder/Minus back");
    const out = await clickEntry(
      live,
      "Draw/Pathfinder/Minus back",
      "media.paged.draw.command.pathfinderMinusBack",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Pathfinder/Minus back changes the document",
    ).not.toBe(out.before);
    await expectOneUndoRestores(live, "Draw/Pathfinder/Minus back", out.before);
  });

  test("Draw/Compound path/Make — makes the two rectangles one compound path, and one Undo takes it back", async () => {
    covers("menu:Draw/Compound path/Make");
    await expectGreyedAndInert(bare, "Draw/Compound path/Make");
    const out = await clickEntry(
      live,
      "Draw/Compound path/Make",
      "media.paged.draw.command.makeCompoundPath",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Compound path/Make changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Compound path/Make", out.before);
  });

  test("Draw/Compound path/Release — runs releaseCompoundPath; the selection holds no compound path, so it changes nothing", async () => {
    covers("menu:Draw/Compound path/Release");
    await expectGreyedAndInert(bare, "Draw/Compound path/Release");
    const out = await clickEntry(
      live,
      "Draw/Compound path/Release",
      "media.paged.draw.command.releaseCompoundPath",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no compound path").toBe(out.before);
  });

  test("Draw/Corners/Rounded — sets the rounded corner style on the selection", async () => {
    covers("menu:Draw/Corners/Rounded");
    await expectGreyedAndInert(bare, "Draw/Corners/Rounded");
    const out = await clickEntry(
      live,
      "Draw/Corners/Rounded",
      "media.paged.draw.command.cornersRounded",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Corners/Rounded changes the document").not.toBe(
      out.before,
    );
  });

  test("MNU-2 — Draw/Corners/Rounded: one Undo takes the click back", async () => {
    test.fail(
      true,
      "MNU-2: one click on this entry is several undo steps (one per mutation the command emits, unbatched); Undo must take a menu action back in one step",
    );
    const out = await clickEntry(
      live,
      "Draw/Corners/Rounded",
      "media.paged.draw.command.cornersRounded",
    );
    expect(out.after).not.toBe(out.before);
    expect(
      await undosToRestore(live, out.before),
      "Undos it takes to take back one click on Draw/Corners/Rounded",
    ).toBe(1);
  });

  test("Draw/Corners/Inverse rounded — sets the inverse rounded corner style on the selection", async () => {
    covers("menu:Draw/Corners/Inverse rounded");
    await expectGreyedAndInert(bare, "Draw/Corners/Inverse rounded");
    const out = await clickEntry(
      live,
      "Draw/Corners/Inverse rounded",
      "media.paged.draw.command.cornersInverseRounded",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Corners/Inverse rounded changes the document",
    ).not.toBe(out.before);
  });

  test("MNU-2 — Draw/Corners/Inverse rounded: one Undo takes the click back", async () => {
    test.fail(
      true,
      "MNU-2: one click on this entry is several undo steps (one per mutation the command emits, unbatched); Undo must take a menu action back in one step",
    );
    const out = await clickEntry(
      live,
      "Draw/Corners/Inverse rounded",
      "media.paged.draw.command.cornersInverseRounded",
    );
    expect(out.after).not.toBe(out.before);
    expect(
      await undosToRestore(live, out.before),
      "Undos it takes to take back one click on Draw/Corners/Inverse rounded",
    ).toBe(1);
  });

  test("Draw/Corners/Bevel — sets the bevel corner style on the selection", async () => {
    covers("menu:Draw/Corners/Bevel");
    await expectGreyedAndInert(bare, "Draw/Corners/Bevel");
    const out = await clickEntry(
      live,
      "Draw/Corners/Bevel",
      "media.paged.draw.command.cornersBevel",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Corners/Bevel changes the document").not.toBe(
      out.before,
    );
  });

  test("MNU-2 — Draw/Corners/Bevel: one Undo takes the click back", async () => {
    test.fail(
      true,
      "MNU-2: one click on this entry is several undo steps (one per mutation the command emits, unbatched); Undo must take a menu action back in one step",
    );
    const out = await clickEntry(
      live,
      "Draw/Corners/Bevel",
      "media.paged.draw.command.cornersBevel",
    );
    expect(out.after).not.toBe(out.before);
    expect(
      await undosToRestore(live, out.before),
      "Undos it takes to take back one click on Draw/Corners/Bevel",
    ).toBe(1);
  });

  test("Draw/Corners/Fancy — sets the fancy corner style on the selection", async () => {
    covers("menu:Draw/Corners/Fancy");
    await expectGreyedAndInert(bare, "Draw/Corners/Fancy");
    const out = await clickEntry(
      live,
      "Draw/Corners/Fancy",
      "media.paged.draw.command.cornersFancy",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Corners/Fancy changes the document").not.toBe(
      out.before,
    );
  });

  test("MNU-2 — Draw/Corners/Fancy: one Undo takes the click back", async () => {
    test.fail(
      true,
      "MNU-2: one click on this entry is several undo steps (one per mutation the command emits, unbatched); Undo must take a menu action back in one step",
    );
    const out = await clickEntry(
      live,
      "Draw/Corners/Fancy",
      "media.paged.draw.command.cornersFancy",
    );
    expect(out.after).not.toBe(out.before);
    expect(
      await undosToRestore(live, out.before),
      "Undos it takes to take back one click on Draw/Corners/Fancy",
    ).toBe(1);
  });

  test("Draw/Corners/None — sets the none corner style on the selection", async () => {
    covers("menu:Draw/Corners/None");
    await expectGreyedAndInert(bare, "Draw/Corners/None");
    const out = await clickEntry(
      live,
      "Draw/Corners/None",
      "media.paged.draw.command.cornersNone",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Corners/None changes the document").not.toBe(
      out.before,
    );
  });

  test("MNU-2 — Draw/Corners/None: one Undo takes the click back", async () => {
    test.fail(
      true,
      "MNU-2: one click on this entry is several undo steps (one per mutation the command emits, unbatched); Undo must take a menu action back in one step",
    );
    const out = await clickEntry(
      live,
      "Draw/Corners/None",
      "media.paged.draw.command.cornersNone",
    );
    expect(out.after).not.toBe(out.before);
    expect(
      await undosToRestore(live, out.before),
      "Undos it takes to take back one click on Draw/Corners/None",
    ).toBe(1);
  });

  test("Draw/Repeat/Radial — makes a radial repeat of the selection, and one Undo takes it back", async () => {
    covers("menu:Draw/Repeat/Radial");
    await expectGreyedAndInert(bare, "Draw/Repeat/Radial");
    const out = await clickEntry(
      live,
      "Draw/Repeat/Radial",
      "media.paged.draw.command.makeRadialRepeat",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Repeat/Radial changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Repeat/Radial", out.before);
  });

  test("Draw/Repeat/Grid — makes a grid repeat of the selection, and one Undo takes it back", async () => {
    covers("menu:Draw/Repeat/Grid");
    await expectGreyedAndInert(bare, "Draw/Repeat/Grid");
    const out = await clickEntry(
      live,
      "Draw/Repeat/Grid",
      "media.paged.draw.command.makeGridRepeat",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Repeat/Grid changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Repeat/Grid", out.before);
  });

  test("Draw/Repeat/Mirror — runs makeMirrorRepeat", async () => {
    covers("menu:Draw/Repeat/Mirror");
    // What it does to two plain rectangles is the draw suite's concern; here: it is reached and runs.
    await expectGreyedAndInert(bare, "Draw/Repeat/Mirror");
    const out = await clickEntry(
      live,
      "Draw/Repeat/Mirror",
      "media.paged.draw.command.makeMirrorRepeat",
    );
    expect(out.shell).toEqual([]);
  });

  test("Draw/Repeat/Update — runs updateRepeat; the selection holds no repeat, so it changes nothing", async () => {
    covers("menu:Draw/Repeat/Update");
    await expectGreyedAndInert(bare, "Draw/Repeat/Update");
    const out = await clickEntry(
      live,
      "Draw/Repeat/Update",
      "media.paged.draw.command.updateRepeat",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no repeat").toBe(out.before);
  });

  test("Draw/Repeat/Expand — runs expandRepeat; the selection holds no repeat, so it changes nothing", async () => {
    covers("menu:Draw/Repeat/Expand");
    await expectGreyedAndInert(bare, "Draw/Repeat/Expand");
    const out = await clickEntry(
      live,
      "Draw/Repeat/Expand",
      "media.paged.draw.command.expandRepeat",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no repeat").toBe(out.before);
  });

  test("Draw/Repeat/Release — runs releaseRepeat; the selection holds no repeat, so it changes nothing", async () => {
    covers("menu:Draw/Repeat/Release");
    await expectGreyedAndInert(bare, "Draw/Repeat/Release");
    const out = await clickEntry(
      live,
      "Draw/Repeat/Release",
      "media.paged.draw.command.releaseRepeat",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no repeat").toBe(out.before);
  });

  test("Draw/Pattern/Make from selection — makes a pattern field from the selection, and one Undo takes it back", async () => {
    covers("menu:Draw/Pattern/Make from selection");
    await expectGreyedAndInert(bare, "Draw/Pattern/Make from selection");
    const out = await clickEntry(
      live,
      "Draw/Pattern/Make from selection",
      "media.paged.draw.command.makePatternFromSelection",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Pattern/Make from selection changes the document",
    ).not.toBe(out.before);
    await expectOneUndoRestores(
      live,
      "Draw/Pattern/Make from selection",
      out.before,
    );
  });

  test("Draw/Pattern/Edit tile field — runs editPatternField; the selection holds no pattern field, so it changes nothing", async () => {
    covers("menu:Draw/Pattern/Edit tile field");
    await expectGreyedAndInert(bare, "Draw/Pattern/Edit tile field");
    const out = await clickEntry(
      live,
      "Draw/Pattern/Edit tile field",
      "media.paged.draw.command.editPatternField",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no pattern field").toBe(out.before);
  });

  test("Draw/Pattern/Release — runs releasePatternField; the selection holds no pattern field, so it changes nothing", async () => {
    covers("menu:Draw/Pattern/Release");
    await expectGreyedAndInert(bare, "Draw/Pattern/Release");
    const out = await clickEntry(
      live,
      "Draw/Pattern/Release",
      "media.paged.draw.command.releasePatternField",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no pattern field").toBe(out.before);
  });

  test("Draw/Appearance/Add fill — adds a fill to the selection's appearance", async () => {
    covers("menu:Draw/Appearance/Add fill");
    await expectGreyedAndInert(bare, "Draw/Appearance/Add fill");
    const out = await clickEntry(
      live,
      "Draw/Appearance/Add fill",
      "media.paged.draw.command.appearanceAddFill",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Appearance/Add fill changes the document").not.toBe(
      out.before,
    );
  });

  test("MNU-2 — Draw/Appearance/Add fill: one Undo takes the click back", async () => {
    test.fail(
      true,
      "MNU-2: one click on this entry is several undo steps (one per mutation the command emits, unbatched); Undo must take a menu action back in one step",
    );
    const out = await clickEntry(
      live,
      "Draw/Appearance/Add fill",
      "media.paged.draw.command.appearanceAddFill",
    );
    expect(out.after).not.toBe(out.before);
    expect(
      await undosToRestore(live, out.before),
      "Undos it takes to take back one click on Draw/Appearance/Add fill",
    ).toBe(1);
  });

  test("Draw/Appearance/Add stroke — adds a stroke to the selection's appearance", async () => {
    covers("menu:Draw/Appearance/Add stroke");
    await expectGreyedAndInert(bare, "Draw/Appearance/Add stroke");
    const out = await clickEntry(
      live,
      "Draw/Appearance/Add stroke",
      "media.paged.draw.command.appearanceAddStroke",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Appearance/Add stroke changes the document",
    ).not.toBe(out.before);
  });

  test("MNU-2 — Draw/Appearance/Add stroke: one Undo takes the click back", async () => {
    test.fail(
      true,
      "MNU-2: one click on this entry is several undo steps (one per mutation the command emits, unbatched); Undo must take a menu action back in one step",
    );
    const out = await clickEntry(
      live,
      "Draw/Appearance/Add stroke",
      "media.paged.draw.command.appearanceAddStroke",
    );
    expect(out.after).not.toBe(out.before);
    expect(
      await undosToRestore(live, out.before),
      "Undos it takes to take back one click on Draw/Appearance/Add stroke",
    ).toBe(1);
  });

  test("Draw/Appearance/Bake — runs bakeAppearance; the rectangles carry no appearance stack, so it changes nothing", async () => {
    covers("menu:Draw/Appearance/Bake");
    await expectGreyedAndInert(bare, "Draw/Appearance/Bake");
    const out = await clickEntry(
      live,
      "Draw/Appearance/Bake",
      "media.paged.draw.command.bakeAppearance",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the rectangles carry no appearance stack").toBe(
      out.before,
    );
  });

  test("Draw/Appearance/Release — runs releaseAppearance; the rectangles carry no appearance stack, so it changes nothing", async () => {
    covers("menu:Draw/Appearance/Release");
    await expectGreyedAndInert(bare, "Draw/Appearance/Release");
    const out = await clickEntry(
      live,
      "Draw/Appearance/Release",
      "media.paged.draw.command.releaseAppearance",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the rectangles carry no appearance stack").toBe(
      out.before,
    );
  });

  test("Draw/Appearance/Clear — runs appearanceClear; the rectangles carry no appearance stack, so it changes nothing", async () => {
    covers("menu:Draw/Appearance/Clear");
    await expectGreyedAndInert(bare, "Draw/Appearance/Clear");
    const out = await clickEntry(
      live,
      "Draw/Appearance/Clear",
      "media.paged.draw.command.appearanceClear",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the rectangles carry no appearance stack").toBe(
      out.before,
    );
  });

  test("Draw/Graphic style/Save from selection — saves the selection's look as a graphic style", async () => {
    covers("menu:Draw/Graphic style/Save from selection");
    await expectGreyedAndInert(bare, "Draw/Graphic style/Save from selection");
    const out = await clickEntry(
      live,
      "Draw/Graphic style/Save from selection",
      "media.paged.draw.command.saveGraphicStyle",
    );
    expect(out.shell).toEqual([]);
    expect(
      out.after,
      "Draw/Graphic style/Save from selection changes the document",
    ).not.toBe(out.before);
  });

  test("MNU-2 — Draw/Graphic style/Save from selection: one Undo takes the click back", async () => {
    test.fail(
      true,
      "MNU-2: one click on this entry is several undo steps (one per mutation the command emits, unbatched); Undo must take a menu action back in one step",
    );
    const out = await clickEntry(
      live,
      "Draw/Graphic style/Save from selection",
      "media.paged.draw.command.saveGraphicStyle",
    );
    expect(out.after).not.toBe(out.before);
    expect(
      await undosToRestore(live, out.before),
      "Undos it takes to take back one click on Draw/Graphic style/Save from selection",
    ).toBe(1);
  });

  test("Draw/Graphic style/Apply — runs applyGraphicStyle; no graphic style is chosen, so it changes nothing", async () => {
    covers("menu:Draw/Graphic style/Apply");
    await expectGreyedAndInert(bare, "Draw/Graphic style/Apply");
    const out = await clickEntry(
      live,
      "Draw/Graphic style/Apply",
      "media.paged.draw.command.applyGraphicStyle",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "no graphic style is chosen").toBe(out.before);
  });

  test("Draw/Graphic style/Redefine — runs redefineGraphicStyle; the selection is linked to no graphic style, so it changes nothing", async () => {
    covers("menu:Draw/Graphic style/Redefine");
    await expectGreyedAndInert(bare, "Draw/Graphic style/Redefine");
    const out = await clickEntry(
      live,
      "Draw/Graphic style/Redefine",
      "media.paged.draw.command.redefineGraphicStyle",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection is linked to no graphic style").toBe(
      out.before,
    );
  });

  test("Draw/Graphic style/Break link — runs breakGraphicStyleLink; the selection is linked to no graphic style, so it changes nothing", async () => {
    covers("menu:Draw/Graphic style/Break link");
    await expectGreyedAndInert(bare, "Draw/Graphic style/Break link");
    const out = await clickEntry(
      live,
      "Draw/Graphic style/Break link",
      "media.paged.draw.command.breakGraphicStyleLink",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection is linked to no graphic style").toBe(
      out.before,
    );
  });

  test("Draw/Symbol/Define from selection — runs defineSymbol", async () => {
    covers("menu:Draw/Symbol/Define from selection");
    // A symbol is kept in the bundle's library; its use is the draw suite's concern.
    await expectGreyedAndInert(bare, "Draw/Symbol/Define from selection");
    const out = await clickEntry(
      live,
      "Draw/Symbol/Define from selection",
      "media.paged.draw.command.defineSymbol",
    );
    expect(out.shell).toEqual([]);
  });

  test("Draw/Symbol/Place instance — runs placeSymbolInstance; no symbol is chosen, so it changes nothing", async () => {
    covers("menu:Draw/Symbol/Place instance");
    await expectGreyedAndInert(bare, "Draw/Symbol/Place instance");
    const out = await clickEntry(
      live,
      "Draw/Symbol/Place instance",
      "media.paged.draw.command.placeSymbolInstance",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "no symbol is chosen").toBe(out.before);
  });

  test("Draw/Symbol/Redefine — runs redefineSymbol; the selection holds no symbol instance, so it changes nothing", async () => {
    covers("menu:Draw/Symbol/Redefine");
    await expectGreyedAndInert(bare, "Draw/Symbol/Redefine");
    const out = await clickEntry(
      live,
      "Draw/Symbol/Redefine",
      "media.paged.draw.command.redefineSymbol",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no symbol instance").toBe(
      out.before,
    );
  });

  test("Draw/Symbol/Break link — runs breakSymbolLink; the selection holds no symbol instance, so it changes nothing", async () => {
    covers("menu:Draw/Symbol/Break link");
    await expectGreyedAndInert(bare, "Draw/Symbol/Break link");
    const out = await clickEntry(
      live,
      "Draw/Symbol/Break link",
      "media.paged.draw.command.breakSymbolLink",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no symbol instance").toBe(
      out.before,
    );
  });

  test("Draw/Symbol/Reset transform — runs resetSymbolTransform; the selection holds no symbol instance, so it changes nothing", async () => {
    covers("menu:Draw/Symbol/Reset transform");
    await expectGreyedAndInert(bare, "Draw/Symbol/Reset transform");
    const out = await clickEntry(
      live,
      "Draw/Symbol/Reset transform",
      "media.paged.draw.command.resetSymbolTransform",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no symbol instance").toBe(
      out.before,
    );
  });

  test("Draw/Live paint/Make — makes a live paint group of the selection, and one Undo takes it back", async () => {
    covers("menu:Draw/Live paint/Make");
    await expectGreyedAndInert(bare, "Draw/Live paint/Make");
    const out = await clickEntry(
      live,
      "Draw/Live paint/Make",
      "media.paged.draw.command.makeLivePaintGroup",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Live paint/Make changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Live paint/Make", out.before);
  });

  test("Draw/Live paint/Regenerate — runs regenerateLivePaint; the selection holds no live paint group, so it changes nothing", async () => {
    covers("menu:Draw/Live paint/Regenerate");
    await expectGreyedAndInert(bare, "Draw/Live paint/Regenerate");
    const out = await clickEntry(
      live,
      "Draw/Live paint/Regenerate",
      "media.paged.draw.command.regenerateLivePaint",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no live paint group").toBe(
      out.before,
    );
  });

  test("Draw/Live paint/Release — runs releaseLivePaint; the selection holds no live paint group, so it changes nothing", async () => {
    covers("menu:Draw/Live paint/Release");
    await expectGreyedAndInert(bare, "Draw/Live paint/Release");
    const out = await clickEntry(
      live,
      "Draw/Live paint/Release",
      "media.paged.draw.command.releaseLivePaint",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no live paint group").toBe(
      out.before,
    );
  });

  test("Draw/Blend/Make — runs blendSelected", async () => {
    covers("menu:Draw/Blend/Make");
    // What it does to two plain rectangles is the draw suite's concern; here: it is reached and runs.
    await expectGreyedAndInert(bare, "Draw/Blend/Make");
    const out = await clickEntry(
      live,
      "Draw/Blend/Make",
      "media.paged.draw.command.blendSelected",
    );
    expect(out.shell).toEqual([]);
  });

  test("Draw/Blend/Update — runs updateBlend; the selection holds no blend, so it changes nothing", async () => {
    covers("menu:Draw/Blend/Update");
    await expectGreyedAndInert(bare, "Draw/Blend/Update");
    const out = await clickEntry(
      live,
      "Draw/Blend/Update",
      "media.paged.draw.command.updateBlend",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no blend").toBe(out.before);
  });

  test("Draw/Blend/Replace spine — runs replaceBlendSpine; the selection holds no blend, so it changes nothing", async () => {
    covers("menu:Draw/Blend/Replace spine");
    await expectGreyedAndInert(bare, "Draw/Blend/Replace spine");
    const out = await clickEntry(
      live,
      "Draw/Blend/Replace spine",
      "media.paged.draw.command.replaceBlendSpine",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no blend").toBe(out.before);
  });

  test("Draw/Blend/Reverse spine — runs reverseBlendSpine; the selection holds no blend, so it changes nothing", async () => {
    covers("menu:Draw/Blend/Reverse spine");
    await expectGreyedAndInert(bare, "Draw/Blend/Reverse spine");
    const out = await clickEntry(
      live,
      "Draw/Blend/Reverse spine",
      "media.paged.draw.command.reverseBlendSpine",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no blend").toBe(out.before);
  });

  test("Draw/Blend/Reverse front to back — runs reverseBlendFrontToBack; the selection holds no blend, so it changes nothing", async () => {
    covers("menu:Draw/Blend/Reverse front to back");
    await expectGreyedAndInert(bare, "Draw/Blend/Reverse front to back");
    const out = await clickEntry(
      live,
      "Draw/Blend/Reverse front to back",
      "media.paged.draw.command.reverseBlendFrontToBack",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no blend").toBe(out.before);
  });

  test("Draw/Blend/Expand — runs expandBlend; the selection holds no blend, so it changes nothing", async () => {
    covers("menu:Draw/Blend/Expand");
    await expectGreyedAndInert(bare, "Draw/Blend/Expand");
    const out = await clickEntry(
      live,
      "Draw/Blend/Expand",
      "media.paged.draw.command.expandBlend",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no blend").toBe(out.before);
  });

  test("Draw/Blend/Release — runs releaseBlend; the selection holds no blend, so it changes nothing", async () => {
    covers("menu:Draw/Blend/Release");
    await expectGreyedAndInert(bare, "Draw/Blend/Release");
    const out = await clickEntry(
      live,
      "Draw/Blend/Release",
      "media.paged.draw.command.releaseBlend",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no blend").toBe(out.before);
  });

  test("Draw/Objects on path/Make — runs makeObjectsOnPath", async () => {
    covers("menu:Draw/Objects on path/Make");
    // What it does to two plain rectangles is the draw suite's concern; here: it is reached and runs.
    await expectGreyedAndInert(bare, "Draw/Objects on path/Make");
    const out = await clickEntry(
      live,
      "Draw/Objects on path/Make",
      "media.paged.draw.command.makeObjectsOnPath",
    );
    expect(out.shell).toEqual([]);
  });

  test("Draw/Objects on path/Update — runs updateObjectsOnPath; the selection holds no objects-on-path group, so it changes nothing", async () => {
    covers("menu:Draw/Objects on path/Update");
    await expectGreyedAndInert(bare, "Draw/Objects on path/Update");
    const out = await clickEntry(
      live,
      "Draw/Objects on path/Update",
      "media.paged.draw.command.updateObjectsOnPath",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no objects-on-path group").toBe(
      out.before,
    );
  });

  test("Draw/Objects on path/Expand — runs expandObjectsOnPath; the selection holds no objects-on-path group, so it changes nothing", async () => {
    covers("menu:Draw/Objects on path/Expand");
    await expectGreyedAndInert(bare, "Draw/Objects on path/Expand");
    const out = await clickEntry(
      live,
      "Draw/Objects on path/Expand",
      "media.paged.draw.command.expandObjectsOnPath",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no objects-on-path group").toBe(
      out.before,
    );
  });

  test("Draw/Objects on path/Release — runs releaseObjectsOnPath; the selection holds no objects-on-path group, so it changes nothing", async () => {
    covers("menu:Draw/Objects on path/Release");
    await expectGreyedAndInert(bare, "Draw/Objects on path/Release");
    const out = await clickEntry(
      live,
      "Draw/Objects on path/Release",
      "media.paged.draw.command.releaseObjectsOnPath",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no objects-on-path group").toBe(
      out.before,
    );
  });

  test("Draw/Type on path/Attach — runs attachTextToPath; the selection holds no text frame, so it changes nothing", async () => {
    covers("menu:Draw/Type on path/Attach");
    await expectGreyedAndInert(bare, "Draw/Type on path/Attach");
    const out = await clickEntry(
      live,
      "Draw/Type on path/Attach",
      "media.paged.draw.command.attachTextToPath",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no text frame").toBe(out.before);
  });

  test("Draw/Type on path/Detach — runs detachTextFromPath; the selection holds no type on a path, so it changes nothing", async () => {
    covers("menu:Draw/Type on path/Detach");
    await expectGreyedAndInert(bare, "Draw/Type on path/Detach");
    const out = await clickEntry(
      live,
      "Draw/Type on path/Detach",
      "media.paged.draw.command.detachTextFromPath",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no type on a path").toBe(out.before);
  });

  test("Draw/Type/Create outlines — runs createOutlines; the selection holds no text, so it changes nothing", async () => {
    covers("menu:Draw/Type/Create outlines");
    await expectGreyedAndInert(bare, "Draw/Type/Create outlines");
    const out = await clickEntry(
      live,
      "Draw/Type/Create outlines",
      "media.paged.draw.command.createOutlines",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no text").toBe(out.before);
  });

  test("Draw/Opacity mask/Make — masks the back rectangle with the front one, and one Undo takes it back", async () => {
    covers("menu:Draw/Opacity mask/Make");
    await expectGreyedAndInert(bare, "Draw/Opacity mask/Make");
    const out = await clickEntry(
      live,
      "Draw/Opacity mask/Make",
      "media.paged.draw.command.makeOpacityMask",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "Draw/Opacity mask/Make changes the document").not.toBe(
      out.before,
    );
    await expectOneUndoRestores(live, "Draw/Opacity mask/Make", out.before);
  });

  test("Draw/Opacity mask/Release — runs releaseOpacityMask; the selection holds no opacity mask, so it changes nothing", async () => {
    covers("menu:Draw/Opacity mask/Release");
    await expectGreyedAndInert(bare, "Draw/Opacity mask/Release");
    const out = await clickEntry(
      live,
      "Draw/Opacity mask/Release",
      "media.paged.draw.command.releaseOpacityMask",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no opacity mask").toBe(out.before);
  });

  test("Object/Insert arc… — Insert ▸ Arc… raises Path Options, where the arc is set up", async () => {
    covers("menu:Object/Insert arc…");
    await expectGreyedAndInert(bare, "Object/Insert arc…");
    const out = await clickEntry(
      live,
      "Object/Insert arc…",
      "media.paged.draw.command.insertArcOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Object/Insert spiral… — Insert ▸ Spiral… raises Path Options, where the spiral is set up", async () => {
    covers("menu:Object/Insert spiral…");
    await expectGreyedAndInert(bare, "Object/Insert spiral…");
    const out = await clickEntry(
      live,
      "Object/Insert spiral…",
      "media.paged.draw.command.insertSpiralOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Object/Insert rectangular grid… — Insert ▸ Rectangular grid… raises Path Options, where the grid is set up", async () => {
    covers("menu:Object/Insert rectangular grid…");
    await expectGreyedAndInert(bare, "Object/Insert rectangular grid…");
    const out = await clickEntry(
      live,
      "Object/Insert rectangular grid…",
      "media.paged.draw.command.insertRectGridOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Object/Insert polar grid… — Insert ▸ Polar grid… raises Path Options, where the grid is set up", async () => {
    covers("menu:Object/Insert polar grid…");
    await expectGreyedAndInert(bare, "Object/Insert polar grid…");
    const out = await clickEntry(
      live,
      "Object/Insert polar grid…",
      "media.paged.draw.command.insertPolarGridOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Edit/Select same/Fill — runs selectSameFill", async () => {
    covers("menu:Edit/Select same/Fill");
    // It changes the selection, not the document; select-same is the draw suite's concern.
    await expectGreyedAndInert(bare, "Edit/Select same/Fill");
    const out = await clickEntry(
      live,
      "Edit/Select same/Fill",
      "media.paged.draw.command.selectSameFill",
    );
    expect(out.shell).toEqual([]);
  });

  test("Edit/Select same/Stroke — runs selectSameStroke", async () => {
    covers("menu:Edit/Select same/Stroke");
    // It changes the selection, not the document; select-same is the draw suite's concern.
    await expectGreyedAndInert(bare, "Edit/Select same/Stroke");
    const out = await clickEntry(
      live,
      "Edit/Select same/Stroke",
      "media.paged.draw.command.selectSameStroke",
    );
    expect(out.shell).toEqual([]);
  });

  test("Edit/Select same/Stroke weight — runs selectSameStrokeWeight", async () => {
    covers("menu:Edit/Select same/Stroke weight");
    // It changes the selection, not the document; select-same is the draw suite's concern.
    await expectGreyedAndInert(bare, "Edit/Select same/Stroke weight");
    const out = await clickEntry(
      live,
      "Edit/Select same/Stroke weight",
      "media.paged.draw.command.selectSameStrokeWeight",
    );
    expect(out.shell).toEqual([]);
  });

  test("Edit/Select same/Stroke weight within… — raises Path Options, where the tolerance is set", async () => {
    covers("menu:Edit/Select same/Stroke weight within…");
    await expectGreyedAndInert(bare, "Edit/Select same/Stroke weight within…");
    const out = await clickEntry(
      live,
      "Edit/Select same/Stroke weight within…",
      "media.paged.draw.command.selectSameStrokeWeightOptions",
    );
    expect(out.shell).toEqual([
      { door: "openPanel", arg: "media.paged.draw.panel.pathOptions" },
    ]);
    expect(out.after, "opening a panel leaves the document alone").toBe(
      out.before,
    );
  });

  test("Draw/Image trace… — runs imageTrace; the selection holds no placed image to trace, so it changes nothing", async () => {
    covers("menu:Draw/Image trace…");
    await expectGreyedAndInert(bare, "Draw/Image trace…");
    const out = await clickEntry(
      live,
      "Draw/Image trace…",
      "media.paged.draw.command.imageTrace",
    );
    expect(out.shell).toEqual([]);
    expect(out.after, "the selection holds no placed image to trace").toBe(
      out.before,
    );
  });

  test("Draw/Transform/Reflect horizontally — the Draw CONTEXT menu sits on the bar while artwork is selected, and runs the same command", async () => {
    covers("menu:Draw/Transform/Reflect horizontally");
    const bar = live.locator('nav[aria-label="Main menu"]');
    await expect(bar.locator('[data-menu-trigger="Draw"]')).toHaveAttribute(
      "data-menu-context",
      "true",
    );
    const out = await clickEntry(
      live,
      "Draw/Transform/Reflect horizontally",
      "media.paged.draw.command.reflectHorizontal",
      { route: contextRouteOf("Draw/Transform/Reflect horizontally") },
    );
    expect(out.after).not.toBe(out.before);
    await expectOneUndoRestores(
      live,
      "Draw/Transform/Reflect horizontally",
      out.before,
    );
    // Nothing selected, the context menu leaves the bar (Plugins ▸ Draw stays).
    await new Designer(live).selectElements([]);
    await expect(bar.locator('[data-menu-trigger="Draw"]')).toHaveCount(0);
  });
});
