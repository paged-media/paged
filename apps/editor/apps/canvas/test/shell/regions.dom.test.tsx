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
        panelRail={[{ id: RIGHT, icon: "panel-layers", label: "Right" }]}
        canvasComponent={() => <div data-test-canvas />}
        regions={resolved?.regions}
        canvasFurniture={resolved?.canvas}
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
