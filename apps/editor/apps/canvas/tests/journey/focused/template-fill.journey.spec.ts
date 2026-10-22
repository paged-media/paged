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

// The template-fill preset end to end (docs/composable-editor-plan.md, D):
// the editor boots without menus, rulers or palette, with the template
// form; an author (through the automation handle) makes a text frame a
// field; as a filler the user fills it in through the form, the engine takes
// it, and refuses a move of the frame.

import { test, expect } from "@playwright/test";

import { Designer } from "../driver/designer";

type Page = import("@playwright/test").Page;

async function makeTemplate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type Reply = { kind: string; payload: Record<string, unknown> };
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            setSessionPolicy(p: unknown): Promise<unknown>;
            mutate(m: unknown): Promise<Reply>;
            templateFields(): Promise<{ storyId: string | null }[]>;
          };
          handle?: { pageIds?: string[] };
        };
      }
    ).__canvas;
    await c.client.setSessionPolicy({ role: "author", overrides: [] });
    const deadline = Date.now() + 10_000;
    while (!c.handle?.pageIds?.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pageId = c.handle!.pageIds![0];
    const frame = await c.client.mutate({
      op: "insertTextFrame",
      args: { pageId, bounds: [100, 40, 160, 300] },
    });
    const elementId = frame.payload.createdId;
    await c.client.mutate({
      op: "setPluginMetadata",
      args: {
        elementId,
        key: "x-paged:template",
        value: JSON.stringify({
          v: 1,
          data: {
            field: {
              name: "headline",
              kind: "text",
              label: "Headline",
              constraints: { maxLength: 30 },
            },
          },
        }),
      },
    });
    const [field] = await c.client.templateFields();
    await c.client.mutate({
      op: "insertText",
      args: { storyId: field!.storyId, offset: 0, text: "Old title" },
    });
    await c.client.setSessionPolicy({ role: "filler", overrides: [] });
  });
}

async function headline(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const c = (
      globalThis as unknown as {
        __canvas: {
          client: {
            templateFields(): Promise<
              { value?: { kind: string; text?: string } | null }[]
            >;
          };
        };
      }
    ).__canvas.client;
    const [f] = await c.templateFields();
    return f?.value?.text ?? null;
  });
}

test.describe("journey · template fill", () => {
  test("a filler fills a field through the form, and the frame stays put @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open({ search: "?profile=template-fill" });

    // The chrome of a fill-in editor: no menus, rulers or search.
    await expect(page.locator('[role="menubar"]')).toHaveCount(0);
    await expect(page.locator("[data-h-ruler]")).toHaveCount(0);
    await expect(page.locator("[data-command-trigger]")).toHaveCount(0);
    await expect(page.locator("[data-template-form-empty]")).toBeVisible();

    await designer.newDocument();
    await makeTemplate(page);
    const input = page.locator('[data-field-input="headline"]');
    await expect(input).toHaveValue("Old title", { timeout: 15_000 });

    await input.fill("Ada Example");
    await input.press("Enter");
    await expect
      .poll(() => headline(page), { timeout: 10_000 })
      .toBe("Ada Example");
    await expect(page.locator('[data-field-count="headline"]')).toHaveText(
      "11/30",
    );

    // The engine refuses what the template does not permit, whoever asks.
    const refused = await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            client: {
              templateFields(): Promise<{ elementId: { id: string } | null }[]>;
              mutate(m: unknown): Promise<{
                kind: string;
                payload: { error?: { kind: string } };
              }>;
            };
          };
        }
      ).__canvas.client;
      const [f] = await c.templateFields();
      const reply = await c.mutate({
        op: "moveFrame",
        args: { frameId: f!.elementId!.id, transform: [1, 0, 0, 1, 50, 50] },
      });
      return reply.kind === "mutationFailed"
        ? reply.payload.error?.kind
        : reply.kind;
    });
    expect(refused).toBe("notPermitted");
  });

  test("the viewer preset shows the canvas and nothing to change @feat:editor-shell.solo-mode @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open({ search: "?profile=viewer" });
    await expect(page.locator("header")).toHaveCount(0);
    await expect(page.locator('[aria-label="Panels"]')).toHaveCount(0);
    await expect(page.locator("[data-paged-viewport]")).toBeVisible();
  });
});
