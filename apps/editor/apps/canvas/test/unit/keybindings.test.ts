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

// The canvas app's keybinding tables (APP_KEYBINDINGS, SELECT_ALL_,
// OBJECT_ and INSERT_KEYBINDINGS), registered the way main.tsx registers
// them, and resolved through the registry's own dispatch rule:
//
//   · each binding fires its command where it applies (an open document,
//     no caret, nothing else owning the key);
//   · each guarded key goes quiet where the key means something else (a
//     caret, path-edit mode, the Page tool, a drawing tool's rubber band,
//     a marquee, a plugin edit context, a focused text field);
//   · every Cmd binding has its Ctrl twin (the registry has no `mod`);
//   · Place (Cmd+D, unguarded) yields to a context's guarded Cmd+D.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers, stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";
import {
  createCommandRegistry,
  createKeybindingRegistry,
  type KeybindingContribution,
} from "@paged-media/shell";

import { APP_KEYBINDINGS } from "../../src/app-commands";
import { INSERT_KEYBINDINGS } from "../../src/insert-commands";
import { OBJECT_KEYBINDINGS } from "../../src/object-commands";
import { SELECT_ALL_KEYBINDINGS } from "../../src/select-all";

const TABLES: KeybindingContribution[] = [
  ...APP_KEYBINDINGS,
  ...SELECT_ALL_KEYBINDINGS,
  ...OBJECT_KEYBINDINGS,
  ...INSERT_KEYBINDINGS,
];

/** A key event from a registered combo. `cmd+shift+]` is reported with
 *  `key` "]" here; the `}` twin covers layouts that report the shifted
 *  glyph. */
function press(combo: string) {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop()!;
  const has = (...m: string[]) => parts.some((p) => m.includes(p));
  return {
    key,
    metaKey: has("cmd", "meta"),
    ctrlKey: has("ctrl", "control"),
    altKey: has("alt", "option"),
    shiftKey: has("shift"),
  };
}

/** The editor state the predicates read: an open one-page document at
 *  the root, no caret, Selection in hand, nothing being drawn. */
const AT_ROOT = {
  document: { handle: { pageCount: 1 } },
  editContext: null,
  contentSelection: { contentSelection: null },
  selection: { pathEditMode: false },
  tool: { effectiveTool: "paged.tool.select" },
  overlaySignals: { toolPreview: null, marqueeRect: null },
};
type State = typeof AT_ROOT;
const at = (patch: Partial<Record<keyof State, unknown>>) =>
  ({ ...AT_ROOT, ...patch }) as unknown;

/** The registry's own dispatch rule over `bindings`, in registration
 *  order (the window listener is attached to a stub and never used). */
function resolveBinding(
  bindings: readonly KeybindingContribution[],
  event: ReturnType<typeof press>,
  state: () => unknown,
) {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = new EventTarget();
  try {
    const r = createKeybindingRegistry(createCommandRegistry(() => null));
    for (const b of bindings) r.register(b);
    const won = r.resolve(event, state());
    r.dispose();
    return won;
  } finally {
    (globalThis as { window?: unknown }).window = previous;
  }
}

const fires = (combo: string, state: unknown = AT_ROOT) =>
  resolveBinding(TABLES, press(combo), () => state)?.command ?? null;

/** The DOM the Cmd+A guard asks (`document.activeElement instanceof
 *  HTMLElement`): focus on the page body unless a test moves it. */
class FakeElement {
  tagName = "BODY";
  isContentEditable = false;
  type = "";
}
const focus = (patch: Partial<FakeElement>) =>
  stubGlobal("document", {
    activeElement: Object.assign(new FakeElement(), patch),
  });

beforeEach(() => {
  stubGlobal("HTMLElement", FakeElement);
  focus({});
});
afterEach(() => unstubAllGlobals());

describe("every app binding fires its command at the document root", () => {
  test("zoom and save", () => {
    covers(
      "keybinding:cmd+=→paged.view.zoomIn",
      "keybinding:ctrl+=→paged.view.zoomIn",
      "keybinding:cmd+-→paged.view.zoomOut",
      "keybinding:ctrl+-→paged.view.zoomOut",
      "keybinding:cmd+s→paged.file.savePaged",
      "keybinding:ctrl+s→paged.file.savePaged",
      "keybinding:cmd+shift+s→paged.file.saveAsIdml",
      "keybinding:ctrl+shift+s→paged.file.saveAsIdml",
    );
    for (const mod of ["cmd", "ctrl"]) {
      expect(fires(`${mod}+=`)).toBe("paged.view.zoomIn");
      expect(fires(`${mod}+-`)).toBe("paged.view.zoomOut");
      expect(fires(`${mod}+s`)).toBe("paged.file.savePaged");
      expect(fires(`${mod}+shift+s`)).toBe("paged.file.saveAsIdml");
    }
    // Unguarded: they work with no document and with a caret too.
    expect(fires("cmd+s", null)).toBe("paged.file.savePaged");
    expect(
      fires("cmd+=", at({ contentSelection: { contentSelection: {} } })),
    ).toBe("paged.view.zoomIn");
  });

  test("arrange and group", () => {
    covers(
      "keybinding:cmd+shift+]→paged.object.bringToFront",
      "keybinding:ctrl+shift+]→paged.object.bringToFront",
      "keybinding:cmd+shift+}→paged.object.bringToFront",
      "keybinding:ctrl+shift+}→paged.object.bringToFront",
      "keybinding:cmd+]→paged.object.bringForward",
      "keybinding:ctrl+]→paged.object.bringForward",
      "keybinding:cmd+[→paged.object.sendBackward",
      "keybinding:ctrl+[→paged.object.sendBackward",
      "keybinding:cmd+shift+[→paged.object.sendToBack",
      "keybinding:ctrl+shift+[→paged.object.sendToBack",
      "keybinding:cmd+shift+{→paged.object.sendToBack",
      "keybinding:ctrl+shift+{→paged.object.sendToBack",
      "keybinding:cmd+g→paged.object.group",
      "keybinding:ctrl+g→paged.object.group",
      "keybinding:cmd+shift+g→paged.object.ungroup",
      "keybinding:ctrl+shift+g→paged.object.ungroup",
    );
    for (const mod of ["cmd", "ctrl"]) {
      expect(fires(`${mod}+shift+]`)).toBe("paged.object.bringToFront");
      expect(fires(`${mod}+shift+}`)).toBe("paged.object.bringToFront");
      expect(fires(`${mod}+]`)).toBe("paged.object.bringForward");
      expect(fires(`${mod}+[`)).toBe("paged.object.sendBackward");
      expect(fires(`${mod}+shift+[`)).toBe("paged.object.sendToBack");
      expect(fires(`${mod}+shift+{`)).toBe("paged.object.sendToBack");
      expect(fires(`${mod}+g`)).toBe("paged.object.group");
      expect(fires(`${mod}+shift+g`)).toBe("paged.object.ungroup");
    }
  });

  test("delete and nudge", () => {
    covers(
      "keybinding:backspace→paged.object.delete",
      "keybinding:delete→paged.object.delete",
      "keybinding:arrowleft→paged.object.nudgeLeft",
      "keybinding:arrowright→paged.object.nudgeRight",
      "keybinding:arrowup→paged.object.nudgeUp",
      "keybinding:arrowdown→paged.object.nudgeDown",
      "keybinding:shift+arrowleft→paged.object.nudgeLeftLarge",
      "keybinding:shift+arrowright→paged.object.nudgeRightLarge",
      "keybinding:shift+arrowup→paged.object.nudgeUpLarge",
      "keybinding:shift+arrowdown→paged.object.nudgeDownLarge",
    );
    expect(fires("backspace")).toBe("paged.object.delete");
    expect(fires("delete")).toBe("paged.object.delete");
    for (const [dir, Dir] of [
      ["left", "Left"],
      ["right", "Right"],
      ["up", "Up"],
      ["down", "Down"],
    ]) {
      expect(fires(`arrow${dir}`)).toBe(`paged.object.nudge${Dir}`);
      expect(fires(`shift+arrow${dir}`)).toBe(`paged.object.nudge${Dir}Large`);
    }
  });

  test("select all and place", () => {
    covers(
      "keybinding:cmd+a→paged.edit.selectAll",
      "keybinding:ctrl+a→paged.edit.selectAll",
      "keybinding:cmd+d→paged.insert.placeImage",
      "keybinding:ctrl+d→paged.insert.placeImage",
    );
    for (const mod of ["cmd", "ctrl"]) {
      expect(fires(`${mod}+a`)).toBe("paged.edit.selectAll");
      expect(fires(`${mod}+d`)).toBe("paged.insert.placeImage");
    }
  });
});

describe("guarded keys go quiet where the key means something else", () => {
  const caret = at({ contentSelection: { contentSelection: { offset: 2 } } });
  const pathEdit = at({ selection: { pathEditMode: true } });
  const pageTool = at({ tool: { effectiveTool: "paged.tool.page" } });
  const drawing = at({
    overlaySignals: { toolPreview: { kind: "rect" }, marqueeRect: null },
  });
  const marquee = at({
    overlaySignals: { toolPreview: null, marqueeRect: [0, 0, 10, 10] },
  });
  const inSheet = at({ editContext: { type: "sheet" } });

  test("Backspace / Delete: a caret, path-edit mode, the Page tool, an edit context", () => {
    covers(
      "keybinding:backspace→paged.object.delete",
      "keybinding:delete→paged.object.delete",
    );
    for (const state of [caret, pathEdit, pageTool, inSheet]) {
      expect(fires("backspace", state)).toBeNull();
      expect(fires("delete", state)).toBeNull();
    }
    // A rubber band does not own Delete.
    expect(fires("delete", drawing)).toBe("paged.object.delete");
  });

  test("the arrows: a caret, path-edit mode, a drawing tool's rubber band, a marquee, an edit context", () => {
    covers(
      "keybinding:arrowleft→paged.object.nudgeLeft",
      "keybinding:shift+arrowdown→paged.object.nudgeDownLarge",
    );
    for (const state of [caret, pathEdit, drawing, marquee, inSheet]) {
      expect(fires("arrowleft", state)).toBeNull();
      expect(fires("shift+arrowdown", state)).toBeNull();
    }
    // The Page tool does not own the arrows.
    expect(fires("arrowleft", pageTool)).toBe("paged.object.nudgeLeft");
  });

  test("Cmd+A: no document, an edit context, or a focused text field", () => {
    covers(
      "keybinding:cmd+a→paged.edit.selectAll",
      "keybinding:ctrl+a→paged.edit.selectAll",
    );
    expect(fires("cmd+a", at({ document: { handle: null } }))).toBeNull();
    expect(
      fires("cmd+a", at({ document: { handle: { pageCount: 0 } } })),
    ).toBeNull();
    expect(fires("ctrl+a", inSheet)).toBeNull();

    for (const field of [
      { tagName: "INPUT", type: "text" },
      { tagName: "INPUT", type: "search" },
      { tagName: "INPUT", type: "number" },
      { tagName: "TEXTAREA" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      focus(field);
      expect({ field, fires: fires("cmd+a") }).toEqual({ field, fires: null });
    }
    // A checkbox, a select or a button: Cmd+A means the page.
    for (const notText of [
      { tagName: "INPUT", type: "checkbox" },
      { tagName: "SELECT" },
      { tagName: "BUTTON" },
    ]) {
      focus(notText);
      expect(fires("cmd+a")).toBe("paged.edit.selectAll");
    }
  });

  test("the arrange, group, zoom and save chords are not guarded", () => {
    for (const combo of [
      "cmd+]",
      "cmd+g",
      "cmd+shift+g",
      "cmd+=",
      "cmd+s",
      "cmd+d",
    ]) {
      const b = TABLES.find((k) => k.key === combo);
      expect({ combo, when: b?.when }).toEqual({ combo, when: undefined });
    }
  });
});

describe("the tables as a whole", () => {
  test("every Cmd binding has its Ctrl twin to the same command, and back", () => {
    const sig = new Set(TABLES.map((k) => `${k.key}→${k.command}`));
    const missing: string[] = [];
    for (const k of TABLES) {
      const parts = k.key.split("+");
      if (parts.includes("cmd"))
        if (!sig.has(`${k.key.replace("cmd", "ctrl")}→${k.command}`))
          missing.push(k.key);
      if (parts.includes("ctrl"))
        if (!sig.has(`${k.key.replace("ctrl", "cmd")}→${k.command}`))
          missing.push(k.key);
    }
    expect(missing).toEqual([]);
  });

  test("no key+command pair is registered twice (INV-REG-3)", () => {
    const seen = new Map<string, number>();
    for (const k of TABLES) {
      const s = `${k.key}→${k.command}`;
      seen.set(s, (seen.get(s) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });

  test("one key fans out only to one command in these tables", () => {
    const byKey = new Map<string, Set<string>>();
    for (const k of TABLES) {
      const s = byKey.get(k.key) ?? new Set<string>();
      s.add(k.command);
      byKey.set(k.key, s);
    }
    expect(
      [...byKey].filter(([, cmds]) => cmds.size > 1).map(([k]) => k),
    ).toEqual([]);
  });

  test("Place yields Cmd+D to a context's guarded binding, and keeps it elsewhere", () => {
    covers("keybinding:cmd+d→paged.insert.placeImage");
    const fillDown: KeybindingContribution = {
      key: "cmd+d",
      command: "media.paged.sheet.command.fillDown",
      when: (s) =>
        (s as { editContext?: { type?: string } } | null)?.editContext?.type ===
        "sheet",
    };
    const all = [...TABLES, fillDown];
    const inSheet = at({ editContext: { type: "sheet" } });
    expect(resolveBinding(all, press("cmd+d"), () => inSheet)?.command).toBe(
      "media.paged.sheet.command.fillDown",
    );
    expect(resolveBinding(all, press("cmd+d"), () => AT_ROOT)?.command).toBe(
      "paged.insert.placeImage",
    );
  });

  // Finding SH-9 (UX F-16): Cmd+0 (Fit document) and Cmd+1 (Zoom to 100%)
  // work, but through a canvas hook, not the registry, so the View menu
  // shows no chord for them and a plugin cannot see or rebind them.
  test.failing(
    "SH-9 (F-16): Fit document and Zoom to 100% are registry bindings",
    () => {
      covers("command:paged.view.zoomFit", "command:paged.view.zoom100");
      expect(fires("cmd+0")).toBe("paged.view.zoomFit");
      expect(fires("ctrl+0")).toBe("paged.view.zoomFit");
      expect(fires("cmd+1")).toBe("paged.view.zoom100");
      expect(fires("ctrl+1")).toBe("paged.view.zoom100");
    },
  );
});
