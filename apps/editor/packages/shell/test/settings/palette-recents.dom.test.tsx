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

// Setting `paged.palette.recents.v1` (chrome/CommandPalette.tsx): the
// command palette's Recent group. A command run from the palette goes to
// the front; at most five, no duplicates; read when the palette mounts,
// so a reload shows the same group. Only registered commands that apply
// where the user is are shown.

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { CommandPalette, notifyPalette } from "../../src/chrome/CommandPalette";
import type { CommandRegistry } from "../../src/registries/command";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";

const KEY = "paged.palette.recents.v1";
const IDS = ["t.one", "t.two", "t.three", "t.four", "t.five", "t.six"];

let commands: CommandRegistry | null = null;
const ran: string[] = [];

/** Hands the live command registry out to the test. */
function Grab({ onRender }: { onRender: (c: CommandRegistry) => void }) {
  const c = useRegistries().commands;
  useEffect(() => {
    onRender(c);
  });
  return null;
}

function mount(extra?: (c: CommandRegistry) => void) {
  const view = render(
    <RegistriesProvider getEditor={() => null}>
      <Grab onRender={(c) => (commands = c)} />
      <CommandPalette />
    </RegistriesProvider>,
  );
  act(() => {
    for (const id of IDS)
      commands!.register({
        id,
        title: `Command ${id.slice(2)}`,
        category: "Test",
        handler: () => void ran.push(id),
      });
    extra?.(commands!);
  });
  return view;
}

const open = () => act(() => notifyPalette("open"));
const item = (id: string) =>
  document.body.querySelector<HTMLElement>(`[cmdk-item][data-value="${id}"]`);
const recentIds = () =>
  [...document.body.querySelectorAll<HTMLElement>("[data-palette-recent]")].map(
    (el) => el.getAttribute("data-palette-recent"),
  );

async function runFromPalette(id: string) {
  open();
  const el = await waitFor(() => {
    const found = item(id);
    if (!found) throw new Error(`no palette row for ${id}`);
    return found;
  });
  fireEvent.click(el);
  await waitFor(() => expect(ran.at(-1)).toBe(id));
}

beforeEach(() => {
  localStorage.clear();
  ran.length = 0;
});
afterEach(() => {
  act(() => notifyPalette("close"));
  cleanup();
  commands = null;
  localStorage.clear();
});

describe("setting paged.palette.recents.v1", () => {
  test("default: no Recent group, nothing stored", async () => {
    covers("setting:paged.palette.recents.v1");
    mount();
    open();
    await waitFor(() => expect(item("t.one")).not.toBeNull());
    expect(recentIds()).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("a run goes to the front, persists, and a reload shows the group", async () => {
    covers("setting:paged.palette.recents.v1");
    const first = mount();
    await runFromPalette("t.two");
    await runFromPalette("t.one");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["t.one", "t.two"]);
    first.unmount();
    mount();
    open();
    await waitFor(() => expect(recentIds()).toEqual(["t.one", "t.two"]));
  });

  test("at most five, newest first, a re-run moves to the front without a duplicate", async () => {
    covers("setting:paged.palette.recents.v1");
    mount();
    for (const id of IDS) await runFromPalette(id);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([
      "t.six",
      "t.five",
      "t.four",
      "t.three",
      "t.two",
    ]);
    await runFromPalette("t.four");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([
      "t.four",
      "t.six",
      "t.five",
      "t.three",
      "t.two",
    ]);
  });

  test("an unregistered or inapplicable recent is not offered", async () => {
    covers("setting:paged.palette.recents.v1");
    localStorage.setItem(KEY, JSON.stringify(["t.gone", "t.gated", "t.one"]));
    mount((c) =>
      c.register({
        id: "t.gated",
        title: "Gated",
        when: () => false,
        handler: () => {},
      }),
    );
    open();
    await waitFor(() => expect(recentIds()).toEqual(["t.one"]));
  });

  test("an unreadable or ill-typed value loads as an empty or filtered list", async () => {
    covers("setting:paged.palette.recents.v1");
    for (const [raw, want] of [
      ["{broken", []],
      ["5", []],
      ['{"0":"t.one"}', []],
      ['["t.two", 3, null, "t.one"]', ["t.two", "t.one"]],
    ] as const) {
      localStorage.setItem(KEY, raw);
      const view = mount();
      open();
      await waitFor(() => expect(item("t.one")).not.toBeNull());
      expect({ raw, recents: recentIds() }).toEqual({
        raw,
        recents: [...want],
      });
      act(() => notifyPalette("close"));
      view.unmount();
    }
  });
});
