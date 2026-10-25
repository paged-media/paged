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

// File ▸ Import ▸ SVG… and File ▸ Export ▸ SVG (engine ADR 1018): an SVG
// with a gradient and a clip path is chosen in the real file picker,
// lands as native items (a gradient swatch, the clipped shape pasted into
// its clip frame) in ONE undo step, and is selected; the page and the
// selection export as SVG downloads.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { clickMenuRow, openShell } from "./harness/shell-surface";

type Node = { id?: unknown; children?: Node[] };

type Canvas = {
  __canvas: {
    client: {
      collection(name: string): Promise<Array<Record<string, unknown>>>;
      send(m: unknown): Promise<{ kind: string; payload: { roots: Node[] } }>;
    };
    registries: {
      commands: { invoke(id: string, payload?: unknown): Promise<unknown> };
    };
    elementSelection?: unknown[];
  };
};

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <defs>
    <linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>
    <clipPath id="c"><circle cx="100" cy="100" r="60"/></clipPath>
  </defs>
  <rect x="10" y="10" width="180" height="60" fill="url(#g)"/>
  <rect x="40" y="40" width="120" height="120" fill="#00aa00" clip-path="url(#c)"/>
</svg>`;

const counts = (page: Page) =>
  page.evaluate(async () => {
    const c = (globalThis as unknown as Canvas).__canvas.client;
    const gradients = (await c.collection("gradients")).filter((g) =>
      String(g.selfId).startsWith("Gradient/svg-"),
    ).length;
    const tree = await c.send({ kind: "requestSceneTree" });
    let items = 0;
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        if (n.id) items++;
        walk(n.children ?? []);
      }
    };
    walk(tree.payload.roots);
    return { gradients, items };
  });

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Canvas).__canvas.registries.commands.invoke(
        cmd,
      ),
    id,
  );

test.describe("SVG through the engine", () => {
  test("File ▸ Import ▸ SVG… brings in a gradient and a clip as one undo step @feat:editor-shell.import-svg-pdf-vectors @level:happy", async ({
    page,
  }) => {
    covers("menu:File/Import/SVG…", "command:paged.file.importSvg");
    await openShell(page, { doc: true });
    const before = await counts(page);
    const chooser = page.waitForEvent("filechooser");
    await clickMenuRow(page, "File/Import/SVG…");
    const fc = await chooser;
    expect((await fc.element().getAttribute("accept")) ?? "").toContain(".svg");
    await fc.setFiles({
      name: "art.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(SVG),
    });
    await expect
      .poll(async () => (await counts(page)).gradients)
      .toBe(before.gradients + 1);
    const after = await counts(page);
    // The gradient rectangle, the clipped rectangle, its clip frame, and
    // the group around them.
    expect(after.items - before.items).toBeGreaterThanOrEqual(3);
    await invoke(page, "paged.editor.undo");
    await expect
      .poll(async () => (await counts(page)).items)
      .toBe(before.items);
  });

  test("File ▸ Export ▸ SVG writes the page and the selection @feat:editor-shell.import-svg-pdf-vectors @level:happy", async ({
    page,
  }) => {
    covers(
      "menu:File/Export/SVG (page)…",
      "command:paged.file.exportSvgPage",
      "menu:File/Export/SVG (selection)…",
      "command:paged.file.exportSvgSelection",
    );
    await openShell(page, { doc: true });
    const chooser = page.waitForEvent("filechooser");
    await clickMenuRow(page, "File/Import/SVG…");
    await (
      await chooser
    ).setFiles({
      name: "art.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(SVG),
    });
    await expect
      .poll(async () => (await counts(page)).gradients)
      .toBeGreaterThan(0);

    const readDownload = async (row: string) => {
      const download = page.waitForEvent("download");
      await clickMenuRow(page, row);
      const file = await download;
      const chunks: Buffer[] = [];
      for await (const c of await file.createReadStream())
        chunks.push(c as Buffer);
      return {
        name: file.suggestedFilename(),
        text: Buffer.concat(chunks).toString("utf8"),
      };
    };
    const pageSvg = await readDownload("File/Export/SVG (page)…");
    expect(pageSvg.name).toMatch(/\.svg$/);
    expect(pageSvg.text).toContain("<linearGradient");
    expect(pageSvg.text).toContain("<clipPath");
    // The import selected what it made: the selection exports alone.
    const selection = await readDownload("File/Export/SVG (selection)…");
    expect(selection.name).toMatch(/-selection\.svg$/);
    expect(selection.text).toContain("<linearGradient");
    expect(selection.text).not.toEqual(pageSvg.text);
  });
});
