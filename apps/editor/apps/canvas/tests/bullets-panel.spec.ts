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

// W2.4 (2026-06-06) — Bullets & Numbering panel acceptance. List
// type + bullet glyph + numbering format flipped seam→live on
// protocol v28's list-authoring text paths
// (`paragraphListType` / `paragraphBulletCharacter` /
// `paragraphNumberingFormat`, all `Value::Text`). The list-definition
// rows (List / Level / Restart / Position) stay honest seams, so the
// panel keeps its Partial badge (the Glyphs precedent). The op-level
// round-trip is e2e/bullets-ops.spec.ts; this proves the live
// controls render and the list-type segment commits.

import { test, expect } from "@playwright/test";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openCanvas, loadIdml, openPanel } from "./fidelity/canvas-driver";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = pathResolve(__dirname, "..", "..", "..");
const FIXTURE = `${REPO_ROOT}/corpus/idml/generated/text.idml`;
const NUMBERING_FIXTURE = `${REPO_ROOT}/corpus/idml/generated/numbering.idml`;

test.describe("W2.4 — Bullets & Numbering panel (partial-live)", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
    await loadIdml(page, FIXTURE);
    await openPanel(page, "paged.bullets-numbering");
  });

  test("AC-BN-1 — panel mounts with the Partial badge and live controls @feat:editor-shell.panels.bullets-numbering @level:smoke", async ({
    page,
  }) => {
    const root = page.locator('[data-bullets-panel="ready"]');
    await expect(root).toBeVisible();
    await expect(root.locator('[data-panel-status="partial"]')).toBeVisible();
    // The live list-type toggle (paragraphListType) carries the IDML
    // enum option values; the bullet glyph + numbering format are
    // bound text fields.
    await expect(root.locator("[data-toggle-group]")).toBeVisible();
    await expect(
      root.locator('[data-bullets-field="bullet-character"]'),
    ).toBeVisible();
    await expect(
      root.locator('[data-bullets-field="numbering-format"]'),
    ).toBeVisible();
  });
});

test.describe("W2.10 — Bullets & Numbering list definitions (live CRUD)", () => {
  test.beforeEach(async ({ page }) => {
    await openCanvas(page);
    await loadIdml(page, NUMBERING_FIXTURE);
    await openPanel(page, "paged.bullets-numbering");
  });

  test("AC-BN-LD-1 — the list-definitions manager renders the document's named lists", async ({
    page,
  }) => {
    const defs = page.locator('[data-list-definitions="ready"]');
    await expect(defs).toBeVisible();
    // The numbering fixture ships one named list (`Shared`).
    const rows = defs.locator("[data-list-def]");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator("[data-list-def-name]")).toHaveText(
      "Shared",
    );
    // Continuity toggle reflects the fixture's
    // ContinueNumbersAcrossStories=true.
    await expect(
      rows.first().locator("[data-list-def-continuity]"),
    ).toHaveAttribute("aria-checked", "true");
    // The applied-list read-back honest seam is present.
    await expect(defs.locator("[data-applied-readback-seam]")).toBeVisible();
  });

  test("AC-BN-LD-3 — continuity toggle flips and re-reads from the model @feat:editor-shell.panels.bullets-numbering @level:happy", async ({
    page,
  }) => {
    const row = page
      .locator('[data-list-definitions="ready"] [data-list-def]')
      .first();
    const toggle = row.locator("[data-list-def-continuity]");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    // The collection re-fetches after the editNumberingList mutation;
    // the toggle reflects the new model value.
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
