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

// ADR 180 — the local library: a save is a version of a repository kept in
// the browser's private file system, and the file is a projection of it.
//
// What this pins, through the UI a person uses:
//   1. Opening a file puts it in the library; a save after an edit is a new
//      version; a save that changed nothing is not.
//   2. Restore makes an old version current AS A NEW VERSION (nothing is
//      rewound) and reloads the canvas from it.
//   3. The library survives a page reload: it lives in OPFS, not memory.
//   4. Save still writes the file. The library rides alongside, never instead.

import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

import { openCanvas, openPanel } from "../fidelity/canvas-driver";

const REPO_ROOT = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const FIXTURE = `${REPO_ROOT}/corpus/idml/generated/text.idml`;

type Canvas = {
  client: {
    send: (m: unknown) => Promise<{ kind: string }>;
  };
  registries: { commands: { invoke: (id: string) => Promise<unknown> } };
};

/** Opens the fixture the way a person does (the shell's file input), so the
 *  document handle, the save command and the library all see it. */
async function load(page: Page): Promise<void> {
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as { __canvas: { ready: boolean } }).__canvas
            .ready,
      ),
    )
    .toBe(true);
}

async function edit(page: Page, text: string): Promise<void> {
  await page.evaluate(async (t) => {
    const c = (globalThis as unknown as { __canvas: Canvas }).__canvas;
    const bytes = Array.from(new TextEncoder().encode(t));
    await c.client.send({
      kind: "writePagedPart",
      payload: { path: "paged/media.paged.test/probe.json", bytes },
    });
  }, text);
}

async function save(page: Page): Promise<void> {
  const download = page.waitForEvent("download");
  await page.evaluate(() =>
    (
      globalThis as unknown as { __canvas: Canvas }
    ).__canvas.registries.commands.invoke("paged.file.savePaged"),
  );
  await download;
}

async function clearLibrary(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    await root
      .removeEntry("paged-library", { recursive: true })
      .catch(() => undefined);
  });
}

test.describe("library panel @feat:editor-shell.panels.library", () => {
  test("saves are versions, restore adds one, and the library outlives a reload @level:happy", async ({
    page,
  }) => {
    await openCanvas(page);
    await clearLibrary(page);
    await page.reload();
    await openCanvas(page);
    await load(page);
    await openPanel(page, "paged.library");
    const panel = page.locator("[data-library-panel]");
    // Opening a file is an import: it is a library document at once.
    const versions = panel.locator("[data-library-version]");
    await expect(versions).toHaveCount(1);
    await expect(versions.first()).toContainText("Open text.idml");

    await edit(page, '{"v":1}');
    await save(page);
    await expect(versions).toHaveCount(2);

    await save(page);
    await expect(
      versions,
      "a save that changed nothing is not a version",
    ).toHaveCount(2);

    await edit(page, '{"v":2}');
    await save(page);
    await expect(versions).toHaveCount(3);

    // Restore the first save: a fourth version, with the one it replaces still listed.
    await versions.nth(1).locator("[data-library-restore]").click();
    await expect(versions).toHaveCount(4);
    await expect(versions.first()).toContainText("Restore");

    await page.reload();
    await openCanvas(page);
    await openPanel(page, "paged.library");
    const docs = page.locator("[data-library-panel] [data-library-document]");
    await expect(docs).toHaveCount(1);
    await docs.first().locator("[data-library-open]").click();
    await expect(
      page.locator("[data-library-panel] [data-library-version]"),
    ).toHaveCount(4);
    await clearLibrary(page);
  });
});
