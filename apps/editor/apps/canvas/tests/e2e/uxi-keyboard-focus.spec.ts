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

// The interaction contract's keyboard and focus scenarios (track KF:
// UXI-T19, T20, T23–T28, T30, T31, T34) in the real browser, on the shell
// matrix document. Each asserts what the user sees AND what the document
// holds: the model (element and story dumps) and the history (the undo
// log's depth), never a screenshot alone (ADR 1200). The DOM lane holds the
// same rules in CI without a browser (test/shell/escape-arbiter.dom.test
// .tsx, keyboard-focus.dom.test.tsx, text-input.dom.test.tsx).

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { selectedIds } from "./harness/gesture-kit";
import { dumpElement, dumpStory } from "./harness/model-dump";
import {
  SHELL,
  activeEditContext,
  blurAll,
  clickMenuRow,
  enterVectorGraphic,
  openShell,
  select,
  setCaret,
} from "./harness/shell-surface";

interface Canvas {
  __canvas: {
    client: {
      undoLog(limit?: number): Promise<{ undoLen: number }>;
      send(m: unknown): Promise<{
        kind: string;
        payload: {
          content?: {
            paragraphs: Array<{ runs: Array<{ text: string }> }>;
          } | null;
        };
      }>;
      sceneTree(): Promise<Array<{ children?: unknown[] }>>;
    };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
    contentSelection?: { start: number; end: number } | null;
  };
}

const undoDepth = (page: Page) =>
  page.evaluate(
    async () =>
      (await (globalThis as unknown as Canvas).__canvas.client.undoLog(0))
        .undoLen,
  );

async function storyText(page: Page): Promise<string | null> {
  return page.evaluate(async (sid) => {
    const c = (globalThis as unknown as Canvas).__canvas.client;
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
    const tree = await (
      globalThis as unknown as Canvas
    ).__canvas.client.sceneTree();
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

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (globalThis as unknown as Canvas).__canvas.registries.commands.invoke(
        cmd,
      ),
    id,
  );

const viewport = (page: Page) =>
  page.locator('[data-canvas-surface="viewport"]');
const rail = (page: Page) => page.locator('nav[aria-label="Tools"]');
const toolInHand = (page: Page) =>
  page
    .locator('[data-tool-slot][aria-pressed="true"]')
    .first()
    .getAttribute("data-tool");
const PRIMARY = process.platform === "darwin" ? "Meta" : "Control";

/** A field of the inspector's kind: a text input in the right dock (the
 *  key-ownership rules go by the element, not by which panel holds it). */
async function inspectorField(page: Page) {
  await page.evaluate(() => {
    const dock =
      document.querySelector("[data-right-dock]") ??
      document.querySelector("[data-paged-editor]")!;
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("data-test-inspector-field", "");
    input.setAttribute("aria-label", "Name");
    dock.prepend(input);
  });
  return page.locator("[data-test-inspector-field]");
}

test.describe("UXI keyboard and focus (track KF)", () => {
  test("UXI-T19 — Tab walks the toolbar, the canvas and the docks: the canvas is reachable and leavable, focus shows, Tab never hides the chrome @feat:editor-shell.keyboard-shortcuts @level:edge", async ({
    page,
  }) => {
    covers("keybinding:tab→paged.view.toggleChrome");
    await openShell(page, { doc: true });
    await blurAll(page);
    const seen: Array<{ canvas: boolean; ring: boolean; tools: boolean }> = [];
    // Walk until one stop past the canvas (the chrome grows; a fixed count
    // of presses breaks when a stop is added before the canvas).
    for (let i = 0; i < 40; i++) {
      if (seen.length > 1 && seen.at(-2)?.canvas) break;
      await page.keyboard.press("Tab");
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return {
            canvas: el?.getAttribute("data-canvas-surface") === "viewport",
            ring: el?.matches(":focus-visible") ?? false,
            tools: el?.closest('[role="toolbar"][aria-label="Tools"]') != null,
          };
        }),
      );
    }
    const at = seen.findIndex((s) => s.canvas);
    expect(at, "Tab reaches the canvas").toBeGreaterThan(0);
    expect(seen.some((s) => s.tools)).toBe(true);
    // Left again on the next press: not a trap.
    expect(seen[at + 1]?.canvas).toBe(false);
    // Every stop shows where focus is.
    expect(seen.every((s) => s.ring)).toBe(true);
    await expect(rail(page)).toBeVisible();

    // The canvas the user CLICKED into passes Tab on too (ADR 1201, D-03).
    await viewport(page).click({ position: { x: 8, y: 8 } });
    await expect(viewport(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(viewport(page)).not.toBeFocused();
    await expect(rail(page)).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(viewport(page)).toBeFocused();
    await expect(rail(page)).toBeVisible();
    // The chord still hides the chrome from anywhere.
    await page.keyboard.press(`${PRIMARY}+Backslash`);
    await expect(rail(page)).toBeHidden();
    await page.keyboard.press(`${PRIMARY}+Backslash`);
    await expect(rail(page)).toBeVisible();
  });

  test('the "Tab hides panels (InDesign)" setting (Edit ▸ Settings) brings Tab back as the chrome toggle on a clicked canvas, and it is remembered @feat:editor-shell.keyboard-shortcuts @feat:editor-shell.menus @level:happy', async ({
    page,
  }) => {
    covers(
      "menu:Edit/Settings/Tab hides panels (InDesign)",
      "command:paged.preferences.tabHidesPanels",
      "command:paged.view.toggleChrome",
      "keybinding:tab→paged.view.toggleChrome",
      "keybinding:shift+tab→paged.chrome.togglePanels",
      "setting:paged.keyboard.tabHidesPanels",
    );
    await openShell(page, { doc: true });
    await clickMenuRow(page, "Edit/Settings/Tab hides panels (InDesign)");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("paged.keyboard.tabHidesPanels"),
      ),
    ).toBe("true");
    await viewport(page).click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("Tab");
    await expect(rail(page)).toBeHidden();
    await page.keyboard.press("Tab");
    await expect(rail(page)).toBeVisible();
    // Reached by keyboard the canvas still passes Tab on: no trap.
    await blurAll(page);
    await viewport(page).focus();
    await page.keyboard.press("Tab");
    await expect(viewport(page)).not.toBeFocused();
    await expect(rail(page)).toBeVisible();
    // Off again: Tab on the clicked canvas moves focus.
    await clickMenuRow(page, "Edit/Settings/Tab hides panels (InDesign)");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("paged.keyboard.tabHidesPanels"),
      ),
    ).toBe(null);
    await viewport(page).click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("Tab");
    await expect(viewport(page)).not.toBeFocused();
    await expect(rail(page)).toBeVisible();
  });

  test("UXI-T20 — v, t and p typed into an inspector text field are text: the tool stays @feat:editor-shell.keyboard-shortcuts @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    const before = await toolInHand(page);
    const field = await inspectorField(page);
    await field.focus();
    await page.keyboard.type("vtp");
    await expect(field).toHaveValue("vtp");
    expect(await toolInHand(page)).toBe(before);
    expect(await selectedIds(page)).toEqual([SHELL.frame.id]);
  });

  test("UXI-T23 — the palette closes on Escape and focus returns to where it was opened from @feat:editor-shell.command-palette @level:edge", async ({
    page,
  }) => {
    covers("keybinding:cmd+k→paged.palette.toggle");
    await openShell(page, { doc: true });
    const palette = page.locator("[data-palette-footer]");
    // Opened from a focused control: back to that control.
    const file = page.locator('[data-menu-trigger="File"]');
    await file.focus();
    await page.keyboard.press(`${PRIMARY}+k`);
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(file).toBeFocused();
    // Opened with nothing focused: to the canvas, not <body>.
    await blurAll(page);
    await page.keyboard.press(`${PRIMARY}+k`);
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(viewport(page)).toBeFocused();
  });

  test("UXI-T21 — a CJK composition in a text frame commits once at the caret; while it composes no tool or shortcut acts @feat:stories-text.text.insert @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    const surface = page.locator('textarea[data-canvas-surface="text"]');
    await expect(surface).toBeFocused();
    const before = (await storyText(page))!;
    const depth = await undoDepth(page);
    const tool = await toolInHand(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "にほん",
      selectionStart: 3,
      selectionEnd: 3,
    });
    await expect(surface).toHaveAttribute("data-composing", "true");
    // The keys an IME is composing with are its own (keyCode 229).
    await page.evaluate(() => {
      const el = document.querySelector(
        'textarea[data-canvas-surface="text"]',
      )!;
      const e = new KeyboardEvent("keydown", {
        key: "v",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(e, "keyCode", { value: 229 });
      Object.defineProperty(e, "isComposing", { value: true });
      el.dispatchEvent(e);
    });
    expect(await toolInHand(page)).toBe(tool);
    expect(await storyText(page)).toBe(before);
    await cdp.send("Input.insertText", { text: "日本" });
    await expect.poll(() => storyText(page)).toBe(`日本${before}`);
    expect(await undoDepth(page)).toBe(depth + 1);
    await expect(surface).toHaveValue("");
  });

  test("UXI-T22 — a dead-key sequence (´ then e) types é exactly once @feat:stories-text.text.insert @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 0);
    const surface = page.locator('textarea[data-canvas-surface="text"]');
    await expect(surface).toBeFocused();
    const before = (await storyText(page))!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "´",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await cdp.send("Input.insertText", { text: "é" });
    await expect.poll(() => storyText(page)).toBe(`é${before}`);
    // Nothing more arrives late (an echo of the commit).
    await page.waitForTimeout(200);
    expect(await storyText(page)).toBe(`é${before}`);
  });

  test("UXI-T32 — Escape during an IME composition is the input method's: the text editing stays; afterwards Escape leaves the text @feat:stories-text.caret-selection @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    await setCaret(page, 2);
    const surface = page.locator('textarea[data-canvas-surface="text"]');
    await expect(surface).toBeFocused();
    const before = (await storyText(page))!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "かな",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await expect(surface).toHaveAttribute("data-composing", "true");
    // The Escape an IME takes to cancel its candidates: composing.
    const taken = await page.evaluate(() => {
      const el = document.querySelector(
        'textarea[data-canvas-surface="text"]',
      )!;
      const e = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(e, "isComposing", { value: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(taken).toBe(false);
    // Still in the text, at the same caret, nothing typed, the frame kept.
    await expect(surface).toBeFocused();
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as Canvas).__canvas.contentSelection?.start,
      ),
    ).toBe(2);
    expect(await storyText(page)).toBe(before);
    expect(await selectedIds(page)).toEqual([SHELL.text.id]);
    // The IME commits; then Escape is the editor's again and leaves the
    // text for its frame (ED-1).
    await cdp.send("Input.insertText", { text: "仮名" });
    await expect
      .poll(() => storyText(page))
      .toBe(`${before.slice(0, 2)}仮名${before.slice(2)}`);
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as Canvas).__canvas.contentSelection ?? null,
        ),
      )
      .toBe(null);
    expect(await selectedIds(page)).toEqual([SHELL.text.id]);
  });

  test("UXI-T24 — in a modal the arrows, Enter and Space are the dialog's: nothing moves, nothing is typed @feat:editor-shell.keyboard-shortcuts @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    const frame = await dumpElement(page, SHELL.text);
    const story = await storyText(page);
    const depth = await undoDepth(page);
    await invoke(page, "paged.file.exportPdf");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('[role="dialog"]') !== null,
        ),
      )
      .toBe(true);
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "Space"])
      await page.keyboard.press(key);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await dumpElement(page, SHELL.text)).toBe(frame);
    expect(await storyText(page)).toBe(story);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T25 — the arrows nudge the selected object only while the canvas owns focus, one undo step per press @feat:editor-shell.keyboard-shortcuts @level:edge", async ({
    page,
  }) => {
    covers("keybinding:arrowright→paged.object.nudgeRight");
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    const start = await dumpElement(page, SHELL.frame);
    const depth = await undoDepth(page);
    // A field holds focus: its arrows, not the frame's.
    const field = await inspectorField(page);
    await field.focus();
    await page.keyboard.press("ArrowRight");
    expect(await dumpElement(page, SHELL.frame)).toBe(start);
    expect(await undoDepth(page)).toBe(depth);
    // The canvas holds focus: one nudge, one undo step.
    await viewport(page).focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => undoDepth(page)).toBe(depth + 1);
    expect(await dumpElement(page, SHELL.frame)).not.toBe(start);
    await page.keyboard.press(`${PRIMARY}+z`);
    await expect.poll(() => dumpElement(page, SHELL.frame)).toBe(start);
  });

  test("UXI-T26 — with a caret in a story the arrows move the caret; the frame does not move @feat:stories-text.caret-selection @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    const frame = await dumpElement(page, SHELL.text);
    const depth = await undoDepth(page);
    await setCaret(page, 3);
    await expect(
      page.locator('textarea[data-canvas-surface="text"]'),
    ).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (globalThis as unknown as Canvas).__canvas.contentSelection
              ?.start ?? null,
        ),
      )
      .toBe(5);
    expect(await dumpElement(page, SHELL.text)).toBe(frame);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T27 — Delete removes the selected object as one undo step; the stories stay @feat:editor-shell.keyboard-shortcuts @level:edge", async ({
    page,
  }) => {
    covers("keybinding:delete→paged.object.delete");
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    await viewport(page).focus();
    const items = await itemCount(page);
    const story = await dumpStory(page, SHELL.storyId);
    const depth = await undoDepth(page);
    await page.keyboard.press("Delete");
    await expect.poll(() => itemCount(page)).toBe(items - 1);
    expect(await dumpStory(page, SHELL.storyId)).toBe(story);
    expect(await undoDepth(page)).toBe(depth + 1);
    await page.keyboard.press(`${PRIMARY}+z`);
    await expect.poll(() => itemCount(page)).toBe(items);
  });

  test("UXI-T28 — Delete on a text range removes the range; its frame stays @feat:stories-text.text.delete @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await select(page, [SHELL.text]);
    const items = await itemCount(page);
    const before = (await storyText(page))!;
    const depth = await undoDepth(page);
    await page.evaluate(
      ({ storyId }) =>
        (
          globalThis as unknown as {
            __canvas: {
              setContentSelection(s: {
                storyId: string;
                start: number;
                end: number;
              }): void;
            };
          }
        ).__canvas.setContentSelection({ storyId, start: 0, end: 6 }),
      { storyId: SHELL.storyId as string },
    );
    await expect(
      page.locator('textarea[data-canvas-surface="text"]'),
    ).toBeFocused();
    await page.keyboard.press("Delete");
    await expect.poll(() => storyText(page)).toBe(before.slice(6));
    expect(await itemCount(page)).toBe(items);
    expect(await undoDepth(page)).toBe(depth + 1);
  });

  test("UXI-T30 — Escape closes the context menu and only that: the selection stays; the next Escape clears it @feat:editor-shell.menus @level:edge", async ({
    page,
  }) => {
    covers("keybinding:shift+f10→paged.edit.contextMenu");
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    await viewport(page).focus();
    const depth = await undoDepth(page);
    await page.keyboard.press("Shift+F10");
    const menu = page.getByTestId("canvas-context-menu");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    expect(await selectedIds(page)).toEqual([SHELL.frame.id]);
    // Focus came back to the canvas, so the next key is the canvas's.
    await expect(viewport(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect.poll(() => selectedIds(page)).toEqual([]);
    // Selection is not history (ADR 1201, D-15).
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T31 — Escape in an edit context with no gesture leaves that context only; the next Escape clears the selection @feat:plugin-platform.edit-context @level:edge", async ({
    page,
  }) => {
    await openShell(page, { doc: true });
    await enterVectorGraphic(page);
    expect(await activeEditContext(page)).toBe("vectorGraphic");
    const selected = await selectedIds(page);
    expect(selected.length).toBeGreaterThan(0);
    const depth = await undoDepth(page);
    await viewport(page).focus();
    await page.keyboard.press("Escape");
    await expect.poll(() => activeEditContext(page)).toBe(null);
    // One level: the selection the context was entered on is still there.
    expect(await selectedIds(page)).toEqual(selected);
    await page.keyboard.press("Escape");
    await expect.poll(() => selectedIds(page)).toEqual([]);
    expect(await undoDepth(page)).toBe(depth);
  });

  test("UXI-T34 — replacing the selected object by keyboard (cut, then paste) keeps focus on the canvas; no key acts on the object that went @feat:editor-shell.vector-clipboard @level:edge", async ({
    page,
  }) => {
    covers(
      "keybinding:cmd+x→paged.edit.cut",
      "keybinding:ctrl+x→paged.edit.cut",
      "keybinding:cmd+v→paged.edit.paste",
      "keybinding:ctrl+v→paged.edit.paste",
    );
    await openShell(page, { doc: true });
    await select(page, [SHELL.frame]);
    await viewport(page).focus();
    const items = await itemCount(page);
    const depth = await undoDepth(page);
    // Cut: the object leaves, as one step, and focus stays on the canvas.
    await page.keyboard.press(`${PRIMARY}+x`);
    await expect.poll(() => itemCount(page)).toBe(items - 1);
    await expect.poll(() => selectedIds(page)).toEqual([]);
    expect(await undoDepth(page)).toBe(depth + 1);
    await expect(viewport(page)).toBeFocused();
    // No ghost: an arrow or Delete now acts on nothing (§12.4: no
    // selection, no-op), and adds no history.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Delete");
    expect(await undoDepth(page)).toBe(depth + 1);
    expect(await itemCount(page)).toBe(items - 1);
    // Paste: the replacement is the selection, the next key is its.
    await page.keyboard.press(`${PRIMARY}+v`);
    await expect.poll(() => itemCount(page)).toBe(items);
    await expect.poll(async () => (await selectedIds(page)).length).toBe(1);
    expect(await undoDepth(page)).toBe(depth + 2);
    await expect(viewport(page)).toBeFocused();
    const pasted = await selectedIds(page);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => undoDepth(page)).toBe(depth + 3);
    expect(await selectedIds(page)).toEqual(pasted);
  });
});
