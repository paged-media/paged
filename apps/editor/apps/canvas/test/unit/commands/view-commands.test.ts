/*
 * This file is part of paged (https://paged.media).
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

// Editor ADR 287 — the View menu's screen modes, grids, snapping and
// Rotate View (view-commands.ts): each toggle flips its own flag in the
// editor's scope (no document change, so no undo step), the rotation
// commands reach the camera handlers, the menu rows tick from the same
// store, and every chord is free.

import { describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";
import {
  createCommandRegistry,
  createEditorScope,
  getViewToggle,
  viewModeOf,
} from "@paged-media/shell";

import { APP_KEYBINDINGS } from "../../../src/app-commands";
import {
  buildViewCommands,
  ROTATE_VIEW_STEP_DEG,
  VIEW_KEYBINDINGS,
  VIEW_MENU_ITEMS,
} from "../../../src/view-commands";

function harness() {
  const calls: Array<[string, unknown?]> = [];
  const scope = createEditorScope();
  const registry = createCommandRegistry(() => ({ scope }) as never);
  for (const c of buildViewCommands({
    rotateView: (deg) => void calls.push(["rotate", deg]),
    resetRotation: () => void calls.push(["reset"]),
    openPreferences: () => void calls.push(["preferences"]),
  }))
    registry.register(c);
  return { calls, registry, scope };
}

const TOGGLES = [
  ["paged.view.outline", "outline"],
  ["paged.view.overprintPreview", "overprintPreview"],
  ["paged.view.pixelPreview", "pixelPreview"],
  ["paged.view.showGrid", "showGrid"],
  ["paged.view.snapToGrid", "snapToGrid"],
  ["paged.view.pixelGrid", "pixelGrid"],
  ["paged.view.snapToPixel", "snapToPixel"],
  ["paged.view.smartGuides", "smartGuides"],
] as const;

describe("View ▸ screen modes, grids and snapping", () => {
  test("each command flips its own toggle, and a second press puts it back", async () => {
    covers(...TOGGLES.map(([id]) => `command:${id}`));
    const { registry, scope } = harness();
    for (const [id, toggle] of TOGGLES) {
      const before = getViewToggle(scope, toggle);
      await registry.invoke(id);
      expect({ id, on: getViewToggle(scope, toggle) }).toEqual({
        id,
        on: !before,
      });
      await registry.invoke(id);
      expect({ id, on: getViewToggle(scope, toggle) }).toEqual({
        id,
        on: before,
      });
    }
  });

  test("the modes add up to the engine's view mode", async () => {
    covers(
      "command:paged.view.outline",
      "command:paged.view.overprintPreview",
      "command:paged.view.pixelPreview",
    );
    const { registry, scope } = harness();
    expect(viewModeOf(scope)).toBe("preview");
    await registry.invoke("paged.view.overprintPreview");
    expect(viewModeOf(scope)).toBe("overprintPreview");
    await registry.invoke("paged.view.pixelPreview");
    expect(viewModeOf(scope)).toBe("pixelPreview");
    expect(getViewToggle(scope, "overprintPreview")).toBe(false);
    await registry.invoke("paged.view.outline");
    expect(viewModeOf(scope)).toBe("outline");
  });

  test("Rotate View and the preferences reach their handlers", async () => {
    covers(
      "command:paged.view.rotateClockwise",
      "command:paged.view.rotateCounterclockwise",
      "command:paged.view.resetRotation",
      "command:paged.view.guidesAndGridPreferences",
    );
    const { registry, calls } = harness();
    await registry.invoke("paged.view.rotateClockwise");
    await registry.invoke("paged.view.rotateCounterclockwise");
    await registry.invoke("paged.view.resetRotation");
    await registry.invoke("paged.view.guidesAndGridPreferences");
    expect(calls).toEqual([
      ["rotate", ROTATE_VIEW_STEP_DEG],
      ["rotate", -ROTATE_VIEW_STEP_DEG],
      ["reset"],
      ["preferences"],
    ]);
  });

  test("the menu rows point at the commands and tick from the toggles", () => {
    const { scope } = harness();
    const paged = { scope };
    const byCommand = new Map(VIEW_MENU_ITEMS.map((m) => [m.command, m]));
    for (const [id] of TOGGLES) {
      const row = byCommand.get(id);
      expect({ id, checkable: typeof row?.checked }).toEqual({
        id,
        checkable: "function",
      });
    }
    expect(byCommand.get("paged.view.smartGuides")?.checked?.(paged as never)).toBe(
      true,
    );
    expect(byCommand.get("paged.view.outline")?.checked?.(paged as never)).toBe(
      false,
    );
    // "Outline" alone is paged.draw's (menu keys are global).
    expect(byCommand.get("paged.view.outline")?.path).toBe("View/Outline view");
  });

  test("Illustrator's chords, none of them taken by the app", () => {
    const chords = VIEW_KEYBINDINGS.map((k) => [k.key, k.command]);
    expect(chords).toContainEqual(["cmd+y", "paged.view.outline"]);
    expect(chords).toContainEqual(["alt+shift+cmd+y", "paged.view.overprintPreview"]);
    expect(chords).toContainEqual(["alt+cmd+y", "paged.view.pixelPreview"]);
    expect(chords).toContainEqual(["cmd+'", "paged.view.showGrid"]);
    expect(chords).toContainEqual(["cmd+u", "paged.view.smartGuides"]);
    const app = new Set(APP_KEYBINDINGS.map((k) => k.key));
    const own = VIEW_KEYBINDINGS.map((k) => k.key);
    expect(own.filter((k) => app.has(k))).toEqual([]);
    expect(new Set(own).size).toBe(own.length);
  });
});
