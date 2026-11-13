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

// Fixture G of the interaction contract (spec §23.1): two editor instances
// mounted at once. It is the embedding demo `demos/two-editors.html`
// (src/demos/two-editors.ts): two `createEditor` instances side by side,
// each with the same locked business card in the `template-fill` profile
// as a filler, each with its own engine, document and keys. An embedding
// publishes no `__canvas` (dev-handles.ts), so a spec reads each editor
// through its own DOM — the field inputs, the actions bar — as a host
// page would.

import { expect, type Locator, type Page } from "@playwright/test";

export type Side = "left" | "right";

export interface TwoEditors {
  /** The host element each editor is mounted in. */
  left: Locator;
  right: Locator;
  /** The editor root inside a side (`[data-paged-editor]`). */
  root(side: Side): Locator;
  /** A template field's input in a side (`name`, `title`, `email`). */
  field(side: Side, name: string): Locator;
}

/** Open the two-editors demo and wait until both editors are ready. */
export async function openTwoEditors(page: Page): Promise<TwoEditors> {
  await page.goto("/demos/two-editors.html");
  await expect(page.getByRole("status")).toContainText("ready: two editors", {
    timeout: 60_000,
  });
  await expect(page.locator("[data-paged-editor]")).toHaveCount(2);
  const host = (side: Side) => page.locator(`[data-demo-editor="${side}"]`);
  const two: TwoEditors = {
    left: host("left"),
    right: host("right"),
    root: (side) => host(side).locator("[data-paged-editor]"),
    field: (side, name) => host(side).locator(`[data-field-input="${name}"]`),
  };
  await expect(two.field("left", "name")).toBeVisible({ timeout: 15_000 });
  await expect(two.field("right", "name")).toBeVisible({ timeout: 15_000 });
  return two;
}

/** Give one editor the keyboard focus the way a user does: a click in its
 *  canvas area (or, without one, on its root). */
export async function focusEditor(two: TwoEditors, side: Side): Promise<void> {
  const viewport = two
    .root(side)
    .locator('[data-testid="viewport-canvas-host"]');
  if ((await viewport.count()) > 0) {
    const box = (await viewport.first().boundingBox())!;
    await viewport.first().click({
      position: { x: box.width * 0.9, y: box.height * 0.9 },
    });
  } else {
    await two.root(side).click();
  }
  await expect
    .poll(() =>
      two.root(side).evaluate((root) => root.contains(document.activeElement)),
    )
    .toBe(true);
}

/** Which side holds the keyboard focus (null: neither). */
export async function focusedSide(two: TwoEditors): Promise<Side | null> {
  for (const side of ["left", "right"] as const) {
    if (
      await two
        .root(side)
        .evaluate((root) => root.contains(document.activeElement))
    )
      return side;
  }
  return null;
}
