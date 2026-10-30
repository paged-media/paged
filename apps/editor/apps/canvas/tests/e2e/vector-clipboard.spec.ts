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

// ADR 289 (D-63) — the vector clipboard in the browser, through the keys.
// Chromium's clipboard (Playwright's, in-process when headless) takes
// `image/svg+xml`: Copy of a polygon writes it beside text/plain and
// text/html; a paste of Illustrator's Edit ▸ Copy (its SVG source as
// plain text, recorded by modules/draw/scripts/illustrator/
// run-clipboard-probe.sh) lands its two paths as native page items in
// one undo step.

import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { covers } from "@paged-media/test-kit";

import { SHELL, blurAll, openShell, select } from "./harness/shell-surface";

const ILLUSTRATOR_SVG = readFileSync(
  new URL(
    "../../test/fixtures/clipboard/clipboard-copy.illustrator.svg",
    import.meta.url,
  ),
  "utf8",
);

type G = {
  __canvas: {
    client: { sceneTree(): Promise<unknown[]> };
    registries: { commands: { invoke(id: string): Promise<unknown> } };
  };
};

/** Polygons in the document (the scene tree's kinds). */
async function polygons(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const tree = await (globalThis as unknown as G).__canvas.client.sceneTree();
    let n = 0;
    const visit = (node: { kind?: string; children?: unknown[] }) => {
      if (node.kind === "Polygon") n++;
      for (const c of (node.children ?? []) as Array<typeof node>) visit(c);
    };
    for (const root of tree as Array<{ kind?: string; children?: unknown[] }>)
      visit(root);
    return n;
  });
}

/** What the clipboard holds, by type. The system clipboard is the
 *  machine's, shared with the other workers: a read that a write elsewhere
 *  overtakes ("Clipboard data has changed") is read again. */
async function clipboardTypes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const out: Record<string, string> = {};
        for (const item of await navigator.clipboard.read())
          for (const t of item.types)
            out[t] = await (await item.getType(t)).text();
        return out;
      } catch (err) {
        if (attempt >= 4 || (err as Error).name !== "InvalidStateError")
          throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
}

test.describe("ADR 289 (D-63) — the vector clipboard [editor-shell.vector-clipboard]", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });

  test("Copy writes image/svg+xml beside text and HTML", async ({ page }) => {
    covers("command:paged.edit.copy", "keybinding:cmd+c→paged.edit.copy");
    await openShell(page, { doc: true });
    await select(page, [SHELL.poly]);
    await blurAll(page);
    await page.keyboard.press("Meta+KeyC");
    await expect
      .poll(async () => Object.keys(await clipboardTypes(page)).sort(), {
        timeout: 10_000,
      })
      .toEqual(["image/svg+xml", "text/html", "text/plain"]);
    const forms = await clipboardTypes(page);
    expect(forms["image/svg+xml"]).toContain("<path ");
    expect(forms["text/html"]).toContain("data-paged-clip");
    // A polygon has no text: the plain text is the SVG code.
    expect(forms["text/plain"]).toMatch(/^<svg[\s>]/);
  });

  test("Illustrator's copy pastes as its two paths, one undo step", async ({
    page,
  }) => {
    covers("command:paged.edit.paste", "keybinding:cmd+v→paged.edit.paste");
    await openShell(page, { doc: true });
    await page.evaluate(
      (svg) =>
        navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([svg], { type: "text/plain" }),
          }),
        ]),
      ILLUSTRATOR_SVG,
    );
    await select(page, []);
    await blurAll(page);
    const before = await polygons(page);
    await page.keyboard.press("Meta+KeyV");
    await expect
      .poll(() => polygons(page), { timeout: 10_000 })
      .toBe(before + 2);
    await page.evaluate(() =>
      (globalThis as unknown as G).__canvas.registries.commands.invoke(
        "paged.editor.undo",
      ),
    );
    await expect.poll(() => polygons(page), { timeout: 5_000 }).toBe(before);
  });
});
