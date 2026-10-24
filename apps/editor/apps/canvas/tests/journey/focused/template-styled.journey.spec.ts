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

// Engine ADR 1016 end to end, in the template-fill preset: a filler writes a
// text field in a character style its author allows, and picks an alternate
// frame; each is one undo step, and the overlay names the alternate shown.

import { test, expect } from "@playwright/test";

import { Designer } from "../driver/designer";

type Page = import("@playwright/test").Page;

interface Client {
  setSessionPolicy(p: unknown): Promise<unknown>;
  mutate(m: unknown): Promise<{
    kind: string;
    payload: Record<string, unknown>;
  }>;
  templateFields(): Promise<
    { field: { name: string }; storyId: string | null; value?: unknown }[]
  >;
  undo(): Promise<unknown>;
}

const client = (page: Page) =>
  page.evaluateHandle(
    () =>
      (globalThis as unknown as { __canvas: { client: unknown } }).__canvas
        .client,
  );

async function makeTemplate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: { client: Client; handle?: { pageIds?: string[] } };
      }
    ).__canvas;
    await c.client.setSessionPolicy({ role: "author", overrides: [] });
    const deadline = Date.now() + 10_000;
    while (!c.handle?.pageIds?.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pageId = c.handle!.pageIds![0];
    for (const name of ["Bold", "Italic"])
      await c.client.mutate({
        op: "createCharacterStyle",
        args: { selfId: `CharacterStyle/${name}`, name },
      });
    const frame = await c.client.mutate({
      op: "insertTextFrame",
      args: { pageId, bounds: [60, 40, 120, 300] },
    });
    await c.client.mutate({
      op: "setPluginMetadata",
      args: {
        elementId: frame.payload.createdId,
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: {
              name: "headline",
              kind: "text",
              constraints: {
                allowedStyles: ["Bold", "Italic"],
                breaks: "line",
              },
            },
          },
        }),
      },
    });
    const rows = await c.client.templateFields();
    await c.client.mutate({
      op: "insertText",
      args: { storyId: rows[0]!.storyId, offset: 0, text: "Old" },
    });
    for (const [i, name] of ["left", "right"].entries()) {
      const f = await c.client.mutate({
        op: "insertFrame",
        args: { pageId, bounds: [160, 40 + i * 140, 260, 160 + i * 140] },
      });
      const prop = (path: string, value: unknown) =>
        c.client.mutate({
          op: "setElementProperty",
          args: { elementId: f.payload.createdId, path, value },
        });
      await prop("itemName", { type: "text", value: name });
      if (i > 0) await prop("elementVisible", { type: "bool", value: false });
    }
    await c.client.mutate({
      op: "setDocumentMetadata",
      args: {
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            alternates: {
              layout: {
                name: "layout",
                kind: "alternates",
                members: ["left", "right"],
              },
            },
          },
        }),
      },
    });
    await c.client.setSessionPolicy({ role: "filler", overrides: [] });
  });
}

async function value(page: Page, name: string): Promise<unknown> {
  const c = await client(page);
  return c.evaluate(async (cl, n) => {
    const rows = await (cl as Client).templateFields();
    return rows.find((r) => r.field.name === n)?.value ?? null;
  }, name);
}

async function undo(page: Page): Promise<void> {
  const c = await client(page);
  await c.evaluate(async (cl) => {
    await (cl as Client).undo();
  });
}

test.describe("journey · template styled values and alternates", () => {
  test("a filler writes in an allowed style and picks an alternate, one undo step each @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open({ search: "?profile=template-fill" });
    await designer.newDocument();
    await makeTemplate(page);

    const box = page.locator('[data-field-styled="headline"]');
    await expect(box).toHaveText("Old", { timeout: 15_000 });
    await expect(page.locator("[data-field-style]")).toHaveCount(2);

    // Type the value, select its last word, and set it in Bold: the form
    // writes the runs.
    await box.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Ada Lovelace");
    await box.evaluate((el) => {
      const text = el.firstChild!;
      const range = document.createRange();
      range.setStart(text, 4);
      range.setEnd(text, 12);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await page.locator('[data-field-style="Bold"]').click();
    await expect
      .poll(() => value(page, "headline"), { timeout: 10_000 })
      .toEqual({
        kind: "runs",
        runs: [{ text: "Ada " }, { text: "Lovelace", style: "Bold" }],
      });
    await undo(page);
    await expect
      .poll(() => value(page, "headline"), { timeout: 10_000 })
      .toEqual({ kind: "runs", runs: [{ text: "Old" }] });

    // The alternates picker shows the right frame and hides the left.
    await expect(page.locator('[data-field-alternate="left"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.locator('[data-field-alternate="right"]').click();
    await expect
      .poll(() => value(page, "layout"), { timeout: 10_000 })
      .toEqual({ kind: "alternate", member: "right" });
    await expect(
      page.locator('[data-template-field-alternate="right"]'),
    ).toHaveCount(1);
    await undo(page);
    await expect
      .poll(() => value(page, "layout"), { timeout: 10_000 })
      .toEqual({ kind: "alternate", member: "left" });
  });
});
