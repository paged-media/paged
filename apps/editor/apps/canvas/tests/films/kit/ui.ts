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

// Driving the editor's own controls on camera (ADR 224): every click a film
// narrates goes through the pointer, to the centre of the real control, so
// the viewer sees the cursor travel there. Menus open item by item, the way
// a hand opens them.

import { expect, type Locator } from "@playwright/test";
import type { Kit } from "./film";

async function centre(
  l: Locator,
): Promise<{ x: number; y: number; w: number }> {
  await l.waitFor({ state: "visible", timeout: 10_000 });
  const b = await l.boundingBox();
  if (!b) throw new Error(`no box for ${l}`);
  return {
    x: b.x + b.width / 2,
    y: b.y + b.height / 2,
    w: Math.min(b.width, b.height),
  };
}

/** Travel to a control and click it. */
export async function press(k: Kit, l: Locator): Promise<void> {
  const c = await centre(l);
  await k.pointer.click(c, { targetWidth: c.w });
}

/** Travel to a control and rest on it. */
export async function hover(k: Kit, l: Locator): Promise<void> {
  const c = await centre(l);
  await k.pointer.moveTo(c, { targetWidth: c.w });
}

/** A menu item by the start of its accessible name, so "Place…" finds
 *  "Place… ⌘D" (the name carries the shortcut). */
const menuItem = (k: Kit, label: string) => {
  const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  // A toggle is a menuitemcheckbox (editor ADR 255).
  return k.page
    .getByRole("menuitem", { name })
    .or(k.page.getByRole("menuitemcheckbox", { name }))
    .first();
};

/** Move sideways onto a submenu item's column, at the pointer's height. */
async function intoColumn(k: Kit, item: Locator): Promise<void> {
  await item.waitFor({ state: "visible", timeout: 10_000 });
  const b = await item.boundingBox();
  const at = k.pointer.position;
  if (!b || at.x >= b.x + 8) return;
  await k.pointer.moveTo(
    { x: b.x + Math.min(40, b.width / 2), y: at.y },
    { targetWidth: b.width },
  );
}

/** Open a menu path: the top-level entry by its label in the menu bar, each
 *  submenu by hovering, the last entry by a click. After each hover the
 *  pointer rests a moment and nudges right, the way a hand settles into a
 *  submenu: crossing another submenu on the way otherwise leaves the wrong
 *  one open. */
export async function menu(k: Kit, path: string[]): Promise<void> {
  const [top, ...rest] = path;
  const bar = k.page.getByRole("menubar");
  const scope =
    (await bar.count()) > 0 ? bar : k.page.locator("header").first();
  await press(k, scope.getByText(top, { exact: true }).first());
  await k.hold(250);
  for (const [i, label] of rest.entries()) {
    // Into a submenu's column first, then along it: a diagonal crosses the
    // parent menu's other rows, and a slow one leaves the submenu's grace
    // area and closes it.
    if (i > 0) await intoColumn(k, menuItem(k, label));
    if (i === rest.length - 1) {
      // A menu fades in: an item clicked mid-animation can miss, so the
      // pointer settles on it first, the way a hand does.
      const item = menuItem(k, label);
      await expect(item).toBeEnabled();
      await hover(k, item);
      await k.hold(200);
      await press(k, item);
      break;
    }
    await hover(k, menuItem(k, label));
    await k.hold(400);
    const at = k.pointer.position;
    await k.pointer.moveTo({ x: at.x + 10, y: at.y }, { targetWidth: 60 });
    await menuItem(k, rest[i + 1]).waitFor({ state: "visible", timeout: 5000 });
  }
}

/** A page point on screen (CSS px), through the live camera. */
export { screenPoint } from "../../e2e/harness/viewport";
