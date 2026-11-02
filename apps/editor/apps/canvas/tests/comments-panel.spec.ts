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

// Comments panel — the host's one panel for every comment thread (engine
// ADR 1055). This spec pins the empty document: the empty state renders, the
// thread list does not, and the new-comment box is there. Thread behaviour
// (grouping, filters, replies, pins) is covered by the model and DOM specs
// next to the panel (test/panels/comments-model.test.ts, the shell's
// comment-pins DOM spec).

import { test, expect } from "@playwright/test";

import { openCanvas, openPanel } from "./fidelity/canvas-driver";

test.describe("Comments panel (engine ADR 1055)", () => {
  test("AC-COMMENTS-1 — an empty document: the empty state and the new-comment box @feat:editor-shell.panels.comments @level:happy", async ({
    page,
  }) => {
    await openCanvas(page);
    await openPanel(page, "paged.comments");

    const panel = page.locator('[data-comments-panel="ready"]');
    await expect(panel).toBeVisible();

    // No threads yet: the empty state says what the panel is for.
    const empty = panel.locator("[data-coming-soon]");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No comments yet");
    await expect(panel.locator("[data-thread-list]")).toHaveCount(0);

    // The new-comment box is there, and offers nothing to send until
    // something is selected to comment on.
    await expect(panel.locator("[data-new-comment-input]")).toBeVisible();
  });
});
