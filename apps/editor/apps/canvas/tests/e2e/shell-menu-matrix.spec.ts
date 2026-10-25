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

// The menu bar, registry-driven, in the running editor:
//
//   · INVENTORY — the host menu items the editor registers are exactly
//     the list below; a new item fails here until it is added (and so
//     covered by every test of this file);
//   · ENABLEMENT MATRIX — in each edit context (no document, a document,
//     each selection kind, a caret, inside a plugin frame, each workflow
//     mode) every rendered row's enabled/disabled state is what the
//     registry's `when` says for the live editor, and the product rules
//     hold (insert needs a document, object verbs refuse inside a frame,
//     a seam never enables);
//   · DISPATCH — clicking an enabled row runs exactly its command
//     (recorded, so a file picker or a download does not interfere);
//   · the two derived families, Window ▸ … and Plugins ▸ …, member by
//     member from the live registry.
//
// UX F-14 (object commands enabled with nothing selected) is SH-8, fixed
// (ADR 249); the View toggles' checked state is SH-4, fixed.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import {
  SHELL,
  clickMenuRow,
  domPathOf,
  enterVectorGraphic,
  isPluginCommand,
  liveMenu,
  menuFamily,
  menuRow,
  modes,
  openShell,
  readMenuBar,
  recordCommands,
  select,
  setCaret,
  setMode,
  type MenuRow,
} from "./harness/shell-surface";

const HOST_MENU = [
  "Help/Documentation",
  "Help/IDML format reference",
  "Help/Report an issue…",
  "Help/About",
  "File/Open PDF…",
  "File/Save (.paged)",
  "File/Save As IDML…",
  "Edit/Undo",
  "Edit/Redo",
  "Edit/History",
  "Edit/Cut",
  "Edit/Copy",
  "Edit/Paste",
  "Edit/Paste in place",
  "Edit/Duplicate",
  "View/Zoom in",
  "View/Zoom out",
  "View/Zoom to 100%",
  "View/Fit document",
  "View/Fit page in window",
  "View/Fit spread in window",
  "View/Fit selection in window",
  "Layout/First page",
  "Layout/Previous page",
  "Layout/Next page",
  "Layout/Last page",
  "View/Show text threads",
  "View/Snap to points",
  "View/Show heading anchors",
  "View/Show data markers",
  // Editor ADR 287.
  "View/Outline view",
  "View/Overprint Preview",
  "View/Pixel Preview",
  "View/Rotate view/15° clockwise",
  "View/Rotate view/15° counterclockwise",
  "View/Rotate view/Reset rotation",
  "View/Smart guides",
  "View/Show grid",
  "View/Snap to grid",
  "View/Show pixel grid",
  "View/Snap to pixel",
  "View/Guides & grid preferences…",
  "Edit/Select all",
  "Object/Bring to front",
  "Object/Bring forward",
  "Object/Send backward",
  "Object/Send to back",
  "Object/Group",
  "Object/Ungroup",
  "Object/Select parent group",
  "Object/Nudge left",
  "Object/Nudge right",
  "Object/Nudge up",
  "Object/Nudge down",
  "Object/Delete",
  "Object/Clipping mask/Make",
  "Object/Clipping mask/Release",
  "Object/Clipping mask/Edit contents",
  "Object/Lock",
  "Object/Unlock all on spread",
  "Object/Hide",
  "Object/Show all on spread",
  "Help/Keyboard shortcuts",
  "Object/Insert text frame",
  "Object/Insert rectangle",
  "Object/Insert ellipse",
  "Object/Insert line",
  "Object/Insert table",
  "File/Place…",
  "Layout/Add page",
  "Layout/Delete page",
  "Edit/Run command…",
  "Object/Insert field…",
  "Object/Insert hyperlink…",
  "Object/Insert anchored frame…",
  "Type/Set field value…",
  "Object/Path/Insert point…",
  "Object/Path/Remove point…",
  "Object/Path/Move point…",
  "Object/Path/Close path",
  "Object/Path/Join paths",
  "Object/Path/Outline stroke…",
  "Object/Path/Offset path…",
  "Object/Pathfinder/Keep or remove faces…",
  "Object/Type on a path/Attach…",
  "Object/Type on a path/Detach",
  "Object/Opacity mask/Make…",
  "Object/Opacity mask/Release",
  "Object/Step and repeat…",
  "Layout/Move page…",
  "Layout/New master…",
  "Object/Effects/Global light…",
  "File/Open as template…",
  "File/New document…",
  "File/New from a brief…",
  "File/Open recent",
  "File/Close",
  "File/Automate/Batch…",
  "File/Package…",
  "File/Print…",
  "Layout/Margins and columns…",
  "Layout/Ruler guides…",
  "Layout/Create guides…",
  "Layout/Numbering and section options…",
  "Type/Character…",
  "Type/Paragraph…",
  "Type/Tabs…",
  "Type/Bullets and numbering…",
  "Type/Paragraph styles",
  "Type/Character styles",
  "Type/Glyphs…",
  "Type/Text variables",
  "Object/Transform/Transform each…",
  "Object/Effects/Effects…",
  "File/Open…",
  "File/Export PDF…",
  "Help/Search commands…",
  "Data/Data sources…",
  "Data/Bindings…",
  "Data/Dataset preview…",
] as const;

const HOST_TOPS = [
  "File",
  "Edit",
  "Insert",
  "Object",
  "Type",
  "Layout",
  "View",
  "Help",
] as const;

const hostRows = (rows: MenuRow[]) =>
  rows.filter((r) => !isPluginCommand(r.command) && menuFamily(r) === null);

interface Context {
  name: string;
  doc: boolean;
  setup(page: Page): Promise<void>;
}

const CONTEXTS: Context[] = [
  { name: "no document", doc: false, setup: async () => {} },
  {
    name: "a document, nothing selected",
    doc: true,
    setup: (p) => select(p, []),
  },
  {
    name: "a frame selected",
    doc: true,
    setup: (p) => select(p, [SHELL.frame]),
  },
  {
    name: "a group selected",
    doc: true,
    setup: (p) => select(p, [SHELL.group]),
  },
  {
    name: "two items selected",
    doc: true,
    setup: (p) => select(p, [SHELL.frame, SHELL.poly]),
  },
  {
    name: "a text frame selected",
    doc: true,
    setup: (p) => select(p, [SHELL.text]),
  },
  {
    name: "a text caret",
    doc: true,
    setup: async (p) => {
      await select(p, [SHELL.text]);
      await setCaret(p);
    },
  },
  {
    name: "inside a plugin frame (vectorGraphic)",
    doc: true,
    setup: enterVectorGraphic,
  },
];

/** The rendered row for every host registry row, and the registry's
 *  verdict beside the bar's. */
async function matrixRow(page: Page) {
  const model = hostRows(await liveMenu(page));
  const dom = await readMenuBar(page, HOST_TOPS);
  // Host rows of a context menu (Data) live in Plugins ▸ <name>: walked
  // one by one, not by reading every plugin's submenu.
  for (const row of model) {
    const at = domPathOf(row);
    if (!at.startsWith("Plugins/") || dom.has(at)) continue;
    const found = await menuRow(page, at);
    if (found)
      dom.set(at, { path: at, disabled: found.disabled, kind: "item" });
  }
  return model.map((row) => {
    const at = domPathOf(row);
    const rendered = dom.get(at);
    return {
      path: row.path,
      at,
      rendered: rendered !== undefined,
      registryEnabled: row.enabled,
      barEnabled: rendered ? !rendered.disabled : null,
      seam: row.seam,
      kind: row.kind,
    };
  });
}

const enabledOf = (rows: Awaited<ReturnType<typeof matrixRow>>) =>
  new Map(rows.map((r) => [r.path, r.barEnabled]));

test.describe("the host menu bar", () => {
  test("inventory: the host items registered are exactly this spec's list", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    const live = hostRows(await liveMenu(page)).map((r) => r.path);
    expect([...live].sort()).toEqual([...HOST_MENU].sort());
  });

  for (const ctx of CONTEXTS) {
    test(`enablement matches each item's when: ${ctx.name}`, async ({
      page,
    }) => {
      covers(
        "menu:Help/Documentation",
        "menu:Help/IDML format reference",
        "menu:Help/Report an issue…",
        "menu:Help/About",
        "menu:File/Open PDF…",
        "menu:File/Save (.paged)",
        "menu:File/Save As IDML…",
        "menu:Edit/Undo",
        "menu:Edit/Redo",
        "menu:View/Zoom in",
        "menu:View/Zoom out",
        "menu:View/Zoom to 100%",
        "menu:View/Fit document",
        "menu:View/Fit page in window",
        "menu:View/Fit spread in window",
        "menu:View/Fit selection in window",
        "menu:Layout/First page",
        "menu:Layout/Previous page",
        "menu:Layout/Next page",
        "menu:Layout/Last page",
        "menu:View/Show text threads",
        "menu:View/Snap to points",
        "menu:View/Show heading anchors",
        "menu:Edit/Select all",
        "menu:Object/Bring to front",
        "menu:Object/Bring forward",
        "menu:Object/Send backward",
        "menu:Object/Send to back",
        "menu:Object/Group",
        "menu:Object/Ungroup",
        "menu:Object/Select parent group",
        "menu:Object/Nudge left",
        "menu:Object/Nudge right",
        "menu:Object/Nudge up",
        "menu:Object/Nudge down",
        "menu:Object/Delete",
        "menu:Object/Clipping mask/Make",
        "menu:Object/Clipping mask/Release",
        "menu:Object/Clipping mask/Edit contents",
        "menu:Object/Lock",
        "menu:Object/Unlock all on spread",
        "menu:Object/Hide",
        "menu:Object/Show all on spread",
        "menu:Help/Keyboard shortcuts",
        "menu:Object/Insert text frame",
        "menu:Object/Insert rectangle",
        "menu:Object/Insert ellipse",
        "menu:Object/Insert line",
        "menu:Object/Insert table",
        "menu:File/Place…",
        "menu:Layout/Add page",
        "menu:Layout/Delete page",
        "menu:Edit/Run command…",
        "menu:Object/Insert field…",
        "menu:Object/Insert hyperlink…",
        "menu:Object/Insert anchored frame…",
        "menu:Type/Set field value…",
        "menu:Object/Path/Insert point…",
        "menu:Object/Path/Remove point…",
        "menu:Object/Path/Move point…",
        "menu:Object/Path/Close path",
        "menu:Object/Path/Join paths",
        "menu:Object/Path/Outline stroke…",
        "menu:Object/Path/Offset path…",
        "menu:Object/Pathfinder/Keep or remove faces…",
        "menu:Object/Type on a path/Attach…",
        "menu:Object/Type on a path/Detach",
        "menu:Object/Opacity mask/Make…",
        "menu:Object/Opacity mask/Release",
        "menu:Object/Step and repeat…",
        "menu:Layout/Move page…",
        "menu:Layout/New master…",
        "menu:Object/Effects/Global light…",
        "menu:File/Open as template…",
        "menu:File/New document…",
        "menu:File/New from a brief…",
        "menu:File/Open recent",
        "menu:File/Close",
        "menu:File/Package…",
        "menu:File/Print…",
        "menu:Layout/Margins and columns…",
        "menu:Layout/Ruler guides…",
        "menu:Layout/Create guides…",
        "menu:Layout/Numbering and section options…",
        "menu:Type/Character…",
        "menu:Type/Paragraph…",
        "menu:Type/Tabs…",
        "menu:Type/Bullets and numbering…",
        "menu:Type/Paragraph styles",
        "menu:Type/Character styles",
        "menu:Type/Glyphs…",
        "menu:Type/Text variables",
        "menu:Object/Transform/Transform each…",
        "menu:Object/Effects/Effects…",
        "menu:File/Open…",
        "menu:File/Export PDF…",
        "menu:Help/Search commands…",
        "menu:Data/Data sources…",
        "menu:Data/Bindings…",
        "menu:Data/Dataset preview…",
      );
      await openShell(page, { doc: ctx.doc });
      await ctx.setup(page);
      const rows = await matrixRow(page);
      // Every registered host item is on the bar, where the model puts it.
      expect(rows.filter((r) => !r.rendered).map((r) => r.at)).toEqual([]);
      // The bar renders exactly the registry's verdict for the live editor.
      expect(
        rows
          .filter((r) => r.barEnabled !== r.registryEnabled)
          .map(
            (r) => `${r.path}: bar ${r.barEnabled}, when ${r.registryEnabled}`,
          ),
      ).toEqual([]);
      // Seams and labels never enable.
      expect(
        rows.filter((r) => (r.seam || r.kind === "label") && r.barEnabled),
      ).toEqual([]);

      // The product rules, per context.
      const on = enabledOf(rows);
      const needsDocument = [
        "Object/Insert text frame",
        "Object/Insert rectangle",
        "Object/Insert ellipse",
        "Object/Insert line",
        "Object/Insert table",
        "File/Place…",
        "Layout/Add page",
        "Layout/Delete page",
        "Edit/Select all",
      ];
      const objectVerbs = [
        "Object/Bring to front",
        "Object/Bring forward",
        "Object/Send backward",
        "Object/Send to back",
        "Object/Group",
        "Object/Ungroup",
        "Object/Select parent group",
        "Object/Nudge left",
        "Object/Nudge right",
        "Object/Nudge up",
        "Object/Nudge down",
        "Object/Delete",
        "Object/Clipping mask/Make",
        "Object/Clipping mask/Release",
        "Object/Clipping mask/Edit contents",
        "Object/Lock",
        "Object/Unlock all on spread",
        "Object/Hide",
        "Object/Show all on spread",
      ];
      if (!ctx.doc) {
        for (const p of needsDocument)
          expect({ p, on: on.get(p) }).toEqual({ p, on: false });
      } else if (ctx.name.startsWith("inside")) {
        for (const p of [...needsDocument, ...objectVerbs])
          expect({ p, on: on.get(p) }).toEqual({ p, on: false });
      } else {
        for (const p of needsDocument)
          expect({ p, on: on.get(p) }).toEqual({ p, on: true });
      }
      if (ctx.name === "a text caret") {
        // Delete and nudge act on the object; with a caret their keys are
        // the text's, and the menu greys where the keys go quiet.
        for (const p of [
          "Object/Delete",
          "Object/Nudge left",
          "Object/Nudge right",
          "Object/Nudge up",
          "Object/Nudge down",
        ])
          expect({ p, on: on.get(p) }).toEqual({ p, on: false });
      }
      // The ever-available items.
      for (const p of [
        "File/Open…",
        "File/New document…",
        "Help/Search commands…",
        "Help/Documentation",
        "View/Zoom in",
      ])
        expect({ p, on: on.get(p) }).toEqual({ p, on: true });
    });
  }

  test("enablement matches each item's when in every workflow mode", async ({
    page,
  }) => {
    covers(
      "menu:Help/Documentation",
      "menu:Help/IDML format reference",
      "menu:Help/Report an issue…",
      "menu:Help/About",
      "menu:File/Open PDF…",
      "menu:File/Save (.paged)",
      "menu:File/Save As IDML…",
      "menu:Edit/Undo",
      "menu:Edit/Redo",
      "menu:View/Zoom in",
      "menu:View/Zoom out",
      "menu:View/Zoom to 100%",
      "menu:View/Fit document",
      "menu:View/Fit page in window",
      "menu:View/Fit spread in window",
      "menu:View/Fit selection in window",
      "menu:Layout/First page",
      "menu:Layout/Previous page",
      "menu:Layout/Next page",
      "menu:Layout/Last page",
      "menu:View/Show text threads",
      "menu:View/Snap to points",
      "menu:View/Show heading anchors",
      "menu:Edit/Select all",
      "menu:Object/Bring to front",
      "menu:Object/Bring forward",
      "menu:Object/Send backward",
      "menu:Object/Send to back",
      "menu:Object/Group",
      "menu:Object/Ungroup",
      "menu:Object/Select parent group",
      "menu:Object/Nudge left",
      "menu:Object/Nudge right",
      "menu:Object/Nudge up",
      "menu:Object/Nudge down",
      "menu:Object/Delete",
      "menu:Object/Clipping mask/Make",
      "menu:Object/Clipping mask/Release",
      "menu:Object/Clipping mask/Edit contents",
      "menu:Object/Lock",
      "menu:Object/Unlock all on spread",
      "menu:Object/Hide",
      "menu:Object/Show all on spread",
      "menu:Help/Keyboard shortcuts",
      "menu:Object/Insert text frame",
      "menu:Object/Insert rectangle",
      "menu:Object/Insert ellipse",
      "menu:Object/Insert line",
      "menu:Object/Insert table",
      "menu:File/Place…",
      "menu:Layout/Add page",
      "menu:Layout/Delete page",
      "menu:Edit/Run command…",
      "menu:Object/Insert field…",
      "menu:Object/Insert hyperlink…",
      "menu:Object/Insert anchored frame…",
      "menu:Type/Set field value…",
      "menu:Object/Path/Insert point…",
      "menu:Object/Path/Remove point…",
      "menu:Object/Path/Move point…",
      "menu:Object/Path/Close path",
      "menu:Object/Path/Join paths",
      "menu:Object/Path/Outline stroke…",
      "menu:Object/Path/Offset path…",
      "menu:Object/Pathfinder/Keep or remove faces…",
      "menu:Object/Type on a path/Attach…",
      "menu:Object/Type on a path/Detach",
      "menu:Object/Opacity mask/Make…",
      "menu:Object/Opacity mask/Release",
      "menu:Object/Step and repeat…",
      "menu:Layout/Move page…",
      "menu:Layout/New master…",
      "menu:Object/Effects/Global light…",
      "menu:File/Open as template…",
      "menu:File/New document…",
      "menu:File/New from a brief…",
      "menu:File/Open recent",
      "menu:File/Close",
      "menu:File/Package…",
      "menu:File/Print…",
      "menu:Layout/Margins and columns…",
      "menu:Layout/Ruler guides…",
      "menu:Layout/Create guides…",
      "menu:Layout/Numbering and section options…",
      "menu:Type/Character…",
      "menu:Type/Paragraph…",
      "menu:Type/Tabs…",
      "menu:Type/Bullets and numbering…",
      "menu:Type/Paragraph styles",
      "menu:Type/Character styles",
      "menu:Type/Glyphs…",
      "menu:Type/Text variables",
      "menu:Object/Transform/Transform each…",
      "menu:Object/Effects/Effects…",
      "menu:File/Open…",
      "menu:File/Export PDF…",
      "menu:Help/Search commands…",
      "menu:Data/Data sources…",
      "menu:Data/Bindings…",
      "menu:Data/Dataset preview…",
    );
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    const all = await modes(page);
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const mode of all) {
      await setMode(page, mode);
      const rows = await matrixRow(page);
      expect({
        mode,
        missing: rows.filter((r) => !r.rendered).map((r) => r.at),
        mismatched: rows
          .filter((r) => r.barEnabled !== r.registryEnabled)
          .map((r) => r.path),
      }).toEqual({ mode, missing: [], mismatched: [] });
    }
  });

  test("clicking an enabled row runs exactly its command", async ({ page }) => {
    covers(
      "menu:Help/Documentation",
      "menu:Help/IDML format reference",
      "menu:Help/Report an issue…",
      "menu:Help/About",
      "menu:File/Open PDF…",
      "menu:File/Save (.paged)",
      "menu:File/Save As IDML…",
      "menu:Edit/Undo",
      "menu:Edit/Redo",
      "menu:View/Zoom in",
      "menu:View/Zoom out",
      "menu:View/Zoom to 100%",
      "menu:View/Fit document",
      "menu:View/Fit page in window",
      "menu:View/Fit spread in window",
      "menu:View/Fit selection in window",
      "menu:Layout/First page",
      "menu:Layout/Previous page",
      "menu:Layout/Next page",
      "menu:Layout/Last page",
      "menu:View/Show text threads",
      "menu:View/Snap to points",
      "menu:View/Show heading anchors",
      "menu:Edit/Select all",
      "menu:Object/Bring to front",
      "menu:Object/Bring forward",
      "menu:Object/Send backward",
      "menu:Object/Send to back",
      "menu:Object/Group",
      "menu:Object/Ungroup",
      "menu:Object/Select parent group",
      "menu:Object/Nudge left",
      "menu:Object/Nudge right",
      "menu:Object/Nudge up",
      "menu:Object/Nudge down",
      "menu:Object/Delete",
      "menu:Object/Clipping mask/Make",
      "menu:Object/Clipping mask/Release",
      "menu:Object/Clipping mask/Edit contents",
      "menu:Object/Lock",
      "menu:Object/Unlock all on spread",
      "menu:Object/Hide",
      "menu:Object/Show all on spread",
      "menu:Help/Keyboard shortcuts",
      "menu:Object/Insert text frame",
      "menu:Object/Insert rectangle",
      "menu:Object/Insert ellipse",
      "menu:Object/Insert line",
      "menu:Object/Insert table",
      "menu:File/Place…",
      "menu:Layout/Add page",
      "menu:Layout/Delete page",
      "menu:Edit/Run command…",
      "menu:Object/Insert field…",
      "menu:Object/Insert hyperlink…",
      "menu:Object/Insert anchored frame…",
      "menu:Type/Set field value…",
      "menu:Object/Path/Insert point…",
      "menu:Object/Path/Remove point…",
      "menu:Object/Path/Move point…",
      "menu:Object/Path/Close path",
      "menu:Object/Path/Join paths",
      "menu:Object/Path/Outline stroke…",
      "menu:Object/Path/Offset path…",
      "menu:Object/Pathfinder/Keep or remove faces…",
      "menu:Object/Type on a path/Attach…",
      "menu:Object/Type on a path/Detach",
      "menu:Object/Opacity mask/Make…",
      "menu:Object/Opacity mask/Release",
      "menu:Object/Step and repeat…",
      "menu:Layout/Move page…",
      "menu:Layout/New master…",
      "menu:Object/Effects/Global light…",
      "menu:File/Open as template…",
      "menu:File/New document…",
      "menu:File/New from a brief…",
      "menu:File/Open recent",
      "menu:File/Close",
      "menu:File/Package…",
      "menu:File/Print…",
      "menu:Layout/Margins and columns…",
      "menu:Layout/Ruler guides…",
      "menu:Layout/Create guides…",
      "menu:Layout/Numbering and section options…",
      "menu:Type/Character…",
      "menu:Type/Paragraph…",
      "menu:Type/Tabs…",
      "menu:Type/Bullets and numbering…",
      "menu:Type/Paragraph styles",
      "menu:Type/Character styles",
      "menu:Type/Glyphs…",
      "menu:Type/Text variables",
      "menu:Object/Transform/Transform each…",
      "menu:Object/Effects/Effects…",
      "menu:File/Open…",
      "menu:File/Export PDF…",
      "menu:Help/Search commands…",
      "menu:Data/Data sources…",
      "menu:Data/Bindings…",
      "menu:Data/Dataset preview…",
    );
    // An AI service answers (its proxy refuses a bare GET as anything but
    // 503): New from a brief is offered only with one (ADR 252, F-25).
    await page.route("**/api/ai/**", (route) =>
      route.fulfill({ status: 405, body: "" }),
    );
    await openShell(page, { doc: true });
    const rows = hostRows(await liveMenu(page));
    const recorder = await recordCommands(page, [
      ...new Set(rows.map((r) => r.command)),
    ]);
    const done = new Set<string>();
    // Two contexts between them enable every row that can enable (the
    // matrix shows a caret enables nothing new).
    for (const setup of [
      () => select(page, [SHELL.frame]),
      () => select(page, []),
    ]) {
      await setup();
      for (const row of hostRows(await liveMenu(page))) {
        if (done.has(row.path) || !row.enabled) continue;
        await clickMenuRow(page, domPathOf(row));
        await expect
          .poll(() => recorder.take().then((c) => c.join(",")))
          .toBe(row.command);
        done.add(row.path);
      }
    }
    await recorder.restore();
    // What never enabled is a seam or a label, nothing else.
    const never = rows.filter((r) => !done.has(r.path));
    expect(
      never.filter((r) => !r.seam && r.kind !== "label").map((r) => r.path),
    ).toEqual([]);
  });

  // Finding SH-8 (UX F-14), fixed (ADR 249): with nothing selected every
  // Object verb was enabled, and choosing one did nothing and said
  // nothing. Each command's `when` now asks for a selection and the menu
  // reads the command's `when`.
  test("SH-8 (F-14): with nothing selected, the Object verbs that need a selection are disabled", async ({
    page,
  }) => {
    covers(
      "menu:Object/Bring to front",
      "menu:Object/Group",
      "menu:Object/Ungroup",
      "menu:Object/Delete",
      "menu:Object/Nudge left",
      "menu:Object/Clipping mask/Make",
    );
    await openShell(page, { doc: true });
    await select(page, []);
    const on = enabledOf(await matrixRow(page));
    for (const p of [
      "Object/Bring to front",
      "Object/Bring forward",
      "Object/Send backward",
      "Object/Send to back",
      "Object/Group",
      "Object/Ungroup",
      "Object/Select parent group",
      "Object/Nudge left",
      "Object/Delete",
      "Object/Clipping mask/Make",
      "Object/Clipping mask/Release",
      "Object/Clipping mask/Edit contents",
      "Object/Lock",
      "Object/Hide",
    ])
      expect({ p, on: on.get(p) }).toEqual({ p, on: false });
  });

  // Finding SH-4 (fixed): the View toggles (Show text threads, Snap to
  // points, Show heading anchors) rendered as plain items with no checked
  // state; they are menuitemcheckbox rows now (`checked` on the item).
  test("SH-4: a View toggle shows its checked state", async ({ page }) => {
    covers("menu:View/Show text threads", "menu:View/Snap to points");
    await openShell(page, { doc: true });
    await page.locator('[data-menu-trigger="View"]').click();
    // Snap to points is ON by default.
    await expect(
      page.getByRole("menuitemcheckbox", { name: /Snap to points/ }),
    ).toHaveAttribute("aria-checked", "true", { timeout: 2_000 });
  });

  test("View/Show data markers toggles its checked state", async ({ page }) => {
    covers("menu:View/Show data markers");
    await openShell(page, { doc: true });
    const trigger = page.locator('[data-menu-trigger="View"]');
    const row = page.getByRole("menuitemcheckbox", {
      name: /Show data markers/,
    });
    // Open the View menu from closed: whether a click on a checkbox row
    // closes the menu is the menu's business, so close it ourselves first.
    const openView = async () => {
      await page.keyboard.press("Escape");
      await expect(row).toBeHidden();
      await trigger.click();
      await expect(row).toBeVisible();
    };
    await openView();
    // Off by default; a click turns it on, and the row shows it checked.
    await expect(row).toHaveAttribute("aria-checked", "false");
    await row.click();
    await openView();
    await expect(row).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
  });
});

test.describe("the derived menu families", () => {
  for (const family of ["Window/*", "Plugins/*"] as const) {
    test(`${family}: every member is on the bar, enabled per its when, and opens its panel`, async ({
      page,
    }) => {
      if (family === "Window/*") covers("menu:Window/*");
      else covers("menu:Plugins/*");
      await openShell(page, { doc: true });
      const all = await liveMenu(page);
      const members = all.filter((r) => menuFamily(r) === family);
      // A floor, so an empty registry cannot pass.
      expect(members.length).toBeGreaterThan(family === "Window/*" ? 40 : 10);
      // Each member shows a REGISTERED panel.
      const unregistered = await page.evaluate(
        (ids) =>
          ids.filter(
            (id) =>
              !(
                globalThis as unknown as {
                  __canvas: {
                    registries: { panels: { get(id: string): unknown } };
                  };
                }
              ).__canvas.registries.panels.get(id),
          ),
        members.map((m) => m.command.slice("paged.panel.show.".length)),
      );
      expect(unregistered).toEqual([]);
      const recorder = await recordCommands(
        page,
        members.map((m) => m.command),
      );
      const problems: string[] = [];
      for (const m of members) {
        // A plugin panel named like one of the plugin's command submenus
        // is nested into it as "<name> panel" (MenuBar's namesake rule).
        const at = domPathOf(m);
        const segs = at.split("/");
        const namesake = [...segs, `${segs[segs.length - 1]} panel`].join("/");
        // A plugin's own menu entry for the same panel wins the row (one
        // command, one row; the first contributor's label): Plugins ▸ Data
        // shows the plugin's "Data sources…" for the derived "Data sources".
        const plugin = segs[1];
        const own = all
          .filter(
            (r) =>
              r.command === m.command &&
              menuFamily(r) === null &&
              r.path.startsWith(`${plugin}/`),
          )
          .map((r) => domPathOf(r));
        let row: { disabled: boolean } | null = null;
        for (const candidate of [at, namesake, ...own]) {
          row = await menuRow(page, candidate, { click: true });
          if (row) break;
        }
        if (!row) {
          problems.push(`${m.path}: not on the bar`);
          continue;
        }
        if (row.disabled === m.enabled) {
          problems.push(
            `${m.path}: bar disabled ${row.disabled}, when ${m.enabled}`,
          );
          continue;
        }
        if (m.enabled) {
          await expect
            .poll(() => recorder.take().then((c) => c.join(",")))
            .toBe(m.command);
        }
      }
      expect(problems).toEqual([]);
      await recorder.restore();
    });
  }

  test("Window/*: inside a plugin frame, another content type's panels are not offered", async ({
    page,
  }) => {
    covers("menu:Window/*", "menu:Plugins/*");
    await openShell(page, { doc: true });
    await enterVectorGraphic(page);
    const rows = (await liveMenu(page)).filter((r) => menuFamily(r) !== null);
    // The registry's verdict per member: the panel-belongs-here rule.
    const verdicts = await page.evaluate(
      (list) => {
        const c = (
          globalThis as unknown as {
            __canvas: {
              registries: {
                editContexts: {
                  list(): Array<{ type: string; panelIds?: string[] }>;
                };
              };
            };
          }
        ).__canvas.registries;
        return list.map((cmd) => {
          const id = cmd.slice("paged.panel.show.".length);
          const claim = c.editContexts
            .list()
            .find((ec) => ec.panelIds?.includes(id));
          return { cmd, claimedBy: claim?.type ?? null };
        });
      },
      rows.map((r) => r.command),
    );
    const byCmd = new Map(verdicts.map((v) => [v.cmd, v.claimedBy]));
    for (const r of rows) {
      const claimedBy = byCmd.get(r.command);
      const offered = claimedBy === null || claimedBy === "vectorGraphic";
      expect({ path: r.path, enabled: r.enabled }).toEqual({
        path: r.path,
        enabled: offered,
      });
    }
    // At least one panel of another content type exists to be hidden.
    expect(
      verdicts.some(
        (v) => v.claimedBy !== null && v.claimedBy !== "vectorGraphic",
      ),
    ).toBe(true);
  });
});
