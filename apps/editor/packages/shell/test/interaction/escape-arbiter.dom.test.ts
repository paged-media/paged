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

// The Escape arbiter on its own (editor ADR 1205): handlers in every tier,
// one press, the first active handler in the order of the interaction
// specification's §12.1 resolves it and no other runs. The built-in tiers
// (an input method composing, an open layer, the focused control, a
// pointer held on the canvas) defer to their owners.

import { afterEach, describe, expect, test } from "bun:test";

import {
  ESCAPE_TIERS,
  escapeArbiterOf,
  type EscapeHandler,
  type EscapeTier,
} from "../../src/interaction/escape-arbiter";
import { createEditorScope } from "../../src/state/editor-scope";

const offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  document.body.innerHTML = "";
});

function escape(
  target: EventTarget = document.body,
  init: KeyboardEventInit & { keyCode?: number } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.keyCode !== undefined)
    Object.defineProperty(event, "keyCode", { value: init.keyCode });
  target.dispatchEvent(event);
  return event;
}

/** A scope with one recording handler per given tier, all active. */
function setup(tiers: ReadonlyArray<Exclude<EscapeTier, "ime">>) {
  const scope = createEditorScope();
  const arbiter = escapeArbiterOf(scope);
  const ran: string[] = [];
  const active = new Map<string, boolean>();
  for (const tier of tiers) {
    const handler: EscapeHandler = {
      id: `test.${tier}`,
      tier,
      isActive: () => active.get(tier) ?? true,
      resolve: () => void ran.push(tier),
    };
    offs.push(arbiter.register(handler));
  }
  return { scope, arbiter, ran, active };
}

describe("the Escape arbiter", () => {
  test("the tiers are the specification's order", () => {
    expect([...ESCAPE_TIERS]).toEqual([
      "ime",
      "menu",
      "modal",
      "palette",
      "layer",
      "gesture",
      "focused",
      "transient",
      "pointer",
      "context-dirty",
      "context",
      "text",
      "group",
      "selection",
    ]);
  });

  test("one press: the first active handler in tier order resolves it, and no other runs", () => {
    // Registered in reverse, so registration order cannot be what wins.
    const { arbiter, ran, active } = setup([
      "selection",
      "group",
      "text",
      "context",
      "context-dirty",
      "transient",
      "gesture",
      "palette",
      "modal",
      "menu",
    ]);
    const order = [
      "menu",
      "modal",
      "palette",
      "gesture",
      "transient",
      "context-dirty",
      "context",
      "text",
      "group",
      "selection",
    ] as const;
    for (const tier of order) {
      ran.length = 0;
      const press = escape();
      expect(ran).toEqual([tier]);
      expect(arbiter.resolutionOf(press)?.id).toBe(`test.${tier}`);
      // Handled: nothing later in the event's path acts on it too.
      expect(press.defaultPrevented).toBe(true);
      active.set(tier, false);
    }
    // Nothing left to dismiss: a no-op, the key untouched.
    ran.length = 0;
    const idle = escape();
    expect(ran).toEqual([]);
    expect(idle.defaultPrevented).toBe(false);
    expect(arbiter.resolutionOf(idle)).toBeNull();
  });

  test("an input method composing owns Escape: no handler runs", () => {
    const { arbiter, ran } = setup(["context", "selection"]);
    const composing = escape(document.body, { isComposing: true });
    expect(ran).toEqual([]);
    expect(composing.defaultPrevented).toBe(false);
    expect(arbiter.resolutionOf(composing)?.tier).toBe("ime");
    // The key that starts a composition (keyCode 229) too.
    escape(document.body, { keyCode: 229 });
    expect(ran).toEqual([]);
  });

  test("the focused control's Escape is its own (a field reverts its draft): the canvas tiers wait", () => {
    const { arbiter, ran } = setup(["transient", "context", "selection"]);
    const field = document.createElement("input");
    document.body.append(field);
    const press = escape(field);
    expect(ran).toEqual([]);
    expect(press.defaultPrevented).toBe(false);
    expect(arbiter.resolutionOf(press)?.id).toBe("paged.focusedControl");
  });

  test("a gesture under way outranks the focused control", () => {
    const { ran } = setup(["gesture", "context"]);
    const field = document.createElement("input");
    document.body.append(field);
    escape(field);
    expect(ran).toEqual(["gesture"]);
  });

  test("an open menu or popover with no handler of its own is Radix's: deferred, nothing else runs", () => {
    const { arbiter, ran } = setup(["context", "selection"]);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.setAttribute("data-state", "open");
    document.body.append(menu);
    const press = escape();
    expect(ran).toEqual([]);
    expect(press.defaultPrevented).toBe(false);
    expect(arbiter.resolutionOf(press)?.id).toBe("paged.openLayer");
    // A tooltip is a hint, not a layer Escape is spent on.
    menu.remove();
    const tip = document.createElement("div");
    tip.setAttribute("data-radix-popper-content-wrapper", "");
    tip.innerHTML = '<div role="tooltip">hint</div>';
    document.body.append(tip);
    escape();
    expect(ran).toEqual(["context"]);
  });

  test("a pointer held on the canvas is the canvas's gesture: deferred to its own listener, after the transient modes", () => {
    const { arbiter, ran, active } = setup([
      "transient",
      "context",
      "selection",
    ]);
    const viewport = document.createElement("div");
    viewport.setAttribute("data-canvas-surface", "viewport");
    document.body.append(viewport);
    viewport.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    expect(arbiter.pointerHeld()).toBe(true);
    // A loaded cursor owns the press it drags.
    escape();
    expect(ran).toEqual(["transient"]);
    active.set("transient", false);
    const press = escape();
    expect(ran).toEqual(["transient"]);
    expect(arbiter.resolutionOf(press)?.id).toBe("paged.canvasPointer");
    // The release ends it.
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(arbiter.pointerHeld()).toBe(false);
    escape();
    expect(ran).toEqual(["transient", "context"]);
  });

  test("a handler that defers leaves the event to its owner; a throwing isActive is not active", () => {
    const scope = createEditorScope();
    const arbiter = escapeArbiterOf(scope);
    const ran: string[] = [];
    offs.push(
      arbiter.register({
        id: "test.broken",
        tier: "menu",
        isActive: () => {
          throw new Error("cannot say");
        },
        resolve: () => void ran.push("broken"),
      }),
      arbiter.register({
        id: "test.defer",
        tier: "transient",
        isActive: () => true,
        resolve: () => {
          ran.push("defer");
          return "defer";
        },
      }),
      arbiter.register({
        id: "test.context",
        tier: "context",
        isActive: () => true,
        resolve: () => void ran.push("context"),
      }),
    );
    const press = escape();
    expect(ran).toEqual(["defer"]);
    expect(press.defaultPrevented).toBe(false);
    expect(arbiter.last()).toEqual({
      id: "test.defer",
      tier: "transient",
      outcome: "defer",
    });
  });

  test("other keys are none of its business; a removed handler is gone", () => {
    const { ran } = setup(["context"]);
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(enter);
    expect(ran).toEqual([]);
    expect(enter.defaultPrevented).toBe(false);
    for (const off of offs.splice(0)) off();
    escape();
    expect(ran).toEqual([]);
  });
});
