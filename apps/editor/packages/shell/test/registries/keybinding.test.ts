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

// The keybinding registry: how a key press becomes a command.
//
//   · the combo vocabulary (`cmd`/`meta`, `ctrl`/`control`, `alt`/`option`,
//     `shift`), refused loudly when malformed — there is no `mod` token and
//     no two-stroke chord: a binding that wants both platforms registers a
//     `cmd+…` and a `ctrl+…` twin;
//   · matching is exact on the modifiers and case-blind on the key;
//   · the dispatch rule among bindings on one key: disabled yields, a
//     guarded binding beats an unguarded one, `precedence` ranks when
//     declared, registration order breaks ties;
//   · `targetOwnsKey`: the focused widget keeps the keys it consumes;
//   · the window listener: attach / detach / dispose, preventDefault on a
//     match, nothing on a miss.
//
// UX findings F-49 (Tab) and F-36 (IME) are expected failures here (SH-2,
// SH-3): they fail for the finding's reason and flip when it is fixed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { createCommandRegistry } from "../../src/registries/command";
import {
  createKeybindingRegistry,
  resolveBinding,
  targetOwnsKey,
  type KeyEventLike,
  type KeybindingContribution,
} from "../../src/registries/keybinding";
import { createEditContextRegistry } from "../../src/registries/edit-context";
import { framePrecedence } from "../../src/state/commands/registry-derived";
import { contentSelectionInactive } from "../../src/state/commands/tool-commands";

/** A key event from a combo, the way a browser reports it. */
function press(
  combo: string,
  extra: Partial<KeyEventLike> = {},
): KeyEventLike & Record<string, unknown> {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const has = (...m: string[]) => parts.some((p) => m.includes(p));
  return {
    key,
    metaKey: has("cmd", "meta"),
    ctrlKey: has("ctrl", "control"),
    altKey: has("alt", "option"),
    shiftKey: has("shift"),
    ...extra,
  };
}

/** A DOM-ish element: tag, contenteditable, and the ancestor roles
 *  `closest` answers for. */
function el(
  tagName: string,
  options: { editable?: boolean; within?: string[] } = {},
): HTMLElement {
  return {
    tagName,
    isContentEditable: options.editable ?? false,
    closest: (selector: string) =>
      (options.within ?? []).some((role) =>
        selector.includes(`[role="${role}"]`),
      )
        ? ({} as Element)
        : null,
  } as unknown as HTMLElement;
}

const keyIn = (
  key: string,
  target: HTMLElement | null,
  mods: Partial<KeyboardEvent> = {},
) =>
  targetOwnsKey({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    target,
    ...mods,
  } as KeyboardEvent);

describe("the combo vocabulary", () => {
  let registry: ReturnType<typeof createKeybindingRegistry>;
  beforeEach(() => {
    stubGlobal("window", new EventTarget());
    registry = createKeybindingRegistry(createCommandRegistry(() => null));
  });
  afterEach(() => {
    registry.dispose();
    unstubAllGlobals();
  });

  test("modifier aliases parse to the same combo", () => {
    for (const [a, b] of [
      ["cmd+k", "meta+k"],
      ["ctrl+k", "control+k"],
      ["alt+k", "option+k"],
      ["CMD+Shift+K", "cmd+shift+k"],
      [" shift+tab ", "shift+tab"],
    ]) {
      const r = createKeybindingRegistry(createCommandRegistry(() => null));
      r.register({ key: a, command: "t.x" });
      expect(r.resolve(press(b.trim().toLowerCase()))?.command).toBe("t.x");
      r.dispose();
    }
  });

  test("a malformed combo is refused at registration", () => {
    for (const bad of ["", "cmd+", "+k", "cmd++k"]) {
      expect(() => registry.register({ key: bad, command: "t.x" })).toThrow(
        /malformed key/,
      );
    }
  });

  test("an unknown modifier is refused: there is no `mod` token", () => {
    for (const bad of ["mod+s", "hyper+k", "super+k", "win+e"]) {
      expect(() => registry.register({ key: bad, command: "t.x" })).toThrow(
        /unknown modifier/,
      );
    }
  });

  test("a two-stroke chord is refused (single combos only)", () => {
    expect(() =>
      registry.register({ key: "cmd+k cmd+s", command: "t.x" }),
    ).toThrow(/unknown modifier "k cmd"/);
  });

  test("the key matches case-blind, the modifiers exactly", () => {
    registry.register({ key: "shift+k", command: "t.shiftK" });
    registry.register({ key: "cmd+k", command: "t.cmdK" });
    // Shift+K reports `K`.
    expect(registry.resolve(press("shift+K"))?.command).toBe("t.shiftK");
    expect(registry.resolve(press("cmd+k"))?.command).toBe("t.cmdK");
    // An extra or missing modifier is a different combo.
    expect(registry.resolve(press("k"))).toBeNull();
    expect(registry.resolve(press("cmd+shift+k"))).toBeNull();
    expect(registry.resolve(press("ctrl+k"))).toBeNull();
    expect(registry.resolve(press("alt+cmd+k"))).toBeNull();
  });

  test("cmd and ctrl are separate flags: a twin is two registrations", () => {
    registry.register({ key: "cmd+s", command: "t.save" });
    expect(registry.resolve(press("cmd+s"))?.command).toBe("t.save");
    expect(registry.resolve(press("ctrl+s"))).toBeNull();
    registry.register({ key: "ctrl+s", command: "t.save" });
    expect(registry.resolve(press("ctrl+s"))?.command).toBe("t.save");
  });

  test("named keys match by their `key` name", () => {
    for (const k of [
      "escape",
      "tab",
      "arrowleft",
      "backspace",
      "delete",
      "=",
      "-",
      "[",
      "\\",
    ]) {
      registry.register({ key: k, command: `t.${k}` });
      expect(registry.resolve(press(k))?.command).toBe(`t.${k}`);
    }
    // `Escape` as the browser spells it.
    expect(registry.resolve(press("Escape"))?.command).toBe("t.escape");
  });

  test("list and dispose", () => {
    const a = registry.register({ key: "a", command: "t.a" });
    registry.register({ key: "b", command: "t.b" });
    expect(registry.list().map((k) => k.command)).toEqual(["t.a", "t.b"]);
    a.dispose();
    a.dispose();
    expect(registry.list().map((k) => k.command)).toEqual(["t.b"]);
    expect(registry.resolve(press("a"))).toBeNull();
  });
});

describe("the dispatch rule among bindings on one key", () => {
  const guarded = (on: () => boolean, command: string) => ({
    key: "cmd+d",
    command,
    when: () => on(),
  });

  test("a disabled binding yields to any other binding on the combo", () => {
    let sheetEntered = false;
    const bindings: KeybindingContribution[] = [
      guarded(() => sheetEntered, "sheet.fillDown"),
      { key: "cmd+d", command: "paged.insert.placeImage" },
    ];
    expect(resolveBinding(bindings, press("cmd+d"))?.command).toBe(
      "paged.insert.placeImage",
    );
    sheetEntered = true;
    expect(resolveBinding(bindings, press("cmd+d"))?.command).toBe(
      "sheet.fillDown",
    );
  });

  test("a guarded binding beats an unguarded one whatever the order (Place vs Fill down)", () => {
    const place = { key: "cmd+d", command: "paged.insert.placeImage" };
    const fill = guarded(() => true, "sheet.fillDown");
    expect(resolveBinding([place, fill], press("cmd+d"))?.command).toBe(
      "sheet.fillDown",
    );
    expect(resolveBinding([fill, place], press("cmd+d"))?.command).toBe(
      "sheet.fillDown",
    );
  });

  test("within a class, the first registration wins the tie", () => {
    const a = guarded(() => true, "t.first");
    const b = guarded(() => true, "t.second");
    expect(resolveBinding([a, b], press("cmd+d"))?.command).toBe("t.first");
    expect(resolveBinding([b, a], press("cmd+d"))?.command).toBe("t.second");
    const c = { key: "cmd+d", command: "t.u1" };
    const d = { key: "cmd+d", command: "t.u2" };
    expect(resolveBinding([c, d], press("cmd+d"))?.command).toBe("t.u1");
  });

  test("`precedence` ranks on the same scale (guarded 1, unguarded 0)", () => {
    const host = guarded(() => true, "host.j");
    const low: KeybindingContribution = {
      key: "cmd+d",
      command: "t.low",
      when: () => true,
      precedence: () => -1,
    };
    const high: KeybindingContribution = {
      key: "cmd+d",
      command: "t.high",
      when: () => true,
      precedence: () => 2,
    };
    expect(resolveBinding([low, host], press("cmd+d"))?.command).toBe("host.j");
    expect(resolveBinding([host, high], press("cmd+d"))?.command).toBe(
      "t.high",
    );
    // Even an unguarded binding beats a negatively ranked one.
    const plain = { key: "cmd+d", command: "t.plain" };
    expect(resolveBinding([low, plain], press("cmd+d"))?.command).toBe(
      "t.plain",
    );
  });

  test("a throwing precedence keeps its class default; a throwing `when` disables", () => {
    const throwsRank: KeybindingContribution = {
      key: "cmd+d",
      command: "t.throwsRank",
      when: () => true,
      precedence: () => {
        throw new Error("rank");
      },
    };
    const plain = { key: "cmd+d", command: "t.plain" };
    // Guarded default 1 > unguarded 0.
    expect(resolveBinding([plain, throwsRank], press("cmd+d"))?.command).toBe(
      "t.throwsRank",
    );
    const throwsWhen: KeybindingContribution = {
      key: "cmd+d",
      command: "t.throwsWhen",
      when: () => {
        throw new Error("when");
      },
    };
    expect(resolveBinding([throwsWhen, plain], press("cmd+d"))?.command).toBe(
      "t.plain",
    );
    expect(resolveBinding([throwsWhen], press("cmd+d"))).toBeNull();
  });

  test("`precedence` and `when` read the same state", () => {
    const seen: unknown[] = [];
    const state = { editContext: { type: "raster" } };
    resolveBinding(
      [
        {
          key: "j",
          command: "t.j",
          when: (s) => (seen.push(["when", s]), true),
          precedence: (s) => (seen.push(["rank", s]), 1),
        },
      ],
      press("j"),
      () => state,
    );
    expect(seen).toEqual([
      ["when", state],
      ["rank", state],
    ]);
  });

  test("a frame tool's shortcut wins inside its context and yields outside (IMG-3, J)", () => {
    // The real derivation: the fill/stroke cluster's `j` and a plugin
    // tool's `j` claimed by the raster edit context.
    const editContexts = createEditContextRegistry();
    editContexts.register({
      type: "raster",
      entry: "doubleClick",
      toolIds: ["media.paged.image.tool.heal"],
    } as never);
    const registries = { editContexts };
    const bindings: KeybindingContribution[] = [
      {
        key: "j",
        command: "paged.fillStroke.toggleAffects",
        when: contentSelectionInactive,
      },
      {
        key: "j",
        command: "paged.tool.activate.media.paged.image.tool.heal",
        when: contentSelectionInactive,
        precedence: (s) =>
          framePrecedence(registries, "media.paged.image.tool.heal", s),
      },
    ];
    const outside = { contentSelection: { contentSelection: null } };
    const inside = {
      ...outside,
      editContext: {
        type: "raster",
        toolIds: ["media.paged.image.tool.heal"],
      },
    };
    const typing = {
      ...inside,
      contentSelection: { contentSelection: { caret: 1 } },
    };
    expect(resolveBinding(bindings, press("j"), () => outside)?.command).toBe(
      "paged.fillStroke.toggleAffects",
    );
    expect(resolveBinding(bindings, press("j"), () => inside)?.command).toBe(
      "paged.tool.activate.media.paged.image.tool.heal",
    );
    // A caret silences both: typing "j" is text.
    expect(resolveBinding(bindings, press("j"), () => typing)).toBeNull();
  });

  test("an unclaimed tool ranks as an ordinary guarded binding", () => {
    const editContexts = createEditContextRegistry();
    expect(framePrecedence({ editContexts }, "paged.tool.pen", null)).toBe(1);
  });
});

describe("the focused widget keeps the keys it consumes (targetOwnsKey)", () => {
  test("a pure letter typed into a field is text; a Cmd chord still reaches the registry", () => {
    for (const field of [
      el("INPUT"),
      el("TEXTAREA"),
      el("DIV", { editable: true }),
    ]) {
      expect(keyIn("v", field)).toBe(true);
      expect(keyIn("V", field)).toBe(true);
      expect(keyIn("k", field, { metaKey: true })).toBe(false);
      expect(keyIn("k", field, { ctrlKey: true })).toBe(false);
      // Alt+letter is a chord too (it is not text the field types).
      expect(keyIn("x", field, { altKey: true })).toBe(false);
    }
  });

  test("a field keeps its editing keys WITH their modifiers", () => {
    const field = el("INPUT");
    for (const key of [
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ]) {
      expect(keyIn(key, field)).toBe(true);
      expect(keyIn(key, field, { metaKey: true })).toBe(true);
      expect(keyIn(key, field, { altKey: true })).toBe(true);
    }
  });

  test("a select and the ARIA composites own the arrows (and Delete)", () => {
    expect(keyIn("ArrowDown", el("SELECT"))).toBe(true);
    for (const role of [
      "menu",
      "menubar",
      "listbox",
      "tree",
      "grid",
      "tablist",
      "radiogroup",
      "slider",
      "spinbutton",
      "combobox",
      "dialog",
    ]) {
      const inside = el("BUTTON", { within: [role] });
      expect({ role, owns: keyIn("ArrowUp", inside) }).toEqual({
        role,
        owns: true,
      });
      expect({ role, owns: keyIn("Delete", inside) }).toEqual({
        role,
        owns: true,
      });
      // A letter is not the composite's.
      expect(keyIn("v", inside)).toBe(false);
    }
  });

  test("a toolbar does NOT own the arrows: click a tool, then nudge", () => {
    expect(keyIn("ArrowLeft", el("BUTTON", { within: ["toolbar"] }))).toBe(
      false,
    );
    expect(keyIn("ArrowLeft", el("BUTTON"))).toBe(false);
  });

  test("a widget key something upstream already took is the widget's", () => {
    expect(keyIn("ArrowDown", el("BUTTON"), { defaultPrevented: true })).toBe(
      true,
    );
    // Scoped to the widget keys: a prevented chord is not affected.
    expect(
      keyIn("s", el("BUTTON"), { defaultPrevented: true, metaKey: true }),
    ).toBe(false);
  });

  test("no target, or a target with no tag (the window), owns nothing", () => {
    expect(keyIn("v", null)).toBe(false);
    expect(keyIn("ArrowLeft", {} as HTMLElement)).toBe(false);
  });

  test("Tab, Enter, Escape and the function keys are not suppressed in a field (shipped behaviour)", () => {
    for (const key of ["Tab", "Enter", "Escape", "F2"]) {
      expect(keyIn(key, el("INPUT"))).toBe(false);
    }
  });

  // Finding SH-2 (UX F-49): Tab is the chrome toggle and fires from
  // anywhere a field is not focused, so keyboard focus can never move —
  // not inside a dialog, not across the chrome. The rule that keeps a
  // dialog's keys its own is this one; Tab is deliberately outside it.
  test.failing(
    "SH-2 (F-49): a dialog owns Tab, so focus can move between its controls",
    () => {
      expect(keyIn("Tab", el("BUTTON", { within: ["dialog"] }))).toBe(true);
      expect(
        keyIn("Tab", el("SELECT", { within: ["dialog"] }), { shiftKey: true }),
      ).toBe(true);
    },
  );
});

describe("the window listener", () => {
  let target: EventTarget;
  let commands: ReturnType<typeof createCommandRegistry>;
  let invoked: string[];

  beforeEach(() => {
    target = new EventTarget();
    stubGlobal("window", target);
    invoked = [];
    commands = createCommandRegistry(() => null);
    for (const id of ["t.save", "t.v", "t.tab"]) {
      commands.register({
        id,
        title: id,
        handler: () => void invoked.push(id),
      });
    }
  });
  afterEach(() => unstubAllGlobals());

  /** Dispatch a keydown on the stub window; returns whether it was
   *  default-prevented. */
  const keydown = (
    combo: string,
    extra: Record<string, unknown> = {},
  ): boolean => {
    const event = new Event("keydown", { cancelable: true });
    // `target` (and `isComposing`) are read-only on Event: shadow every
    // field on the instance, which is what the listener reads.
    for (const [k, v] of Object.entries({
      target: null,
      ...press(combo),
      ...extra,
    })) {
      Object.defineProperty(event, k, { value: v });
    }
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test("a match prevents the default and invokes its command; a miss does neither", async () => {
    const r = createKeybindingRegistry(commands);
    r.register({ key: "cmd+s", command: "t.save" });
    expect(keydown("cmd+s")).toBe(true);
    expect(keydown("cmd+e")).toBe(false);
    await flush();
    expect(invoked).toEqual(["t.save"]);
    r.dispose();
  });

  test("the binding's `when` reads the state thunk at key time", async () => {
    let caret: unknown = null;
    const r = createKeybindingRegistry(commands, () => ({
      contentSelection: { contentSelection: caret },
    }));
    r.register({ key: "v", command: "t.v", when: contentSelectionInactive });
    expect(keydown("v")).toBe(true);
    caret = { story: "u1", offset: 3 };
    // Typing "v" in a story is text, not a tool switch.
    expect(keydown("v")).toBe(false);
    await flush();
    expect(invoked).toEqual(["t.v"]);
    r.dispose();
  });

  test("a key the focused field owns never reaches a binding", async () => {
    const r = createKeybindingRegistry(commands);
    r.register({ key: "v", command: "t.v" });
    expect(keydown("v", { target: el("INPUT") })).toBe(false);
    await flush();
    expect(invoked).toEqual([]);
    r.dispose();
  });

  test("attach is idempotent, detach keeps the bindings, dispose drops them", async () => {
    const r = createKeybindingRegistry(commands);
    r.register({ key: "cmd+s", command: "t.save" });
    r.attach();
    r.attach();
    keydown("cmd+s");
    await flush();
    // One listener, one invocation.
    expect(invoked).toEqual(["t.save"]);
    r.detach();
    r.detach();
    expect(keydown("cmd+s")).toBe(false);
    expect(r.list()).toHaveLength(1);
    r.attach();
    keydown("cmd+s");
    await flush();
    expect(invoked).toEqual(["t.save", "t.save"]);
    r.dispose();
    expect(r.list()).toEqual([]);
    expect(keydown("cmd+s")).toBe(false);
  });

  test("a binding to a command that refuses (`when` false) is still consumed", async () => {
    // The keybinding fires; the command registry's gate refuses. The key
    // does not fall through to the browser (Cmd+S never opens Save Page).
    commands.register({
      id: "t.gated",
      title: "Gated",
      when: () => false,
      handler: () => void invoked.push("t.gated"),
    });
    const r = createKeybindingRegistry(commands);
    r.register({ key: "cmd+s", command: "t.gated" });
    expect(keydown("cmd+s")).toBe(true);
    await flush();
    expect(invoked).toEqual([]);
    r.dispose();
  });

  // Finding SH-3 (UX F-36): a keydown that belongs to an IME composition
  // (`isComposing`, `key` "Process" on Windows, keyCode 229) is the input
  // method's, not a shortcut. The listener ignores `isComposing`, so a
  // single-key tool shortcut fires mid-composition.
  test.failing(
    "SH-3 (F-36): a key pressed during IME composition fires no binding",
    async () => {
      const r = createKeybindingRegistry(commands);
      r.register({ key: "v", command: "t.v" });
      expect(keydown("v", { isComposing: true, keyCode: 229 })).toBe(false);
      await flush();
      expect(invoked).toEqual([]);
      r.dispose();
    },
  );
});
