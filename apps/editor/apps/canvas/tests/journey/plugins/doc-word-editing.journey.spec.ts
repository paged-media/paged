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

// Journey: Word inside paged — the editing model (doc ADR 608, editor ADRs
// 298 and 299, extensions ADR 348).
//
// A .docx opened with File ▸ Open becomes the document, and paged.doc
// holds the wordDocument document context for it: there is no frame to
// enter, yet the Word chrome and keys apply on every page.
//
//   · STATUS BAR — page X of Y and the word count, the selection's of the
//     document's once text is selected;
//   · KEYS over the text input — Cmd+B on a selection makes a bold run in
//     the engine, Cmd+Alt+1 applies the document's Heading 1, Cmd+E
//     centres the paragraph: the scoped bindings win over the host's keys
//     and the text input;
//   · CONTROL BAR — the Home group replaces the text controls, and its
//     style box applies one of the document's own styles.
//
// Wave 1 (doc ADR 608 amendment 1, editor ADR 303):
//
//   · FIND & REPLACE — Cmd+H opens the host's dialog; Replace All is ONE
//     undo step (one Undo restores every hit);
//   · LISTS — Tab at the start of a list paragraph demotes it
//     (`setListLevel`);
//   · HIGHLIGHT — the Home group's button highlights the selection.

import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { openCanvas } from "../../fidelity/canvas-driver";

const FIXTURE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../e2e/harness/doc-memo.docx",
);
const OPEN = "paged.file.openIdml";
const IMPORTER = "media.paged.doc.importer.docx";
// doc-memo.docx: "Plain body text." / "A Centered Heading" (heading 1) / …
const STORY = "docx_s0";

type Reply = { kind: string; payload: Record<string, unknown> };
type CanvasGlobal = {
  __canvas: {
    ready: boolean;
    client: { send(m: unknown): Promise<Reply> };
    registries: {
      commands: { invoke(id: string): Promise<unknown> };
      importers: { resolve(name: string): { id: string } | null };
    };
    setContentSelection(s: unknown): void;
  };
};

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (cmd) =>
      (
        globalThis as unknown as CanvasGlobal
      ).__canvas.registries.commands.invoke(cmd),
    id,
  );

/** The first paragraph's runs and style, from the engine. */
async function firstParagraph(page: Page) {
  return page.evaluate(async (storyId) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const r = await c.client.send({
      kind: "requestStoryContent",
      payload: { storyId },
    });
    const content = r.payload.content as {
      paragraphs: Array<{
        paragraphStyle?: string;
        runs: Array<{ text: string; fontStyle?: string }>;
      }>;
    } | null;
    return content?.paragraphs[0] ?? null;
  }, STORY);
}

/** An effective value of the first paragraph's first characters. */
async function get(page: Page, path: string): Promise<unknown> {
  return page.evaluate(
    async ({ storyId, path }) => {
      const c = (globalThis as unknown as CanvasGlobal).__canvas;
      const r = await c.client.send({
        kind: "requestGet",
        payload: { address: `storyRange:${storyId}@0..5`, path },
      });
      const v = r.payload.value as { value: unknown } | null;
      return v?.value ?? null;
    },
    { storyId: STORY, path },
  );
}

const select = (page: Page, start: number, end: number) =>
  page.evaluate(
    ({ storyId, start, end }) =>
      (globalThis as unknown as CanvasGlobal).__canvas.setContentSelection({
        storyId,
        start,
        end,
      }),
    { storyId: STORY, start, end },
  );

/** File ▸ Open of doc-memo.docx, through the Word importer. */
async function openMemo(page: Page): Promise<void> {
  await openCanvas(page);
  await invoke(page, "paged.file.new");
  await page.waitForFunction(
    () => (globalThis as unknown as CanvasGlobal).__canvas.ready === true,
    null,
    { timeout: 15_000 },
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as CanvasGlobal
            ).__canvas.registries.importers.resolve("x.docx")?.id ?? null,
        ),
      { timeout: 15_000 },
    )
    .toBe(IMPORTER);
  const chooser = page.waitForEvent("filechooser");
  const opened = invoke(page, OPEN);
  await (await chooser).setFiles(FIXTURE);
  await opened;
  await expect
    .poll(async () => (await firstParagraph(page))?.runs[0]?.text ?? "", {
      timeout: 30_000,
    })
    .toContain("Plain body text.");
}

/** The story's paragraph texts, from the engine. */
async function storyText(page: Page): Promise<string[]> {
  return page.evaluate(async (storyId) => {
    const c = (globalThis as unknown as CanvasGlobal).__canvas;
    const r = await c.client.send({
      kind: "requestStoryContent",
      payload: { storyId },
    });
    const content = r.payload.content as {
      paragraphs: Array<{ runs: Array<{ text: string }> }>;
    } | null;
    return (content?.paragraphs ?? []).map((p) =>
      p.runs.map((x) => x.text).join(""),
    );
  }, STORY);
}

test.describe("journey · Word inside paged", () => {
  test.setTimeout(120_000);

  test("a Word user formats with Word's keys, control bar and status bar @feat:plugin-doc.edit-context @feat:editor-shell.keyboard-shortcuts @feat:editor-shell.context-toolbars @level:happy", async ({
    page,
  }) => {
    await openMemo(page);

    // STATUS BAR — the document context's items.
    const status = page.locator('[data-status-bar="wordDocument"]');
    await expect(status).toBeVisible({ timeout: 15_000 });
    await expect(status.locator('[data-word-status="page"]')).toContainText(
      /Page 1 of \d+/,
    );
    await expect(status.locator('[data-word-status="words"]')).toContainText(
      /\d+ words/,
    );

    // KEYS — Cmd+B on "Plain" makes a bold run in the engine.
    await select(page, 0, 5);
    await expect(
      page.locator('[data-control-bar="contributed"] [data-word-home]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(status.locator('[data-word-status="words"]')).toContainText(
      /^1 of \d+ words/,
    );
    await page.keyboard.press("Meta+b");
    await expect
      .poll(async () => {
        const p = await firstParagraph(page);
        const run = p?.runs.find((r) => r.text === "Plain");
        return run?.fontStyle ?? null;
      })
      .toBe("Bold");
    await expect(page.locator('[data-word-button="bold"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Cmd+Alt+1 — the document's own Heading 1.
    await page.keyboard.press("Meta+Alt+Digit1");
    await expect
      .poll(async () => (await firstParagraph(page))?.paragraphStyle ?? null)
      .toBe("ParagraphStyle/docx-Heading1");

    // Cmd+E — centred.
    await page.keyboard.press("Meta+e");
    await expect
      .poll(() => get(page, "paragraphJustification"))
      .toBe("CenterAlign");

    // CONTROL BAR — the style box applies the document's Normal style.
    const box = page.locator("[data-word-style]");
    await expect(box).toBeEnabled();
    await box.selectOption({ label: "Normal" });
    await expect
      .poll(async () => (await firstParagraph(page))?.paragraphStyle ?? null)
      .toBe("ParagraphStyle/docx-Normal");
  });
  test("a Word user replaces all in one undo step, demotes a list item with Tab and highlights @feat:plugin-doc.edit-context @feat:editor-shell.keyboard-shortcuts @feat:editor-shell.context-toolbars @level:happy", async ({
    page,
  }) => {
    await openMemo(page);
    const before = await storyText(page);
    expect(before[0]).toBe("Plain body text.");

    // FIND & REPLACE — Cmd+H (Word's key, the host's dialog).
    await select(page, 0, 5);
    await expect(
      page.locator('[data-control-bar="contributed"] [data-word-home]'),
    ).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Meta+h");
    const dialog = page.locator("[data-find-dialog]");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.locator('[data-find-input="find"]').fill("e");
    await dialog.locator('[data-find-input="replace"]').fill("E");
    await dialog.locator('[data-find-option="matchCase"]').check();
    await dialog.locator('[data-find-action="replaceAll"]').click();
    await expect(dialog.locator("[data-find-status]")).toContainText(
      /replacements?/,
    );
    await expect
      .poll(async () => (await storyText(page))[0])
      .toBe("Plain body tExt.");
    expect((await storyText(page)).join("\n")).not.toContain("e");
    await dialog.locator('[data-find-action="close"]').click();
    await expect(dialog).toHaveCount(0);
    // ONE undo restores every hit.
    await invoke(page, "paged.editor.undo");
    await expect.poll(() => storyText(page)).toEqual(before);

    // HIGHLIGHT — the Home group's button.
    await select(page, 0, 5);
    const highlight = page.locator('[data-word-button="highlight"]');
    await expect(highlight).toBeEnabled();
    await highlight.click();
    await expect
      .poll(() => get(page, "characterHighlightColor"))
      .not.toMatch(/^(Swatch\/None)?$/);
    await expect(highlight).toHaveAttribute("aria-pressed", "true");

    // LISTS — number the paragraph, then Tab at its start demotes it.
    await page.locator('[data-word-button="numbering"]').click();
    await expect
      .poll(() => get(page, "paragraphListType"))
      .toBe("NumberedList");
    await select(page, 0, 0);
    // The caret's paragraph is a list item at its start: Tab is the level.
    await expect(
      page.locator('[data-word-button="numbering"]'),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect.poll(() => get(page, "paragraphNumberingLevel")).toBe(2);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => get(page, "paragraphNumberingLevel")).toBe(1);
  });
});
