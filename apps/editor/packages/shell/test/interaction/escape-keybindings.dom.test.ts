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

// A module's binding on Escape and the Escape arbiter (editor ADR 1207,
// amendment 2026-11-15). The arbiter resolves a press in the capture phase,
// before the keybinding registry's window listener: a guarded binding on
// Escape — a module's transient mode, the Format Painter's loaded brush —
// answers in the arbiter's `transient` tier, so a selection on the canvas
// does not take the press from it. One press, one thing.

import { afterEach, describe, expect, test } from "bun:test";

import { escapeArbiterOf } from "../../src/interaction/escape-arbiter";
import { createCommandRegistry } from "../../src/registries/command";
import {
  createKeybindingRegistry,
  keybindingEscapeHandler,
} from "../../src/registries/keybinding";
import { createEditorScope } from "../../src/state/editor-scope";

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  document.body.innerHTML = "";
});

function escape(target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** An editor's arbiter with a selection on the canvas, and its keybinding
 *  registry (listening on the window, as in the editor) holding the
 *  painter's guarded binding on Escape and the bridge between the two. */
function setup() {
  const scope = createEditorScope();
  const arbiter = escapeArbiterOf(scope);
  const ran: string[] = [];
  const commands = createCommandRegistry(() => null);
  for (const id of ["t.painterOff", "t.global"]) {
    commands.register({ id, title: id, handler: () => void ran.push(id) });
  }
  const keybindings = createKeybindingRegistry(commands);
  offs.push(() => keybindings.dispose());
  const state = { armed: true, selected: true };
  keybindings.register({
    key: "escape",
    command: "t.painterOff",
    when: () => state.armed,
  });
  offs.push(
    arbiter.register({
      id: "test.selection",
      tier: "selection",
      isActive: () => state.selected,
      resolve: () => void ran.push("selection"),
    }),
  );
  offs.push(arbiter.register(keybindingEscapeHandler(keybindings, commands)));
  return { arbiter, keybindings, ran, state };
}

describe("a guarded binding on Escape answers through the arbiter", () => {
  test("while it holds (the painter's brush is loaded) it wins over the selection: its command runs once, the selection stays", async () => {
    const { arbiter, ran } = setup();
    const press = escape();
    await flush();
    expect(ran).toEqual(["t.painterOff"]);
    expect(press.defaultPrevented).toBe(true);
    expect(arbiter.resolutionOf(press)).toEqual({
      id: "paged.keybinding",
      tier: "transient",
      outcome: "handled",
    });
  });

  test("while it does not hold, the next Escape clears the selection and runs no binding", async () => {
    const { ran, state } = setup();
    state.armed = false;
    escape();
    await flush();
    expect(ran).toEqual(["selection"]);
  });

  test("an unguarded binding on Escape stays behind the arbiter: the selection takes the press", async () => {
    const { keybindings, ran, state } = setup();
    state.armed = false;
    keybindings.register({ key: "escape", command: "t.global" });
    escape();
    await flush();
    expect(ran).toEqual(["selection"]);
    // With nothing for the arbiter to do, the registry's own listener runs
    // it, as before.
    state.selected = false;
    escape();
    await flush();
    expect(ran).toEqual(["selection", "t.global"]);
  });

  test("a focused field keeps its place before the binding: the arbiter defers to it, and the binding runs at most once", async () => {
    const { arbiter, ran } = setup();
    const field = document.createElement("input");
    document.body.append(field);
    const press = escape(field);
    await flush();
    expect(arbiter.resolutionOf(press)?.id).toBe("paged.focusedControl");
    // The registry's own rule lets Escape reach a binding from a field
    // (targetOwnsKey); the bridge adds no second run.
    expect(ran).toEqual(["t.painterOff"]);
  });
});
