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

// `paged.tool.activate.*` — the family the shell DERIVES from the tool
// registry (B-15), over the editor's real built-in tool table: every live
// tool gets an activation command that puts it in the user's hand, and a
// tool with a shortcut gets a single-key binding silenced by a text caret
// and ranked by the frame rule. A planned tool (an honest stub) gets
// neither. A tool registered later (a bundle's) is treated the same, live.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createCommandRegistry,
  createEditContextRegistry,
  createKeybindingRegistry,
  createPanelRegistry,
  createToolRegistry,
  type ShellRegistries,
} from "@paged-media/shell";
import { installRegistryDerivedContributions } from "@paged-media/shell/state/commands/registry-derived";
import { contentSelectionInactive } from "@paged-media/shell/state/commands/tool-commands";
import { BUILT_IN_TOOLS } from "@paged-media/tools";
import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

let inHand: string[];
let state: Record<string, unknown>;

function shell(): ShellRegistries {
  const editor = () => ({
    ...state,
    tool: { setBaseTool: (id: string) => void inHand.push(id) },
  });
  const commands = createCommandRegistry(editor);
  const r = {
    commands,
    keybindings: createKeybindingRegistry(commands, editor),
    tools: createToolRegistry(),
    panels: createPanelRegistry(),
    editContexts: createEditContextRegistry(),
  } as unknown as ShellRegistries;
  for (const t of BUILT_IN_TOOLS) r.tools.register(t);
  return r;
}

beforeEach(() => {
  stubGlobal("window", new EventTarget());
  inHand = [];
  state = { contentSelection: { contentSelection: null }, editContext: null };
});
afterEach(() => unstubAllGlobals());

const key = (combo: string) => {
  const parts = combo.toLowerCase().split("+");
  const k = parts.pop()!;
  return {
    key: k,
    metaKey: parts.includes("cmd"),
    ctrlKey: parts.includes("ctrl"),
    altKey: parts.includes("alt"),
    shiftKey: parts.includes("shift"),
  };
};

describe("paged.tool.activate.* over the built-in tool table", () => {
  test("every live tool: its command puts it in hand; its shortcut fires that command", async () => {
    covers("command:paged.tool.activate.*");
    const r = shell();
    installRegistryDerivedContributions(r);
    const live = r.tools.list().filter((t) => t.status !== "planned");
    expect(live.length).toBeGreaterThan(15);
    for (const tool of live) {
      const id = `paged.tool.activate.${tool.id}`;
      expect(r.commands.get(id)?.title).toBe(`Tool: ${tool.title}`);
      inHand = [];
      await r.commands.invoke(id);
      expect({ id, inHand }).toEqual({ id, inHand: [tool.id] });
      if (!tool.shortcut) continue;
      const bound = r.keybindings.list().filter((k) => k.command === id);
      expect(bound.map((k) => k.key)).toEqual([tool.shortcut]);
      expect(bound[0].when).toBe(contentSelectionInactive);
      expect(r.keybindings.resolve(key(tool.shortcut), state)?.command).toBe(
        id,
      );
    }
  });

  test("a planned tool contributes nothing executable", () => {
    covers("command:paged.tool.activate.*");
    const r = shell();
    installRegistryDerivedContributions(r);
    const planned = r.tools.list().filter((t) => t.status === "planned");
    expect(planned.length).toBeGreaterThan(0);
    for (const t of planned) {
      expect(r.commands.get(`paged.tool.activate.${t.id}`)).toBeUndefined();
      expect(r.keybindings.list().some((k) => k.command.endsWith(t.id))).toBe(
        false,
      );
    }
  });

  test("with a text caret no tool shortcut fires", () => {
    covers("command:paged.tool.activate.*");
    const r = shell();
    installRegistryDerivedContributions(r);
    const caret = {
      contentSelection: {
        contentSelection: { storyId: "s", start: 0, end: 0 },
      },
    };
    for (const t of r.tools.list()) {
      if (!t.shortcut || t.status === "planned") continue;
      expect(r.keybindings.resolve(key(t.shortcut), caret)).toBeNull();
    }
  });

  test("a bundle's tool registered later is derived live and removed with it", async () => {
    covers("command:paged.tool.activate.*");
    const r = shell();
    installRegistryDerivedContributions(r);
    const handle = r.tools.register({
      id: "media.paged.draw.tool.knife",
      title: "Knife",
      icon: "tool-scissors",
      shortcut: "k",
      group: "media.paged.draw.knife",
    } as never);
    await r.commands.invoke("paged.tool.activate.media.paged.draw.tool.knife");
    expect(inHand).toEqual(["media.paged.draw.tool.knife"]);
    handle.dispose();
    expect(
      r.commands.get("paged.tool.activate.media.paged.draw.tool.knife"),
    ).toBeUndefined();
    expect(r.keybindings.resolve(key("k"), state)).toBeNull();
  });
});
