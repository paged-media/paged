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

// The six screens on paged.media (website ADR 858), captured from the real
// editor: one still per theme, each state reached through the editor's own
// automation and asserted against the engine before the picture is taken.
// Not a film: no voice, no cursor. Recorded locally (PAGED_MEDIA_ROOT), into
// <media>/.build/stills/<id>.png at 1536×860 CSS px, device scale 2, each
// with its entry in stills.json (kit.ts).
//
// Five come from the showcase annual (tests/showcase, a 134-page document
// built by driving this editor, with its fonts registered first so no run
// falls back to a substitute); the catalogue is built here from the data
// film's product list.

import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Designer } from "../../journey/driver/designer";
import { ShowcaseDoc } from "../../showcase/driver";
import { dressStage } from "../kit/stage";
import { sampleRole } from "../kit/samples";
import {
  ASSETS,
  openShowcase,
  canvas,
  deselect,
  FONTS,
  goTo,
  hidePanels,
  openSampleStill,
  OUT,
  park,
  ROOT,
  seasoned,
  SHOWCASE,
  shot,
  showPanel,
  STILL_VIEW,
  zoomAt,
} from "./kit";

test.skip(!ROOT, "PAGED_MEDIA_ROOT is not set (stills are captured locally)");
test.use({
  viewport: STILL_VIEW,
  deviceScaleFactor: 2,
  colorScheme: "dark",
});

const CSV = join(ASSETS, "catalogue.csv");

type CanvasGlobal = { __canvas: any };

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(SHOWCASE))
    throw new Error(
      `no showcase at ${SHOWCASE}: build it with --project=showcase`,
    );
});

test("stills · from the showcase annual", async ({ page }) => {
  test.setTimeout(600_000);
  // The command bar as play.paged.media serves it, where the Claude proxy
  // is deployed: its availability probe (editor ADR 252) is answered the
  // way that proxy answers a bare GET. The still asks Claude nothing.
  await page.route("**/api/ai/**", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 405,
          contentType: "application/json",
          body: '{"type":"error","error":{"type":"invalid_request_error","message":"POST only"}}',
        })
      : route.abort(),
  );
  await openShowcase(page);

  // ── tables: page 66, a table in its document style, and the table styles. ──
  await goTo(page, 66);
  const story66 = await canvas(
    page,
    async (c) =>
      (
        await c.client.send({
          kind: "hitTest",
          payload: {
            pageId: c.handle.pageIds[65],
            docPoint: [264, 400],
            filter: "any",
          },
        })
      ).payload.storyId,
  );
  const tables = await canvas(
    page,
    async (c, sid) => {
      const out: Record<string, unknown> = {};
      for (const t of await c.objects.query(`story:${sid} > table`))
        out[t] = (await c.objects.get(t, "appliedTableStyle")).value;
      return out;
    },
    story66,
  );
  expect(
    Object.values(tables),
    "the page plan wears the annual's table style",
  ).toEqual(["TableStyle/Annual Table"]);
  await showPanel(page, "paged.table-styles");
  await expect(
    page.getByText("Annual Table", { exact: true }).filter({ visible: true }),
  ).toHaveCount(1);
  const scale66 = await zoomAt(page, 66, 264, 70, 1.05);
  await park(page);
  await page.waitForTimeout(900);
  await shot(page, "tables", {
    page: 66,
    story: story66,
    tables,
    scale: scale66,
  });
  await hidePanels(page, /table-styles$/);
});

// ── On a sample publication (website ADR 863): type, image, prepress and the
//    command bar on a page of a real magazine, rebuilt from its publisher's
//    PDF. Which one, which page and where on it is the storyboard's
//    (films/samples.take.json, "stills"): this repository names no
//    publication. The table still stays on the showcase: a sample's tables
//    are set with tabs, not table objects. ──
test("stills · on a sample publication", async ({ page }) => {
  test.setTimeout(900_000);
  await page.route("**/api/ai/**", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 405,
          contentType: "application/json",
          body: '{"type":"error","error":{"type":"invalid_request_error","message":"POST only"}}',
        })
      : route.abort(),
  );
  const ref = sampleRole("stills");
  const n = ref.page as number;
  const at = (key: string) => ref[key] as number[];
  await openSampleStill(page, ref);
  await goTo(page, n);
  const fitPage = () =>
    canvas(page, (c) => c.registries.commands.invoke("paged.view.fitPage"));

  // ── type: a caret in a paragraph of the magazine, the paragraph styles. ──
  const [tx, ty] = at("typePoint");
  const hit = await canvas(
    page,
    async (c, a) =>
      (
        await c.client.send({
          kind: "hitTest",
          payload: {
            pageId: c.handle.pageIds[a.n - 1],
            docPoint: [a.tx, a.ty],
            filter: "text",
          },
        })
      ).payload,
    { n, tx, ty },
  );
  expect(hit.storyId, "a story under the paragraph").toBeTruthy();
  await canvas(
    page,
    (c, s) => c.setContentSelection({ storyId: s, start: 40, end: 40 }),
    hit.storyId,
  );
  await showPanel(page, "paged.paragraph-styles");
  const [zx, zy, zs] = at("typeZoom");
  const typeScale = await zoomAt(page, n, zx, zy, zs);
  await park(page);
  await expect(page.getByRole("combobox").first()).toHaveValue(/./);
  const style = await page
    .locator("select:visible")
    .first()
    .evaluate(
      (el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent,
    );
  expect(style, "the caret's paragraph wears a named style").toBeTruthy();
  await page.waitForTimeout(800);
  await shot(page, "type", {
    page: n,
    story: hit.storyId,
    scale: typeScale,
    style,
  });
  await hidePanels(page, /paragraph-styles$/);

  // ── image: the magazine's photograph, open for editing where it sits. ──
  await goTo(page, n);
  await fitPage();
  const photo = await canvas(
    page,
    async (c, a) => {
      const ids = (
        await c.client.marqueeHits(c.handle.pageIds[a.n - 1], a.rect)
      ).filter((i: any) => i.kind === "rectangle");
      c.setElementSelection(ids.slice(0, 1), "replace");
      return ids.slice(0, 1);
    },
    { n, rect: at("photoRect") },
  );
  expect(photo, "a placed photograph").toHaveLength(1);
  await page
    .locator("header")
    .getByText("Plugins", { exact: true })
    .first()
    .click();
  await page
    .getByRole("menuitem", { name: /^Image/ })
    .first()
    .hover();
  await page
    .getByRole("menuitem", { name: /^Adjust/ })
    .first()
    .click();
  await expect(page.getByText("Image adjustments")).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      () => canvas(page, (c) => c.debugContext().editContext?.type ?? null),
      {
        timeout: 30_000,
      },
    )
    .toBe("rasterImage");
  const [ix, iy, is] = at("imageZoom");
  const imageScale = await zoomAt(page, n, ix, iy, is);
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await park(page);
  await page.waitForTimeout(1500);
  await shot(page, "image", {
    page: n,
    element: photo[0],
    context: "rasterImage",
    scale: imageScale,
  });
  await page.keyboard.press("Escape");
  await hidePanels(page, /image/i);
  await page.waitForTimeout(800);

  // ── prepress: Prepress mode, the real output check run on the publication. ──
  await goTo(page, n);
  await fitPage();
  await page
    .getByRole("button", { name: "Prepress", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "Validate output" }).first().click();
  // A clean publication reports "No findings".
  const findings = page.getByText(/\d+ findings?\b|No findings/).first();
  await expect(findings).toBeVisible({ timeout: 120_000 });
  await park(page);
  await page.waitForTimeout(800);
  await shot(page, "prepress", {
    page: n,
    findings: await findings.textContent(),
    readiness: await page
      .getByText(/Not ready|Ready/)
      .first()
      .textContent(),
  });
  await page
    .getByRole("button", { name: "Design", exact: true })
    .last()
    .click();

  // ── command: the command bar, asked for something no command does. ──
  await goTo(page, n);
  await fitPage();
  await showPanel(page, "paged.paragraph-styles");
  await page.keyboard.press("Meta+k");
  const input = page.getByPlaceholder("Ask or search anything…");
  await input.waitFor();
  const ask = "Make every headline one size larger";
  await input.pressSequentially(ask, { delay: 15 });
  await expect(page.locator("[data-palette-ai]")).toBeVisible();
  await park(page);
  await page.waitForTimeout(700);
  await shot(page, "command", { page: n, query: ask });
  await page.keyboard.press("Escape");
});

// ── catalogue: the data film's product list merged into catalogue pages. ──

type Bounds = [number, number, number, number];

async function mutate(page: Page, op: string, args: unknown): Promise<unknown> {
  const reply = (await page.evaluate(
    ([op, args]) =>
      (globalThis as unknown as CanvasGlobal).__canvas.client.mutate({
        op,
        args,
      }),
    [op, args] as const,
  )) as { kind: string };
  if (reply.kind !== "mutationApplied")
    throw new Error(
      `${op} was not applied: ${JSON.stringify(reply).slice(0, 300)}`,
    );
  return reply;
}

async function storyAt(page: Page, pageId: string, b: Bounds): Promise<string> {
  const id = await canvas(
    page,
    async (c, a) =>
      (
        await c.client.send({
          kind: "hitTest",
          payload: { pageId: a.pageId, docPoint: [a.x, a.y], filter: "text" },
        })
      ).payload.storyId ?? null,
    { pageId, x: (b[1] + b[3]) / 2, y: (b[0] + b[2]) / 2 },
  );
  if (!id) throw new Error(`no story at ${b}`);
  return id;
}

const len = (v: number) => ({ type: "length", value: v });
const txt = (v: string) => ({ type: "text", value: v });
const color = (v: string) => ({ type: "colorRef", value: v });

/** The data film's catalogue template: a running header and one product card
 *  of four <<field>> frames, each in its own paragraph style. */
async function buildTemplate(page: Page, designer: Designer): Promise<void> {
  const ink = await designer.createSwatch("Ink", [28, 26, 38]);
  const teal = await designer.createSwatch("Teal", [14, 116, 144]);
  const grey = await designer.createSwatch("Grey", [104, 100, 118]);
  const styles: Array<[string, string, Array<[string, unknown]>]> = [
    [
      "ParagraphStyle/Header",
      "Catalogue header",
      [
        ["characterFontFamily", txt("Inter")],
        ["characterFontSize", len(8)],
        ["characterLeading", len(10)],
        ["characterTracking", len(140)],
        ["characterFillColor", color(grey)],
      ],
    ],
    [
      "ParagraphStyle/Name",
      "Product name",
      [
        ["characterFontFamily", txt("Fraunces")],
        ["characterFontSize", len(17)],
        ["characterLeading", len(20)],
        ["characterFillColor", color(ink)],
      ],
    ],
    [
      "ParagraphStyle/Detail",
      "Product detail",
      [
        ["characterFontFamily", txt("Inter")],
        ["characterFontSize", len(9)],
        ["characterLeading", len(12)],
        ["characterFillColor", color(grey)],
      ],
    ],
    [
      "ParagraphStyle/Price",
      "Product price",
      [
        ["characterFontFamily", txt("Inter")],
        ["characterFontSize", len(13)],
        ["characterLeading", len(16)],
        ["characterFillColor", color(teal)],
      ],
    ],
    [
      "ParagraphStyle/Sku",
      "Product SKU",
      [
        ["characterFontFamily", txt("JetBrains Mono")],
        ["characterFontSize", len(7.5)],
        ["characterLeading", len(10)],
        ["characterTracking", len(40)],
        ["characterFillColor", color(grey)],
        ["paragraphJustification", txt("RightAlign")],
      ],
    ],
  ];
  for (const [selfId, name, props] of styles) {
    await mutate(page, "createParagraphStyle", { selfId, name, basedOn: null });
    for (const [path, value] of props)
      await mutate(page, "setStyleProperty", {
        collection: "paragraph",
        styleId: selfId,
        path,
        value,
      });
  }
  const pageId = await canvas(page, (c) => c.handle.pageIds[0] as string);
  for (const [path, v] of [
    ["pageMarginTop", 84],
    ["pageMarginLeft", 54],
    ["pageMarginBottom", 36],
    ["pageMarginRight", 54],
  ] as const) {
    await mutate(page, "set", {
      address: `page:${pageId}`,
      path,
      value: len(v),
    });
  }
  const frames: Array<[Bounds, string, string]> = [
    [
      [40, 54, 56, 558],
      "DESK & PAPER  ·  SPRING CATALOGUE",
      "ParagraphStyle/Header",
    ],
    [[84, 54, 110, 294], "<<name>>", "ParagraphStyle/Name"],
    [[110, 54, 138, 294], "<<detail>>", "ParagraphStyle/Detail"],
    [[142, 54, 164, 180], "<<price>>", "ParagraphStyle/Price"],
    [[146, 180, 162, 294], "SKU <<sku>>", "ParagraphStyle/Sku"],
  ];
  for (const [b, text, style] of frames) {
    await mutate(page, "insertTextFrame", { pageId, bounds: b });
    const storyId = await storyAt(page, pageId, b);
    await mutate(page, "insertText", { storyId, offset: 0, text });
    await mutate(page, "applyStyle", {
      storyId,
      start: 0,
      end: text.length,
      style,
      scope: "paragraph",
    });
  }
}

/** Every text frame's text, page by page (the data film's reader). */
async function pageTexts(page: Page): Promise<string[][]> {
  return page.evaluate(async () => {
    type Reply = { kind: string; payload: Record<string, unknown> };
    const c = (
      globalThis as unknown as {
        __canvas: { client: { send(m: unknown): Promise<Reply> } };
      }
    ).__canvas;
    const tree = await c.client.send({ kind: "requestSceneTree" });
    type Node = {
      kind: string;
      id?: { kind: string; id: string } | null;
      children?: Node[];
    };
    const pages: { kind: string; id: string }[][] = [];
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.kind === "Page")
          pages.push(
            (n.children ?? [])
              .map((x) => x.id)
              .filter(
                (id): id is { kind: string; id: string } =>
                  !!id && id.kind === "textFrame",
              ),
          );
        else if (n.children) walk(n.children);
      }
    };
    walk(((tree.payload as { roots?: Node[] }).roots ?? []) as Node[]);
    const out: string[][] = [];
    for (const frames of pages) {
      const g = await c.client.send({
        kind: "requestElementGeometry",
        payload: { ids: frames },
      });
      const texts: string[] = [];
      for (const it of (g.payload as { items?: { storyId?: string }[] })
        .items ?? []) {
        if (!it.storyId) continue;
        const r = await c.client.send({
          kind: "requestStoryContent",
          payload: { storyId: it.storyId },
        });
        const content = (
          r.payload as {
            content?: { paragraphs: { runs: { text: string }[] }[] };
          }
        ).content;
        texts.push(
          content
            ? content.paragraphs
                .map((p) => p.runs.map((x) => x.text).join(""))
                .join("\n")
            : "",
        );
      }
      out.push(texts);
    }
    return out;
  });
}

test("stills · a catalogue merged from product data", async ({ page }) => {
  test.setTimeout(300_000);
  await dressStage(page);
  await seasoned(page);
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  await new ShowcaseDoc(page).registerFonts(FONTS);
  await buildTemplate(page, designer);
  await page.waitForTimeout(800);

  // The product list, into the data engine, through the Data layout's own import.
  await page
    .getByRole("button", { name: "Data layout", exact: true })
    .last()
    .click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator("[data-data-import-csv]:visible").first().click();
  await (await chooser).setFiles(CSV);
  const status = page.locator("[data-status]").last();
  await expect
    .poll(
      async () =>
        (await status.getAttribute("data-status").catch(() => null)) ?? "?",
      { timeout: 60_000 },
    )
    .toBe("ready");

  // The merge: several records to a page, the template making way.
  await page.getByText("Bindings", { exact: true }).last().click();
  const row = page.locator("[data-data-merge]");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.locator("[data-data-merge-mode]").selectOption("multiple");
  const keep = row.getByLabel("Keep template", { exact: true });
  if (await keep.isChecked()) await keep.click();
  await row.locator("[data-data-merge-run]").click();
  const merged = page.locator("[data-data-merge-msg]");
  await expect(merged).toHaveText("Merged 24 records onto 2 pages", {
    timeout: 60_000,
  });
  const texts = (await pageTexts(page)).flat();
  expect(
    texts.filter((t) => t.includes("<<")),
    "no field left unmerged",
  ).toEqual([]);
  expect(
    texts.filter((t) => t.startsWith("SKU ")),
    "one card per record",
  ).toHaveLength(24);

  await deselect(page).catch(() => {});
  const scale = await zoomAt(page, 1, 200, 40, 1.0);
  await park(page);
  await page.waitForTimeout(1200);
  await shot(page, "catalogue", {
    records: 24,
    pages: 2,
    message: await merged.textContent(),
    scale,
  });
});
