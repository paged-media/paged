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

// The shell's browser-only findings, each an expected failure beside a
// control that proves the path it walks works (so the failure is the
// finding's, not the harness's):
//
//   SH-2   (UX F-49)  Tab inside a dialog toggles the chrome; focus is stuck
//   SH-3   (UX F-36)  text from an input method (insertText) or Option+-
//                     never reaches the story
//   SH-10  (UX F-01)  a file dropped on the canvas replaced an edited
//                     document without the discard prompt — FIXED (ADR 230)
//   SH-11             with a text caret in a story, an open menu's arrow
//                     keys move the caret behind it and never reach the menu
//   SH-12             Enter that chooses a menu item also reaches the canvas:
//                     the selected frame enters path-edit mode
//   SH-201 (UX F-28)  no Cut, Copy, Paste or Duplicate for page items

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import {
  SHELL,
  blurAll,
  openShell,
  select,
  setCaret,
  shellFixture,
} from "./harness/shell-surface";

interface Client {
  send(m: unknown): Promise<{
    kind: string;
    payload: {
      content?: {
        paragraphs: Array<{ runs: Array<{ text: string }> }>;
      } | null;
    };
  }>;
  sceneTree(): Promise<Array<{ children?: unknown[] }>>;
  documentMeta(): Promise<{ dirty: boolean }>;
}
type G = {
  __canvas: {
    client: Client;
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

async function storyText(page: Page): Promise<string | null> {
  return page.evaluate(async (sid) => {
    const c = (globalThis as unknown as G).__canvas.client;
    const r = await c.send({
      kind: "requestStoryContent",
      payload: { storyId: sid },
    });
    const content = r.payload.content;
    if (!content) return null;
    return content.paragraphs
      .map((p) => p.runs.map((run) => run.text).join(""))
      .join("\n");
  }, SHELL.storyId as string);
}

/** Page items in the document (leaves of the scene tree under pages). */
async function itemCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const tree = await (globalThis as unknown as G).__canvas.client.sceneTree();
    let n = 0;
    const visit = (node: { kind?: string; children?: unknown[] }) => {
      if (node.kind && !["Spread", "Page"].includes(node.kind)) n++;
      for (const c of (node.children ?? []) as Array<typeof node>) visit(c);
    };
    for (const root of tree as Array<{ kind?: string; children?: unknown[] }>)
      visit(root);
    return n;
  });
}

const railVisible = (page: Page) =>
  page.locator('nav[aria-label="Tools"]').isVisible();

test.describe("SH-2 (UX F-49) — Tab in a dialog", () => {
  test("control: Tab on the page toggles the chrome (the binding works)", async ({
    page,
  }) => {
    covers("keybinding:tab→paged.chrome.toggleAll");
    await openShell(page, { doc: true });
    await blurAll(page);
    expect(await railVisible(page)).toBe(true);
    await page.keyboard.press("Tab");
    await expect.poll(() => railVisible(page)).toBe(false);
    await page.keyboard.press("Tab");
    await expect.poll(() => railVisible(page)).toBe(true);
  });

  test("SH-2: Tab moves focus between a dialog's controls and leaves the chrome alone", async ({
    page,
  }) => {
    test.fail();
    covers("keybinding:tab→paged.chrome.toggleAll");
    await openShell(page, { doc: true });
    await page.evaluate(() =>
      (globalThis as unknown as G).__canvas.registries.commands.invoke(
        "paged.file.exportPdf",
      ),
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const focusable = dialog.locator("select, button, input").first();
    await focusable.focus();
    const before = await page.evaluate(() => document.activeElement?.outerHTML);
    await page.keyboard.press("Tab");
    expect(await railVisible(page)).toBe(true);
    const after = await page.evaluate(() => document.activeElement?.outerHTML);
    expect(after).not.toBe(before);
  });
});

test.describe("SH-3 (UX F-36) — text from an input method", () => {
  test("control: a plain key typed with a caret reaches the story", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    await blurAll(page);
    const before = await storyText(page);
    await page.keyboard.press("KeyQ");
    await expect.poll(() => storyText(page)).toBe(`q${before}`);
  });

  test("SH-3: text committed by an input method (insertText) lands in the story", async ({
    page,
  }) => {
    test.fail();
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    await blurAll(page);
    const before = await storyText(page);
    await page.keyboard.insertText("é–@");
    await expect
      .poll(() => storyText(page), { timeout: 5_000 })
      .toBe(`é–@${before}`);
  });

  test("SH-3: Option+- types an en dash", async ({ page }) => {
    test.fail();
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    await blurAll(page);
    const before = await storyText(page);
    // What macOS reports for Option+- on the US layout.
    await page.keyboard.down("Alt");
    await page.keyboard.press("Minus", { delay: 0 });
    await page.keyboard.up("Alt");
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "–",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect
      .poll(() => storyText(page), { timeout: 5_000 })
      .toBe(`–${before}`);
  });
});

test.describe("SH-10 (UX F-01) — a drop on an edited document asks first", () => {
  const drop = (page: Page) =>
    page.evaluate((bytes) => {
      const target = document.querySelector("[data-cockpit-canvas]");
      if (!target) throw new Error("no canvas drop target");
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], "dropped.idml", {
          type: "application/vnd.adobe.indesign-idml-package",
        }),
      );
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    }, Array.from(shellFixture()));

  const dirty = (page: Page) =>
    page.evaluate(() =>
      (globalThis as unknown as G).__canvas.client
        .documentMeta()
        .then((m) => m.dirty),
    );
  const prompt = (page: Page) => page.getByTestId("replace-document-dialog");

  test("control: File ▸ New on an edited document asks first", async ({
    page,
  }) => {
    covers("command:paged.file.new");
    await openShell(page, { doc: true, answerReplacePrompts: false });
    await page.evaluate(() =>
      (globalThis as unknown as G).__canvas.registries.commands.invoke(
        "paged.insert.rectangle",
      ),
    );
    await expect.poll(() => dirty(page)).toBe(true);
    void page.evaluate(() =>
      (globalThis as unknown as G).__canvas.registries.commands.invoke(
        "paged.file.new",
      ),
    );
    await expect(prompt(page)).toBeVisible();
    await expect(prompt(page)).toContainText("Creating a new document");
    await page.getByTestId("replace-document-keep").click();
    await expect(prompt(page)).toHaveCount(0);
    expect(await dirty(page)).toBe(true);
  });

  test("SH-10: a file dropped on the canvas asks before replacing an edited document", async ({
    page,
  }) => {
    await openShell(page, { doc: true, answerReplacePrompts: false });
    await page.evaluate(() =>
      (globalThis as unknown as G).__canvas.registries.commands.invoke(
        "paged.insert.rectangle",
      ),
    );
    await expect.poll(() => dirty(page)).toBe(true);
    const before = await itemCount(page);
    await drop(page);
    await expect(prompt(page)).toBeVisible({ timeout: 5_000 });
    await expect(prompt(page)).toContainText("Opening dropped.idml");
    // Cancel keeps the document and its edit; Escape is a Cancel too.
    await page.getByTestId("replace-document-keep").click();
    await expect(prompt(page)).toHaveCount(0);
    expect(await dirty(page)).toBe(true);
    expect(await itemCount(page)).toBe(before);
    await drop(page);
    await expect(prompt(page)).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await expect(prompt(page)).toHaveCount(0);
    expect(await dirty(page)).toBe(true);
    // Don't save replaces it with the dropped file.
    await drop(page);
    await page.getByTestId("replace-document-discard").click();
    await expect.poll(() => dirty(page), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => itemCount(page)).toBe(before - 1);
  });
});

test.describe("SH-11 — the arrows in an open menu while a caret is active", () => {
  const caret = (page: Page) =>
    page.evaluate(
      () =>
        (
          globalThis as unknown as {
            __canvas: { contentSelection: { start: number } | null };
          }
        ).__canvas.contentSelection?.start ?? null,
    );
  const highlighted = (page: Page) =>
    page.locator('[role="menu"] [role="menuitem"][data-highlighted]').count();

  test("control: with no caret, ArrowDown walks the open Edit menu", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    await page.locator('[data-menu-trigger="Edit"]').click();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => highlighted(page)).toBe(1);
  });

  test("SH-11: with a caret, ArrowDown walks the open menu and the caret stays", async ({
    page,
  }) => {
    test.fail();
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 3);
    await blurAll(page);
    await page.locator('[data-menu-trigger="Edit"]').click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    expect(await caret(page)).toBe(3);
    await expect.poll(() => highlighted(page), { timeout: 3_000 }).toBe(1);
  });
});

test.describe("SH-12 — Enter in an open menu", () => {
  const pathEditMode = (page: Page) =>
    page.evaluate(async () => {
      const r = (
        globalThis as unknown as {
          __canvas: {
            registries: {
              commands: {
                register(c: unknown): { dispose(): void };
                invoke(id: string): Promise<unknown>;
              };
            };
          };
        }
      ).__canvas.registries;
      const probe = r.commands.register({
        id: "test.shell.probeEditor",
        title: "probe",
        handler: (paged: unknown) => paged,
      });
      const editor = (await r.commands.invoke("test.shell.probeEditor")) as {
        selection?: { pathEditMode?: boolean };
      };
      probe.dispose();
      return editor.selection?.pathEditMode ?? false;
    });

  test("SH-12: choosing View ▸ Zoom in with Enter only zooms", async ({
    page,
  }) => {
    test.fail();
    covers("menu:View/Zoom in");
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    await blurAll(page);
    expect(await pathEditMode(page)).toBe(false);
    await page.locator('[data-menu-trigger="View"]').click();
    const row = page.getByRole("menuitem", { name: /^Zoom in/ });
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    // The control: Enter did choose the item (the menu closed). The
    // finding: the same key also entered path-edit mode on the frame.
    expect(await pathEditMode(page)).toBe(false);
  });
});

test.describe("SH-201 (UX F-28) — Cut, Copy, Paste, Duplicate", () => {
  test("SH-201: Copy then Paste on a selected frame adds a frame", async ({
    page,
  }) => {
    test.fail();
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    await blurAll(page);
    const before = await itemCount(page);
    await page.keyboard.press("Meta+KeyC");
    await page.keyboard.press("Meta+KeyV");
    await expect
      .poll(() => itemCount(page), { timeout: 5_000 })
      .toBe(before + 1);
  });

  test("SH-201: the Edit menu offers Cut, Copy, Paste and Duplicate", async ({
    page,
  }) => {
    test.fail();
    await openShell(page, { doc: true });
    await page.locator('[data-menu-trigger="Edit"]').click();
    for (const name of ["Cut", "Copy", "Paste", "Duplicate"]) {
      await expect(
        page.getByRole("menuitem", { name: new RegExp(`^${name}`) }),
      ).toBeVisible({ timeout: 2_000 });
    }
  });
});
