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

// Keyboard shortcuts (paged.keyboard-shortcuts): every binding in the
// keybinding registry under its command's title, chords that differ only
// by Cmd / Ctrl shown once, then the maintained list of keys bound outside
// the registry.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { nativeKey, prettyKey } from "@paged-media/shell";

import { KeyboardShortcutsPanel } from "../../src/panels/keyboard-shortcuts-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const rows = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll<HTMLElement>("[data-shortcut-row]")].map((r) =>
    [...r.querySelectorAll("span")].map((s) => s.textContent),
  );

const noop = () => undefined;

describe("Keyboard shortcuts panel", () => {
  test("an empty registry: no command rows, the bindings outside the registry listed", async () => {
    covers("panel:paged.keyboard-shortcuts");
    const h = await mountPanel(KeyboardShortcutsPanel, {
      id: "paged.keyboard-shortcuts",
    });
    expect(h.root.textContent).toContain("Commands (0)");
    expect(rows(h)).toEqual([]);
    expect(
      h.root.querySelector('[data-shortcut-adhoc="Undo"]')?.textContent,
    ).toContain(prettyKey("cmd+z"));
    expect(
      h.root.querySelector('[data-shortcut-adhoc="First page"]'),
    ).not.toBeNull();
  });

  test("registered bindings: under the command's title, sorted, Cmd and Ctrl twins once", async () => {
    covers("panel:paged.keyboard-shortcuts");
    const h = await mountPanel(KeyboardShortcutsPanel, {
      id: "paged.keyboard-shortcuts",
      registries: (r) => {
        r.commands.register({
          id: "test.zoom",
          title: "Zoom in",
          handler: noop,
        });
        r.commands.register({
          id: "test.align",
          title: "Align left",
          handler: noop,
        });
        r.keybindings.register({ key: "cmd+=", command: "test.zoom" });
        r.keybindings.register({ key: "ctrl+=", command: "test.zoom" });
        r.keybindings.register({ key: "shift+l", command: "test.align" });
        // A binding whose command is not registered shows its id.
        r.keybindings.register({ key: "f5", command: "test.unregistered" });
      },
    });
    expect(h.root.textContent).toContain("Commands (3)");
    expect(rows(h)).toEqual([
      ["Align left", prettyKey(nativeKey(["shift+l"]))],
      ["test.unregistered", prettyKey(nativeKey(["f5"]))],
      ["Zoom in", prettyKey(nativeKey(["cmd+=", "ctrl+="]))],
    ]);
  });

  // The rows are memoised on the registry objects, which never change
  // identity: a binding a bundle registers while the panel is open never
  // appears (bundles load after the shell mounts, some on demand).
  test.failing(
    "PN-351: a binding registered while the panel is open appears in it",
    async () => {
      covers("panel:paged.keyboard-shortcuts");
      const h = await mountPanel(KeyboardShortcutsPanel, {
        id: "paged.keyboard-shortcuts",
      });
      await h.act(() => {
        h.registries.commands.register({
          id: "test.late",
          title: "Late command",
          handler: noop,
        });
        h.registries.keybindings.register({
          key: "cmd+j",
          command: "test.late",
        });
      });
      expect(rows(h).map((r) => r[0])).toContain("Late command");
    },
  );
});
