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

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
import { REPO_ROOT } from "./harness/fixtures";

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
  "View/Editing aids/Text threads",
  "View/Snap to points",
  "View/Show heading anchors",
  // Editor ADR 1223.
  "View/Show issue markers",
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
  "Edit/Find…",
  "Edit/Find and replace…",
  "Edit/Find next",
  "Edit/Find previous",
  "Edit/Go to page…",
  // Editor ADR 290 — the ML service's Models settings page.
  "Edit/Settings/Models…",
  // ADR 1201 D-03 — the opt-in "Tab hides panels (InDesign)".
  "Edit/Settings/Tab hides panels (InDesign)",
  // Editor ADRs 1208 and 1209 — the workspace's switch, the density
  // presets and the Focus workspace.
  "Edit/Settings/Adapt the workspace to the window",
  "Edit/Settings/Interface density/Comfortable",
  "Edit/Settings/Interface density/Professional",
  "Edit/Settings/Interface density/Compact",
  "View/Focus workspace",
  // Editor ADR 1211 — the named views beside 100 %, the calibration, and
  // Back / Forward through the navigation history.
  "View/Actual size",
  "View/Calibrated size",
  "View/Calibrate screen size…",
  "Layout/Go back",
  "Layout/Go forward",
  // Editor ADR "Editing aids and Proof view".
  "View/Proof view",
  "View/Editing aids/Frame edges",
  "View/Editing aids/Margins and columns",
  "View/Editing aids/Ruler guides",
  "View/Editing aids/Baseline grid",
  "View/Editing aids/Overset markers",
  "View/Editing aids/Hidden characters",
  "View/Editing aids/Nonprinting items",
  "View/Editing aids/Data bindings",
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
  "Object/Insert star…",
  "Object/Insert barcode…",
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
  "Object/Pathfinder/Unite",
  "Object/Pathfinder/Subtract",
  "Object/Pathfinder/Intersect",
  "Object/Pathfinder/Exclude",
  "Object/Pathfinder/Divide",
  "Object/Pathfinder/Trim",
  "Object/Pathfinder/Merge",
  "Object/Pathfinder/Crop",
  "Object/Pathfinder/Outline",
  "Object/Pathfinder/Minus back",
  "Object/Pathfinder/Keep or remove faces…",
  "Object/Type on a path/Attach…",
  "Object/Type on a path/Detach",
  "Object/Corners/Rounded",
  "Object/Corners/Inverse rounded",
  "Object/Corners/Bevel",
  "Object/Corners/Fancy",
  "Object/Corners/None",
  "Object/Appearance/Add fill",
  "Object/Appearance/Add stroke",
  "Object/Appearance/Clear",
  "Object/Stroke/Dashes…",
  "Object/Opacity mask/Make…",
  "Object/Opacity mask/Release",
  "Object/Step and repeat…",
  "Layout/Move page…",
  "Layout/New master…",
  "Object/Effects/Global light…",
  "Object/Generate image…",
  "File/Open as template…",
  "File/New document…",
  "File/New from a brief…",
  "File/Open recent…",
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
  // The reference inserts (paged.insert.*, editor ADR 315).
  "Type/Insert footnote",
  "Type/Insert endnote",
  "Type/Insert bookmark…",
  "Type/Insert cross-reference…",
  "Type/New index entry…",
  // The text-format verbs (paged.text.*, 1867d9152).
  "Type/Format/Bold",
  "Type/Format/Italic",
  "Type/Format/Underline",
  "Type/Format/Strikethrough",
  "Type/Format/Subscript",
  "Type/Format/Superscript",
  "Type/Format/All caps",
  "Type/Format/Small caps",
  "Type/Format/Increase font size",
  "Type/Format/Decrease font size",
  "Type/Format/Align left",
  "Type/Format/Align center",
  "Type/Format/Align right",
  "Type/Format/Justify",
  "Type/Format/Increase indent",
  "Type/Format/Decrease indent",
  "Type/Format/Line spacing 1",
  "Type/Format/Line spacing 1.5",
  "Type/Format/Line spacing 2",
  "Type/Format/Increase leading",
  "Type/Format/Decrease leading",
  "Type/Format/Increase tracking",
  "Type/Format/Decrease tracking",
  "Object/Transform/Transform each…",
  "Object/Transform/Reflect horizontally",
  "Object/Transform/Reflect vertically",
  "Object/Transform/Reflect…",
  "Object/Transform/Transform again",
  "Object/Effects/Effects…",
  "Object/Effects/Picture adjustments…",
  "File/Open…",
  "File/Export PDF…",
  "File/Import/SVG…",
  "File/Export/SVG (page)…",
  "File/Export/SVG (selection)…",
  "File/Export/Asset Export…",
  "Object/Collect for Export/As Single Asset",
  "Object/Collect for Export/As Multiple Assets",
  "Help/Search commands…",
  "Data/Data sources…",
  "Data/Bindings…",
  "Data/Dataset preview…",
  // Editor ADR 309 — the Transparency and Appearance panels beside Effects….
  "Object/Effects/Transparency…",
  "Object/Effects/Appearance…",
  // …and Object ▸ Effects ▸ <group> ▸ <effect>, one row per kind core's
  // catalog describes (EFFECT_ROWS below).
] as const;

/** The Effect menu's rows: one per core effect kind (effect-menu.ts). */
const EFFECT_ROWS: readonly string[] = (
  JSON.parse(
    readFileSync(
      join(
        REPO_ROOT,
        "../../platform/extensions/packages/plugin-api/src/catalog.json",
      ),
      "utf8",
    ),
  ) as {
    effectKinds: Array<{
      title: string;
      category: string;
      strokeStyle?: boolean;
      indesign: boolean;
      vector?: boolean;
      params: unknown[];
    }>;
  }
).effectKinds
  // The stroke styles (engine ADR 1053) have no Effect menu row, nor has a
  // kind without parameters to set (effect-stack.ts `offered`: a layer
  // style's pattern overlay, engine ADR 1099).
  .filter(
    (k) =>
      !k.strokeStyle &&
      (k.indesign || k.vector === true || k.params.length > 0),
  )
  .map(
    (k) =>
      `Object/Effects/${
        (
          {
            stylize: "Stylize",
            blur: "Blur",
            noise: "Noise",
            color: "Color",
            distortAndTransform: "Distort & Transform",
            path: "Path",
            pathfinder: "Pathfinder",
            warp: "Warp",
            convertToShape: "Convert to Shape",
            rasterize: "Rasterize",
          } as Record<string, string>
        )[k.category] ?? k.category
      }/${k.title}`,
  );

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

/** The unit a row is dispatched in: Object ▸ Effects ▸ <group> rows are most
 *  of the bar and one test each, every other row goes with its top menu. */
const unitOf = (path: string) => {
  const seg = path.split("/");
  return seg[0] === "Object" && seg[1] === "Effects" && seg.length >= 4
    ? seg.slice(0, 3).join("/")
    : seg[0];
};

/** Every unit the registered host rows fall in (the inventory test holds the
 *  live rows to these lists, so none is left out). */
const DISPATCH_UNITS: readonly string[] = [
  ...new Set([...HOST_MENU, ...EFFECT_ROWS].map(unitOf)),
];

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
    expect([...live].sort()).toEqual([...HOST_MENU, ...EFFECT_ROWS].sort());
    // The dispatch tests run per top-level menu: none may be left out.
    for (const row of hostRows(await liveMenu(page)))
      expect(DISPATCH_UNITS).toContain(unitOf(row.path));
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
        "menu:View/Editing aids/Text threads",
        "menu:View/Snap to points",
        "menu:View/Show heading anchors",
        "menu:Edit/Select all",
        "menu:Edit/Find…",
        "menu:Edit/Find and replace…",
        "menu:Edit/Find next",
        "menu:Edit/Find previous",
        "menu:Edit/Go to page…",
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
        "menu:Object/Insert star…",
        "menu:Object/Insert barcode…",
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
        "menu:Object/Pathfinder/Unite",
        "menu:Object/Pathfinder/Subtract",
        "menu:Object/Pathfinder/Intersect",
        "menu:Object/Pathfinder/Exclude",
        "menu:Object/Pathfinder/Divide",
        "menu:Object/Pathfinder/Trim",
        "menu:Object/Pathfinder/Merge",
        "menu:Object/Pathfinder/Crop",
        "menu:Object/Pathfinder/Outline",
        "menu:Object/Pathfinder/Minus back",
        "menu:Object/Pathfinder/Keep or remove faces…",
        "menu:Object/Type on a path/Attach…",
        "menu:Object/Type on a path/Detach",
        "menu:Object/Corners/Rounded",
        "menu:Object/Corners/Inverse rounded",
        "menu:Object/Corners/Bevel",
        "menu:Object/Corners/Fancy",
        "menu:Object/Corners/None",
        "menu:Object/Appearance/Add fill",
        "menu:Object/Appearance/Add stroke",
        "menu:Object/Appearance/Clear",
        "menu:Object/Stroke/Dashes…",
        "menu:Object/Opacity mask/Make…",
        "menu:Object/Opacity mask/Release",
        "menu:Object/Step and repeat…",
        "menu:Layout/Move page…",
        "menu:Layout/New master…",
        "menu:Object/Effects/Global light…",
        "menu:File/Open as template…",
        "menu:File/New document…",
        "menu:File/New from a brief…",
        "menu:File/Open recent…",
        "menu:View/Show issue markers",
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
        "menu:Type/Insert footnote",
        "menu:Type/Insert endnote",
        "menu:Type/Insert bookmark…",
        "menu:Type/Insert cross-reference…",
        "menu:Type/New index entry…",
        "menu:Type/Format/Bold",
        "menu:Type/Format/Italic",
        "menu:Type/Format/Underline",
        "menu:Type/Format/Strikethrough",
        "menu:Type/Format/Subscript",
        "menu:Type/Format/Superscript",
        "menu:Type/Format/All caps",
        "menu:Type/Format/Small caps",
        "menu:Type/Format/Increase font size",
        "menu:Type/Format/Decrease font size",
        "menu:Type/Format/Align left",
        "menu:Type/Format/Align center",
        "menu:Type/Format/Align right",
        "menu:Type/Format/Justify",
        "menu:Type/Format/Increase indent",
        "menu:Type/Format/Decrease indent",
        "menu:Type/Format/Line spacing 1",
        "menu:Type/Format/Line spacing 1.5",
        "menu:Type/Format/Line spacing 2",
        "menu:Type/Format/Increase leading",
        "menu:Type/Format/Decrease leading",
        "menu:Type/Format/Increase tracking",
        "menu:Type/Format/Decrease tracking",
        "menu:Object/Transform/Transform each…",
        "menu:Object/Transform/Reflect horizontally",
        "menu:Object/Transform/Reflect vertically",
        "menu:Object/Transform/Reflect…",
        "menu:Object/Transform/Transform again",
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
        "Object/Insert star…",
        "Object/Insert barcode…",
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
      "menu:View/Editing aids/Text threads",
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
      "menu:Object/Insert star…",
      "menu:Object/Insert barcode…",
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
      "menu:Object/Pathfinder/Unite",
      "menu:Object/Pathfinder/Subtract",
      "menu:Object/Pathfinder/Intersect",
      "menu:Object/Pathfinder/Exclude",
      "menu:Object/Pathfinder/Divide",
      "menu:Object/Pathfinder/Trim",
      "menu:Object/Pathfinder/Merge",
      "menu:Object/Pathfinder/Crop",
      "menu:Object/Pathfinder/Outline",
      "menu:Object/Pathfinder/Minus back",
      "menu:Object/Pathfinder/Keep or remove faces…",
      "menu:Object/Type on a path/Attach…",
      "menu:Object/Type on a path/Detach",
      "menu:Object/Corners/Rounded",
      "menu:Object/Corners/Inverse rounded",
      "menu:Object/Corners/Bevel",
      "menu:Object/Corners/Fancy",
      "menu:Object/Corners/None",
      "menu:Object/Appearance/Add fill",
      "menu:Object/Appearance/Add stroke",
      "menu:Object/Appearance/Clear",
      "menu:Object/Stroke/Dashes…",
      "menu:Object/Opacity mask/Make…",
      "menu:Object/Opacity mask/Release",
      "menu:Object/Step and repeat…",
      "menu:Layout/Move page…",
      "menu:Layout/New master…",
      "menu:Object/Effects/Global light…",
      "menu:File/Open as template…",
      "menu:File/New document…",
      "menu:File/New from a brief…",
      "menu:File/Open recent…",
      "menu:View/Show issue markers",
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
      "menu:Type/Insert footnote",
      "menu:Type/Insert endnote",
      "menu:Type/Insert bookmark…",
      "menu:Type/Insert cross-reference…",
      "menu:Type/New index entry…",
      "menu:Type/Format/Bold",
      "menu:Type/Format/Italic",
      "menu:Type/Format/Underline",
      "menu:Type/Format/Strikethrough",
      "menu:Type/Format/Subscript",
      "menu:Type/Format/Superscript",
      "menu:Type/Format/All caps",
      "menu:Type/Format/Small caps",
      "menu:Type/Format/Increase font size",
      "menu:Type/Format/Decrease font size",
      "menu:Type/Format/Align left",
      "menu:Type/Format/Align center",
      "menu:Type/Format/Align right",
      "menu:Type/Format/Justify",
      "menu:Type/Format/Increase indent",
      "menu:Type/Format/Decrease indent",
      "menu:Type/Format/Line spacing 1",
      "menu:Type/Format/Line spacing 1.5",
      "menu:Type/Format/Line spacing 2",
      "menu:Type/Format/Increase leading",
      "menu:Type/Format/Decrease leading",
      "menu:Type/Format/Increase tracking",
      "menu:Type/Format/Decrease tracking",
      "menu:Object/Transform/Transform each…",
      "menu:Object/Transform/Reflect horizontally",
      "menu:Object/Transform/Reflect vertically",
      "menu:Object/Transform/Reflect…",
      "menu:Object/Transform/Transform again",
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

  // One test per top-level menu, and per Object ▸ Effects group: the whole bar
  // in one test took 2.1 min of its 3-minute CI budget on 2026-10-30 and passed
  // it on 2026-11-01 as the Effects, Envelope, Brushes, ML, Mesh and Warps rows
  // landed (176 s of 180 s locally). The cost grows with the row count, so a
  // longer timeout would only postpone it, and a top menu alone (Object, 2 min)
  // was still too close. Each test opens the shell once and clicks only its
  // own unit's rows (unitOf).
  for (const unit of DISPATCH_UNITS) {
    test(`clicking an enabled row runs exactly its command: ${unit}`, async ({
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
        "menu:View/Editing aids/Text threads",
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
        "menu:Object/Insert star…",
        "menu:Object/Insert barcode…",
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
        "menu:Object/Pathfinder/Unite",
        "menu:Object/Pathfinder/Subtract",
        "menu:Object/Pathfinder/Intersect",
        "menu:Object/Pathfinder/Exclude",
        "menu:Object/Pathfinder/Divide",
        "menu:Object/Pathfinder/Trim",
        "menu:Object/Pathfinder/Merge",
        "menu:Object/Pathfinder/Crop",
        "menu:Object/Pathfinder/Outline",
        "menu:Object/Pathfinder/Minus back",
        "menu:Object/Pathfinder/Keep or remove faces…",
        "menu:Object/Type on a path/Attach…",
        "menu:Object/Type on a path/Detach",
        "menu:Object/Corners/Rounded",
        "menu:Object/Corners/Inverse rounded",
        "menu:Object/Corners/Bevel",
        "menu:Object/Corners/Fancy",
        "menu:Object/Corners/None",
        "menu:Object/Appearance/Add fill",
        "menu:Object/Appearance/Add stroke",
        "menu:Object/Appearance/Clear",
        "menu:Object/Stroke/Dashes…",
        "menu:Object/Opacity mask/Make…",
        "menu:Object/Opacity mask/Release",
        "menu:Object/Step and repeat…",
        "menu:Layout/Move page…",
        "menu:Layout/New master…",
        "menu:Object/Effects/Global light…",
        "menu:File/Open as template…",
        "menu:File/New document…",
        "menu:File/New from a brief…",
        "menu:File/Open recent…",
        "menu:View/Show issue markers",
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
        "menu:Type/Insert footnote",
        "menu:Type/Insert endnote",
        "menu:Type/Insert bookmark…",
        "menu:Type/Insert cross-reference…",
        "menu:Type/New index entry…",
        "menu:Type/Format/Bold",
        "menu:Type/Format/Italic",
        "menu:Type/Format/Underline",
        "menu:Type/Format/Strikethrough",
        "menu:Type/Format/Subscript",
        "menu:Type/Format/Superscript",
        "menu:Type/Format/All caps",
        "menu:Type/Format/Small caps",
        "menu:Type/Format/Increase font size",
        "menu:Type/Format/Decrease font size",
        "menu:Type/Format/Align left",
        "menu:Type/Format/Align center",
        "menu:Type/Format/Align right",
        "menu:Type/Format/Justify",
        "menu:Type/Format/Increase indent",
        "menu:Type/Format/Decrease indent",
        "menu:Type/Format/Line spacing 1",
        "menu:Type/Format/Line spacing 1.5",
        "menu:Type/Format/Line spacing 2",
        "menu:Type/Format/Increase leading",
        "menu:Type/Format/Decrease leading",
        "menu:Type/Format/Increase tracking",
        "menu:Type/Format/Decrease tracking",
        "menu:Object/Transform/Transform each…",
        "menu:Object/Transform/Reflect horizontally",
        "menu:Object/Transform/Reflect vertically",
        "menu:Object/Transform/Reflect…",
        "menu:Object/Transform/Transform again",
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
      const inUnit = (r: MenuRow) => unitOf(r.path) === unit;
      const rows = hostRows(await liveMenu(page)).filter(inUnit);
      const recorder = await recordCommands(page, [
        ...new Set(rows.map((r) => r.command)),
      ]);
      const done = new Set<string>();
      // Two contexts between them enable every row that can enable (the
      // matrix shows a caret enables nothing new).
      for (const setup of [
        () => select(page, [SHELL.frame]),
        () => select(page, []),
        // Layout ▸ Go back / Go forward (editor ADR 1211) enable once the
        // navigation history holds a place each way.
        () =>
          page.evaluate(() => {
            type Nav = {
              record(from: object, to: object): void;
              back(current: object): unknown;
            };
            const nav = (
              globalThis as unknown as {
                __paged?: { camera?: { navigation?: Nav } };
              }
            ).__paged?.camera?.navigation;
            const at = (tx: number) => ({ scale: 1, tx, ty: 0, rotation: 0 });
            nav?.record(at(0), at(500));
            nav?.record(at(500), at(1000));
            nav?.back(at(1000));
          }),
      ]) {
        await setup();
        for (const row of hostRows(await liveMenu(page)).filter(inUnit)) {
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
      expect(rows.length).toBeGreaterThan(0);
      const never = rows.filter((r) => !done.has(r.path));
      expect(
        never.filter((r) => !r.seam && r.kind !== "label").map((r) => r.path),
      ).toEqual([]);
    });
  }

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

  // Finding SH-4 (fixed): the View toggles (Text threads, Snap to
  // points, Show heading anchors) rendered as plain items with no checked
  // state; they are menuitemcheckbox rows now (`checked` on the item).
  test("SH-4: a View toggle shows its checked state", async ({ page }) => {
    covers("menu:View/Editing aids/Text threads", "menu:View/Snap to points");
    await openShell(page, { doc: true });
    await page.locator('[data-menu-trigger="View"]').click();
    // Snap to points is ON by default.
    await expect(
      page.getByRole("menuitemcheckbox", { name: /Snap to points/ }),
    ).toHaveAttribute("aria-checked", "true", { timeout: 2_000 });
  });

  test("View/Editing aids/Data bindings toggles the binding badges and is remembered", async ({
    page,
  }) => {
    // Data ADR 566 — the data markers are an editing aid (they moved from
    // View ▸ Show data markers).
    covers("menu:View/Editing aids/Data bindings");
    await openShell(page, { doc: true });
    const stored = () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("paged.view.editingAids") ?? "{}")
            .dataMarkers ?? false,
      );
    expect(await stored()).toBe(false);
    await clickMenuRow(page, "View/Editing aids/Data bindings");
    await expect.poll(stored).toBe(true);
    await clickMenuRow(page, "View/Editing aids/Data bindings");
    await expect.poll(stored).toBe(false);
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
        // UX audit F-18 — a plugin's own row that opens the panel through
        // its dialog ("Data query…") stands for the panel's row ("Data
        // query"), which the bar drops: one entry per panel.
        if (!row && family === "Plugins/*" && (await menuRow(page, `${at}…`)))
          continue;
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
