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

// Documents and files (interaction spec, wave 5; track DF of
// apps/editor/docs/interaction-plan.md): the save status says what a save
// really did (editor ADR 1203, UXI-T67), and the recovery journal offers
// unsaved work back after the page went away (editor ADR 1204, F-06).
//
// Every test asserts the model and the history, not the chrome alone: a
// save changes neither, a restore opens the recovered model as a new
// document with nothing to undo.

import { expect, test, type Page } from "@playwright/test";

import { loadViaFileInput, openCanvas } from "../fidelity/canvas-driver";
import { fixturePath } from "./harness/fixtures";
import { dumpDoc } from "./harness/model-dump";

interface SaveStateView {
  kind: string;
  checkpointAt: number | null;
  missed: { code: string; target: { kind: string; name?: string } } | null;
  saved: { where: { kind: string }[] } | null;
  document: { origin: { kind: string; name?: string } } | null;
}

type Win = {
  __canvas: {
    client: {
      mutate(m: unknown): Promise<unknown>;
      undoLog(): Promise<{ undoLen: number; redoLen: number }>;
      documentMeta(): Promise<{ pageCount: number; dirty: boolean }>;
    };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
  __saveState: {
    current(): SaveStateView;
    subscribe(l: () => void): () => void;
    setOpenFileHandle(h: unknown): void;
  };
  __kinds?: string[];
};

const saveState = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as Win).__saveState.current());

const undoDepth = (page: Page) =>
  page.evaluate(async () => {
    const log = await (globalThis as unknown as Win).__canvas.client.undoLog();
    return log.undoLen;
  });

const pageCount = (page: Page) =>
  page.evaluate(
    async () =>
      (await (globalThis as unknown as Win).__canvas.client.documentMeta())
        .pageCount,
  );

/** The scene's shape: node kinds, depth first (spreads, pages, items). */
const sceneShape = (page: Page) =>
  page.evaluate(async () => {
    const tree = await (
      globalThis as unknown as {
        __canvas: { client: { sceneTree(): Promise<unknown[]> } };
      }
    ).__canvas.client.sceneTree();
    const kinds: string[] = [];
    const visit = (node: { kind?: string; children?: unknown[] }) => {
      kinds.push(node.kind ?? "?");
      for (const c of (node.children ?? []) as Array<typeof node>) visit(c);
    };
    for (const root of tree as Array<{ kind?: string; children?: unknown[] }>)
      visit(root);
    return kinds;
  });

/** One accepted operation: a page added. */
async function edit(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (globalThis as unknown as Win).__canvas.client.mutate({
      op: "insertPage",
      args: {},
    });
  });
  await expect.poll(async () => (await saveState(page)).kind).toBe("editing");
}

async function openFixture(page: Page): Promise<void> {
  await openCanvas(page);
  await loadViaFileInput(page, fixturePath("geometry"));
  // The open is over once its pages are rendered: right after it the
  // importer's result is marked saved (F-08), which would swallow an edit
  // made sooner (as AC-SAFE-1 waits).
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = (
            globalThis as unknown as {
              __canvas: { ready: boolean; snapshotsReady: boolean };
            }
          ).__canvas;
          return c.ready && c.snapshotsReady;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect
    .poll(async () => (await saveState(page)).kind, { timeout: 30_000 })
    .toBe("new");
}

async function save(page: Page): Promise<void> {
  const download = page.waitForEvent("download");
  await page.evaluate(() =>
    (globalThis as unknown as Win).__canvas.registries.commands.invoke(
      "paged.file.savePaged",
    ),
  );
  await download;
}

const status = (page: Page) => page.locator("[data-save-status]");

/** The document model without its dirty flag, which a save clears. */
async function model(page: Page): Promise<unknown> {
  const doc = JSON.parse(await dumpDoc(page)) as {
    meta: Record<string, unknown>;
  };
  delete doc.meta.dirty;
  return doc;
}

test.describe("the save status says what a save did (editor ADR 1203)", () => {
  test("UXI-T67 — a local save whose write-back fails reads Saved locally · Not synced, never Saved @feat:editor-shell.document-title @feat:package-anatomy.paged-container @level:unhappy", async ({
    page,
  }) => {
    await openFixture(page);
    await edit(page);
    const before = await model(page);
    const depth = await undoDepth(page);
    // The file the document saves back to refuses the write: the local
    // library commit and the download land, the target does not.
    await page.evaluate(() => {
      const w = globalThis as unknown as Win;
      w.__kinds = [];
      w.__saveState.subscribe(() =>
        w.__kinds!.push(w.__saveState.current().kind),
      );
      w.__saveState.setOpenFileHandle({
        name: "geometry.paged",
        queryPermission: async () => "granted",
        createWritable: async () => {
          throw new DOMException(
            "The file is locked",
            "NoModificationAllowedError",
          );
        },
      });
    });
    await save(page);
    await expect(status(page)).toHaveAttribute("data-save-state", "not-synced");
    await expect(status(page)).toHaveText("Saved locally · Not synced");
    const seen = await page.evaluate(
      () => (globalThis as unknown as Win).__kinds ?? [],
    );
    expect(seen, "the status never claimed the file was written").not.toContain(
      "synced",
    );
    const state = await saveState(page);
    expect(state.missed?.target).toEqual({
      kind: "file",
      name: "geometry.paged",
    });
    expect(state.saved?.where.map((d) => d.kind)).not.toContain("file");
    // The popover says where and why, and offers Retry.
    await status(page).click();
    const details = page.locator("[data-save-status-details]");
    await expect(details).toContainText(
      "Could not write to geometry.paged: it could not be written.",
    );
    await expect(details.locator("[data-save-retry]")).toBeVisible();
    // A save changes neither the model nor the history.
    expect(await model(page)).toEqual(before);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T67 — Retry after the file takes the bytes reads Saved @feat:editor-shell.document-title @level:edge", async ({
    page,
  }) => {
    await openFixture(page);
    await edit(page);
    await page.evaluate(() => {
      const w = globalThis as unknown as Win;
      let fail = true;
      w.__saveState.setOpenFileHandle({
        name: "geometry.paged",
        queryPermission: async () => "granted",
        createWritable: async () => {
          if (fail) {
            fail = false;
            throw new DOMException("denied", "NotAllowedError");
          }
          return { write: async () => undefined, close: async () => undefined };
        },
      });
    });
    await save(page);
    await expect(status(page)).toHaveAttribute("data-save-state", "not-synced");
    await status(page).click();
    await page.locator("[data-save-retry]").click();
    await expect(status(page)).toHaveAttribute("data-save-state", "synced");
    await expect(status(page)).toHaveText("Saved");
  });
});

test.describe("the recovery journal offers unsaved work back (editor ADR 1204)", () => {
  /** Edit until the journal holds a checkpoint of the edit. */
  async function editAndCheckpoint(page: Page) {
    await edit(page);
    await expect
      .poll(async () => (await saveState(page)).checkpointAt, {
        timeout: 20_000,
      })
      .not.toBeNull();
  }

  test("a reload with unsaved work offers it; Restore opens it as a new document, the saved version untouched @feat:editor-shell.file-intake @uxi:UXI-MUT-010 @level:happy", async ({
    page,
  }) => {
    await openFixture(page);
    const savedPages = await pageCount(page);
    await editAndCheckpoint(page);
    const editedPages = await pageCount(page);
    expect(editedPages).toBe(savedPages + 1);
    const editedScene = await sceneShape(page);

    // A fresh load of the page: the old one's session is gone, its lock
    // with it.
    await openCanvas(page);
    const dialog = page.getByTestId("recovery-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("recovery-body")).toContainText("geometry");
    // Compare: what the copy holds against the saved version.
    await page.getByTestId("recovery-compare-toggle").click();
    await expect(page.getByTestId("recovery-compare")).toContainText(
      `${editedPages} pages`,
    );
    await page.getByTestId("recovery-restore").click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // The recovered model, opened as a new document with nothing to undo.
    await expect
      .poll(() => pageCount(page), { timeout: 30_000 })
      .toBe(editedPages);
    expect(await sceneShape(page)).toEqual(editedScene);
    expect(await undoDepth(page)).toBe(0);
    await expect(status(page)).toHaveAttribute("data-save-state", "recovered");
    await expect(page.locator("[data-document-chip]")).toContainText(
      "geometry (recovered)",
    );
    const state = await saveState(page);
    expect(state.document?.origin.kind).toBe("recovered");
    // Not tied to the source: a save cannot write over it.
    const target = await page.evaluate(() =>
      (
        globalThis as unknown as {
          __saveState: { openFileName(): string | null };
        }
      ).__saveState.openFileName(),
    );
    expect(target).toBeNull();
    // Kept by this session at once: a second crash would not lose it.
    await expect
      .poll(async () => (await saveState(page)).checkpointAt)
      .not.toBeNull();
  });

  test("Discard forgets the copy: the next start offers nothing @feat:editor-shell.file-intake @uxi:UXI-MUT-010 @level:edge", async ({
    page,
  }) => {
    await openFixture(page);
    await editAndCheckpoint(page);
    // A fresh load of the page: the old one's session is gone, its lock
    // with it.
    await openCanvas(page);
    await expect(page.getByTestId("recovery-dialog")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByTestId("recovery-discard").click();
    await expect(page.getByTestId("recovery-dialog")).toBeHidden();
    // A fresh load of the page: the old one's session is gone, its lock
    // with it.
    await openCanvas(page);
    // Give the journal time to start and find nothing.
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("recovery-dialog")).toHaveCount(0);
  });

  test("a save purges the journal: a reload after it offers nothing @feat:editor-shell.file-intake @level:edge", async ({
    page,
  }) => {
    await openFixture(page);
    await editAndCheckpoint(page);
    await save(page);
    await expect
      .poll(async () => (await saveState(page)).checkpointAt)
      .toBeNull();
    // A fresh load of the page: the old one's session is gone, its lock
    // with it.
    await openCanvas(page);
    await page.waitForTimeout(2_000);
    await expect(page.getByTestId("recovery-dialog")).toHaveCount(0);
  });
});
