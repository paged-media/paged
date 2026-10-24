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

// E2E — WP4.11 and WP4.10 in the real editor.
//
//  · Actions: a replay of two document-writing commands is ONE undo step;
//    a breakpoint pauses the replay before its step and Continue finishes
//    it.
//  · File ▸ Automate ▸ Batch…: the menu row opens the dialog, two picked
//    IDML files run through the action and download as the chosen format.
//  · The colour tools: paged.image's Eyedropper and Color Sampler reach
//    the rail and activate; the host Color panel's mixer shows a colour
//    in CMYK and Lab with the gamut verdict.

import { expect, test, type Page } from "@playwright/test";
import { covers } from "@paged-media/test-kit";

import { openPanel } from "../fidelity/canvas-driver";
import { clickMenuRow, openShell } from "./harness/shell-surface";

type Canvas = {
  __canvas: {
    client: {
      mutate(m: unknown): Promise<unknown>;
      collection(name: string): Promise<unknown[]>;
      exportIdml(): Promise<Uint8Array>;
      newBlankDocument(w: number, h: number): Promise<unknown>;
      markSaved(): void;
    };
    registries: {
      commands: {
        invoke(id: string, payload?: unknown): Promise<unknown>;
        register(c: unknown): unknown;
      };
      tools: { list(): Array<{ id: string }> };
    };
  };
};

/** A command that writes the document twice (two swatches). */
async function registerWriter(page: Page) {
  await page.evaluate(() => {
    const c = (globalThis as unknown as Canvas).__canvas;
    let n = 0;
    c.registries.commands.register({
      id: "test.e2e.write",
      title: "Write two swatches",
      handler: async () => {
        for (let i = 0; i < 2; i++) {
          n += 1;
          await c.client.mutate({
            op: "createSwatch",
            args: {
              spec: {
                name: `E2E ${n}`,
                space: "CMYK",
                value: [n, 0, 0, 0],
                model: "Process",
              },
            },
          });
        }
      },
    });
  });
}

const swatchCount = (page: Page) =>
  page.evaluate(async () => {
    const c = (globalThis as unknown as Canvas).__canvas;
    return (await c.client.collection("swatches")).length;
  });

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Canvas).__canvas.registries.commands.invoke(
        cmd,
      ),
    id,
  );

/** Record the writer twice as a named action. */
async function recordWriter(page: Page, name: string) {
  await openPanel(page, "paged.actions");
  await expect(page.locator('[data-actions-panel="ready"]')).toBeVisible();
  await page.locator('[data-cockpit-action="actions-record"]').click();
  await invoke(page, "test.e2e.write");
  await invoke(page, "test.e2e.write");
  await expect(page.locator("[data-actions-step-count]")).toHaveText("2");
  await page.locator("[data-actions-name]").fill(name);
  await page.locator('[data-cockpit-action="actions-stop"]').click();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe("WP4.11 — Actions", () => {
  test.beforeEach(async ({ page }) => {
    await openShell(page, { doc: true });
    await registerWriter(page);
  });

  test("a replay is one undo step; a breakpoint pauses it and Continue finishes @feat:editor-shell.actions-batch @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.actions", "command:paged.actions.play");
    await recordWriter(page, "Write four");
    const before = await swatchCount(page);
    await page.locator('[data-cockpit-action^="actions-play-"]').click();
    await expect(page.locator("[data-actions-undo]")).toContainText(
      "applied as one undo step",
    );
    await expect.poll(() => swatchCount(page)).toBe(before + 4);
    await invoke(page, "paged.editor.undo");
    await expect.poll(() => swatchCount(page)).toBe(before);

    // A breakpoint before step 2.
    await page.getByRole("button", { name: "Pause before step 2" }).click();
    await page.locator('[data-cockpit-action^="actions-play-"]').click();
    await expect(
      page.locator('[data-actions-playback="paused"]'),
    ).toBeVisible();
    await expect.poll(() => swatchCount(page)).toBe(before + 2);
    await page.locator('[data-cockpit-action="actions-continue"]').click();
    await expect(page.locator("[data-actions-playback]")).toHaveCount(0);
    await expect.poll(() => swatchCount(page)).toBe(before + 4);
    await invoke(page, "paged.editor.undo");
    await expect.poll(() => swatchCount(page)).toBe(before);
  });

  test("File ▸ Automate ▸ Batch… runs the action over two files and downloads each result @feat:editor-shell.actions-batch @level:happy", async ({
    page,
  }) => {
    covers("menu:File/Automate/Batch…", "command:paged.actions.batch");
    await recordWriter(page, "Stamp");
    // Two generated documents.
    const files = await page.evaluate(async () => {
      const c = (globalThis as unknown as Canvas).__canvas;
      const out: number[][] = [];
      for (let i = 0; i < 2; i++) {
        out.push(Array.from(await c.client.exportIdml()));
      }
      c.client.markSaved();
      return out;
    });
    await clickMenuRow(page, "File/Automate/Batch…");
    const dialog = page.locator("[data-batch-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.locator("[data-batch-files]").setInputFiles(
      files.map((bytes, i) => ({
        name: `Doc ${i + 1}.idml`,
        mimeType: "application/vnd.adobe.indesign-idml-package",
        buffer: Buffer.from(bytes),
      })),
    );
    await expect(dialog.locator("[data-batch-file-count]")).toHaveText(
      "2 files",
    );
    await dialog.locator("[data-batch-format]").selectOption("idml");
    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.suggestedFilename()));
    await dialog.locator("[data-batch-run]").click();
    await expect(dialog.locator("[data-batch-summary]")).toHaveText(
      "2 saved, 0 failed",
      { timeout: 60_000 },
    );
    await expect
      .poll(() => downloads.sort())
      .toEqual(["Doc 1.idml", "Doc 2.idml"]);
    await expect(dialog.locator('[data-batch-log-entry="ok"]')).toHaveCount(2);
    await dialog.locator("[data-batch-close]").click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe("WP4.10 — colour for the raster context", () => {
  test("the Eyedropper and Color Sampler reach the rail and activate @feat:editor-shell.raster-color-binding @level:smoke", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    const ids = await page.evaluate(() =>
      (globalThis as unknown as Canvas).__canvas.registries.tools
        .list()
        .map((t) => t.id),
    );
    for (const id of [
      "media.paged.image.tool.eyedropper",
      "media.paged.image.tool.colorSampler",
    ]) {
      expect(ids, `${id} is registered`).toContain(id);
      await invoke(page, `paged.tool.activate.${id}`);
      await expect(
        page.locator(`[data-tool="${id}"][data-active="true"]`),
      ).toHaveCount(1, { timeout: 10_000 });
    }
  });

  test("the Color panel's mixer shows a colour in CMYK and Lab, and the engine's gamut verdict @feat:editor-shell.raster-color-binding @level:happy", async ({
    page,
  }) => {
    covers("panel:paged.color");
    await openShell(page, { doc: true });
    await openPanel(page, "paged.color");
    const panel = page.locator('[data-color-panel="ready"]');
    await expect(panel).toBeVisible();
    await panel.locator('[data-mixer-space="RGB"]').click();
    const hex = panel.locator("[data-mixer-hex]");
    await hex.fill("00ff00");
    await hex.press("Enter");
    // The verdict is the engine's, against the document's CMYK working
    // space: the triangle and the note show exactly when it says so.
    const outOfGamut = await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              colorCompute(a: {
                space: string;
                value: number[];
              }): Promise<{ outOfGamut: boolean }>;
            };
          };
        }
      ).__canvas.client;
      return (await c.colorCompute({ space: "RGB", value: [0, 255, 0] }))
        .outOfGamut;
    });
    await expect(panel.locator("[data-mixer-preview]")).toHaveAttribute(
      "title",
      "#00ff00",
    );
    await expect(panel.locator('[data-gamut="out"]')).toHaveCount(
      outOfGamut ? 1 : 0,
    );
    await expect(panel.locator("[data-mixer-gamut-note]")).toHaveCount(
      outOfGamut ? 1 : 0,
    );
    await panel.locator('[data-mixer-space="LAB"]').click();
    const lab = await panel
      .locator("[data-mixer-channel] input")
      .evaluateAll((els) =>
        els.map((e) => Number((e as HTMLInputElement).value)),
      );
    expect(lab[0]).toBeGreaterThan(80);
    expect(lab[1]).toBeLessThan(-60);
    await panel.locator('[data-mixer-space="CMYK"]').click();
    await expect(panel.locator("[data-mixer-naive-cmyk]")).toBeVisible();
  });
});
