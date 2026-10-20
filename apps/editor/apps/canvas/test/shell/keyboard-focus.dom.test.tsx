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

// Keyboard focus across the main chrome (F-49, SH-2, ADR 234): the whole
// PagedShell mounted in happy-dom over the real engine. What a browser
// does with Tab is not available here, so the tab ORDER is read with
// `tabbableElements` (the sequential focus order the browser walks), and
// the KEYS are dispatched as the window listeners receive them:
//
//   · the chrome's tab stops, region by region, in reading order, each
//     toolbar (menu bar, tools, rail foot, panel rail, modes) ONE stop;
//   · the canvas viewport is a stop of its own;
//   · Tab from the page, a button or a dialog moves focus and never hides
//     the chrome; Tab on the canvas the user CLICKED into hides it; Tab on
//     a canvas reached by keyboard passes on (no trap); Cmd/Ctrl+\ hides
//     it from anywhere;
//   · the arrows, Home and End walk a toolbar;
//   · a FocusScope moves focus in, keeps Tab inside, and gives focus back.

import { act, cleanup, render } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { useEffect, useState } from "react";

import { CanvasClient } from "@paged-media/client";
import {
  FocusScope,
  PagedShell,
  tabbableElements,
  useRegistries,
  type ModeContribution,
  type ShellRegistries,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";
import { covers } from "@paged-media/test-kit";

import { EngineWorker, headlessEngine } from "../panels/engine-worker";

const LEFT = "test.left";
const MODES: ModeContribution[] = [
  {
    id: "design",
    title: "Design",
    icon: "mode-design",
    order: 0,
    slots: { left: LEFT },
  },
  {
    id: "content",
    title: "Content",
    icon: "mode-content",
    order: 1,
    slots: { left: LEFT },
  },
];

function Capture({ onRegistries }: { onRegistries(r: ShellRegistries): void }) {
  const registries = useRegistries();
  useEffect(() => {
    onRegistries(registries);
  }, [registries, onRegistries]);
  return null;
}

/** A dialog the test opens over the shell, as a canvas-app dialog is. */
function TestDialog({ open }: { open: boolean }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Test dialog"
      data-test-dialog
    >
      <FocusScope trap autoFocus restoreFocus>
        <h2>Settings</h2>
        <input aria-label="Name" data-test-first />
        <button type="button">Cancel</button>
        <button type="button" data-test-last>
          OK
        </button>
      </FocusScope>
    </div>
  );
}

let openDialog: (open: boolean) => void = () => {};
function DialogHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openDialog = setOpen;
  }, []);
  return <TestDialog open={open} />;
}

// happy-dom lets ANY element take focus; a browser focuses only a
// focusable one (a control, a link, an element with a tabindex,
// contenteditable). Fragment refs' `focus()` relies on that rule to skip
// a dialog's heading, so the lane applies it here.
const nativeFocus = HTMLElement.prototype.focus;
function focusable(el: HTMLElement): boolean {
  if (el.hasAttribute("tabindex") || el.isContentEditable) return true;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.tagName === "A") return el.hasAttribute("href");
  return [
    "INPUT",
    "SELECT",
    "TEXTAREA",
    "BUTTON",
    "SUMMARY",
    "IFRAME",
  ].includes(el.tagName);
}
beforeAll(() => {
  HTMLElement.prototype.focus = function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    if (focusable(this)) nativeFocus.call(this, options);
  };
});
afterAll(() => {
  HTMLElement.prototype.focus = nativeFocus;
});

afterEach(() => cleanup());

async function mountShell() {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  await client.newBlankDocument(612, 792);
  let registries: ShellRegistries | null = null;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        panels={[
          {
            id: LEFT,
            title: "Left",
            component: () => (
              <div data-test-left>
                <input aria-label="Search pages" />
              </div>
            ),
          },
        ]}
        tools={BUILT_IN_TOOLS}
        modes={MODES}
        initialMode="design"
        panelRail={[
          { panelId: LEFT, title: "Left", icon: "panel-layers" },
          { panelId: "test.other", title: "Other", icon: "panel-swatches" },
        ]}
        canvasComponent={() => <div data-test-canvas />}
      >
        <Capture onRegistries={(r) => (registries = r)} />
        <DialogHost />
      </PagedShell>,
    );
  });
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  await settle();
  if (!registries) throw new Error("PagedShell did not publish registries");
  const r: ShellRegistries = registries;
  for (const [path, id] of [
    ["File/New", "test.file.new"],
    ["Edit/Undo", "test.edit.undo"],
    ["View/Zoom in", "test.view.zoomIn"],
  ] as const) {
    r.commands.register({ id, title: path, handler: () => {} });
    r.menus.register({ path, command: id });
  }
  await settle();
  const root = view.container;
  return {
    root,
    registries: r,
    settle,
    rail: () => root.querySelector("[data-tool-rail]") !== null,
    viewport: () =>
      root.querySelector<HTMLElement>('[data-canvas-surface="viewport"]')!,
    /** A keydown as the browser delivers it: on the focused element (or
     *  the body), bubbling to the window listeners. */
    async key(init: KeyboardEventInit, target?: Element | null) {
      const on = target ?? document.activeElement ?? document.body;
      await act(async () => {
        on.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
      await settle();
    },
  };
}

/** The region of the chrome an element belongs to. */
function regionOf(el: Element): string {
  const at = (selector: string) => el.closest(selector) !== null;
  if (at('[role="menubar"]')) return "menu bar";
  if (at('[role="toolbar"][aria-label="Tools"]')) return "tools";
  if (at('[role="toolbar"][aria-label="Fill, stroke and view"]'))
    return "rail foot";
  if (at("[data-left-panel]")) return "left panel";
  if (at('[data-canvas-surface="viewport"]')) return "canvas";
  if (at("[data-thumbnail-rail]")) return "page strip";
  if (at("[data-right-dock]")) return "right dock";
  if (at("[data-panel-rail]")) return "panel rail";
  if (at('[role="toolbar"][aria-label="Workflow mode"]')) return "modes";
  if (at("[data-mode-switcher]")) return "mode bar";
  if (at("header")) return "header";
  return "control bar";
}

describe("keyboard focus across the main chrome", () => {
  test("the tab order walks the chrome region by region; each toolbar is one stop and the canvas is a stop", async () => {
    const s = await mountShell();
    const stops = tabbableElements(s.root);
    const regions = stops.map(regionOf);
    // The order the regions are met in (consecutive stops of one region
    // collapse to one entry).
    const order = regions.filter((r, i) => i === 0 || regions[i - 1] !== r);
    // (The right dock has no tabs open in this mount; in the app its
    // tab strip sits between the page strip and the panel rail.)
    expect(order).toEqual([
      "menu bar",
      "header",
      "control bar",
      "tools",
      "rail foot",
      "left panel",
      "canvas",
      "page strip",
      "panel rail",
      "modes",
      "mode bar",
    ]);
    // A roving group is ONE tab stop, however many buttons it holds.
    const count = (region: string) =>
      regions.filter((r) => r === region).length;
    for (const group of [
      "menu bar",
      "tools",
      "rail foot",
      "panel rail",
      "modes",
    ]) {
      expect({ group, stops: count(group) }).toEqual({ group, stops: 1 });
    }
    expect(s.root.querySelectorAll("[data-tool-slot]").length).toBeGreaterThan(
      10,
    );
    // The tools' stop is the tool in hand.
    const toolStop = stops.find((el) => regionOf(el) === "tools")!;
    expect(toolStop.getAttribute("aria-pressed")).toBe("true");
    // The modes' stop is the active mode.
    const modeStop = stops.find((el) => regionOf(el) === "modes")!;
    expect(modeStop.getAttribute("data-mode-option")).toBe("design");
  });

  test("SH-2 (F-49): Tab from the page, a button or a dialog moves focus and leaves the chrome alone", async () => {
    covers(
      "keybinding:tab→paged.chrome.toggleAll",
      "keybinding:shift+tab→paged.chrome.togglePanels",
    );
    const s = await mountShell();
    await s.key({ key: "Tab" }, document.body);
    expect(s.rail()).toBe(true);
    const file = s.root.querySelector<HTMLElement>(
      '[data-menu-trigger="File"]',
    )!;
    file.focus();
    await s.key({ key: "Tab" });
    await s.key({ key: "Tab", shiftKey: true });
    expect(s.rail()).toBe(true);
    await act(async () => openDialog(true));
    await s.settle();
    const inDialog = document.querySelector<HTMLElement>(
      "[data-test-dialog] button",
    )!;
    inDialog.focus();
    await s.key({ key: "Tab" });
    await s.key({ key: "Tab", shiftKey: true });
    expect(s.rail()).toBe(true);
  });

  test("Tab on the canvas the user clicked into hides the chrome; on a canvas reached by keyboard it passes on", async () => {
    covers(
      "keybinding:tab→paged.chrome.toggleAll",
      "command:paged.chrome.toggleAll",
    );
    const s = await mountShell();
    const viewport = s.viewport();
    expect(viewport.tabIndex).toBe(0);
    expect(viewport.getAttribute("role")).toBe("application");

    // Reached by keyboard: focus, no pointer. Tab is focus traversal.
    await act(async () => viewport.focus());
    expect(document.activeElement).toBe(viewport);
    await s.key({ key: "Tab" });
    expect(s.rail()).toBe(true);

    // A click in the canvas: Tab is the chrome toggle (InDesign).
    await act(async () => {
      viewport.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
    expect(document.activeElement).toBe(viewport);
    await s.key({ key: "Tab" });
    expect(s.rail()).toBe(false);
    await s.key({ key: "Tab" });
    expect(s.rail()).toBe(true);
  });

  test("Cmd+\\ and Ctrl+\\ hide and show the chrome from anywhere, a field included", async () => {
    covers(
      "keybinding:cmd+\\→paged.chrome.toggleAll",
      "keybinding:ctrl+\\→paged.chrome.toggleAll",
    );
    const s = await mountShell();
    const field = s.root.querySelector<HTMLInputElement>(
      "[data-test-left] input",
    )!;
    field.focus();
    await s.key({ key: "\\", metaKey: true });
    expect(s.rail()).toBe(false);
    await s.key({ key: "\\", ctrlKey: true }, document.body);
    expect(s.rail()).toBe(true);
  });

  test("the arrows, Home and End walk a toolbar and move its one tab stop", async () => {
    const s = await mountShell();
    const slots = () =>
      Array.from(s.root.querySelectorAll<HTMLElement>("[data-tool-slot]"));
    const first = slots()[0];
    await act(async () => first.focus());
    await s.key({ key: "ArrowDown" });
    expect(document.activeElement).toBe(slots()[1]);
    expect(slots()[1].tabIndex).toBe(0);
    expect(slots()[0].tabIndex).toBe(-1);
    await s.key({ key: "End" });
    expect(document.activeElement).toBe(slots()[slots().length - 1]);
    await s.key({ key: "Home" });
    expect(document.activeElement).toBe(slots()[0]);
    // Wraps backwards from the first.
    await s.key({ key: "ArrowUp" });
    expect(document.activeElement).toBe(slots()[slots().length - 1]);

    // The menu bar walks with Left/Right.
    const file = s.root.querySelector<HTMLElement>(
      '[data-menu-trigger="File"]',
    )!;
    await act(async () => file.focus());
    await s.key({ key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("data-menu-trigger")).toBe(
      "Edit",
    );
    await s.key({ key: "ArrowLeft" });
    expect(document.activeElement).toBe(file);
  });

  test("a dialog's focus scope moves focus in, keeps Tab inside, and gives focus back on close", async () => {
    const s = await mountShell();
    const opener = s.root.querySelector<HTMLElement>(
      '[data-menu-trigger="File"]',
    )!;
    await act(async () => opener.focus());
    await act(async () => openDialog(true));
    await s.settle();
    const dialog = document.querySelector<HTMLElement>("[data-test-dialog]")!;
    // In: the first focusable control.
    expect(document.activeElement).toBe(
      dialog.querySelector("[data-test-first]"),
    );
    // Tab from the last control lands on the end guard, which wraps.
    const end = dialog.querySelector<HTMLElement>('[data-focus-guard="end"]')!;
    await act(async () => end.focus());
    expect(document.activeElement).toBe(
      dialog.querySelector("[data-test-first]"),
    );
    // Shift+Tab from the first lands on the start guard, which wraps.
    const start = dialog.querySelector<HTMLElement>(
      '[data-focus-guard="start"]',
    )!;
    await act(async () => start.focus());
    expect(document.activeElement).toBe(
      dialog.querySelector("[data-test-last]"),
    );
    // The guards are the only way out by Tab, and both lead back in.
    expect(tabbableElements(dialog).at(0)).toBe(start);
    expect(tabbableElements(dialog).at(-1)).toBe(end);
    // Closed: focus is the opener's again.
    await act(async () => openDialog(false));
    await s.settle();
    expect(document.activeElement).toBe(opener);
  });
});

describe("the menu bar's toggles", () => {
  // Finding SH-4: a View toggle is a menuitemcheckbox whose aria-checked
  // follows its state (the e2e matrix asserts the shipped View items).
  test("SH-4: a toggle item renders as a menuitemcheckbox with its state", async () => {
    const s = await mountShell();
    let on = true;
    s.registries.commands.register({
      id: "test.view.toggle",
      title: "Snap",
      handler: () => {
        on = !on;
      },
    });
    s.registries.menus.register({
      path: "View/Snap to points",
      command: "test.view.toggle",
      checked: () => on,
    });
    await s.settle();
    const trigger = s.root.querySelector<HTMLElement>(
      '[data-menu-trigger="View"]',
    )!;
    const openView = async () => {
      await act(async () => trigger.focus());
      await s.key({ key: "Enter" }, trigger);
    };
    await openView();
    const item = () =>
      [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((el) =>
        el.textContent?.includes("Snap to points"),
      );
    expect(item()?.getAttribute("aria-checked")).toBe("true");
    await s.key({ key: "Escape" }, item() ?? document.body);
    on = false;
    await openView();
    expect(item()?.getAttribute("aria-checked")).toBe("false");
  });
});
