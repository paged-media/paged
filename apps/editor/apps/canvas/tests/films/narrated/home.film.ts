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

// The home film (ADR 224): the website's `films/home.yaml`. One document,
// made from nothing on camera, and every kind of content in a frame of its
// own. File ▸ New, Layout ▸ Add page and the Margins and Columns panel; a
// headline typed with the Type tool; the copy placed from a Word document
// (paged.doc), set in its own styles, in two columns, with a drop cap and
// justified; the story threaded onto page two and reflowed; then a frame
// each for a photograph (paged.image), a pen drawing (paged.draw), a chart
// from an Excel workbook (paged.sheet), HTML (paged.web) and a barcode
// drawn from a product list in DuckDB (paged.data); preflight, a PDF and
// the saved .paged file. Every step goes through the editor's own controls
// and is asserted against the engine or the written bytes.
//
// Off camera: the two OFL faces the Word document's styles name (core's
// corpus/fonts; the editor has no user path to add a font yet) are given to
// the engine, and the spreadsheet and image engines are started, so their
// first boot does not stall the film.

import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { film, type Kit } from "../kit/film";
import { typeHuman } from "../kit/pointer";
import { hover, menu, press, screenPoint } from "../kit/ui";
import { decodeEan13, type Bounds } from "../kit/ean";
import { openPanel } from "../../fidelity/canvas-driver";
import { readZipText, zipEntryNames } from "../../e2e/harness/read-zip";

const MEDIA = process.env.PAGED_MEDIA_ROOT ?? "";
const ASSETS = join(MEDIA, "assets");
const FONTS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "engine",
  "core",
  "corpus",
  "fonts",
);

/** Pages stack vertically, 24 pt apart (ui/layout.ts): page 2's top. */
const P2 = 792 + 24;
const HEADLINE = "The quiet page";

type Rect = [number, number, number, number]; // x0, y0, x1, y1 (pt) for focus()
/** The pieces of the layout, in page-1 points (page 2 is P2 lower). */
const HEAD_BOX = { x0: 48, y0: 48, x1: 430, y1: 132 };
const BODY_TOP = 300;
const BODY_TOP_AFTER = 412;
const PHOTO = { x0: 48, y0: 140, x1: 564, y1: 400 };
const MARK = [
  [452, 124],
  [492, 62],
  [514, 96],
  [532, 76],
  [564, 124],
] as const;
const P2_BODY = { x0: 48, y0: P2 + 48, x1: 564, y1: P2 + 330 };
const WEB = { left: 390, top: 342, width: 174, height: 229 };
const CODE = { x0: 390, y0: P2 + 600, x1: 564, y1: P2 + 700 };

const PAGE1: Rect = [-30, -20, 642, 812];
const TOP1: Rect = [20, 20, 592, 420];
const LOWER1: Rect = [20, 280, 592, 760];
const SPREAD: Rect = [-40, -30, 652, P2 + 822];
const PAGE2: Rect = [-30, P2 - 20, 642, P2 + 812];

const pt = (k: Kit, x: number, y: number) => screenPoint(k.page, x, y);

interface Item {
  id: { kind: string; id: string };
  pageId: string;
  bounds: Bounds;
  hasImage?: boolean;
  storyId?: string;
}

/** Every page item with its page, bounds, image and story. */
async function items(page: Page): Promise<Item[]> {
  return page.evaluate(async () => {
    type Node = { id?: { kind: string; id: string } | null; children?: Node[] };
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            executeScript(s: string): Promise<{ output: string[] }>;
            send(m: unknown): Promise<{ payload: { items?: unknown[] } }>;
          };
        };
      }
    ).__canvas.client;
    const r = await c.executeScript("JSON.stringify(paged.tree())");
    const ids: { kind: string; id: string }[] = [];
    const walk = (n: Node) => {
      if (n.id) ids.push(n.id);
      for (const ch of n.children ?? []) walk(ch);
    };
    for (const root of JSON.parse(JSON.parse(r.output[0])) as Node[])
      walk(root);
    const g = await c.send({
      kind: "requestElementGeometry",
      payload: { ids },
    });
    return (g.payload.items ?? []) as Item[];
  });
}

/** The stories: id, length, overset. */
async function stories(
  page: Page,
): Promise<
  Array<{ selfId: string; characterCount: number; overset: boolean }>
> {
  return page.evaluate(async () => {
    const r = await (
      globalThis as unknown as {
        __canvas: {
          client: { executeScript(s: string): Promise<{ output: string[] }> };
        };
      }
    ).__canvas.client.executeScript("paged.stories()");
    return JSON.parse(r.output[0]);
  });
}

/** What the control bar's pickers show (the style and face of the text
 *  the caret is in). */
const controlBar = (page: Page) =>
  page.$$eval("select", (els) =>
    els
      .filter((e) => e.getBoundingClientRect().top < 110)
      .map(
        (e) =>
          (e as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ??
          "",
      ),
  );

const caret = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas: { contentSelection?: { storyId: string } | null };
        }
      ).__canvas.contentSelection ?? null,
  );

const selection = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas: { elementSelection?: Array<{ kind: string; id: string }> };
        }
      ).__canvas.elementSelection ?? [],
  );

const imageStatus = async (page: Page) =>
  (
    (await page
      .locator("[data-image-status]")
      .allTextContents()
      .catch(() => [])) as string[]
  ).join(" | ");

const editContext = (page: Page) =>
  page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __canvas: {
            debugContext(): { editContext: { type: string } | null };
          };
        }
      ).__canvas.debugContext().editContext?.type ?? null,
  );

async function registerFonts(page: Page): Promise<void> {
  const faces = [
    { family: "Fraunces", file: "Fraunces-VF.ttf" },
    { family: "Source Serif 4", file: "SourceSerif4.ttf" },
  ];
  await page.route("**/__film-fonts/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "font/ttf",
      body: readFileSync(
        join(
          FONTS,
          decodeURIComponent(route.request().url().split("/__film-fonts/")[1]),
        ),
      ),
    }),
  );
  await page.evaluate(async (list) => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            registerFont(
              f: string,
              b: Uint8Array,
              s: string | null,
            ): Promise<void>;
          };
        };
      }
    ).__canvas.client;
    for (const f of list) {
      const res = await fetch(`/__film-fonts/${encodeURIComponent(f.file)}`);
      if (!res.ok) throw new Error(`font ${f.file}: ${res.status}`);
      await c.registerFont(
        f.family,
        new Uint8Array(await res.arrayBuffer()),
        null,
      );
    }
  }, faces);
  await page.unroute("**/__film-fonts/*");
}

/** Type into a panel or control-bar field the way a person does: click it,
 *  select what is there, type, press Enter. */
async function retype(k: Kit, field: Locator, value: string): Promise<void> {
  await press(k, field);
  await expect(field).toBeFocused();
  await k.page.keyboard.press("ControlOrMeta+a");
  await typeHuman(k.page, value, 13);
  await k.hold(120);
  await k.page.keyboard.press("Enter");
  await k.hold(200);
}

/** Fill fields that follow each other with Tab, the way a person does:
 *  click the first, then type each value and Tab on; Enter after the last. */
async function tabChain(
  k: Kit,
  first: Locator,
  values: readonly string[],
): Promise<void> {
  await press(k, first);
  await expect(first).toBeFocused();
  for (const [i, v] of values.entries()) {
    await k.page.keyboard.press("ControlOrMeta+a");
    await typeHuman(k.page, v, 17 + i);
    await k.hold(80);
    await k.page.keyboard.press(i === values.length - 1 ? "Enter" : "Tab");
  }
  await k.hold(200);
}

/** Pick an option the way a person does: rest on the select, then choose. */
async function choose(k: Kit, field: Locator, value: string): Promise<void> {
  await hover(k, field);
  await k.hold(250);
  await field.selectOption(value);
  await k.hold(250);
}

/** Back to the Selection tool with nothing selected: Escape and V, as a
 *  hand does; a click on the pasteboard only when something is still
 *  selected. */
async function deselect(k: Kit, y = 400): Promise<void> {
  await k.key("Escape");
  await k.hold(150);
  if (await caret(k.page)) {
    // Out of the text first: a caret would take the V as a letter.
    await press(k, k.page.locator('[data-tool-slot="select"]').first());
  } else {
    await k.key("v");
  }
  await k.key("Escape");
  if ((await selection(k.page)).length > 0) {
    await k.pointer.click(await pt(k, -90, y), { targetWidth: 80 });
    await k.hold(150);
  }
}

film("home", async (k) => {
  // A lot happens in this take: the hand moves a little briskly.
  k.pointer.pace = 1.3;
  const { page, designer, pointer } = k;
  let bodyStory = "";
  let bodyFrame = "";
  let p2Frame = "";
  page.setDefaultTimeout(30_000);

  await k.setup(async () => {
    await designer.open();
    await designer.newDocument();
    await registerFonts(page);
    // Start the spreadsheet engine: its first workbook otherwise spends
    // seconds booting it, on screen.
    await openPanel(page, "media.paged.sheet.panel.workbook");
    await page.locator("[data-sheet-new]").click();
    await expect(page.locator("[data-sheet-range]")).toBeVisible({
      timeout: 30_000,
    });
    await designer.newDocument();
    await openPanel(page, "paged.properties");
    await k.key("v");
    await k.hold(800);
  });
  await k.roll();

  // ── File ▸ New document, and a second page. ──
  await k.scene("new", async () => {
    await k.hold(300);
    await menu(k, ["File", "New document…"]);
    await expect.poll(async () => (await designer.handle()).pageCount).toBe(1);
    await k.hold(500);
    await menu(k, ["Layout", "Add page"]);
    await expect.poll(async () => (await designer.handle()).pageCount).toBe(2);
    await k.hold(600);
  });

  // ── Margins and two columns on every page. ──
  await k.scene("margins", async () => {
    await menu(k, ["Window", "Structure", "Margins and Columns"]);
    const panel = page
      .locator('[role="tabpanel"]:visible')
      .filter({ has: page.locator("[data-page-select]") })
      .first();
    await choose(k, panel.locator("[data-page-select]"), "All pages");
    const fields = panel.locator('input[type="text"]');
    // Bounds (4), then Top, Bottom, Inside, Outside, column Number, Gutter.
    await tabChain(k, fields.nth(4), ["48", "48", "48", "48"]);
    await tabChain(k, fields.nth(8), ["2", "18"]);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await (
            globalThis as unknown as {
              __canvas: {
                client: {
                  executeScript(s: string): Promise<{ output: string[] }>;
                };
              };
            }
          ).__canvas.client.executeScript("paged.pages()");
          return (
            JSON.parse(r.output[0]) as Array<{
              marginTopPt: number;
              columnCount: number;
            }>
          )
            .map((p) => `${p.marginTopPt}/${p.columnCount}`)
            .join(" ");
        }),
      )
      .toBe("48/2 48/2");
    await expect(page.locator("[data-margin-guides]")).toHaveCount(2);
    k.focus(PAGE1);
    await k.hold(1200);
  });

  // ── The headline: a frame drawn with the Type tool, typed into. ──
  await k.scene("headline", async () => {
    k.unfocus();
    await k.key("t", "Type tool");
    await pointer.drag(
      await pt(k, HEAD_BOX.x0, HEAD_BOX.y0),
      await pt(k, HEAD_BOX.x1, HEAD_BOX.y1),
      { speed: 1.2 },
    );
    k.focus(TOP1);
    await k.hold(300);
    await typeHuman(page, HEADLINE, 3);
    await expect
      .poll(async () => (await stories(page))[0]?.characterCount ?? 0)
      .toBe(HEADLINE.length);
    await k.hold(500);
  });

  // ── The copy, placed from Word into a frame of its own. ──
  await k.scene("word", async () => {
    k.unfocus();
    await deselect(k);
    const chooser = page.waitForEvent("filechooser", { timeout: 120_000 });
    await menu(k, ["Insert", "Word document…"]);
    k.chip("the-page.docx", "file");
    await (await chooser).setFiles(join(ASSETS, "the-page.docx"));
    await expect
      .poll(async () => (await stories(page)).length, { timeout: 20_000 })
      .toBe(2);
    const body = (await stories(page)).find((s) => s.characterCount > 1000)!;
    bodyStory = body.selfId;
    const frame = (await items(page)).find(
      (i) =>
        i.id.kind === "textFrame" &&
        Math.round(i.bounds[0]) === BODY_TOP &&
        Math.round(i.bounds[1]) === 48,
    );
    expect(frame, "the Word copy sits in its own frame").toBeTruthy();
    bodyFrame = frame!.id.id;
    expect(body.overset, "the copy runs longer than its frame").toBe(true);
    k.focus(LOWER1);
    await k.hold(1500);
  });

  // ── The headline takes the Title style the Word document brought. ──
  await k.scene("style", async () => {
    k.unfocus();
    await k.key("t");
    await pointer.click(await pt(k, 120, 90), { targetWidth: 40 });
    await expect
      .poll(async () => (await caret(page))?.storyId ?? "")
      .not.toBe(bodyStory);
    // The control bar's paragraph-style picker, where Word's styles now are.
    const styles = page
      .locator("select")
      .filter({ has: page.locator("option", { hasText: /^Title$/ }) })
      .first();
    await hover(k, styles);
    await k.hold(250);
    await styles.selectOption({ label: "Title" });
    // The control bar names the caret's paragraph style and face.
    await expect
      .poll(() => controlBar(page))
      .toEqual(expect.arrayContaining(["Title", "Fraunces"]));
    k.focus(TOP1);
    await k.hold(1800);
  });

  // ── Two columns for the copy's frame. ──
  await k.scene("columns", async () => {
    k.unfocus();
    await deselect(k);
    await pointer.click(await pt(k, 300, 560), { targetWidth: 120 });
    await expect
      .poll(async () => (await selection(page)).map((s) => s.id))
      .toEqual([bodyFrame]);
    await openPanel(page, "paged.text-frame-options");
    const count = page
      .locator('input[aria-label="Text frame column count"]:visible')
      .first();
    const gutter = page
      .locator('input[aria-label="Text frame column gutter"]:visible')
      .first();
    await retype(k, count, "2");
    await retype(k, gutter, "18");
    // The panel reads the frame back: two columns, an 18 pt gutter.
    await expect(count).toHaveValue("2");
    await expect(gutter).toHaveValue(/^18/);
    k.focus(LOWER1);
    await k.hold(1400);
  });

  // ── A drop cap, then the whole story justified. ──
  await k.scene("paragraph", async () => {
    k.unfocus();
    await k.key("t");
    await pointer.click(await pt(k, 110, BODY_TOP + 24), { targetWidth: 40 });
    await expect
      .poll(async () => (await caret(page))?.storyId ?? "")
      .toBe(bodyStory);
    await openPanel(page, "paged.paragraph");
    await retype(
      k,
      page
        .locator('input[aria-label="Paragraph drop cap lines"]:visible')
        .first(),
      "3",
    );
    await retype(
      k,
      page
        .locator('input[aria-label="Paragraph drop cap characters"]:visible')
        .first(),
      "1",
    );
    // The caret goes back to the text, and every paragraph is selected.
    await pointer.click(await pt(k, 110, BODY_TOP + 24), { targetWidth: 40 });
    await k.key("Meta+a", "Select all", "⌘A");
    await press(
      k,
      page.locator('[data-option-value="LeftJustified"]:visible').first(),
    );
    k.focus(LOWER1);
    await k.hold(2200);
  });

  // ── The story threads onto page two. ──
  await k.scene("thread", async () => {
    k.unfocus();
    await deselect(k);
    await k.key("Alt+Shift+Meta+0", "Fit document", "⌥⇧⌘0");
    await k.hold(700);
    await k.recamera();
    // The frame on page two, drawn with the Type tool.
    await k.key("t", "Type tool");
    await pointer.drag(
      await pt(k, P2_BODY.x0, P2_BODY.y0),
      await pt(k, P2_BODY.x1, P2_BODY.y1),
      { speed: 1.3 },
    );
    await deselect(k, 700);
    const p2 = (await items(page)).find(
      (i) =>
        i.id.kind === "textFrame" &&
        i.id.id !== bodyFrame &&
        Math.round(i.bounds[0]) === 48 &&
        Math.round(i.bounds[2]) === 330,
    );
    expect(p2, "the frame on page two").toBeTruthy();
    p2Frame = p2!.id.id;
    await pointer.click(await pt(k, 300, 560), { targetWidth: 80 });
    const port = page.locator('[data-thread-port="out"]').first();
    await expect(port).toHaveAttribute("data-thread-state", "overset");
    await press(k, port);
    await k.hold(300);
    await pointer.click(await pt(k, 300, P2 + 180), { targetWidth: 120 });
    await expect
      .poll(
        async () =>
          (await items(page)).filter(
            (i) => i.id.kind === "textFrame" && i.storyId === bodyStory,
          ).length,
      )
      .toBe(2);
    await expect
      .poll(
        async () =>
          (await stories(page)).find((s) => s.selfId === bodyStory)?.overset,
      )
      .toBe(false);
    k.focus(SPREAD, 1.2);
    await k.hold(1200);
  });

  // ── Room for a picture: the frame's top edge comes down, the text moves on. ──
  await k.scene("reflow", async () => {
    await pointer.drag(
      await pt(k, 306, BODY_TOP),
      await pt(k, 306, BODY_TOP_AFTER),
      { speed: 0.8 },
    );
    await expect
      .poll(async () =>
        Math.round(
          (await items(page)).find((i) => i.id.id === bodyFrame)?.bounds[0] ??
            0,
        ),
      )
      .toBe(BODY_TOP_AFTER);
    await expect
      .poll(
        async () =>
          (await stories(page)).find((s) => s.selfId === bodyStory)?.overset,
      )
      .toBe(false);
    await deselect(k, 700);
    await k.hold(1600);
  });

  // ── A photograph in a frame, enhanced where it sits. ──
  await k.scene("photo", async () => {
    k.unfocus();
    await k.key("Home");
    await k.key("Meta+0", "Fit page", "⌘0");
    await k.hold(600);
    await k.recamera();
    await k.key("f", "Rectangle frame tool");
    await pointer.drag(
      await pt(k, PHOTO.x0, PHOTO.y0),
      await pt(k, PHOTO.x1, PHOTO.y1),
      { speed: 1.3 },
    );
    await k.hold(400);
    const chooser = page.waitForEvent("filechooser", { timeout: 120_000 });
    await k.key("Meta+d", "Place", "⌘D");
    k.chip("dolomites.jpg", "file");
    await (await chooser).setFiles(join(ASSETS, "pexels-618833-dolomites.jpg"));
    await expect
      .poll(async () => (await items(page)).some((i) => i.hasImage), {
        timeout: 15_000,
      })
      .toBe(true);
    await openPanel(page, "paged.frame-fitting");
    await press(
      k,
      page.getByRole("button", { name: "Fill frame proportionally" }).first(),
    );
    await k.hold(500);
    await menu(k, ["Plugins", "Image", "Adjust…"]);
    await expect
      .poll(() => editContext(page), { timeout: 20_000 })
      .toBe("rasterImage");
    await expect
      .poll(() => imageStatus(page), { timeout: 20_000 })
      .toContain("decoded");
    await press(k, page.locator("[data-image-auto-enhance]"));
    await k.hold(900);
    await press(
      k,
      page.getByRole("button", { name: "Apply", exact: true }).first(),
    );
    await expect
      .poll(() => imageStatus(page), { timeout: 20_000 })
      .toContain("Composited");
    await menu(k, ["Image", "Commit edits to the document"]);
    await expect
      .poll(() => imageStatus(page), { timeout: 20_000 })
      .toContain("Committed revision");
    await k.key("Escape");
    await expect.poll(() => editContext(page)).toBe(null);
    // Done with the picture: its panel closes.
    await press(
      k,
      page.getByRole("button", { name: "Close Image", exact: true }).first(),
    );
    k.focus(TOP1);
    await k.hold(1600);
  });

  // ── A mark beside the headline, drawn with the pen and filled. ──
  await k.scene("draw", async () => {
    k.unfocus();
    await deselect(k);
    const before = (await items(page)).filter(
      (i) => i.id.kind === "polygon",
    ).length;
    await press(k, page.locator('[data-tool-slot="pen"]'));
    k.focus(TOP1);
    for (const [x, y] of MARK) {
      await pointer.click(await pt(k, x, y), { targetWidth: 28 });
      await k.hold(120);
    }
    await pointer.click(await pt(k, MARK[0][0], MARK[0][1]), {
      targetWidth: 20,
    });
    await expect
      .poll(
        async () =>
          (await items(page)).filter((i) => i.id.kind === "polygon").length,
      )
      .toBe(before + 1);
    // Filled black from the tool rail's fill swatch.
    const mark = (await items(page))
      .filter((i) => i.id.kind === "polygon")
      .at(-1)!;
    await press(
      k,
      page
        .getByRole("button", { name: "Fill — click to choose a colour" })
        .first(),
    );
    await press(
      k,
      page.locator('[data-swatch-picker] [title="Black"]').first(),
    );
    await expect
      .poll(() =>
        page.evaluate(async (ref) => {
          const p = await (
            globalThis as unknown as {
              __canvas: {
                client: {
                  elementProperties(r: unknown): Promise<{
                    entries: Array<{
                      path: string;
                      value?: { value?: unknown };
                    }>;
                  } | null>;
                };
              };
            }
          ).__canvas.client.elementProperties(ref);
          return JSON.stringify(
            p?.entries.find((e) => e.path === "frameFillColor")?.value?.value ??
              null,
          );
        }, mark.id),
      )
      .toContain("Black");
    await k.hold(400);
    await deselect(k);
    await k.hold(1200);
  });

  // ── Page two: the Excel workbook's chart, placed as vector shapes. ──
  let chartParts = 0;
  await k.scene("sheet", async () => {
    k.unfocus();
    await k.key("PageDown");
    await k.key("Meta+0", "Fit page", "⌘0");
    await k.hold(600);
    await k.recamera();
    // The chart lands beside the selection: under the story's frame.
    await press(k, page.locator('[data-tool-slot="select"]').first());
    await pointer.click(await pt(k, 300, P2 + 180), { targetWidth: 120 });
    const before = (await items(page)).length;
    const chooser = page.waitForEvent("filechooser", { timeout: 120_000 });
    await menu(k, ["Insert", "Spreadsheet…"]);
    k.chip("price-list.xlsx", "file");
    await (await chooser).setFiles(join(ASSETS, "price-list.xlsx"));
    const charts = page.locator('[data-sheet-section="charts"]');
    await expect(charts).toBeVisible({ timeout: 20_000 });
    await press(k, charts.locator("summary"));
    await expect(page.locator("[data-sheet-chart-list]")).toContainText(
      "Amount by item",
    );
    await press(k, page.locator("[data-sheet-chart-lower]").first());
    await expect
      .poll(async () => (await items(page)).length - before, {
        timeout: 15_000,
      })
      .toBeGreaterThan(5);
    chartParts = (await items(page)).length - before;
    await deselect(k, P2 + 400);
    k.focus(PAGE2);
    await k.hold(1200);
  });

  // ── A web frame: HTML and CSS, laid out on the page. ──
  await k.scene("web", async () => {
    k.unfocus();
    const before = (await items(page)).filter(
      (i) => i.id.kind === "rectangle",
    ).length;
    const chooser = page.waitForEvent("filechooser", { timeout: 120_000 });
    await menu(k, ["File", "Open…"]);
    k.chip("paper-goods.html", "file");
    await (await chooser).setFiles(join(ASSETS, "paper-goods.html"));
    await expect
      .poll(
        async () =>
          (await items(page)).filter((i) => i.id.kind === "rectangle").length,
        { timeout: 20_000 },
      )
      .toBe(before + 1);
    // It lands at the page's top left; moved beside the chart, then sized
    // to the chart's height by its corner handle.
    const web = (await items(page))
      .filter((i) => i.id.kind === "rectangle")
      .at(-1)!;
    const [t, l, b, r] = web.bounds;
    await pointer.drag(
      await pt(k, (l + r) / 2, P2 + (t + b) / 2),
      await pt(k, WEB.left + (r - l) / 2, P2 + WEB.top + (b - t) / 2),
      { speed: 1.2 },
    );
    await pointer.drag(
      await pt(k, WEB.left + (r - l), P2 + WEB.top + (b - t)),
      await pt(k, WEB.left + WEB.width, P2 + WEB.top + WEB.height),
      { speed: 1.2 },
    );
    // Beside the chart, within a point or two of where the hand aimed.
    const want = [
      WEB.top,
      WEB.left,
      WEB.top + WEB.height,
      WEB.left + WEB.width,
    ];
    await expect
      .poll(async () => {
        const got = (await items(page)).find((i) => i.id.id === web.id.id);
        return got
          ? Math.max(...got.bounds.map((v, j) => Math.abs(v - want[j])))
          : 99;
      })
      .toBeLessThan(3);
    await deselect(k, P2 + 400);
    k.focus(PAGE2);
    await k.hold(1600);
  });

  // ── Data: the product list, into DuckDB, in the Data layout. ──
  await k.scene("data", async () => {
    k.unfocus();
    await press(
      k,
      page.getByRole("button", { name: "Data layout", exact: true }).last(),
    );
    await k.hold(600);
    const chooser = page.waitForEvent("filechooser", { timeout: 120_000 });
    await press(k, page.locator("[data-data-import-csv]:visible").first());
    k.chip("catalogue.csv", "file");
    await (await chooser).setFiles(join(ASSETS, "catalogue.csv"));
    const status = page.locator("[data-status]").last();
    const ready = async () =>
      (await status.getAttribute("data-status").catch(() => null)) ?? "?";
    const quick = await expect
      .poll(ready, { timeout: 4000 })
      .toBe("ready")
      .then(
        () => true,
        () => false,
      );
    if (!quick)
      await k.cut("duckdb", () =>
        expect.poll(ready, { timeout: 60_000 }).toBe("ready"),
      );
    await expect(
      page.getByText("catalogue", { exact: true }).first(),
    ).toBeVisible();
    await k.hold(800);
  });

  // ── A frame bound to the EAN column, lowered to a vector barcode. ──
  await k.scene("barcode", async () => {
    const polys = new Set(
      (await items(page))
        .filter((i) => i.id.kind === "polygon")
        .map((i) => i.id.id),
    );
    await k.key("m", "Rectangle tool");
    await pointer.drag(
      await pt(k, CODE.x0, CODE.y0),
      await pt(k, CODE.x1, CODE.y1),
      { speed: 1.4 },
    );
    await press(k, page.getByText("Bindings", { exact: true }).last());
    const author = page.locator("[data-data-bind-author]");
    await choose(k, author.locator("[data-data-bind-kind]"), "barcode");
    await choose(
      k,
      author
        .locator("select")
        .filter({ has: page.locator('option[value="ean13"]') })
        .first(),
      "ean13",
    );
    await press(k, author.locator("[data-data-bind-field]"));
    await page.keyboard.type("ean", { delay: 90 });
    await press(k, author.locator("[data-data-bind-add]"));
    await expect(page.locator("[data-data-bind-msg]").first()).toContainText(
      "(ean13)",
    );
    await press(k, page.getByRole("button", { name: /lower to document/i }));
    await expect
      .poll(
        async () =>
          (await items(page)).filter(
            (i) => i.id.kind === "polygon" && !polys.has(i.id.id),
          ).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(20);
    const bars = (await items(page))
      .filter((i) => i.id.kind === "polygon" && !polys.has(i.id.id))
      .map((i) => i.bounds);
    const eans = readFileSync(join(ASSETS, "catalogue.csv"), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => l.split(",").at(-1)!.trim());
    expect(eans, "the barcode encodes an EAN from the data").toContain(
      decodeEan13(bars),
    );
    await deselect(k, P2 + 400);
    k.focus([CODE.x0 - 60, CODE.y0 - 60, CODE.x1 + 30, CODE.y1 + 40]);
    await k.hold(1600);
  });

  // ── Prepress: preflight, the whole document. ──
  await k.scene("preflight", async () => {
    k.unfocus();
    await press(
      k,
      page.getByRole("button", { name: "Prepress", exact: true }).last(),
    );
    await k.hold(500);
    await openPanel(page, "paged.preflight");
    await press(
      k,
      page.locator('[data-cockpit-action="run-validation"]:visible').first(),
    );
    await expect(
      page.getByText("No findings — the document exports cleanly.").first(),
    ).toBeVisible({ timeout: 30_000 });
    await k.hold(1200);
  });

  // ── A PDF for print. ──
  await k.scene("pdf", async () => {
    await menu(k, ["File", "Export PDF…"]);
    const dialog = page.locator("[role=dialog], dialog").first();
    await expect(dialog).toBeVisible();
    const conformance = dialog.locator("select").first();
    await hover(k, conformance);
    await conformance.selectOption({ label: "PDF 1.7" });
    await k.hold(300);
    const pdf = page.waitForEvent("download", { timeout: 120_000 });
    await press(k, dialog.getByRole("button", { name: /^Export$/ }));
    let file = await Promise.race([
      pdf,
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    if (!file) await k.cut("pdf", async () => void (file = await pdf));
    k.chip(`${file!.suggestedFilename()} saved`, "save");
    await press(k, dialog.getByRole("button", { name: "Close" }).first());
    await expect(dialog).toBeHidden();
    await file!.saveAs(join(k.dir, "home.pdf"));
    const bytes = readFileSync(join(k.dir, "home.pdf"));
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(
      (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length,
      "a page each",
    ).toBe(2);
    await k.hold(800);
  });

  // ── One .paged file, every plugin's content inside. ──
  await k.scene("save", async () => {
    const download = page.waitForEvent("download", { timeout: 120_000 });
    await k.key("Meta+s", "Save", "⌘S");
    const file = await download;
    const saved = join(k.dir, file.suggestedFilename());
    await file.saveAs(saved);
    k.chip(`${file.suggestedFilename()} saved`, "save");
    const zip = readFileSync(saved);
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    // Each plugin's own parts travel inside the one file, and the web
    // frame's source rides on its frame in the spread.
    const names = zipEntryNames(zip);
    for (const ns of [
      "media.paged.doc",
      "media.paged.image",
      "media.paged.sheet",
      "media.paged.data",
    ])
      expect(
        names.some((n) => n.startsWith(`paged/${ns}/`)),
        `${ns} travels in the file`,
      ).toBe(true);
    expect(
      names
        .filter((n) => n.startsWith("Spreads/"))
        .some((n) => readZipText(zip, n)?.includes("media.paged.web")),
      "the web frame's source travels in the file",
    ).toBe(true);
    expect(chartParts).toBeGreaterThan(5);
    expect(p2Frame).not.toBe("");
    // The finished pages, as they print: back in the Design workspace, the
    // whole document, and Preview hides the guides and frame edges.
    await press(
      k,
      page.getByRole("button", { name: "Design", exact: true }).last(),
    );
    await k.key("Alt+Shift+Meta+0", "Fit document", "⌥⇧⌘0");
    await press(k, page.getByRole("button", { name: "Preview" }).first());
    await k.hold(300);
    await k.recamera();
    k.focus(SPREAD, 1.3);
    await k.hold(1800);
  });
});
