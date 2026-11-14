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

// Modifier hints (plan task IC10; extensions ADR 1109): the strip names
// what the modifiers do with the tool in hand — the handler's own
// `modifierHints`, else the host's for a built-in tool — lights the ones
// held, shows for a tool's first uses and then recedes; the preference
// keeps it showing. Its two settings live in the editor's storage.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  MODIFIER_HINTS_ALWAYS_KEY,
  MODIFIER_HINTS_USES_KEY,
  MODIFIER_HINT_USES,
  ModifierHints,
  modifierHintsAlways,
  setModifierHintsAlways,
} from "../../src/overlays/modifier-hints";
import {
  createEditorScope,
  EditorScopeProvider,
  type EditorScope,
} from "../../src/state/editor-scope";
import { setEditorStorage, type StorageAdapter } from "../../src/state/storage";

afterEach(() => cleanup());

function memoryStorage(seed: Record<string, string> = {}): StorageAdapter & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  } as StorageAdapter & { data: Map<string, string> };
}

function mount(scope: EditorScope, props: Parameters<typeof ModifierHints>[0]) {
  return render(
    <EditorScopeProvider scope={scope}>
      <ModifierHints {...props} />
    </EditorScopeProvider>,
  );
}

describe("modifier hints", () => {
  it("names the host's hints for a built-in tool and lights the key held", async () => {
    covers("setting:paged.modifierHints.uses");
    const scope = createEditorScope();
    const storage = memoryStorage();
    setEditorStorage(scope, storage);
    const view = mount(scope, { toolId: "paged.tool.select" });
    const strip = view.container.querySelector(
      '[data-modifier-hints="paged.tool.select"]',
    );
    expect(strip).not.toBeNull();
    const shift = () =>
      view.container.querySelector('[data-modifier-hint="shift"]');
    expect(shift()?.hasAttribute("data-held")).toBe(false);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }),
      );
    });
    expect(shift()?.hasAttribute("data-held")).toBe(true);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    });
    expect(shift()?.hasAttribute("data-held")).toBe(false);
    // Taking the tool up counted one use, in the editor's storage.
    expect(JSON.parse(storage.data.get(MODIFIER_HINTS_USES_KEY)!)).toEqual({
      "paged.tool.select": 1,
    });
  });

  it("shows a handler's own hints, and nothing for a tool that names none", () => {
    const scope = createEditorScope();
    setEditorStorage(scope, memoryStorage());
    const view = mount(scope, {
      toolId: "example.tool.sprinkle",
      hints: [{ keys: ["alt"], label: "Sprinkle from the centre" }],
    });
    expect(view.container.textContent).toContain("Sprinkle from the centre");
    cleanup();
    const none = mount(scope, { toolId: "example.tool.quiet" });
    expect(none.container.querySelector("[data-modifier-hints]")).toBeNull();
  });

  it("recedes after a tool's first uses; the preference keeps it, remembered", async () => {
    covers("setting:paged.modifierHints.always");
    const scope = createEditorScope();
    const storage = memoryStorage({
      [MODIFIER_HINTS_USES_KEY]: JSON.stringify({
        "paged.tool.select": MODIFIER_HINT_USES,
        // A malformed count is dropped, not trusted (ADR 247).
        "paged.tool.pen": "many",
      }),
    });
    setEditorStorage(scope, storage);
    const view = mount(scope, { toolId: "paged.tool.select" });
    // This use is one past the first five: receded.
    expect(view.container.querySelector("[data-modifier-hints]")).toBeNull();
    await act(async () => setModifierHintsAlways(scope, true));
    expect(
      view.container.querySelector("[data-modifier-hints]"),
    ).not.toBeNull();
    expect(storage.data.get(MODIFIER_HINTS_ALWAYS_KEY)).toBe("true");
    expect(modifierHintsAlways(scope)).toBe(true);
    await act(async () => setModifierHintsAlways(scope, false));
    expect(storage.data.has(MODIFIER_HINTS_ALWAYS_KEY)).toBe(false);
    expect(view.container.querySelector("[data-modifier-hints]")).toBeNull();
  });
});
