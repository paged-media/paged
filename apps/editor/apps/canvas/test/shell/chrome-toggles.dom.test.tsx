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

// The two chrome toggles PagedShell registers over its own state (Tab,
// Shift+Tab): the whole PagedShell mounted in happy-dom over the real
// engine, with a stub canvas, one mode whose left slot holds a panel, and
// the built-in tools on the rail. The commands run through the shell's
// registry; what they change is which chrome is mounted.

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
];

function Capture({ onRegistries }: { onRegistries(r: ShellRegistries): void }) {
  const registries = useRegistries();
  useEffect(() => {
    onRegistries(registries);
  }, [registries, onRegistries]);
  return null;
}

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
            component: () => <p data-test-left>left panel</p>,
          },
        ]}
        tools={BUILT_IN_TOOLS}
        modes={MODES}
        initialMode="design"
        canvasComponent={() => <div data-test-canvas />}
      >
        <Capture onRegistries={(r) => (registries = r)} />
      </PagedShell>,
    );
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  await settle();
  if (!registries) throw new Error("PagedShell did not publish registries");
  const r: ShellRegistries = registries;
  const root = view.container;
  return {
    root,
    async invoke(id: string) {
      await act(async () => {
        await r.commands.invoke(id);
      });
      await settle();
    },
    chrome(): { rail: boolean; left: boolean; canvas: boolean } {
      return {
        rail: root.querySelector("[data-tool-rail]") !== null,
        left: root.querySelector(`[data-left-panel="${LEFT}"]`) !== null,
        canvas: root.querySelector("[data-test-canvas]") !== null,
      };
    },
  };
}

describe("the chrome toggles, on a mounted PagedShell", () => {
  test("toggleAll hides the panels and the tool rail, and the second run brings both back", async () => {
    covers("command:paged.chrome.toggleAll");
    const s = await mountShell();
    expect(s.chrome()).toEqual({ rail: true, left: true, canvas: true });
    await s.invoke("paged.chrome.toggleAll");
    expect(s.chrome()).toEqual({ rail: false, left: false, canvas: true });
    await s.invoke("paged.chrome.toggleAll");
    expect(s.chrome()).toEqual({ rail: true, left: true, canvas: true });
  });

  test("togglePanels hides the panels and keeps the tool rail", async () => {
    covers("command:paged.chrome.togglePanels");
    const s = await mountShell();
    await s.invoke("paged.chrome.togglePanels");
    expect(s.chrome()).toEqual({ rail: true, left: false, canvas: true });
    await s.invoke("paged.chrome.togglePanels");
    expect(s.chrome()).toEqual({ rail: true, left: true, canvas: true });
  });

  test("toggleAll after togglePanels shows everything: one hidden half counts as hidden", async () => {
    covers(
      "command:paged.chrome.toggleAll",
      "command:paged.chrome.togglePanels",
    );
    const s = await mountShell();
    await s.invoke("paged.chrome.togglePanels");
    expect(s.chrome()).toEqual({ rail: true, left: false, canvas: true });
    await s.invoke("paged.chrome.toggleAll");
    expect(s.chrome()).toEqual({ rail: true, left: true, canvas: true });
    await s.invoke("paged.chrome.toggleAll");
    expect(s.chrome()).toEqual({ rail: false, left: false, canvas: true });
  });
});
