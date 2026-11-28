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

// Actions — record / replay a command sequence.
//
// The BROWSER tier: it proves the tap. The claim under test is not
// "the panel renders" — it is that the recorder sees a command
// invoked from anywhere, and that a document edit which does NOT
// go through a command is COUNTED rather than silently dropped.
// That second assertion is the whole point of the feature's
// scoping, so it gets a test.
//
// The classifier, the replay plan and the projections (AC-ACT-1 to
// AC-ACT-11) are unit tests of the shell:
// `packages/shell/test/actions/model.test.ts`.

import { expect, test } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openCanvas, loadIdml } from "./fidelity/canvas-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = pathResolve(__dirname, "..", "..", "..");
const FIXTURE = `${REPO_ROOT}/corpus/idml/generated/geometry-groups.idml`;

test.describe("Actions — the command tap (browser)", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
    await loadIdml(page, FIXTURE);
    await page.evaluate(() =>
      (
        globalThis as unknown as {
          __canvas: { openPanel: (id: string) => void };
        }
      ).__canvas.openPanel("paged.actions"),
    );
    await expect(page.locator('[data-actions-panel="ready"]')).toBeVisible();
  });

  test("AC-ACT-12 — record → stop → play captures and replays command invocations @feat:editor-shell.panels.actions @level:happy", async ({
    page,
  }) => {
    await page.locator('[data-cockpit-action="actions-record"]').click();
    await expect(page.locator("[data-actions-recording]")).toBeVisible();

    // Invoked through the registry — the same door the menu bar, the
    // palette and the keybinding dispatcher all use.
    await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): Promise<unknown> } };
          };
        }
      ).__canvas.registries.commands;
      await c.invoke("paged.view.zoom100");
      await c.invoke("paged.view.zoomFit");
    });

    await expect(page.locator("[data-actions-step-count]")).toHaveText("2");

    await page.locator("[data-actions-name]").fill("Zoom pair");
    await page.locator('[data-cockpit-action="actions-stop"]').click();

    await expect(page.getByText("Zoom pair")).toBeVisible();
    // Both steps carry no payload, so both are classified `contextual`
    // — the verdict that says "replays against the replay-time
    // selection", and the one that makes an action portable at all.
    await expect(page.locator("[data-actions-step]")).toHaveCount(2);
    await expect(
      page.locator('[data-actions-verdict="contextual"]'),
    ).toHaveCount(2);

    await page.locator('[data-cockpit-action^="actions-play-"]').click();
    await expect(page.locator("[data-actions-report]")).toBeVisible();
    await expect(page.locator("[data-actions-report-step]")).toHaveCount(2);
    // No step reports an error.
    await expect(page.locator("[data-actions-report]")).not.toContainText(
      "failed:",
    );
  });

  test("AC-ACT-13 — an edit that bypasses the command registry is COUNTED, not silently dropped @feat:editor-shell.panels.actions @level:edge", async ({
    page,
  }) => {
    // The load-bearing honesty test. `client.mutate` is the door
    // gestures, typing and panel fields go through; none of them can
    // reach the command registry. The recorder must therefore say a
    // change happened that it could not capture — a recording that
    // looked complete while missing this is the failure mode the
    // whole scoping exists to prevent.
    await page.locator('[data-cockpit-action="actions-record"]').click();
    await page.evaluate(async () => {
      const canvas = globalThis as unknown as {
        __canvas: { client: { mutate(m: unknown): Promise<unknown> } };
      };
      await canvas.__canvas.client.mutate({
        op: "insertPage",
        args: { afterPageId: null, masterId: null },
      });
    });

    await expect(page.locator("[data-actions-uncaptured]")).toContainText(
      "direct edit",
    );
    // …and it produced no step, because it is not a command.
    await expect(page.locator("[data-actions-step-count]")).toHaveText("0");
  });

  test("AC-ACT-14 — record/stop/play are themselves commands, and the recorder does not record them @feat:editor-shell.panels.actions @level:edge", async ({
    page,
  }) => {
    // Without the deny-list, starting a recording from the command
    // palette would make the recording's first step "start recording".
    await page.evaluate(async () => {
      const c = (
        globalThis as unknown as {
          __canvas: {
            registries: { commands: { invoke(id: string): Promise<unknown> } };
          };
        }
      ).__canvas.registries.commands;
      await c.invoke("paged.actions.record");
      await c.invoke("paged.view.zoomFit");
    });
    await expect(page.locator("[data-actions-recording]")).toBeVisible();
    await expect(page.locator("[data-actions-step-count]")).toHaveText("1");
  });
});
