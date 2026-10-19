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

// The shell's own keybindings, registered the way PagedShell registers
// them, dispatched through the registry against a stub window:
//
//   · Cmd/Ctrl+K opens the command palette, from inside a field too;
//   · W toggles the preview screen mode, never while typing;
//   · a tool's single-key shortcut (derived live from the tool registry)
//     activates the tool, is silent with a caret, never exists for a
//     planned tool, and yields outside the edit context that claims it.
// The per-member check of the whole live tool family runs in the browser
// (tests/e2e/shell-keybindings.spec.ts), where the bundles' tools exist.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { createCommandRegistry } from "../../src/registries/command";
import { createEditContextRegistry } from "../../src/registries/edit-context";
import { createKeybindingRegistry } from "../../src/registries/keybinding";
import { createPanelRegistry } from "../../src/registries/panel";
import { createToolRegistry, DEFAULT_TOOLS } from "../../src/registries/tool";
import {
  PAGED_PALETTE_TOGGLE,
  PALETTE_TOGGLE_COMMAND,
  PALETTE_TOGGLE_KEYBINDING,
  PALETTE_TOGGLE_KEYBINDING_CTRL,
} from "../../src/state/commands/built-in-commands";
import { installRegistryDerivedContributions } from "../../src/state/commands/registry-derived";
import { buildToolbarContributions } from "../../src/state/commands/tool-commands";

interface Editor {
  contentSelection: { contentSelection: unknown };
  editContext: { type: string; toolIds?: string[] } | null;
  tool: { setBaseTool(id: string): void };
  screenMode: { togglePreview(): void };
}

function shell() {
  const log: string[] = [];
  const editor: Editor = {
    contentSelection: { contentSelection: null },
    editContext: null,
    tool: { setBaseTool: (id) => void log.push(`tool:${id}`) },
    screenMode: { togglePreview: () => void log.push("preview") },
  };
  const commands = createCommandRegistry(() => editor);
  const keybindings = createKeybindingRegistry(commands, () => editor);
  const tools = createToolRegistry();
  const panels = createPanelRegistry();
  const editContexts = createEditContextRegistry();
  const registries = {
    commands,
    keybindings,
    tools,
    panels,
    editContexts,
  } as never;
  // PagedShell: the palette effect, the W toggle, the registry-derived
  // tool activations.
  commands.register(PALETTE_TOGGLE_COMMAND);
  keybindings.register(PALETTE_TOGGLE_KEYBINDING);
  keybindings.register(PALETTE_TOGGLE_KEYBINDING_CTRL);
  const w = buildToolbarContributions([]);
  for (const c of w.commands) commands.register(c);
  for (const k of w.keybindings) keybindings.register(k);
  const derived = installRegistryDerivedContributions(registries);
  return {
    log,
    editor,
    commands,
    keybindings,
    tools,
    editContexts,
    dispose: () => {
      derived.dispose();
      keybindings.dispose();
    },
  };
}

let target: EventTarget;
beforeEach(() => {
  target = new EventTarget();
  stubGlobal("window", target);
});
afterEach(() => unstubAllGlobals());

/** A keydown on the stub window; resolves after the invoked command ran. */
async function keydown(
  combo: string,
  focused: { tagName: string } | null = null,
): Promise<boolean> {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const event = new Event("keydown", { cancelable: true });
  for (const [k, v] of Object.entries({
    key,
    metaKey: parts.includes("cmd"),
    ctrlKey: parts.includes("ctrl"),
    altKey: parts.includes("alt"),
    shiftKey: parts.includes("shift"),
    target: focused
      ? { isContentEditable: false, closest: () => null, ...focused }
      : null,
  })) {
    Object.defineProperty(event, k, { value: v });
  }
  target.dispatchEvent(event);
  await new Promise((r) => setTimeout(r, 0));
  return event.defaultPrevented;
}

describe("the command palette", () => {
  test("Cmd+K and Ctrl+K open it, from the page and from inside a field", async () => {
    covers(
      "keybinding:cmd+k→paged.palette.toggle",
      "keybinding:ctrl+k→paged.palette.toggle",
    );
    const s = shell();
    let toggles = 0;
    // The palette's handler notifies the mounted palette; count it.
    s.commands.unregister(PAGED_PALETTE_TOGGLE);
    s.commands.register({
      ...PALETTE_TOGGLE_COMMAND,
      handler: () => void toggles++,
    });
    expect(await keydown("cmd+k")).toBe(true);
    expect(await keydown("ctrl+k")).toBe(true);
    expect(await keydown("cmd+k", { tagName: "INPUT" })).toBe(true);
    expect(toggles).toBe(3);
    // A caret does not stop it: it is a chord, not text.
    s.editor.contentSelection.contentSelection = { offset: 1 };
    await keydown("cmd+k");
    expect(toggles).toBe(4);
    s.dispose();
  });
});

describe("W, the preview screen mode", () => {
  test("toggles preview from the page; is text while a caret is active or a field is focused", async () => {
    covers("keybinding:w→paged.view.toggleScreenPreview");
    const s = shell();
    expect(await keydown("w")).toBe(true);
    expect(s.log).toEqual(["preview"]);
    s.editor.contentSelection.contentSelection = { offset: 1 };
    expect(await keydown("w")).toBe(false);
    s.editor.contentSelection.contentSelection = null;
    expect(await keydown("w", { tagName: "INPUT" })).toBe(false);
    expect(s.log).toEqual(["preview"]);
    s.dispose();
  });
});

describe("tool shortcuts, derived live from the tool registry", () => {
  test("the seed tools: V and T activate Selection and Type; silent with a caret", async () => {
    const s = shell();
    for (const t of DEFAULT_TOOLS) s.tools.register(t);
    expect(await keydown("v")).toBe(true);
    expect(await keydown("t")).toBe(true);
    expect(s.log).toEqual(["tool:paged.tool.select", "tool:paged.tool.type"]);
    s.editor.contentSelection.contentSelection = { story: "u1", offset: 0 };
    expect(await keydown("v")).toBe(false);
    expect(s.log).toHaveLength(2);
    s.dispose();
  });

  test("a tool registered later gets its binding; disposing it removes the binding and the command", async () => {
    const s = shell();
    const h = s.tools.register({
      id: "x.tool.late",
      title: "Late",
      icon: "x",
      group: "g",
      shortcut: "shift+l",
    } as never);
    expect(s.commands.get("paged.tool.activate.x.tool.late")?.title).toBe(
      "Tool: Late",
    );
    expect(await keydown("shift+l")).toBe(true);
    h.dispose();
    expect(s.commands.get("paged.tool.activate.x.tool.late")).toBeUndefined();
    expect(await keydown("shift+l")).toBe(false);
    expect(s.log).toEqual(["tool:x.tool.late"]);
    s.dispose();
  });

  test("a planned tool contributes nothing executable, its shortcut reserved only", async () => {
    const s = shell();
    s.tools.register({
      id: "x.tool.planned",
      title: "Planned",
      icon: "x",
      group: "g",
      shortcut: "q",
      status: "planned",
    } as never);
    expect(
      s.commands.get("paged.tool.activate.x.tool.planned"),
    ).toBeUndefined();
    expect(s.keybindings.list().some((k) => k.key === "q")).toBe(false);
    expect(await keydown("q")).toBe(false);
    s.dispose();
  });

  test("a frame tool's key outranks the host's inside its context and yields outside", async () => {
    const s = shell();
    s.commands.register({
      id: "host.j",
      title: "Host J",
      handler: () => void s.log.push("host.j"),
    });
    s.keybindings.register({
      key: "j",
      command: "host.j",
      when: (st) => (st as Editor).contentSelection.contentSelection == null,
    });
    s.editContexts.register({
      type: "raster",
      entry: "doubleClick",
      toolIds: ["x.tool.heal"],
    } as never);
    s.tools.register({
      id: "x.tool.heal",
      title: "Heal",
      icon: "x",
      group: "g",
      shortcut: "j",
    } as never);
    await keydown("j");
    s.editor.editContext = { type: "raster", toolIds: ["x.tool.heal"] };
    await keydown("j");
    s.editor.editContext = { type: "sheet", toolIds: [] };
    await keydown("j");
    expect(s.log).toEqual(["host.j", "tool:x.tool.heal", "host.j"]);
    s.dispose();
  });
});
