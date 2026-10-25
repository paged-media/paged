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
// paged.slide live presets (slide ADR 717), in the browser: a PowerPoint
// deck's rounded rectangle shows its yellow adjust handle when selected,
// and dragging it changes the corner radius — written back to PowerPoint
// as the new adjust value, one undo step. Insert ▸ Shapes puts a live
// preset on the slide that exports as `a:prstGeom`.

import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import { Designer } from "../driver/designer";

// Authored through PowerPoint (modules/slide/scripts/fixtures/connectors.*).
const DECK = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../../../modules/slide/slide-conformance/fixtures/connectors.pptx",
);

type Reg = {
  __canvas: {
    registries: {
      importers?: {
        resolve: (n: string) => {
          import: (a: { name: string; bytes: Uint8Array }) => Promise<void>;
        } | null;
      };
      exporters?: {
        list: () => {
          id: string;
          export: () => Promise<{ bytes: Uint8Array } | null>;
        }[];
      };
    };
  };
};

async function importDeck(page: Page): Promise<void> {
  const bytes = [...readFileSync(DECK)];
  await page.evaluate(async (bytes) => {
    const imp = (
      globalThis as unknown as Reg
    ).__canvas.registries.importers?.resolve("connectors.pptx");
    await imp!.import({
      name: "connectors.pptx",
      bytes: new Uint8Array(bytes),
    });
  }, bytes);
}

/** Slide 1 of the deck the exporter writes now, as XML. */
async function exportedSlide1(page: Page): Promise<string> {
  const bytes = await page.evaluate(async () => {
    const ex = (globalThis as unknown as Reg).__canvas.registries.exporters
      ?.list()
      .find((e) => e.id === "media.paged.slide.exporter.pptx");
    const out = ex ? await ex.export() : null;
    return out ? Array.from(out.bytes) : null;
  });
  const b = Buffer.from(bytes!);
  let eocd = b.length - 22;
  while (b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < b.readUInt16LE(eocd + 10); i++) {
    const n = b.readUInt16LE(p + 28);
    const local = b.readUInt32LE(p + 42);
    if (b.toString("utf8", p + 46, p + 46 + n) === "ppt/slides/slide1.xml") {
      const start =
        local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
      const data = b.subarray(start, start + b.readUInt32LE(p + 20));
      return (
        b.readUInt16LE(p + 10) === 8 ? inflateRawSync(data) : data
      ).toString("utf8");
    }
    p += 46 + n + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  throw new Error("no slide 1");
}

const roundRectAdj = (xml: string) =>
  /name="Rounded Rectangle 1".*?<a:gd name="adj" fmla="val (\d+)"\/>/s.exec(
    xml,
  )?.[1];

test.describe("journey · paged.slide live presets", () => {
  test("dragging a rounded rectangle's adjust handle changes its radius, written back as its adjust value @feat:editor-shell.plugin-bundles @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    await importDeck(page);
    await expect
      .poll(async () => (await designer.handle()).pageCount, {
        timeout: 20_000,
      })
      .toBe(2);
    expect(roundRectAdj(await exportedSlide1(page))).toBe("30000");

    // Select the rounded rectangle's outline (shape 2, drawn with text, so
    // its outline is `u2p`) as a click does, through the engine: its yellow
    // handle appears.
    await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              setElementSelection: (
                ids: { kind: string; id: string }[],
                mode: string,
              ) => Promise<unknown>;
            };
          };
        }
      ).__canvas;
      await c.client.setElementSelection(
        [{ kind: "polygon", id: "u2p" }],
        "replace",
      );
    });
    await designer.selectElement("polygon", "u2p");
    const handle = page.locator('[data-slide-adjust-handle="0"]');
    await expect(handle).toBeVisible({ timeout: 15_000 });

    // Drag it 40 px to the right.
    const box = (await handle.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y, { steps: 4 });
    await page.mouse.move(x + 40, y, { steps: 4 });
    await page.mouse.up();

    await expect
      .poll(async () => Number(roundRectAdj(await exportedSlide1(page)) ?? 0), {
        timeout: 15_000,
      })
      .toBeGreaterThan(30000);

    // One undo puts the radius back.
    await designer.runCommand("paged.editor.undo");
    await expect
      .poll(async () => roundRectAdj(await exportedSlide1(page)), {
        timeout: 15_000,
      })
      .toBe("30000");
  });

  test("Insert ▸ Shapes puts a live preset on the slide @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();
    await importDeck(page);
    await expect
      .poll(async () => (await designer.handle()).pageCount, {
        timeout: 20_000,
      })
      .toBe(2);
    await designer.openPanel("media.paged.slide.panel.shapes");
    const star = page.locator('[data-shapes-panel] [data-shape="star5"]');
    await expect(star).toBeVisible({ timeout: 15_000 });
    await star.click();
    await expect
      .poll(
        async () =>
          (await exportedSlide1(page)).includes('<a:prstGeom prst="star5">'),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
  });
});
