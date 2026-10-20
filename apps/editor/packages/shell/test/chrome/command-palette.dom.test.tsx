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

// The command palette's rows (UX audit F-16, F-25): the right column is
// the command's chord, never its id; the ask row says when there is no
// AI service before it is chosen.

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import { CommandPalette, notifyPalette } from "../../src/chrome/CommandPalette";
import {
  resetAiAvailability,
  setAiAvailability,
} from "../../src/ai/availability";
import type { CommandRegistry } from "../../src/registries/command";
import type { KeybindingRegistry } from "../../src/registries/keybinding";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";

let commands: CommandRegistry | null = null;
let keybindings: KeybindingRegistry | null = null;

function Grab() {
  const r = useRegistries();
  useEffect(() => {
    commands = r.commands;
    keybindings = r.keybindings;
  });
  return null;
}

function mount() {
  render(
    <RegistriesProvider getEditor={() => null}>
      <Grab />
      <CommandPalette />
    </RegistriesProvider>,
  );
  act(() => {
    commands!.register({
      id: "t.bound",
      title: "Bound command",
      category: "Test",
      handler: () => undefined,
    });
    commands!.register({
      id: "t.unbound",
      title: "Unbound command",
      category: "Test",
      handler: () => undefined,
    });
    keybindings!.register({ key: "shift+b", command: "t.bound" });
  });
}

const row = (id: string) =>
  document.body.querySelector<HTMLElement>(`[cmdk-item][data-value="${id}"]`);

afterEach(() => {
  act(() => notifyPalette("close"));
  cleanup();
  resetAiAvailability();
  commands = null;
  keybindings = null;
});

describe("command palette rows", () => {
  test("F-16: a row shows its chord, and never the command id", async () => {
    setAiAvailability("available");
    mount();
    act(() => notifyPalette("open"));
    const bound = await waitFor(() => {
      const el = row("t.bound");
      if (!el) throw new Error("no row");
      return el;
    });
    expect(
      bound.querySelector("[data-palette-chord]")?.textContent,
    ).toBeTruthy();
    expect(bound.textContent).not.toContain("t.bound");
    const unbound = row("t.unbound")!;
    expect(unbound.querySelector("[data-palette-chord]")).toBeNull();
    expect(unbound.textContent).not.toContain("t.unbound");
  });

  test("F-25: with no AI service the ask row says so and runs nothing", async () => {
    setAiAvailability("unavailable");
    let asked = 0;
    mount();
    act(() => {
      commands!.register({
        id: "paged.ai.ask",
        title: "Ask",
        handler: () => void asked++,
      });
      notifyPalette("open");
    });
    const input = await waitFor(() => {
      const el = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
      if (!el) throw new Error("no input");
      return el;
    });
    act(() => {
      fireEvent.change(input, {
        target: { value: "make the heading larger please" },
      });
    });
    const ai = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>("[data-palette-ai]");
      if (!el) throw new Error("no ask row");
      return el;
    });
    expect(ai.getAttribute("aria-disabled")).toBe("true");
    expect(ai.querySelector("[data-palette-ai-unavailable]")).not.toBeNull();
    fireEvent.click(ai);
    expect(asked).toBe(0);
  });
});
