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

// The Mesh tool and the Gradient tool's freeform modes (WP7.2, engine
// ADR 1048), driven through the real rail, canvas and Color panel on a
// File ▸ New document (corpus-free): a click makes a 2×2 mesh, a node
// drag moves the node, a colour applied in the Color panel colours the
// selected node and repaints the rectangle; every gesture is ONE undo
// step that restores the exact previous `frameFillMesh`. The freeform
// "points" mode adds a point with a click, and one undo removes it.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../journey/driver/designer";
import { opSandwich } from "./harness/op-sandwich";
import { mutate, openPanel, selectElements } from "./harness/ui";
import { dragMouse, screenPoint } from "./harness/viewport";

type Ref = { kind: string; id: string };
type Vec2 = [number, number];
interface Node {
  point: Vec2;
  handles: [Vec2, Vec2, Vec2, Vec2];
  color: { space: string; value: number[] };
}
interface Fill {
  kind: "mesh" | "freeform";
  grids?: Array<{ rows: number; cols: number; nodes: Node[] }>;
  points?: Array<{ point: Vec2; color: unknown }>;
  lines?: number[][];
}

interface CanvasGlobal {
  __canvas: {
    client: {
      collection: (n: string) => Promise<Array<Record<string, unknown>>>;
      executeScript: (
        s: string,
      ) => Promise<{ output: string[]; error: string | null }>;
      elementProperties: (id: unknown) => Promise<{
        entries: Array<{ path: string; value: unknown }>;
      } | null>;
      elementGeometry: (ids: unknown[]) => Promise<
        Array<{
          bounds: [number, number, number, number];
          itemTransform?: number[] | null;
        }>
      >;
      undo: () => Promise<unknown>;
    };
  };
}

/** The rectangle's box, page-local pt (`[top, left, bottom, right]`). */
const BOX: [number, number, number, number] = [120, 100, 320, 400];

async function firstPage(page: Page) {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.pages()");
    const pages = JSON.parse(r.output[0] ?? "[]") as Array<{
      selfId: string;
      sizePt: [number, number];
    }>;
    const rows = await c.collection("pages");
    const row = rows.find((p) => p.selfId === pages[0]!.selfId);
    const origin = Array.isArray(row?.pageOrigin)
      ? (row!.pageOrigin as [number, number])
      : ([0, 0] as [number, number]);
    return { pageId: pages[0]!.selfId, widthPt: pages[0]!.sizePt[0], origin };
  });
}

async function rectangles(page: Page): Promise<Ref[]> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.tree()");
    type N = { id?: Ref | null; children?: N[] };
    const out: Ref[] = [];
    const walk = (nodes: N[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.id?.kind === "rectangle") out.push(n.id);
        walk(n.children);
      }
    };
    walk(JSON.parse(r.output[0] ?? "[]") as N[]);
    return out;
  });
}

async function fillMesh(page: Page, ref: Ref): Promise<Fill | null> {
  return page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const props = await c.elementProperties(id);
    const v = props?.entries.find((e) => e.path === "frameFillMesh")?.value as
      { value?: Fill | null } | undefined;
    return v?.value ?? null;
  }, ref);
}

/** Inner → page-local pt for the rectangle (its item transform). */
async function innerToPage(page: Page, ref: Ref) {
  const m = await page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const [g] = await c.elementGeometry([id]);
    return g?.itemTransform ?? null;
  }, ref);
  return (p: Vec2): Vec2 =>
    m
      ? [
          m[0]! * p[0] + m[2]! * p[1] + m[4]!,
          m[1]! * p[0] + m[3]! * p[1] + m[5]!,
        ]
      : p;
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (globalThis as unknown as CanvasGlobal).__canvas.client.undo();
  });
}

/** File ▸ New, one rectangle filled with a CMYK swatch, selected. */
async function setUp(page: Page) {
  const designer = new Designer(page);
  await designer.open();
  await designer.newDocument();
  const first = await firstPage(page);
  const before = (await rectangles(page)).length;
  await mutate(page, {
    op: "createSwatch",
    args: {
      spec: {
        selfId: null,
        name: "Mesh Teal",
        space: "CMYK",
        value: [80, 0, 40, 0],
        model: "Process",
        alternateSpace: null,
        alternateValue: [],
        tint: null,
        alpha: null,
      },
    },
  });
  const swatches = await page.evaluate(async () =>
    (
      await (globalThis as unknown as CanvasGlobal).__canvas.client.collection(
        "swatches",
      )
    ).map((s) => s.selfId as string),
  );
  const swatch = swatches.at(-1)!;
  await mutate(page, {
    op: "batch",
    args: {
      ops: [
        { op: "insertFrame", args: { pageId: first.pageId, bounds: BOX } },
        {
          op: "setElementProperty",
          args: {
            elementId: { kind: "rectangle", id: "$created" },
            path: "frameFillColor",
            value: { type: "colorRef", value: swatch },
          },
        },
      ],
    },
  });
  const all = await rectangles(page);
  expect(all.length).toBe(before + 1);
  const rect = all.at(-1)!;
  await selectElements(page, [rect]);
  /** Screen point of a page-local pt point. */
  const screen = (p: Vec2) =>
    screenPoint(page, first.origin[0] + p[0], first.origin[1] + p[1]);
  return { ...first, rect, screen };
}

/** Pick a member of the Gradient Swatch slot's flyout. */
async function pickFromGradientSlot(page: Page, tool: string) {
  await page
    .locator('[data-tool-slot="gradientSwatch"]')
    .click({ button: "right" });
  await page
    .locator(`[data-tool-flyout="gradientSwatch"] [data-tool="${tool}"]`)
    .click();
  await expect(
    page.locator(
      `[data-tool-slot="gradientSwatch"][data-active="true"][data-tool="${tool}"]`,
    ),
  ).toBeVisible();
}

const close = (a: Vec2, b: Vec2, eps: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;

test.describe("the Mesh tool", () => {
  test("AC-MESH-1 — a click makes a 2×2 mesh, a node drag moves it, the Color panel colours it; each is one undo step @feat:color-swatches.mesh-freeform-gradients @level:happy", async ({
    page,
  }) => {
    covers("tool:paged.tool.mesh", "panel:paged.color");
    const { pageId, widthPt, rect, screen } = await setUp(page);
    await pickFromGradientSlot(page, "paged.tool.mesh");

    // 1 — the click: a 2×2 grid, the middle node at the click.
    const click: Vec2 = [200, 180];
    const at = await screen(click);
    await page.mouse.click(at.x, at.y);
    await expect
      .poll(async () => (await fillMesh(page, rect))?.grids?.[0]?.rows ?? 0)
      .toBe(2);
    const made = (await fillMesh(page, rect))!;
    expect(made.kind).toBe("mesh");
    expect(made.grids![0]!.cols).toBe(2);
    const toPage = await innerToPage(page, rect);
    const middle = made.grids![0]!.nodes[4]!;
    // The click lands on the new node, through the item transform (a
    // screen pixel is under 1 pt at the fitted zoom; 1.5 pt slack).
    expect(close(toPage(middle.point), click, 1.5)).toBe(true);
    // One undo removes the mesh exactly.
    await undo(page);
    await expect.poll(() => fillMesh(page, rect)).toBeNull();
    await page.evaluate(async () => {
      await (
        globalThis as unknown as {
          __canvas: { client: { redo: () => Promise<unknown> } };
        }
      ).__canvas.client.redo();
    });
    await expect.poll(() => fillMesh(page, rect)).toEqual(made);

    // 2 — the node drag: the node (and its handles) move, one step.
    const from = await screen(toPage(middle.point));
    const to = await screen([
      toPage(middle.point)[0] + 40,
      toPage(middle.point)[1] + 30,
    ]);
    await dragMouse(page, from, to);
    await expect
      .poll(async () => {
        const n = (await fillMesh(page, rect))?.grids?.[0]?.nodes[4];
        return n ? Math.round(toPage(n.point)[0] - toPage(middle.point)[0]) : 0;
      })
      .toBeGreaterThan(30);
    const moved = (await fillMesh(page, rect))!;
    expect(moved.grids![0]!.nodes[0]).toEqual(made.grids![0]!.nodes[0]);
    await undo(page);
    await expect.poll(() => fillMesh(page, rect)).toEqual(made);

    // 3 — the colour: the selected node takes the Color panel's colour;
    // the rectangle repaints; one undo restores the mesh and the pixels.
    await openPanel(page, "paged.color");
    const panel = page.locator('[data-color-panel="ready"]');
    await expect(panel).toHaveAttribute("data-target", "paint-target");
    await expect(
      page.locator('[data-paint-target="paged.tool.mesh"]'),
    ).toBeVisible();
    await page.locator('[data-mixer-space="RGB"]').click();
    const channels = page.locator("[data-mixer-channel] input");
    await channels.nth(0).fill("255");
    await channels.nth(1).fill("200");
    await channels.nth(2).fill("0");
    await channels.nth(2).blur();
    await opSandwich(page, {
      pageId,
      pageWidthPt: widthPt,
      region: { top: BOX[0], left: BOX[1], bottom: BOX[2], right: BOX[3] },
      regionSlackPx: 4,
      apply: async () => {
        await page.locator("[data-mixer-apply]").click();
      },
      expectModel: async () => {
        await expect
          .poll(
            async () =>
              (await fillMesh(page, rect))?.grids?.[0]?.nodes[4]?.color,
          )
          .toEqual({ space: "RGB", value: [255, 200, 0] });
        const now = (await fillMesh(page, rect))!;
        expect(now.grids![0]!.nodes[0]!.color).toEqual(
          made.grids![0]!.nodes[0]!.color,
        );
      },
      dumpModel: async () => JSON.stringify(await fillMesh(page, rect)),
      expectRestored: async () => {
        expect(await fillMesh(page, rect)).toEqual(made);
      },
    });
  });
});

test.describe("the Gradient tool's freeform points mode", () => {
  test("AC-MESH-2 — in Freeform points a click adds a gradient point; one undo removes it @feat:color-swatches.mesh-freeform-gradients @level:happy", async ({
    page,
  }) => {
    covers(
      "tool:paged.tool.gradientSwatch",
      "setting:paged.tool.gradientSwatch.mode",
    );
    const { rect, screen } = await setUp(page);
    await page.locator('[data-tool-slot="gradientSwatch"]').click();
    await expect(
      page.locator(
        '[data-tool-slot="gradientSwatch"][data-active="true"][data-tool="paged.tool.gradientSwatch"]',
      ),
    ).toBeVisible();
    // The mode, through the real double-click options popover.
    const popover = page.locator(
      '[data-tool-options="paged.tool.gradientSwatch"]',
    );
    await page.locator('[data-tool-slot="gradientSwatch"]').dblclick();
    await popover
      .locator('[data-tool-option="mode"]')
      .selectOption("freeformPoints");
    await page.mouse.click(5, 5);
    await expect(popover).toBeHidden();
    await selectElements(page, [rect]);

    const point: Vec2 = [250, 220];
    const at = await screen(point);
    await page.mouse.click(at.x, at.y);
    await expect
      .poll(async () => (await fillMesh(page, rect))?.points?.length ?? 0)
      .toBe(1);
    const spec = (await fillMesh(page, rect))!;
    expect(spec.kind).toBe("freeform");
    const toPage = await innerToPage(page, rect);
    expect(close(toPage(spec.points![0]!.point), point, 1.5)).toBe(true);
    await undo(page);
    await expect.poll(() => fillMesh(page, rect)).toBeNull();
  });
});
