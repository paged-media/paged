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

// Journey: paged.data RENDERED output — the data-publishing flow lowers bound
// content INTO the layout and it VISIBLY renders on the page.
//
// paged.data publishes governed data into the document: a CSV registers through
// the data engine's query store, a binding resolves, and the bound
// content LOWERS to native Paged content (data-host-model → Mutation) that
// reaches the page. This journey drives that end to end through the REAL editor
// host and render-verifies the result with a before/after pixel diff.
//
// The data engine (the data-js wasm, the query store inside it, ADR 561) boots
// in the headless harness on both the bundled-Chromium `journeys` lane and the
// real-Chrome `journeys-gpu` lane.
//
// Defence in depth: if the engine ever fails to boot on a future host (a
// missing bin/data_js_bg.wasm), the source never reaches "ready" and the test
// SKIPS with the precise status rather than flaking — but on the standard
// editor dev server the render assertion is HARD and drives green.

import { expect, test, type Page } from "@playwright/test";

import { openPanel } from "../../fidelity/canvas-driver";
import { Designer } from "../driver/designer";

import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skipWithoutEngine } from "./data-engine-gate";
import { addBindingThroughPanel } from "./data-engine";

const CSV_FIXTURE = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../e2e/harness/data-people.csv",
);

const SOURCES_PANEL = "media.paged.data.panel.sources";
const BINDINGS_PANEL = "media.paged.data.panel.bindings";
const IMPORT_COMMAND = "media.paged.data.command.importData";

const invoke = (page: Page, id: string) =>
  page.evaluate(
    (c) =>
      (
        globalThis as unknown as {
          __canvas: {
            registries: {
              commands: { invoke: (i: string) => Promise<unknown> };
            };
          };
        }
      ).__canvas.registries.commands.invoke(c),
    id,
  );

test.describe("journey · paged.data render output", () => {
  test("a designer publishes data into the layout: import a CSV, wire a binding, then the bound content renders on the page @feat:data.plugin.bundle @feat:editor-shell.plugin-bundles @level:happy", async ({
    page,
  }) => {
    const designer = new Designer(page);
    await designer.open();
    await designer.newDocument();

    // ── 1. IMPORT GATEWAY — feed the CSV into the sources panel; the session
    //    lazily boots the data engine and registers the table.
    //    Reaching "ready" means the query engine booted (the unblocked path). ──
    await invoke(page, IMPORT_COMMAND);
    await openPanel(page, SOURCES_PANEL);
    // data canary.6: import goes through the shell.pickFile@1 door
    // (programmatic input.click -> Playwright filechooser, the doc.journey
    // idiom); the raw <input> survives only in the SDK harness.
    const importButton = page.locator("[data-data-import-csv]");
    await expect(importButton).toBeVisible({ timeout: 10_000 });
    const chooser = page.waitForEvent("filechooser");
    await importButton.click();
    await (await chooser).setFiles(CSV_FIXTURE);

    const status = page.locator("[data-status]").last();
    let ready = false;
    try {
      await expect
        .poll(
          async () =>
            (await status.getAttribute("data-status").catch(() => null)) ?? "?",
          { timeout: 45_000 },
        )
        .toBe("ready");
      ready = true;
    } catch {
      ready = false;
    }

    if (!ready) {
      const got =
        (await status.getAttribute("data-status").catch(() => null)) ??
        "unknown";
      skipWithoutEngine(
        got,
        `paged.data render needs the data engine to boot (engine status "${got}"). On the ` +
          "standard editor dev server it boots on both lanes; " +
          "this skip only fires if the package shipped no bin/data_js_bg.wasm or the " +
          "context is not cross-origin isolated — see the file header.",
      );
    }

    // The source registered (the panel sanitises `data-people.csv` →
    // `data_people`). The sanitised name surfaces in more than one place once
    // wired (the source row + a query referencing it), so target the first.
    await expect(page.getByText(/data_people/).first()).toBeVisible({
      timeout: 6_000,
    });

    // ── 2. WIRE + LOWER — open the bindings panel, add bindings through its
    //    authoring row (a variable field and a table over "All rows of
    //    data_people", which defines that query on first use), then
    //    lower it to the document. `lowerAll` refreshes the data through the store
    //    and commits the resolved content as native Paged Mutations — the page,
    //    blank before, now carries the data-driven content. ──
    await openPanel(page, BINDINGS_PANEL);
    await expect(page.locator("[data-data-bind-author]")).toBeVisible({
      timeout: 10_000,
    });

    const beforeLower = await designer.renderBytes();
    await addBindingThroughPanel(page, "variable", "name");
    await addBindingThroughPanel(page, "table", "name, role");
    await page.getByRole("button", { name: /lower to document/i }).click();

    // ── 3. RENDER ASSERTION (HARD) — the bound content visibly reached the
    //    page. The lower lane refreshes data (a store query) and then
    //    commits the Mutations: polled until the commit lands (ADR 228). ──
    await designer.expectRenderChangesFrom(beforeLower);
  });
});
