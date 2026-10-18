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

// ADR 225 — the live relay in a real tab: this test plays Claude through
// paged.server's /mcp (with the signed-in person's own token) while the
// person allows, declines and merges in the Library panel.
//
// Needs what library-server.spec needs: `npx wrangler dev --port 8791` and
// PAGED_SERVER_URL=http://127.0.0.1:8791 IDML_CANVAS_TEST_PORT=5291.

import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";

import { openCanvas, openPanel } from "../fidelity/canvas-driver";
import { startFakeIdp } from "./harness/fake-idp";

const SERVER = process.env.PAGED_SERVER_URL;
const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE = `${REPO_ROOT}/corpus/idml/generated/text.idml`;

/** One MCP tool call, as Claude would make it, with the person's token. */
async function claude(token: string, name: string, args: Record<string, unknown>) {
  const resp = await fetch(`${SERVER}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return ((await resp.json()) as { result: { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError: boolean } }).result;
}

async function tokenOf(page: Page): Promise<string> {
  return page.evaluate((server) => {
    const raw = localStorage.getItem(`paged.server.${new URL(server).origin}.tokens`);
    return (JSON.parse(raw ?? "{}") as { access: string }).access;
  }, SERVER!);
}

test.describe("library panel · Claude in this tab @feat:editor-shell.panels.library", () => {
  test.skip(!SERVER, "needs PAGED_SERVER_URL and a running paged.server");
  let idp: Server;
  test.beforeAll(async () => {
    idp = await startFakeIdp();
  });
  test.afterAll(async () => {
    await new Promise((r) => idp.close(r));
  });

  test("Claude scripts, renders and saves in the tab; the person allows, declines, merges @level:happy", async ({ page, context }) => {
    await openCanvas(page);
    await page.evaluate(async () => {
      localStorage.clear();
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("paged-library", { recursive: true }).catch(() => undefined);
    });
    await page.reload();
    await openCanvas(page);
    await page.setInputFiles('input[type="file"]', FIXTURE);
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { __canvas: { ready: boolean } }).__canvas.ready))
      .toBe(true);
    await openPanel(page, "paged.library");
    const panel = page.locator("[data-library-panel]");
    await expect(panel.locator("[data-library-version]")).toHaveCount(1);

    const popup = context.waitForEvent("page");
    await panel.locator("[data-library-signin]").click();
    await (await popup).waitForEvent("close");
    await panel.locator("[data-library-live-connect]").click();
    await expect(panel.locator("[data-library-live-state]")).toBeVisible();
    const token = await tokenOf(page);

    const sessions = await claude(token, "list_live_sessions", {});
    expect((sessions.structuredContent?.sessions as unknown[]).length).toBe(1);

    // A change waits for the person.
    const ran = claude(token, "run_script", { source: "console.log(paged.pages().length > 0)" });
    await expect(panel.locator('[data-library-live-pending="run_script"]')).toBeVisible();
    await panel.locator("[data-library-live-allow]").click();
    const result = await ran;
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("true");

    const declined = claude(token, "run_script", { source: "paged.pages()" });
    await expect(panel.locator('[data-library-live-pending="run_script"]')).toBeVisible();
    await panel.locator("[data-library-live-decline]").click();
    expect((await declined).isError).toBe(true);
    await expect(panel.locator('[data-library-live-entry="declined"]')).toHaveCount(1);

    // Reading needs no permission.
    const shot = await claude(token, "render_page", { page: 1 });
    expect(shot.content[0].type).toBe("image");

    // A save is Claude's version on its own branch; main does not move until the person merges.
    const saving = claude(token, "save_document", { message: "Claude's pass" });
    await expect(panel.locator('[data-library-live-pending="save_document"]')).toBeVisible();
    await panel.locator("[data-library-live-allow]").click();
    const saved = await saving;
    expect(saved.isError).toBe(false);
    const branch = String(saved.structuredContent?.ref);
    expect(branch).toMatch(/^agent\//);
    await expect(panel.locator("[data-library-version]")).toHaveCount(1);
    await expect(panel.locator(`[data-library-merge="${branch}"]`)).toBeVisible();
    await panel.locator(`[data-library-merge="${branch}"]`).click();
    await expect(panel.locator("[data-library-version]")).toHaveCount(2);

    await panel.locator("[data-library-live-disconnect]").click();
    await expect(panel.locator("[data-library-live-connect]")).toBeVisible();
    await expect.poll(async () => ((await claude(token, "list_live_sessions", {})).structuredContent?.sessions as unknown[]).length).toBe(0);
  });
});
