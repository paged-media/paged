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

// F-27 (UX audit): a right-click on the canvas opened the browser's page
// menu. Now it opens the canvas context menu (ADR 232): the whole
// PagedShell over the real engine, the app's clipboard and object commands
// registered, a right-click on the viewport. The rows are commands, greyed
// by their own `when`, with their chords; Escape closes; a row runs its
// command; Shift+F10 opens it from the keyboard.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { CanvasClient } from "@paged-media/client";
import {
  PagedShell,
  useRegistries,
  type ModeContribution,
  type ShellRegistries,
} from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  CANVAS_CONTEXT_MENU_COMMAND,
  CANVAS_CONTEXT_MENU_KEYBINDINGS,
  CanvasContextMenuHost,
} from "../../src/canvas-context-menu";
import {
  buildClipboardCommands,
  CLIPBOARD_KEYBINDINGS,
} from "../../src/clipboard-commands";
import { EngineWorker, headlessEngine } from "../panels/engine-worker";

const MODES: ModeContribution[] = [
  {
    id: "design",
    title: "Design",
    icon: "mode-design",
    order: 0,
    slots: { left: "test.left" },
  },
];

function Register({
  onRegistries,
}: {
  onRegistries(r: ShellRegistries): void;
}) {
  const registries = useRegistries();
  useEffect(() => {
    const ds = [
      ...buildClipboardCommands({
        report: () => {},
        system: { write: async () => false, read: async () => null },
        deleteSelection: async () => {},
      }),
      CANVAS_CONTEXT_MENU_COMMAND,
      {
        id: "paged.object.delete",
        title: "Delete",
        category: "Object",
        handler: () => {
          deleted += 1;
        },
      },
    ].map((c) => registries.commands.register(c));
    const ks = [
      ...CLIPBOARD_KEYBINDINGS,
      ...CANVAS_CONTEXT_MENU_KEYBINDINGS,
    ].map((k) => registries.keybindings.register(k));
    onRegistries(registries);
    return () => {
      for (const d of [...ds, ...ks]) d.dispose();
    };
  }, [registries, onRegistries]);
  return null;
}

let deleted = 0;
afterEach(() => {
  cleanup();
  deleted = 0;
});

async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount() {
  const { worker } = await headlessEngine();
  const client = new CanvasClient({
    workerFactory: () => new EngineWorker(worker) as unknown as Worker,
  });
  await client.newBlankDocument(612, 792);
  let registries: ShellRegistries | null = null;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        panels={[
          { id: "test.left", title: "Left", component: () => <p>left</p> },
        ]}
        modes={MODES}
        initialMode="design"
        canvasComponent={() => <div data-test-canvas />}
      >
        <Register onRegistries={(r) => (registries = r)} />
        <CanvasContextMenuHost />
      </PagedShell>,
    );
  });
  await settle();
  if (!registries) throw new Error("no registries");
  return { view, registries: registries as ShellRegistries };
}

const menu = () =>
  document.querySelector('[data-testid="canvas-context-menu"]');
const row = (command: string) =>
  document.querySelector<HTMLElement>(`[data-command="${command}"]`);

describe("F-27 (UX audit): the canvas context menu", () => {
  test("a right-click on the canvas opens the editor's menu, not the browser's", async () => {
    covers("command:paged.edit.contextMenu");
    const s = await mount();
    const viewport = s.view.container.querySelector("[data-paged-viewport]");
    if (!viewport) throw new Error("no viewport");
    let prevented = false;
    await act(async () => {
      const e = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      });
      viewport.dispatchEvent(e);
      prevented = e.defaultPrevented;
    });
    await settle();
    expect(prevented).toBe(true);
    expect(menu()?.getAttribute("role")).toBe("menu");
    // The rows are the registered commands, in order; one not registered
    // (Arrange here) is left out rather than shown dead.
    const items = [...menu()!.querySelectorAll('[role="menuitem"]')].map((e) =>
      e.getAttribute("data-command"),
    );
    expect(items).toEqual([
      "paged.edit.cut",
      "paged.edit.copy",
      "paged.edit.paste",
      "paged.edit.pasteInPlace",
      "paged.edit.duplicate",
      "paged.object.delete",
    ]);
    // Greyed by the command's own `when`: nothing is selected.
    expect(
      row("paged.edit.copy")?.getAttribute("data-disabled"),
    ).not.toBeNull();
    expect(
      row("paged.object.delete")?.getAttribute("data-disabled"),
    ).toBeNull();
    expect(row("paged.edit.copy")?.textContent).toMatch(/Copy(⌘C|Ctrl\+C)/);
    // A row runs its command and closes the menu.
    await act(async () => {
      fireEvent.click(row("paged.object.delete")!);
    });
    await settle();
    expect(deleted).toBe(1);
    expect(menu()).toBeNull();
  });

  test("a right-click outside the canvas keeps the browser's menu", async () => {
    covers("command:paged.edit.contextMenu");
    await mount();
    let prevented = true;
    await act(async () => {
      const e = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(e);
      prevented = e.defaultPrevented;
    });
    expect(prevented).toBe(false);
    expect(menu()).toBeNull();
  });

  test("Shift+F10 opens it from the keyboard; Escape closes it", async () => {
    covers(
      "command:paged.edit.contextMenu",
      "keybinding:shift+f10→paged.edit.contextMenu",
      "keybinding:contextmenu→paged.edit.contextMenu",
    );
    const s = await mount();
    expect(
      s.registries.keybindings.resolve({
        key: "ContextMenu",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      })?.command,
    ).toBe("paged.edit.contextMenu");
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F10", shiftKey: true }),
      );
    });
    await settle();
    expect(menu()).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(menu()!, { key: "Escape" });
    });
    await settle();
    expect(menu()).toBeNull();
  });
});
