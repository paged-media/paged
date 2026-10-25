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

// Photoshop's blend modes (engine ADR 1016) through the Effects panel: a
// grey square over a darker one, the top square set to Linear Burn in
// the real menu. The overlap must darken (Linear Burn is not Normal), the
// property must read back, the panel must say what IDML keeps, and one
// undo must restore the model and the pixels. Corpus-free: File ▸ New and
// two squares written in code.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { Designer } from "../journey/driver/designer";
import { opSandwich } from "./harness/op-sandwich";
import { mutate, openPanel, selectElements } from "./harness/ui";

type Ref = { kind: string; id: string };

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
    };
  };
}

const square = (x: number, y: number, n: number) =>
  (
    [
      [x, y],
      [x + n, y],
      [x + n, y + n],
      [x, y + n],
    ] as const
  ).map(([px, py]) => {
    const p: [number, number] = [px, py];
    return { anchor: p, left: p, right: p };
  });

async function firstPage(page: Page) {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.pages()");
    const pages = JSON.parse(r.output[0] ?? "[]") as Array<{
      selfId: string;
      sizePt: [number, number];
    }>;
    return { pageId: pages[0]!.selfId, widthPt: pages[0]!.sizePt[0] };
  });
}

async function polygons(page: Page): Promise<Ref[]> {
  return page.evaluate(async () => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const r = await c.executeScript("paged.tree()");
    type Node = { id?: Ref | null; children?: Node[] };
    const out: Ref[] = [];
    const walk = (nodes: Node[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.id?.kind === "polygon") out.push(n.id);
        walk(n.children);
      }
    };
    walk(JSON.parse(r.output[0] ?? "[]") as Node[]);
    return out;
  });
}

async function blendMode(page: Page, ref: Ref): Promise<unknown> {
  return page.evaluate(async (id) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas.client;
    const props = await c.elementProperties(id);
    const v = props?.entries.find((e) => e.path === "frameBlendMode")
      ?.value as { value?: unknown } | undefined;
    return v?.value ?? null;
  }, ref);
}

/** A black square at `tint` % with the handle `h`. */
const tinted = (
  pageId: string,
  h: string,
  x: number,
  n: number,
  tint: number,
) => [
  { op: "insertPath", args: { pageId, anchors: square(x, x, n), open: false } },
  { op: "bindCreated", args: { handle: h } },
  {
    op: "setElementProperty",
    args: {
      elementId: { kind: "polygon", id: `$h:${h}` },
      path: "frameFillColor",
      value: { type: "colorRef", value: "Color/Black" },
    },
  },
  {
    op: "setElementProperty",
    args: {
      elementId: { kind: "polygon", id: `$h:${h}` },
      path: "frameFillTint",
      value: { type: "length", value: tint },
    },
  },
];

test.describe("Photoshop's blend modes in the Effects panel", () => {
  test("AC-BLEND-27-1 — Linear Burn darkens the overlap, reads back, notes the IDML loss, one undo restores @feat:effects-transparency.blend-modes-27 @feat:editor-shell.panels.effects @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.effects");
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    const { pageId, widthPt } = await firstPage(page);

    const before = (await polygons(page)).length;
    await mutate(page, {
      op: "batch",
      args: {
        ops: [
          ...tinted(pageId, "under", 100, 200, 50),
          ...tinted(pageId, "top", 200, 200, 40),
        ],
      },
    });
    const all = await polygons(page);
    expect(all.length).toBe(before + 2);
    const top = all[all.length - 1]!;

    await openPanel(page, "paged.effects");
    await selectElements(page, [top]);
    const menu = page.locator("select[data-blend-mode]");
    await expect(menu).toHaveValue("Normal");
    // 27 modes, the eleven InDesign cannot store marked.
    await expect(menu.locator("option")).toHaveCount(27);
    await expect(menu.locator("option[data-not-in-idml]")).toHaveCount(11);
    expect(await blendMode(page, top)).toBe("Normal");

    await opSandwich(page, {
      pageId,
      pageWidthPt: widthPt,
      // The overlap: the only pixels the mode changes.
      region: { top: 200, left: 200, bottom: 300, right: 300 },
      regionSlackPx: 4,
      apply: async () => {
        await menu.selectOption("LinearBurn");
      },
      expectModel: async () => {
        expect(await blendMode(page, top)).toBe("LinearBurn");
        await expect(menu).toHaveValue("LinearBurn");
        await expect(page.locator("[data-blend-not-in-idml]")).toContainText(
          "Multiply",
        );
      },
      dumpModel: async () => JSON.stringify(await blendMode(page, top)),
      expectRestored: async () => {
        expect(await blendMode(page, top)).toBe("Normal");
        await expect(menu).toHaveValue("Normal");
        await expect(page.locator("[data-blend-not-in-idml]")).toHaveCount(0);
      },
    });
  });
});
