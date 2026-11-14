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

// The palette says why (editor ADR 1218): a match that does not apply here
// is listed, greyed, with its reason; "go to page …" navigates through
// `paged.view.goToPage`, by a page's name or position.

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "bun:test";

import {
  CommandPalette,
  GO_TO_PAGE_COMMAND,
  goToPageQuery,
  notifyPalette,
  pageNamed,
} from "../../src/chrome/CommandPalette";
import {
  setAiAvailability,
  resetAiAvailability,
} from "../../src/ai/availability";
import { CanvasClientProvider } from "../../src/state/canvas-client-context";
import { detachedEditorScope } from "../../src/state/editor-scope";
import type { CommandRegistry } from "../../src/registries/command";
import { commandNeeds } from "../../src/registries/command-reasons";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";

let commands: CommandRegistry | null = null;

function Grab() {
  const r = useRegistries();
  useEffect(() => {
    commands = r.commands;
  });
  return null;
}

const PAGES = [
  { selfId: "p1", index: 1, name: "1" },
  { selfId: "p2", index: 2, name: "B-1" },
  { selfId: "p3", index: 3, name: "B-2" },
];

const fakeClient = {
  collection: async () => PAGES,
} as never;

function mount() {
  render(
    <CanvasClientProvider client={fakeClient}>
      <RegistriesProvider
        getEditor={() => ({ selection: { elementSelection: [] } })}
      >
        <Grab />
        <CommandPalette />
      </RegistriesProvider>
    </CanvasClientProvider>,
  );
}

async function typeQuery(value: string) {
  const input = await waitFor(() => {
    const el = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
    if (!el) throw new Error("no input");
    return el;
  });
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

afterEach(() => {
  act(() => notifyPalette(detachedEditorScope(), "close"));
  cleanup();
  resetAiAvailability();
  commands = null;
});

describe("UXI-CMD-002 — the palette lists what does not apply, with why @uxi:UXI-PNL-004", () => {
  test("a match that needs a selection is listed, greyed, with its reason", async () => {
    setAiAvailability("available");
    mount();
    act(() => {
      commands!.register({
        id: "t.group",
        title: "Group objects",
        category: "Object",
        applicability: commandNeeds("selection"),
        handler: () => undefined,
      });
      notifyPalette(detachedEditorScope(), "open");
    });
    await typeQuery("Group");
    const row = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>(
        '[data-palette-unavailable="t.group"]',
      );
      if (!el) throw new Error("no row");
      return el;
    });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector("[data-palette-why]")?.textContent).toBe(
      "Select an object first.",
    );
    expect(document.body.querySelector("[cmdk-empty]")).toBeNull();
  });

  test("go to page: by position and by name, through paged.view.goToPage", async () => {
    setAiAvailability("available");
    const sent: unknown[] = [];
    mount();
    act(() => {
      commands!.register({
        id: GO_TO_PAGE_COMMAND,
        title: "Go to page…",
        category: "Layout",
        handler: (_p, payload) => void sent.push(payload),
      });
      notifyPalette(detachedEditorScope(), "open");
    });
    await typeQuery("go to page B-2");
    const row = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>(
        '[data-palette-goto="p3"]',
      );
      if (!el) throw new Error("no go-to row");
      return el;
    });
    expect(row.textContent).toContain("Go to page B-2");
    fireEvent.click(row);
    await waitFor(() => expect(sent).toEqual([{ page: "p3" }]));
  });

  test("a page that does not exist is said, not offered", async () => {
    setAiAvailability("available");
    mount();
    act(() => {
      commands!.register({
        id: GO_TO_PAGE_COMMAND,
        title: "Go to page…",
        handler: () => undefined,
      });
      notifyPalette(detachedEditorScope(), "open");
    });
    await typeQuery("page 40");
    const row = await waitFor(() => {
      const el = document.body.querySelector<HTMLElement>(
        "[data-palette-goto]",
      );
      if (!el || !el.textContent?.includes("40")) throw new Error("no row");
      return el;
    });
    expect(row.textContent).toContain("No page 40 in this document");
    expect(row.getAttribute("aria-disabled")).toBe("true");
  });

  test("the go-to query and the page it names", () => {
    const words = "go to page, go to, goto, page, p";
    expect(goToPageQuery("go to page 14", words)).toBe("14");
    expect(goToPageQuery("Page B-3", words)).toBe("B-3");
    expect(goToPageQuery("p4", words)).toBe("4");
    expect(goToPageQuery("paste", words)).toBeNull();
    expect(goToPageQuery("pages", words)).toBeNull();
    expect(goToPageQuery("group", words)).toBeNull();
    expect(pageNamed(PAGES, "B-1")?.selfId).toBe("p2");
    expect(pageNamed(PAGES, "3")?.selfId).toBe("p3");
    expect(pageNamed(PAGES, "+2")?.selfId).toBe("p2");
    expect(pageNamed(PAGES, "9")).toBeNull();
  });
});
