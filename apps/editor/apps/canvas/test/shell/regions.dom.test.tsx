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

// The chrome regions of an editor profile (docs/composable-editor.md §5.2,
// plan task A2): the whole PagedShell mounted in happy-dom over the real
// engine. Without a profile every region is there, as it always was; a
// region the profile removes renders nothing and reserves no space; a
// profile that keeps only the canvas leaves the document alone on screen.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { CanvasClient } from "@paged-media/client";
import {
  PagedShell,
  resolveProfile,
  type EditorProfile,
  type ModeContribution,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";

import { EngineWorker, headlessEngine } from "../panels/engine-worker";

const LEFT = "test.left";
const RIGHT = "test.right";
const MODES: ModeContribution[] = [
  {
    id: "design",
    title: "Design",
    icon: "mode-design",
    order: 0,
    slots: { left: LEFT, tabs: [RIGHT] },
  },
  {
    id: "content",
    title: "Content",
    icon: "mode-content",
    order: 1,
    slots: { left: LEFT },
  },
];

afterEach(() => cleanup());

async function mount(profile?: EditorProfile) {
  const { worker } = await headlessEngine();
  const engine = new EngineWorker(worker);
  const client = new CanvasClient({
    workerFactory: () => engine as unknown as Worker,
  });
  await client.newBlankDocument(612, 792);
  const resolved = profile ? resolveProfile(profile, {}).profile : undefined;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <PagedShell
        client={client}
        panels={[
          { id: LEFT, title: "Left", component: () => <p data-test-left /> },
          { id: RIGHT, title: "Right", component: () => <p data-test-right /> },
        ]}
        tools={BUILT_IN_TOOLS}
        modes={MODES}
        initialMode="design"
        panelRail={[{ panelId: RIGHT, icon: "panel-layers", title: "Right" }]}
        canvasComponent={() => <div data-test-canvas />}
        regions={resolved?.regions}
        canvasFurniture={resolved?.canvas}
        compactLayout={resolved?.compact ?? null}
      />,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  const root = view.container;
  return {
    root,
    has: (selector: string) => root.querySelector(selector) !== null,
  };
}

const CHROME = {
  header: "header",
  menubar: '[role="menubar"]',
  trigger: "[data-command-trigger]",
  contextToolbar: "[data-context-toolbar]",
  toolRail: "[data-tool-rail]",
  panelRail: "[data-panel-rail]",
  modeSwitcher: "[data-mode-switcher]",
  titleBar: "[data-doc-title-bar]",
  hRuler: "[data-h-ruler]",
  vRuler: "[data-v-ruler]",
  thumbnails: "[data-thumbnail-rail]",
  left: '[aria-label="Left panels"]',
  right: '[aria-label="Panels"]',
} as const;

describe("chrome regions", () => {
  test("without a profile every region is there", async () => {
    const shell = await mount();
    for (const [name, selector] of Object.entries(CHROME)) {
      expect({ name, present: shell.has(selector) }).toEqual({
        name,
        present: true,
      });
    }
    expect(shell.has("[data-test-canvas]")).toBe(true);
  });

  test("the full profile is the same editor", async () => {
    const shell = await mount({});
    for (const [name, selector] of Object.entries(CHROME)) {
      expect({ name, present: shell.has(selector) }).toEqual({
        name,
        present: true,
      });
    }
  });

  test("a profile that keeps only the canvas shows the document alone", async () => {
    const shell = await mount({
      regions: {
        header: null,
        menubar: null,
        "context-toolbar": null,
        "tool-rail": null,
        left: null,
        right: null,
        "panel-rail": null,
        "mode-bar": null,
        palette: null,
      },
      canvas: { titleBar: false, rulers: false, thumbnails: false },
    });
    for (const [name, selector] of Object.entries(CHROME)) {
      expect({ name, present: shell.has(selector) }).toEqual({
        name,
        present: false,
      });
    }
    expect(shell.has("[data-test-canvas]")).toBe(true);
    expect(shell.has("[data-paged-viewport]")).toBe(true);
  });

  test("the header stays without its menu bar or search", async () => {
    const shell = await mount({ regions: { menubar: null, palette: null } });
    expect(shell.has(CHROME.header)).toBe(true);
    expect(shell.has(CHROME.menubar)).toBe(false);
    expect(shell.has(CHROME.trigger)).toBe(false);
    expect(shell.has(CHROME.toolRail)).toBe(true);
  });
});

describe("region contents (A3)", () => {
  const triggers = (root: Element) =>
    [...root.querySelectorAll("[data-menu-trigger]")].map((el) =>
      el.getAttribute("data-menu-trigger"),
    );
  const railTools = (root: Element) =>
    [...root.querySelectorAll("[data-tool-slot]")].map((el) =>
      el.getAttribute("data-tool"),
    );

  test("a menu bar list keeps the menus it names, in its order", async () => {
    const shell = await mount({
      regions: { menubar: { items: ["Help", "File"] } },
    });
    expect(triggers(shell.root)).toEqual(["Help", "File"]);
  });

  test("removing a menu from the whole bar keeps the others", async () => {
    const all = triggers((await mount()).root);
    cleanup();
    const shell = await mount({
      adjust: [{ region: "menubar", op: "remove", match: "Help" }],
    });
    expect(triggers(shell.root)).toEqual(all.filter((l) => l !== "Help"));
  });

  test("a tool rail list keeps only the tools it names", async () => {
    const shell = await mount({
      regions: {
        "tool-rail": { items: ["paged.tool.select", "paged.tool.hand"] },
      },
    });
    const shown = railTools(shell.root);
    expect(shown).toContain("paged.tool.select");
    expect(shown).toContain("paged.tool.hand");
    expect(
      shown.filter(
        (id) => id !== "paged.tool.select" && id !== "paged.tool.hand",
      ),
    ).toEqual([]);
  });

  test("a panel rail list drops what it does not name", async () => {
    const shell = await mount({
      regions: { "panel-rail": { items: ["nothing.here"] } },
    });
    expect(shell.has(CHROME.panelRail)).toBe(false);
  });

  test("a header list replaces the right-hand cluster with commands", async () => {
    const shell = await mount({
      regions: {
        header: { items: ["paged.file.exportPdf", "no.such.command"] },
      },
    });
    const buttons = [
      ...shell.root.querySelectorAll("header [data-region-command]"),
    ];
    expect(buttons.map((b) => b.getAttribute("data-region-command"))).toEqual([
      "paged.file.exportPdf",
    ]);
    expect(buttons[0]!.textContent).toBeTruthy();
  });

  test("the actions bar exists only when a profile gives it items", async () => {
    expect((await mount()).has("[data-actions-bar]")).toBe(false);
    cleanup();
    const shell = await mount({
      regions: {
        "actions-bar": {
          items: [
            { kind: "host", id: "price" },
            { kind: "spacer" },
            "paged.file.exportPdf",
          ],
        },
      },
    });
    expect(shell.has("[data-actions-bar]")).toBe(true);
    expect(shell.has('[data-actions-bar] [data-host-component="price"]')).toBe(
      true,
    );
    expect(
      shell.has(
        '[data-actions-bar] [data-region-command="paged.file.exportPdf"]',
      ),
    ).toBe(true);
  });
});

describe("a fill shape on a phone (editor ADR 293)", () => {
  const FILL: EditorProfile = {
    regions: {
      header: { items: ["paged.editor.undo", "paged.editor.redo"] },
      menubar: null,
      "context-toolbar": null,
      "tool-rail": { items: ["paged.tool.select", "paged.tool.hand"] },
      right: null,
      "panel-rail": null,
      "mode-bar": null,
      palette: null,
      form: { items: [RIGHT] },
    },
    canvas: { titleBar: false, rulers: false, thumbnails: false },
    compact: "field-sheet",
  };
  const realWidth = window.innerWidth;
  const setWidth = (px: number) =>
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: px,
    });
  afterEach(() => setWidth(realWidth));

  test("below 720 px the tool rail gives way and the form is a sheet", async () => {
    setWidth(390);
    const shell = await mount(FILL);
    expect(shell.has(CHROME.toolRail)).toBe(false);
    expect(shell.has("[data-header-compact]")).toBe(true);
    expect(shell.has("[data-field-sheet] [data-test-right]")).toBe(true);
    expect(shell.has("[data-touch-zoom]")).toBe(true);
    for (const button of shell.root.querySelectorAll<HTMLElement>(
      "[data-region-command]",
    ))
      expect(parseFloat(button.style.minHeight)).toBeGreaterThanOrEqual(44);
  });

  test("at 720 px and wider it is the desktop fill layout", async () => {
    setWidth(1024);
    const shell = await mount(FILL);
    expect(shell.has(CHROME.toolRail)).toBe(true);
    expect(shell.has("[data-header-compact]")).toBe(false);
    expect(shell.has("[data-field-sheet]")).toBe(false);
    expect(shell.has("[data-form-column] [data-test-right]")).toBe(true);
    expect(shell.has("[data-touch-zoom]")).toBe(false);
  });
});
