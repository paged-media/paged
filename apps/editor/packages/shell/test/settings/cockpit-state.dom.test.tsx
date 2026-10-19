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

// Setting `paged.cockpit.v1`, observed through its consumer: the cockpit's
// right-dock state (cockpit-state-context.tsx). A mode with nothing stored
// seeds its tabs from its registered slots; opening, raising and closing
// tabs is persisted per mode and read back by the next provider (a
// reload); a persisted blob is also a value from the past, so it has to
// survive being wrong.

import { act, cleanup, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { covers } from "@paged-media/test-kit";

import {
  CockpitStateProvider,
  useCockpitState,
} from "../../src/cockpit/cockpit-state-context";
import {
  RegistriesProvider,
  useRegistries,
} from "../../src/state/registries-context";
import {
  WorkflowModeProvider,
  useWorkflowMode,
} from "../../src/state/workflow-mode-context";

const KEY = "paged.cockpit.v1";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const Nothing = () => null;

function Providers({ children }: PropsWithChildren) {
  return (
    <RegistriesProvider getEditor={() => null}>
      <WorkflowModeProvider>
        <CockpitStateProvider>{children}</CockpitStateProvider>
      </WorkflowModeProvider>
    </RegistriesProvider>
  );
}

/** Mount the cockpit state with a design mode whose slots seed two tabs,
 *  a prepress mode with one inspector, and three registered panels. */
function mount() {
  const view = renderHook(
    () => ({
      cockpit: useCockpitState(),
      mode: useWorkflowMode(),
      registries: useRegistries(),
    }),
    { wrapper: Providers },
  );
  act(() => {
    const r = view.result.current.registries;
    for (const id of ["p.props", "p.swatches", "p.layers", "p.preflight"])
      r.panels.register({ id, title: id, component: Nothing });
    r.modes.register({
      id: "design",
      title: "Design",
      icon: "x",
      order: 1,
      slots: { left: "p.layers", tabs: ["p.props", "p.swatches"] },
    });
    r.modes.register({
      id: "prepress",
      title: "Prepress",
      icon: "x",
      order: 2,
      slots: { left: "p.layers", inspector: "p.preflight" },
    });
  });
  return view;
}

beforeEach(() => localStorage.clear());
afterEach(async () => {
  cleanup();
  await wait(350);
  localStorage.clear();
});

describe("setting paged.cockpit.v1 in the cockpit", () => {
  test("nothing stored: each mode seeds from its slots", () => {
    covers("setting:paged.cockpit.v1");
    const { result } = mount();
    expect(result.current.cockpit.rightTabs).toEqual(["p.props", "p.swatches"]);
    expect(result.current.cockpit.activeTab).toBe("p.props");
    act(() => result.current.mode.setMode("prepress"));
    expect(result.current.cockpit.rightTabs).toEqual(["p.preflight"]);
    expect(result.current.cockpit.activeTab).toBe("p.preflight");
  });

  test("open, raise and close persist per mode and survive a reload", async () => {
    covers("setting:paged.cockpit.v1");
    const first = mount();
    act(() => first.result.current.cockpit.openPanel("p.layers"));
    expect(first.result.current.cockpit.rightTabs).toEqual([
      "p.props",
      "p.swatches",
      "p.layers",
    ]);
    expect(first.result.current.cockpit.activeTab).toBe("p.layers");
    act(() => first.result.current.cockpit.closeTab("p.props"));
    act(() => first.result.current.cockpit.activateTab("p.swatches"));
    await wait(350);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({
      design: {
        rightTabs: ["p.swatches", "p.layers"],
        activeTab: "p.swatches",
      },
    });
    first.unmount();
    const second = mount();
    expect(second.result.current.cockpit.rightTabs).toEqual([
      "p.swatches",
      "p.layers",
    ]);
    expect(second.result.current.cockpit.activeTab).toBe("p.swatches");
  });

  test("an unregistered panel id never opens; a background open does not raise", () => {
    covers("setting:paged.cockpit.v1");
    const { result } = mount();
    act(() => result.current.cockpit.openPanel("p.never"));
    expect(result.current.cockpit.rightTabs).toEqual(["p.props", "p.swatches"]);
    act(() =>
      result.current.cockpit.openPanel("p.layers", { activate: false }),
    );
    expect(result.current.cockpit.rightTabs).toContain("p.layers");
    expect(result.current.cockpit.activeTab).toBe("p.props");
  });

  test("closing the active tab raises its left neighbour", () => {
    covers("setting:paged.cockpit.v1");
    const { result } = mount();
    act(() => result.current.cockpit.activateTab("p.swatches"));
    act(() => result.current.cockpit.closeTab("p.swatches"));
    expect(result.current.cockpit.activeTab).toBe("p.props");
    act(() => result.current.cockpit.closeTab("p.props"));
    expect(result.current.cockpit.rightTabs).toEqual([]);
    expect(result.current.cockpit.activeTab).toBeNull();
  });

  test("an unreadable blob falls back to the slot seed", () => {
    covers("setting:paged.cockpit.v1");
    localStorage.setItem(KEY, "{broken");
    const { result } = mount();
    expect(result.current.cockpit.rightTabs).toEqual(["p.props", "p.swatches"]);
  });

  // Finding SH-101: `loadCockpitStore` checks only that the blob is an
  // object; a mode entry of the wrong shape is handed to the cockpit as
  // is, so `rightTabs` becomes whatever was stored (a number here) and the
  // first `includes`/`map` over it throws — the right dock (and every
  // openPanel, the Window menu's panel commands) breaks on a stale or
  // hand-edited value instead of falling back to the mode's seed.
  test.failing(
    "SH-101: a mode entry of the wrong shape falls back to the slot seed",
    () => {
      covers("setting:paged.cockpit.v1");
      localStorage.setItem(
        KEY,
        JSON.stringify({ design: { rightTabs: 5, activeTab: 7 } }),
      );
      const { result } = mount();
      expect(result.current.cockpit.rightTabs).toEqual([
        "p.props",
        "p.swatches",
      ]);
      act(() => result.current.cockpit.openPanel("p.layers"));
      expect(result.current.cockpit.rightTabs).toContain("p.layers");
    },
  );
});
