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

// Editor ADR 299 — keybindings scoped to an edit context (extensions ADR
// 348, C2), and the context-bar registries and document context (ADR 298).
//
//   · a scoped binding exists only while its context is active: the frame
//     edit context, else the document context;
//   · while active it outranks every host binding on the key (guarded,
//     unguarded, a tool's `precedence`);
//   · it takes keys from the canvas TEXT INPUT (Tab, Cmd+B) — `claims` —
//     but never from a panel's field or a composition;
//   · the reserved host keys refuse a scoped binding.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { stubGlobal, unstubAllGlobals } from "@paged-media/test-kit";

import { createCommandRegistry } from "../../src/registries/command";
import {
  activeScopeContext,
  createControlBarGroupRegistry,
  createDocumentContextStore,
  createStatusItemRegistry,
} from "../../src/registries/context-bar";
import {
  createKeybindingRegistry,
  isReservedCombo,
  type KeyEventLike,
} from "../../src/registries/keybinding";

function press(
  combo: string,
  target: unknown = null,
): KeyEventLike & { target: unknown } {
  const parts = combo.split("+");
  const key = parts.pop()!;
  const has = (...m: string[]) => parts.some((p) => m.includes(p));
  return {
    key,
    metaKey: has("cmd", "meta"),
    ctrlKey: has("ctrl"),
    altKey: has("alt"),
    shiftKey: has("shift"),
    target,
  };
}

/** The canvas text input (TextInputSurface): a textarea tagged as the
 *  canvas's `text` surface. */
const textInput = {
  tagName: "TEXTAREA",
  isContentEditable: false,
  getAttribute: (n: string) => (n === "data-canvas-surface" ? "text" : null),
  hasAttribute: (n: string) => n === "data-canvas-surface",
  closest: () => null,
};
/** A panel's own field. */
const panelField = {
  tagName: "INPUT",
  isContentEditable: false,
  getAttribute: () => null,
  hasAttribute: () => false,
  closest: () => null,
};

describe("scoped keybindings (editor ADR 299)", () => {
  let state: {
    editContext: { type: string } | null;
    documentContext: string | null;
  };
  let invoked: string[];
  let commands: ReturnType<typeof createCommandRegistry>;
  let target: EventTarget;
  beforeEach(() => {
    target = new EventTarget();
    stubGlobal("window", target);
    state = { editContext: null, documentContext: null };
    invoked = [];
    commands = createCommandRegistry(() => state);
    for (const id of ["host.chord", "word.bold", "word.level", "host.tool"])
      commands.register({ id, title: id, handler: () => void invoked.push(id) });
  });
  afterEach(() => unstubAllGlobals());

  test("exists only while its context is active, frame context first", () => {
    const r = createKeybindingRegistry(commands, () => state);
    r.register({
      key: "cmd+b",
      command: "word.bold",
      scope: { editContext: "wordDocument" },
    });
    expect(r.resolve(press("cmd+b"))).toBeNull();
    state.documentContext = "wordDocument";
    expect(r.resolve(press("cmd+b"))?.command).toBe("word.bold");
    // A frame context above the document context hides it.
    state.editContext = { type: "sheet" };
    expect(r.resolve(press("cmd+b"))).toBeNull();
    state.editContext = { type: "wordDocument" };
    expect(r.resolve(press("cmd+b"))?.command).toBe("word.bold");
    r.dispose();
  });

  test("outranks guarded, unguarded and precedence-ranked host bindings", () => {
    const r = createKeybindingRegistry(commands, () => state);
    r.register({ key: "cmd+e", command: "host.chord" });
    r.register({ key: "cmd+e", command: "host.chord", when: () => true });
    r.register({ key: "cmd+e", command: "host.tool", precedence: () => 50 });
    r.register({
      key: "cmd+e",
      command: "word.bold",
      scope: { editContext: "wordDocument" },
    });
    expect(r.resolve(press("cmd+e"))?.command).toBe("host.tool");
    state.documentContext = "wordDocument";
    expect(r.resolve(press("cmd+e"))?.command).toBe("word.bold");
    r.dispose();
  });

  test("claims the text input's keys, never a field's or a composition's", () => {
    const r = createKeybindingRegistry(commands, () => state);
    r.register({ key: "tab", command: "host.chord" });
    r.register({
      key: "tab",
      command: "word.level",
      scope: { editContext: "wordDocument" },
    });
    expect(r.claims(press("tab", textInput))).toBe(false);
    state.editContext = { type: "wordDocument" };
    expect(r.claims(press("tab", textInput))).toBe(true);
    expect(r.claims(press("tab", panelField))).toBe(false);
    expect(
      r.claims({ ...press("tab", textInput), isComposing: true } as never),
    ).toBe(false);
    r.dispose();
  });

  test("a claimed key in the text input fires the scoped command", async () => {
    const r = createKeybindingRegistry(commands, () => state);
    r.register({
      key: "tab",
      command: "word.level",
      scope: { editContext: "wordDocument" },
    });
    state.documentContext = "wordDocument";
    const event = new Event("keydown", { cancelable: true });
    for (const [k, v] of Object.entries(press("tab", textInput)))
      Object.defineProperty(event, k, { value: v });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(invoked).toEqual(["word.level"]);
    r.dispose();
  });

  test("the reserved host keys refuse a scoped binding", () => {
    const r = createKeybindingRegistry(commands, () => state);
    for (const key of ["cmd+s", "cmd+p", "cmd+\\", "cmd+shift+p", "ctrl+s"]) {
      expect(isReservedCombo(key)).toBe(true);
      expect(() =>
        r.register({
          key,
          command: "word.bold",
          scope: { editContext: "wordDocument" },
        }),
      ).toThrow(/reserved/);
    }
    expect(() => r.register({ key: "cmd+s", command: "host.chord" })).not.toThrow();
    r.dispose();
  });
});

describe("context-bar registries and the document context (editor ADR 298)", () => {
  test("groups list by order and filter by context", () => {
    const groups = createControlBarGroupRegistry();
    const render = () => null;
    groups.register({ id: "b", order: 200, scope: { editContext: "w" }, render });
    groups.register({ id: "a", scope: { editContext: "w" }, render });
    groups.register({ id: "c", scope: { editContext: "x" }, render });
    expect(groups.forContext("w").map((g) => g.id)).toEqual(["a", "b"]);
    expect(groups.forContext(null)).toEqual([]);
    expect(() =>
      groups.register({ id: "a", scope: { editContext: "w" }, render }),
    ).toThrow(/already registered/);
    const items = createStatusItemRegistry();
    const d = items.register({ id: "s", scope: { editContext: "w" }, render });
    let changed = 0;
    items.onChange(() => changed++);
    d.dispose();
    expect(changed).toBe(1);
    expect(items.list()).toEqual([]);
  });

  test("the document context is held per plugin and followed by activeScopeContext", () => {
    const store = createDocumentContextStore();
    expect(store.set("p", "wordDocument")).toBe(true);
    expect(store.get()).toEqual({ pluginId: "p", type: "wordDocument" });
    store.set("other", null); // not the holder: nothing changes
    expect(store.get()?.type).toBe("wordDocument");
    store.set("p", null);
    expect(store.get()).toBeNull();
    expect(
      activeScopeContext({ editContext: null, documentContext: "wordDocument" }),
    ).toBe("wordDocument");
    expect(
      activeScopeContext({
        editContext: { type: "sheet" },
        documentContext: "wordDocument",
      }),
    ).toBe("sheet");
  });
});
