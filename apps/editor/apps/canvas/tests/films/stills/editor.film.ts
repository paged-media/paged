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

// The editor's own surfaces for paged.media's plugin pages, /studio/ and
// /product/, and the docs' plugin and template pages (website ADR 858):
// draw, sheet, web and slide, the editor over a spread of the showcase
// annual, a module's panel, and a template being filled. Each state is
// reached through the editor's own commands and files, and asserted against
// the engine before the picture is taken. Recorded locally
// (PAGED_MEDIA_ROOT) at 1536×860 CSS px, device scale 2, dark (kit.ts).

import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { Designer } from "../../journey/driver/designer";
import {
  sceneText,
  tapSceneLayers,
  webFrames,
} from "../../journey/plugins/web-kit";
import { dressStage } from "../kit/stage";
import { sampleRole } from "../kit/samples";
import {
  ASSETS,
  canvas,
  deselect,
  goTo,
  openSampleStill,
  pagePt,
  park,
  ROOT,
  script,
  seasoned,
  settled,
  shot,
  showPanel,
  STILL_VIEW,
} from "./kit";

test.skip(!ROOT, "PAGED_MEDIA_ROOT is not set (stills are captured locally)");
test.use({
  viewport: STILL_VIEW,
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

type Ref = { kind: string; id: string };

/** The editor with a fresh blank page, the Selection tool armed. */
async function fresh(page: Page): Promise<Designer> {
  page.setDefaultTimeout(30_000);
  await dressStage(page);
  await seasoned(page);
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  return designer;
}

/** A wire op, which must apply; answers the id it created, if any. */
async function mutate(page: Page, op: string, args: unknown): Promise<Ref> {
  const reply = (await canvas(page, (c, m) => c.client.mutate(m), {
    op,
    args,
  })) as { kind: string; payload?: { createdId?: Ref } };
  if (reply.kind !== "mutationApplied")
    throw new Error(
      `${op} was not applied: ${JSON.stringify(reply).slice(0, 300)}`,
    );
  return reply.payload?.createdId as Ref;
}

const run = (page: Page, id: string) =>
  canvas(page, (c, i) => c.registries.commands.invoke(i), id);

/** Select as a click does: the engine's selection (what commands and
 *  modules read), the panels' mirror and the selection box. */
const select = (page: Page, ids: Ref[]) =>
  canvas(
    page,
    async (c, a) => {
      const applied = await c.client.setElementSelection(a, "replace");
      c.setElementSelection(applied, "replace");
      c.setElementGeometry?.(await c.client.elementGeometry(applied));
    },
    ids,
  );

/** File ▸ Open… with `file` chosen in the picker. */
async function openFile(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  const opening = run(page, "paged.file.openIdml");
  await (await chooser).setFiles(file);
  await opening;
}

/** Fit the current page (⌘0), then let the camera settle. */
async function fitPage(page: Page): Promise<void> {
  await run(page, "paged.view.fitPage");
  await settled(page);
}

/** Every page item of a kind. */
async function ids(page: Page, kind: string): Promise<string[]> {
  type Node = { id?: Ref | null; children?: Node[] };
  // paged.tree() answers JSON text; logged, it is that text.
  let tree: unknown = (await script(page, "console.log(paged.tree())"))[0];
  while (typeof tree === "string") tree = JSON.parse(tree);
  const out: string[] = [];
  const visit = (n: Node) => {
    if (n.id?.kind === kind) out.push(n.id.id);
    for (const ch of n.children ?? []) visit(ch);
  };
  for (const root of tree as Node[]) visit(root);
  return out;
}

const SWATCHES = `for (const [selfId, name, rgb] of [
  ["Color/Rose", "Rose", [244, 127, 192]],
  ["Color/Violet", "Violet", [169, 139, 245]],
  ["Color/Night", "Night", [42, 33, 64]],
]) paged.createSwatch({ selfId, name, space: "RGB", value: rgb, model: "Process" });`;

const fill = (page: Page, ref: Ref, color: string) =>
  mutate(page, "setElementProperty", {
    elementId: ref,
    path: "frameFillColor",
    value: { type: "colorRef", value: color },
  });

// ── draw: a pen-drawn dome, a card with live rounded corners (its corner
//    widgets showing under Direct Selection), a Pathfinder union. ──
test("stills · draw", async ({ page }) => {
  test.setTimeout(240_000);
  const designer = await fresh(page);
  await script(page, SWATCHES);
  const pageId = (await designer.handle()).pageIds[0];
  const dome = await mutate(page, "insertPath", {
    pageId,
    open: false,
    anchors: [
      { anchor: [100, 250], left: [100, 250], right: [100, 250] },
      { anchor: [205, 90], left: [120, 90], right: [290, 90] },
      { anchor: [310, 250], left: [310, 250], right: [310, 250] },
    ],
  });
  await fill(page, dome, "Color/Rose");
  const a = await mutate(page, "insertFrame", {
    pageId,
    bounds: [320, 90, 440, 250],
  });
  const b = await mutate(page, "insertFrame", {
    pageId,
    bounds: [340, 190, 460, 350],
  });
  await fill(page, a, "Color/Rose");
  await fill(page, b, "Color/Violet");
  await select(page, [a, b]);
  await run(page, "paged.pathfinder.unite");
  // The frontmost shape is kept as the union; the other is gone.
  await expect.poll(async () => (await ids(page, "rectangle")).length).toBe(1);
  const card = await mutate(page, "insertFrame", {
    pageId,
    bounds: [90, 360, 250, 540],
  });
  await fill(page, card, "Color/Violet");
  await select(page, [card]);
  await run(page, "paged.corners.rounded");
  await expect
    .poll(
      async () =>
        (
          await canvas(page, (c, r) => c.client.elementProperties(r), card)
        )?.entries.find(
          (e: { path: string }) => e.path === "frameCornerOptionTopLeft",
        )?.value?.value,
    )
    .toBe("RoundedCorner");
  await showPanel(page, "paged.swatches");
  await fitPage(page);
  // Direct Selection shows the card's live corner widgets.
  await page.keyboard.press("a");
  await select(page, [card]);
  await expect(
    page.locator('[data-live-shape-handles]:not([data-count="0"])').first(),
  ).toBeAttached({
    timeout: 10_000,
  });
  await park(page);
  await page.waitForTimeout(800);
  await shot(page, "draw", {
    shows:
      "a closed curved path, a Pathfinder union and a card with live rounded corners (Direct Selection, corner widgets)",
    card: card.id,
    corner: "RoundedCorner",
  });
});

// ── sheet: an Excel workbook placed as a table, its chart on the page as
//    vector shapes, and the Grid panel. ──
test("stills · sheet", async ({ page }) => {
  test.setTimeout(240_000);
  const designer = await fresh(page);
  // The spreadsheet engine starts on the first workbook.
  await showPanel(page, "media.paged.sheet.panel.workbook");
  await page.locator("[data-sheet-new]").click();
  await expect(page.locator("[data-sheet-range]")).toBeVisible({
    timeout: 30_000,
  });
  await designer.newDocument();
  await openFile(page, join(ASSETS, "price-list.xlsx"));
  await expect(page.locator('[data-sheet-panel="workbook"]')).toContainText(
    "Imported price-list.xlsx",
    { timeout: 20_000 },
  );
  await page.locator("[data-sheet-lower]").click();
  await expect
    .poll(async () => (await ids(page, "textFrame")).length, {
      timeout: 15_000,
    })
    .toBe(1);
  const before = (await ids(page, "polygon")).length;
  const charts = page.locator('[data-sheet-section="charts"]');
  await charts.locator("summary").click();
  await expect(page.locator("[data-sheet-chart-list]")).toContainText(
    "Amount by item",
  );
  await page.locator("[data-sheet-chart-lower]").first().click();
  await expect
    .poll(async () => (await ids(page, "polygon")).length - before, {
      timeout: 15_000,
    })
    .toBeGreaterThan(3);
  await page.getByText("Grid panel", { exact: true }).first().click();
  await expect(page.locator("[data-grid-svg-root]")).toBeVisible({
    timeout: 10_000,
  });
  await deselect(page);
  await fitPage(page);
  await park(page);
  await page.waitForTimeout(800);
  await shot(page, "sheet", {
    shows:
      "price-list.xlsx placed as a table, its chart lowered to vector shapes, the Grid panel",
    workbook: "price-list.xlsx",
    chart: "Amount by item",
    chartParts: (await ids(page, "polygon")).length - before,
  });
});

// ── web: an HTML mailer flowed through two frames on the page. ──
test("stills · web", async ({ page }) => {
  test.setTimeout(240_000);
  const designer = await fresh(page);
  await tapSceneLayers(page);
  await openFile(page, join(ASSETS, "spring-mailer.html"));
  await expect
    .poll(async () => (await webFrames(page)).length, { timeout: 10_000 })
    .toBe(1);
  const first = (await webFrames(page))[0];
  await expect
    .poll(() => sceneText(page, first.id), { timeout: 10_000 })
    .toContain("Spring line sheet");
  const pageId = (await designer.handle()).pageIds[0];
  const second = await mutate(page, "insertFrame", {
    pageId,
    bounds: [60, 320, 240, 560],
  });
  await select(page, [first, second]);
  await run(page, "media.paged.web.command.threadWebFlow");
  await expect
    .poll(() => sceneText(page, second.id), { timeout: 10_000 })
    .toContain("Cotton sailor shirt");
  await deselect(page);
  await fitPage(page);
  // The first frame selected: the source panel shows its HTML and CSS.
  await select(page, [first]);
  await showPanel(page, "media.paged.web.panel.source");
  await expect(page.locator("[data-web-css]").first()).toBeVisible({
    timeout: 10_000,
  });
  await park(page);
  await page.waitForTimeout(1200);
  await shot(page, "web", {
    shows:
      "spring-mailer.html as a web frame, its flow threaded into a second frame, the source panel",
    file: "spring-mailer.html",
    frames: [first.id, second.id],
  });
});

// ── slide: a PowerPoint deck, a page per slide, and the Slides panel. ──
test("stills · slide", async ({ page }) => {
  test.setTimeout(240_000);
  const designer = await fresh(page);
  await openFile(page, join(ASSETS, "pitch-deck.pptx"));
  await expect
    .poll(async () => (await designer.handle()).pageCount, { timeout: 20_000 })
    .toBe(6);
  await page
    .locator('[data-panel-rail-item="media.paged.slide.panel.slides"]')
    .click();
  const thumbs = page.locator('[data-slides-panel="ready"] [data-slide]');
  await expect(thumbs).toHaveCount(6, { timeout: 10_000 });
  await expect(thumbs.locator("img")).toHaveCount(6, { timeout: 30_000 });
  const row = thumbs.nth(1);
  await row.locator("button").first().click();
  await expect(row).toHaveAttribute("data-active", "true", {
    timeout: 10_000,
  });
  await settled(page);
  await park(page);
  await page.waitForTimeout(800);
  await shot(page, "slide", {
    shows:
      "pitch-deck.pptx open as six 960×540 pages, slide 2 fitted, the Slides panel",
    file: "pitch-deck.pptx",
    slides: 6,
    active: 2,
  });
});

// ── overview: a sample publication (website ADR 863), a page fitted, the
//    editor's panels. Which one is the storyboard's (films/samples.take.json,
//    "overview"). ──
test("stills · overview", async ({ page }) => {
  test.setTimeout(400_000);
  const ref = sampleRole("overview");
  const n = ref.page as number;
  await openSampleStill(page, ref);
  await showPanel(page, "paged.pages");
  await goTo(page, n);
  await deselect(page);
  // Fitted last, once the dock and the selection are settled. The editor
  // lays a publication's pages one under the other: the page is fitted.
  await run(page, "paged.view.fitPage");
  await settled(page);
  await park(page);
  await page.waitForTimeout(1500);
  await shot(page, "overview", {
    shows: `a sample publication, page ${n} fitted, the Pages panel`,
    sample: ref.sample,
    page: n,
  });
});

// ── plugin-panel: paged.draw's Path Options, its Width profile applied to
//    an open path. ──
test("stills · plugin-panel", async ({ page }) => {
  test.setTimeout(240_000);
  const designer = await fresh(page);
  await script(page, SWATCHES);
  const pageId = (await designer.handle()).pageIds[0];
  const path = await mutate(page, "insertPath", {
    pageId,
    open: true,
    anchors: [
      { anchor: [90, 420], left: [90, 420], right: [170, 260] },
      { anchor: [306, 360], left: [230, 470], right: [380, 250] },
      { anchor: [522, 300], left: [450, 420], right: [522, 300] },
    ],
  });
  await mutate(page, "setElementProperty", {
    elementId: path,
    path: "frameStrokeColor",
    value: { type: "colorRef", value: "Color/Violet" },
  });
  await mutate(page, "setElementProperty", {
    elementId: path,
    path: "frameStrokeWeight",
    value: { type: "length", value: 4 },
  });
  await select(page, [path]);
  // Bare, the command raises the panel's Width profile section.
  await run(page, "media.paged.draw.command.widthProfile");
  const panel = page.locator("[data-draw-pathopts-panel]").first();
  await expect(panel).toHaveAttribute(
    "data-draw-pathopts-panel",
    "widthProfile",
    { timeout: 10_000 },
  );
  // The path picked on the canvas, as a person picks it: the panel counts
  // what the selection tool selects.
  await fitPage(page);
  await page.keyboard.press("v");
  const on = await pagePt(page, 1, 306, 360);
  await page.mouse.click(on.x, on.y);
  await expect(
    page.locator('[data-draw-pathopts-apply="widthProfile"]').first(),
  ).toHaveText(/1 path/, { timeout: 10_000 });
  const polys = (await ids(page, "polygon")).length;
  await page
    .locator('[data-draw-pathopts-apply="widthProfile"]')
    .first()
    .click();
  await expect
    .poll(async () => (await ids(page, "polygon")).length)
    .toBe(polys);
  await fitPage(page);
  await park(page);
  await page.waitForTimeout(800);
  await shot(page, "plugin-panel", {
    shows:
      "paged.draw's Path Options panel, its Width profile section applied to an open path",
    panel: "media.paged.draw.panel.pathOptions",
    section: "widthProfile",
  });
});
