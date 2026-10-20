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

// UX audit F-03 (no document open) and F-31 (ruler labels), in the real
// editor (ADRs 262 and 263):
//
//   F-03  a picture dropped with nothing open opens as a document: one
//         page the picture's size, the picture placed on it edge to edge.
//   F-31  at the least zoom the ruler's labels are thinned so none runs
//         into the next, and the numbers left of the origin keep their
//         minus sign.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { openShell } from "./harness/shell-surface";

type Handle = { pageCount: number; pageSizesPt: Array<[number, number]> };
type G = {
  __canvas: {
    handle: Handle | null;
    client: { sceneTree(): Promise<unknown[]> };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

/** Page items in the document (leaves of the scene tree under pages). */
async function itemKinds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const tree = await (globalThis as unknown as G).__canvas.client.sceneTree();
    const kinds: string[] = [];
    const visit = (node: { kind?: string; children?: unknown[] }) => {
      if (node.kind && !["Spread", "Page"].includes(node.kind))
        kinds.push(node.kind);
      for (const c of (node.children ?? []) as Array<typeof node>) visit(c);
    };
    for (const root of tree as Array<{ kind?: string; children?: unknown[] }>)
      visit(root);
    return kinds;
  });
}

const handle = (page: Page) =>
  page.evaluate(() => {
    const h = (globalThis as unknown as G).__canvas.handle;
    return h ? { pageCount: h.pageCount, size: h.pageSizesPt[0] } : null;
  });

test.describe("F-03 — a picture opened with no document", () => {
  test("a dropped PNG opens as a page its own size with the picture on it", async ({
    page,
  }) => {
    covers("command:paged.insert.placeImage");
    await openShell(page, { doc: false });
    expect(await handle(page)).toBeNull();
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(120, 80);
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#c03";
      g.fillRect(0, 0, 120, 80);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const file = new File([blob], "swatch.png", { type: "image/png" });
      const target = document.querySelector("[data-cockpit-canvas]");
      if (!target) throw new Error("no canvas drop target");
      const transfer = new DataTransfer();
      transfer.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
            clientX: 300,
            clientY: 300,
          }),
        );
      }
    });
    await expect
      .poll(() => handle(page), { timeout: 15_000 })
      .toEqual({ pageCount: 1, size: [120, 80] });
    await expect
      .poll(() => itemKinds(page), { timeout: 15_000 })
      .toHaveLength(1);
  });
});

test.describe("F-31 — ruler labels at low zoom", () => {
  test("at 5 % no label runs into the next, and negatives keep their sign", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await page.evaluate(async () => {
      const c = (globalThis as unknown as G).__canvas;
      for (let i = 0; i < 60; i++)
        await c.registries.commands.invoke("paged.view.zoomOut");
    });
    const labels = page.locator("[data-h-ruler] [data-ruler-label]");
    await expect.poll(() => labels.count()).toBeGreaterThan(1);
    const boxes = await labels.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, text: el.textContent ?? "" };
      }),
    );
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.left).toBeGreaterThan(boxes[i - 1]!.right + 4);
    }
    // Every number is a whole label: a negative one starts with its sign.
    const ruler = await page.locator("[data-h-ruler]").boundingBox();
    for (const b of boxes) {
      if (b.left >= (ruler?.x ?? 0)) expect(b.text).toMatch(/^(−)?\d+$/);
    }
  });
});
