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

// Features in the mounted shell (docs/composable-editor-plan.md, B2): a
// feature switched off disappears from every surface that offered it, at
// once and without a reload, and comes back when switched on. A profile's
// switches are set before the first paint.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { CanvasClient } from "@paged-media/client";
import {
  PagedShell,
  useRegistries,
  type ModeContribution,
  type ShellRegistries,
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
];

function Capture({ onRegistries }: { onRegistries(r: ShellRegistries): void }) {
  const registries = useRegistries();
  useEffect(() => {
    onRegistries(registries);
    const disposables = [
      registries.commands.register({
        id: "test.go",
        title: "Go",
        handler: () => {},
      }),
      registries.menus.register({ path: "Test/Go", command: "test.go" }),
      registries.menus.register({ path: "Test/Again", command: "test.go" }),
    ];
    return () => disposables.forEach((d) => d.dispose());
  }, [registries, onRegistries]);
  return null;
}

afterEach(() => cleanup());

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(features?: Record<string, boolean>) {
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
          { id: LEFT, title: "Left", component: () => <p data-test-left /> },
          { id: RIGHT, title: "Right", component: () => <p data-test-right /> },
        ]}
        tools={BUILT_IN_TOOLS}
        modes={MODES}
        initialMode="design"
        panelRail={[{ panelId: RIGHT, icon: "panel-layers", title: "Right" }]}
        canvasComponent={() => <div data-test-canvas />}
        features={features}
      >
        <Capture onRegistries={(r) => (registries = r)} />
      </PagedShell>,
    );
  });
  await settle();
  if (!registries) throw new Error("no registries");
  const r: ShellRegistries = registries;
  const root = view.container;
  return {
    root,
    has: (selector: string) => root.querySelector(selector) !== null,
    async set(id: string, on: boolean) {
      await act(async () => {
        r.features.set(id as never, on);
      });
      await settle();
    },
  };
}

describe("features in the shell", () => {
  test("a command switched off leaves the menu bar; on, it is back", async () => {
    const s = await mount();
    expect(s.has('[data-menu-trigger="Test"]')).toBe(true);
    await s.set("command:test.go", false);
    expect(s.has('[data-menu-trigger="Test"]')).toBe(false);
    await s.set("command:test.go", true);
    expect(s.has('[data-menu-trigger="Test"]')).toBe(true);
  });

  test("a menu path glob removes the menu's entries", async () => {
    const s = await mount();
    await s.set("menu:Test/*", false);
    expect(s.has('[data-menu-trigger="Test"]')).toBe(false);
  });

  test("a tool switched off leaves the rail", async () => {
    const s = await mount();
    expect(s.has('[data-tool-slot][data-tool="paged.tool.hand"]')).toBe(true);
    await s.set("tool:paged.tool.hand", false);
    expect(s.has('[data-tool="paged.tool.hand"]')).toBe(false);
  });

  test("a panel switched off leaves its rail launcher and its dock tab", async () => {
    const s = await mount();
    expect(s.has("[data-panel-rail]")).toBe(true);
    expect(s.has("[data-test-right]")).toBe(true);
    await s.set(`panel:${RIGHT}`, false);
    expect(s.has("[data-panel-rail]")).toBe(false);
    expect(s.has("[data-test-right]")).toBe(false);
    expect(s.has("[data-test-left]")).toBe(true);
  });

  test("canvas furniture follows chrome features", async () => {
    const s = await mount();
    await s.set("chrome:rulers", false);
    expect(s.has("[data-h-ruler]")).toBe(false);
    expect(s.has("[data-v-ruler]")).toBe(false);
    expect(s.has("[data-doc-title-bar]")).toBe(true);
  });

  test("a profile's switches hold from the first paint", async () => {
    const s = await mount({
      "chrome:thumbnails": false,
      "command:test.*": false,
    });
    expect(s.has("[data-thumbnail-rail]")).toBe(false);
    expect(s.has('[data-menu-trigger="Test"]')).toBe(false);
  });
});
