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

// Keyboard focus and text input in the real browser (ADR 234; F-49, F-36).
// The DOM lane (test/shell/keyboard-focus.dom.test.tsx, text-input.dom.test
// .tsx) holds the rules in CI; this spec proves what only a browser does:
// Tab's focus traversal, the focus ring, Radix's menus, and Chromium's own
// input-method path, driven through the DevTools protocol
// (`Input.imeSetComposition` marks text as an IME does, `Input.insertText`
// commits it). A real operating-system IME, dead-key layout or emoji
// picker cannot be automated; those deliver the same events.

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import {
  SHELL,
  blurAll,
  openShell,
  select,
  setCaret,
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
}

async function storyText(page: Page): Promise<string | null> {
  return page.evaluate(async (sid) => {
    const c = (globalThis as unknown as { __canvas: { client: Client } })
      .__canvas.client;
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

const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return (
      el?.getAttribute("data-menu-trigger") ??
      el?.getAttribute("aria-label") ??
      el?.textContent?.trim() ??
      ""
    );
  });

const surface = (page: Page) =>
  page.locator('textarea[data-canvas-surface="text"]');

test.describe("focus: the ring, the menus, the toolbars, the dialogs", () => {
  test("a keyboard-focused control shows the focus ring; a clicked one does not", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await blurAll(page);
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(ring).toEqual({ style: "solid", width: "2px" });
    await page.locator("[data-panel-rail-item]").first().click();
    const clicked = await page.evaluate(() =>
      (document.activeElement as HTMLElement).matches(":focus-visible"),
    );
    expect(clicked).toBe(false);
  });

  test("menus: Enter opens, the arrows, Home/End and typeahead walk, Left/Right switch menus, Escape returns to the trigger", async ({
    page,
  }) => {
    covers("menu:View/Zoom in");
    await openShell(page, { doc: true });
    const file = page.locator('[data-menu-trigger="File"]');
    await file.focus();
    // The bar is a menubar: Right walks it.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-menu-trigger="Edit"]')).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(file).toBeFocused();
    await page.keyboard.press("Enter");
    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();
    const highlighted = () =>
      page.evaluate(
        () =>
          document
            .querySelector('[role="menu"] [role="menuitem"][data-highlighted]')
            ?.textContent?.trim() ?? null,
      );
    await expect.poll(highlighted).not.toBeNull();
    const first = await highlighted();
    await page.keyboard.press("End");
    await expect.poll(highlighted).not.toBe(first);
    await page.keyboard.press("Home");
    await expect.poll(highlighted).toBe(first);
    // Right switches to the next menu, on its first item.
    await page.keyboard.press("ArrowRight");
    await expect(
      page.locator('[data-menu-trigger="Edit"][data-state="open"]'),
    ).toHaveCount(1);
    await expect.poll(highlighted).not.toBeNull();
    // Typeahead in the View menu: "z" lands on a Zoom row.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(
      page.locator('[data-menu-trigger="View"][data-state="open"]'),
    ).toHaveCount(1);
    await page.keyboard.press("z");
    await expect.poll(highlighted).toMatch(/^Zoom/);
    // Escape closes and focus is the trigger's (a keyboard-opened menu).
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.locator('[data-menu-trigger="View"]')).toBeFocused();
  });

  test("a menu opened with the pointer hands focus back to the canvas, so the next arrow nudges", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await page
      .locator("[data-paged-canvas]")
      .click({ position: { x: 8, y: 8 } });
    await select(page, [SHELL.frame]);
    await page.locator('[data-menu-trigger="Edit"]').click();
    await expect(page.locator('[role="menu"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await expect(
      page.locator('[data-canvas-surface="viewport"]'),
    ).toBeFocused();
  });

  test("the tool rail is one tab stop the arrows walk; Enter picks; a click hands focus back to the canvas", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    const selection = page.locator('[data-tool="paged.tool.select"]');
    await selection.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.locator('[data-tool="paged.tool.directSelect"]'),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.locator('[data-tool="paged.tool.directSelect"]'),
    ).toHaveAttribute("aria-pressed", "true");
    // Still on the rail after a keyboard pick, and the stop moved with it.
    await expect(
      page.locator('[data-tool="paged.tool.directSelect"]'),
    ).toBeFocused();
    await expect(
      page.locator('[data-tool="paged.tool.directSelect"]'),
    ).toHaveAttribute("tabindex", "0");
    await expect(selection).toHaveAttribute("tabindex", "-1");
    // A pointer click on a tool: the document has focus again.
    await selection.click();
    await expect(
      page.locator('[data-canvas-surface="viewport"]'),
    ).toBeFocused();
  });

  test("a tool's flyout opens from the keyboard (Shift+F10), walks with the arrows and returns on Escape", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    const shape = page.locator('[data-tool-slot="shape"]');
    await shape.focus();
    await page.keyboard.press("Shift+F10");
    const flyout = page.locator('[data-tool-flyout="shape"]');
    await expect(flyout).toBeVisible();
    const items = flyout.locator('[role="menuitem"]');
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(flyout).toHaveCount(0);
    await expect(shape).toBeFocused();
  });

  test("the Export PDF dialog takes focus, keeps Tab inside, and gives focus back on Escape", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    const file = page.locator('[data-menu-trigger="File"]');
    await file.focus();
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): Promise<unknown> } };
          };
        }
      ).__canvas.registries.commands.invoke("paged.file.exportPdf"),
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('[role="dialog"]') !== null,
        ),
      )
      .toBe(true);
    for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('[role="dialog"]') !== null,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(file).toBeFocused();
  });
});

test.describe("text input: the input method's path (F-36)", () => {
  test("with a caret in a story, keyboard focus is on the text input surface at the caret", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    await expect(surface(page)).toBeFocused();
    // It sits at the caret, so an IME's candidate window opens there.
    const at = await page.evaluate(() => {
      const caret = document.querySelector("[data-text-caret]");
      const area = document.querySelector(
        'textarea[data-canvas-surface="text"]',
      );
      if (!caret || !area) return null;
      const c = caret.getBoundingClientRect();
      const a = area.getBoundingClientRect();
      return { dx: Math.abs(a.left - c.left), dy: Math.abs(a.top - c.top) };
    });
    expect(at).not.toBeNull();
    expect(at!.dx).toBeLessThan(6);
    expect(at!.dy).toBeLessThan(6);
  });

  test("an IME composition shows its marked text at the caret and lands in the story on commit", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    await expect(surface(page)).toBeFocused();
    const before = await storyText(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "にほん",
      selectionStart: 3,
      selectionEnd: 3,
    });
    await expect(surface(page)).toHaveAttribute("data-composing", "true");
    await expect(surface(page)).toHaveValue("にほん");
    expect(
      await surface(page).evaluate((el) => getComputedStyle(el).opacity),
    ).toBe("1");
    // Nothing reaches the story while the text is marked.
    expect(await storyText(page)).toBe(before);
    await cdp.send("Input.insertText", { text: "日本" });
    await expect.poll(() => storyText(page)).toBe(`日本${before}`);
    await expect(surface(page)).toHaveValue("");
    await expect(surface(page)).not.toHaveAttribute("data-composing", "true");
  });

  test("a dead-key composition (´ then e) types é; emoji and AltGr characters type", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    await expect(surface(page)).toBeFocused();
    const before = await storyText(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "´",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await cdp.send("Input.insertText", { text: "é" });
    await expect.poll(() => storyText(page)).toBe(`é${before}`);
    await page.keyboard.insertText("😀");
    await expect.poll(() => storyText(page)).toBe(`é😀${before}`);
    // AltGr+Q on a German layout reports Ctrl+Alt and "@".
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "@",
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect.poll(() => storyText(page)).toBe(`é😀@${before}`);
  });

  test("Enter, Shift+Enter and Tab type a paragraph break, a forced line break and a tab", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    await expect(surface(page)).toBeFocused();
    const before = await storyText(page);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("x");
    await expect.poll(() => storyText(page)).toBe(`\t\u2028\nx${before}`);
    // The chrome never moved.
    await expect(page.locator('nav[aria-label="Tools"]')).toBeVisible();
  });
});
