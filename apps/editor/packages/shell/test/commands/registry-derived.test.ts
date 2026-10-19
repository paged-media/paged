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

// The registry-DERIVED commands (B-15): every registered panel gets a
// `paged.panel.show.<id>` / `paged.panel.hide.<id>` pair, live — a panel
// registered after the shell mounted (a bundle) gets its pair the moment
// it registers and loses it when it goes. Show opens the panel as the
// active right-dock tab, hide closes that tab, through the cockpit's
// docking actions. Also: the frame-tool precedence rule and the `W`
// screen-preview toggle the toolbar contributions add.
//
// The tool-activation family (`paged.tool.activate.*`) is asserted over
// the real built-in tool table in the canvas app's unit tier
// (apps/canvas/test/unit/commands/tool-activation.test.ts), which may
// depend on @paged-media/tools.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { cockpitActions } from "../../src/cockpit/cockpit-state-context";
import { createCommandRegistry } from "../../src/registries/command";
import { createEditContextRegistry } from "../../src/registries/edit-context";
import { createKeybindingRegistry } from "../../src/registries/keybinding";
import { createPanelRegistry } from "../../src/registries/panel";
import type { PanelContribution } from "../../src/registries/panel";
import { createToolRegistry } from "../../src/registries/tool";
import type { ShellRegistries } from "../../src/state/registries-context";
import {
  framePrecedence,
  installRegistryDerivedContributions,
} from "../../src/state/commands/registry-derived";
import {
  buildToolbarContributions,
  contentSelectionInactive,
} from "../../src/state/commands/tool-commands";

const Stub = () => null;

/** A spread of the panel kinds the editor registers: a host panel, a
 *  dev-only one, plugin panels (namespaced ids, a `source`). */
const PANELS: PanelContribution[] = [
  {
    id: "paged.layers",
    title: "Layers",
    component: Stub,
    defaultGroup: "structure",
  },
  {
    id: "paged.swatches",
    title: "Swatches",
    component: Stub,
    defaultGroup: "styles",
  },
  { id: "paged.repl", title: "REPL", component: Stub, devOnly: true },
  {
    id: "media.paged.draw.panel.stroke",
    title: "Vector stroke",
    component: Stub,
    source: "Draw",
  },
  {
    id: "media.paged.sheet.panel.workbook",
    title: "Workbook",
    component: Stub,
    source: "Sheet",
  },
] as PanelContribution[];

let opened: Array<[string, unknown]>;
let closed: string[];

function registries(state: unknown = null): ShellRegistries {
  const commands = createCommandRegistry(() => state);
  return {
    commands,
    keybindings: createKeybindingRegistry(commands, () => state),
    panels: createPanelRegistry(),
    tools: createToolRegistry(),
    editContexts: createEditContextRegistry(),
  } as unknown as ShellRegistries;
}

beforeEach(() => {
  stubGlobal("window", new EventTarget());
  opened = [];
  closed = [];
  cockpitActions.openPanel = (id, options) => void opened.push([id, options]);
  cockpitActions.closeTab = (id) => void closed.push(id);
});
afterEach(() => {
  cockpitActions.openPanel = null;
  cockpitActions.closeTab = null;
  unstubAllGlobals();
});

describe("the panel show / hide families", () => {
  test("every registered panel gets a show/hide pair that opens / closes ITS tab", async () => {
    covers("command:paged.panel.show.*", "command:paged.panel.hide.*");
    const r = registries();
    for (const p of PANELS) r.panels.register(p);
    const off = installRegistryDerivedContributions(r);
    const members = r.panels.list();
    expect(members.length).toBe(PANELS.length);
    for (const panel of members) {
      const show = r.commands.get(`paged.panel.show.${panel.id}`);
      const hide = r.commands.get(`paged.panel.hide.${panel.id}`);
      expect(show?.title).toBe(`Show: ${panel.title}`);
      expect(hide?.title).toBe(`Hide: ${panel.title}`);
      // Ungated: the Window menu's `when` decides what is OFFERED.
      expect(show?.when).toBeUndefined();
      expect(hide?.when).toBeUndefined();
      opened = [];
      closed = [];
      await r.commands.invoke(`paged.panel.show.${panel.id}`);
      await r.commands.invoke(`paged.panel.hide.${panel.id}`);
      expect({ panel: panel.id, opened, closed }).toEqual({
        panel: panel.id,
        opened: [[panel.id, undefined]],
        closed: [panel.id],
      });
    }
    // Exactly the pairs, nothing else.
    expect(
      r.commands
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(
      PANELS.flatMap((p) => [
        `paged.panel.hide.${p.id}`,
        `paged.panel.show.${p.id}`,
      ]).sort(),
    );
    off.dispose();
    expect(r.commands.list()).toEqual([]);
  });

  test("a panel registered later (a bundle) gets its pair live, and loses it when it goes", async () => {
    covers("command:paged.panel.show.*", "command:paged.panel.hide.*");
    const r = registries();
    const off = installRegistryDerivedContributions(r);
    expect(r.commands.list()).toEqual([]);
    const handle = r.panels.register({
      id: "media.paged.data.panel.sources",
      title: "Data sources",
      component: Stub,
      source: "Data",
    } as PanelContribution);
    await r.commands.invoke("paged.panel.show.media.paged.data.panel.sources");
    expect(opened).toEqual([["media.paged.data.panel.sources", undefined]]);
    handle.dispose();
    expect(
      r.commands.get("paged.panel.show.media.paged.data.panel.sources"),
    ).toBeUndefined();
    await expect(
      r.commands.invoke("paged.panel.hide.media.paged.data.panel.sources"),
    ).rejects.toThrow(/unknown command/);
    off.dispose();
  });

  test("without a mounted cockpit, show and hide are harmless no-ops", async () => {
    covers("command:paged.panel.show.*", "command:paged.panel.hide.*");
    cockpitActions.openPanel = null;
    cockpitActions.closeTab = null;
    const r = registries();
    r.panels.register(PANELS[0]);
    installRegistryDerivedContributions(r);
    await expect(
      r.commands.invoke("paged.panel.show.paged.layers"),
    ).resolves.toBeUndefined();
    await expect(
      r.commands.invoke("paged.panel.hide.paged.layers"),
    ).resolves.toBeUndefined();
  });
});

describe("tool shortcuts: precedence inside and outside the frame that claims the tool", () => {
  test("framePrecedence: unclaimed 1, claimed and active 2, claimed elsewhere -1", () => {
    covers("command:paged.tool.activate.*");
    const r = registries();
    expect(framePrecedence(r, "t.brush", null)).toBe(1);
    r.editContexts.register({
      type: "raster",
      entry: "doubleClick",
      toolIds: ["t.brush"],
    } as never);
    expect(framePrecedence(r, "t.brush", { editContext: null })).toBe(-1);
    expect(
      framePrecedence(r, "t.brush", {
        editContext: { type: "raster", toolIds: ["t.brush"] },
      }),
    ).toBe(2);
    expect(
      framePrecedence(r, "t.other", { editContext: { toolIds: ["t.brush"] } }),
    ).toBe(1);
  });

  test("contentSelectionInactive: a caret silences every single-key tool shortcut", () => {
    covers("command:paged.tool.activate.*");
    const inactive = contentSelectionInactive as (state: unknown) => boolean;
    expect(inactive({ contentSelection: { contentSelection: null } })).toBe(
      true,
    );
    expect(inactive(null)).toBe(true);
    expect(
      inactive({ contentSelection: { contentSelection: { storyId: "s" } } }),
    ).toBe(false);
  });
});

describe("Toggle preview screen mode (paged.view.toggleScreenPreview)", () => {
  test("flips Normal ⇄ Preview on the editor's screen-mode store, bound to W outside text", async () => {
    covers("command:paged.view.toggleScreenPreview");
    let toggles = 0;
    const editor = { screenMode: { togglePreview: () => void toggles++ } };
    const { commands, keybindings } = buildToolbarContributions([]);
    expect(commands.map((c) => c.id)).toEqual([
      "paged.view.toggleScreenPreview",
    ]);
    const r = createCommandRegistry(() => editor);
    for (const c of commands) r.register(c);
    await r.invoke("paged.view.toggleScreenPreview");
    await r.invoke("paged.view.toggleScreenPreview");
    expect(toggles).toBe(2);
    expect(keybindings).toEqual([
      {
        key: "w",
        command: "paged.view.toggleScreenPreview",
        when: contentSelectionInactive,
      },
    ]);
  });

  test("the toolbar contributions give a planned tool nothing executable", () => {
    covers("command:paged.tool.activate.*");
    const { commands, keybindings } = buildToolbarContributions([
      { id: "t.live", title: "Live", shortcut: "q", group: "g" } as never,
      {
        id: "t.stub",
        title: "Stub",
        shortcut: "z",
        group: "g",
        status: "planned",
      } as never,
    ]);
    expect(commands.map((c) => c.id)).toEqual([
      "paged.tool.activate.t.live",
      "paged.view.toggleScreenPreview",
    ]);
    expect(keybindings.map((k) => `${k.key}→${k.command}`)).toEqual([
      "q→paged.tool.activate.t.live",
      "w→paged.view.toggleScreenPreview",
    ]);
  });
});
