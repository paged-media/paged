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

// W2.4 (2026-06-06) — Tabs panel acceptance. The stop editor went
// fully LIVE on protocol v28's whole-list `paragraphTabStops` path
// (`Value::TabStops(TabStopSpec[])`). With a content selection the
// editor reads the paragraph's stops, edits them in local state, and
// commits the FULL list per change (one `setElementProperty` mutate).
// The op-level round-trip is e2e/tabs-ops.spec.ts; this proves the
// panel mounts live and the add/remove controls drive real commits.

import { test, expect } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openCanvas, loadIdml, openPanel } from "./fidelity/canvas-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = pathResolve(__dirname, "..", "..", "..");
const FIXTURE = `${REPO_ROOT}/corpus/idml/generated/text.idml`;

test.describe("W2.4 — Tabs panel (live whole-list editor)", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
    await loadIdml(page, FIXTURE);
    await openPanel(page, "paged.tabs");
  });

  test("AC-TABS-1 — panel mounts live (no concept badge, ruler present) @feat:editor-shell.panels.tabs @level:smoke", async ({
    page,
  }) => {
    const root = page.locator('[data-tabs-panel="ready"]');
    await expect(root).toBeVisible();
    // Fully live now — no Concept/Partial badge, no Target footnote.
    await expect(root.locator("[data-panel-status]")).toHaveCount(0);
    await expect(root.locator("[data-tabs-ruler]")).toBeVisible();
  });
});
