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

// The adaptive workspace on a mounted PagedShell (editor ADR "Docks are
// resizable and the workspace adapts"; UX audit F-55): the whole shell in
// happy-dom over the real engine, a stub canvas, a left panel and two dock
// panels. The cockpit's width is what decides its class, so the tests set
// it on the cockpit element itself (happy-dom lays nothing out): wide
// docks both columns, laptop collapses the left one to a rail and a
// flyout, narrow turns the right dock into a drawer; the dividers resize
// with the keyboard; the Focus workspace hides everything but the canvas
// and the tool rail and brings it all back.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import { CanvasClient } from "@paged-media/client";
import {
  FOCUS_WORKSPACE_COMMAND,
  PagedShell,
  useRegistries,
  type ModeContribution,
  type ShellRegistries,
} from "@paged-media/shell";
import { BUILT_IN_TOOLS } from "@paged-media/tools";
import { covers } from "@paged-media/test-kit";

import { EngineWorker, headlessEngine } from "../panels/engine-worker";

const LEFT = "test.left";
const RIGHT = "test.right";
const OTHER = "test.other";
const MODES: ModeContribution[] = [
  {
    id: "design",
    title: "Design",
    icon: "panel-canvas",
    order: 0,
    slots: { left: LEFT, tabs: [RIGHT] },
  },
  {
    // UX audit F-23 — a mode of stubs is not offered on the mode bar.
    id: "review",
    title: "Review",
    icon: "ui-comment",
    order: 10,
    placeholder: true,
    slots: { left: LEFT },
  },
  {
    id: "export",
    title: "Export",
    icon: "ui-export",
    order: 20,
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

/** happy-dom lays nothing out: the cockpit reports `width` px. */
function stubCockpitWidth(width: number): () => void {
  const proto = HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute("data-cockpit-layout")) {
      return {
        width,
        height: 800,
        top: 0,
        left: 0,
        right: width,
        bottom: 800,
        x: 0,
        y: 0,
        toJSON() {},
      } as DOMRect;
    }
    return original.call(this);
  };
  return () => {
    proto.getBoundingClientRect = original;
  };
}

let restoreWidth: (() => void) | null = null;
afterEach(() => {
  cleanup();
  restoreWidth?.();
  restoreWidth = null;
  // Each test starts from the cockpit's seed, not the tabs and widths the
  // last one left behind.
  localStorage.clear();
});

/** In the document and not inside a subtree an <Activity> hides. */
function shown(el: Element | null, root: Element): boolean {
  for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
    if ((n as HTMLElement).style?.display === "none") return false;
  }
  return el !== null;
}

async function mountShell(width: number) {
  restoreWidth = stubCockpitWidth(width);
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
          {
            id: RIGHT,
            title: "Right",
            component: () => <p data-test-right>right panel</p>,
          },
          {
            id: OTHER,
            title: "Other",
            component: () => <p data-test-other>other panel</p>,
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
  const q = (sel: string) => root.querySelector<HTMLElement>(sel);
  return {
    root,
    registries: r,
    q,
    settle,
    async invoke(id: string) {
      await act(async () => {
        await r.commands.invoke(id);
      });
      await settle();
    },
    async click(sel: string) {
      await act(async () => {
        fireEvent.click(q(sel)!);
      });
      await settle();
    },
    async pressCanvas() {
      await act(async () => {
        fireEvent.pointerDown(q("[data-test-canvas]")!);
      });
      await settle();
    },
    cls: () => q("[data-cockpit-layout]")?.getAttribute("data-workspace-class"),
    is: (sel: string) => shown(q(sel), root),
  };
}

describe("the workspace adapts to the width the cockpit is given (F-55)", () => {
  test("wide: both docks docked, no rail", async () => {
    const s = await mountShell(1500);
    expect(s.cls()).toBe("wide");
    expect(s.is("[data-test-left]")).toBe(true);
    expect(s.is("[data-test-right]")).toBe(true);
    expect(s.q("[data-dock-rail]")).toBeNull();
    expect(
      s.q("[data-left-panel]")!.getAttribute("data-dock-presentation"),
    ).toBe("docked");
  });

  test("laptop: the left dock is a rail whose button opens a flyout; a canvas press closes it; a pin docks it", async () => {
    const s = await mountShell(1200);
    expect(s.cls()).toBe("laptop");
    expect(s.is("[data-test-left]")).toBe(false);
    expect(s.is("[data-test-right]")).toBe(true);
    const panel = s.q("[data-test-left]");

    await s.click('[data-dock-rail-toggle="left"]');
    expect(s.is("[data-test-left]")).toBe(true);
    expect(
      s.q("[data-left-panel]")!.getAttribute("data-dock-presentation"),
    ).toBe("flyout");
    // The same panel, not a new one (ADR 240).
    expect(s.q("[data-test-left]")).toBe(panel);

    await s.pressCanvas();
    expect(s.is("[data-test-left]")).toBe(false);

    await s.click('[data-dock-pin="left"]');
    expect(s.is("[data-test-left]")).toBe(true);
    expect(
      s.q("[data-left-panel]")!.getAttribute("data-dock-presentation"),
    ).toBe("docked");
    // Docked, a canvas press leaves it.
    await s.pressCanvas();
    expect(s.is("[data-test-left]")).toBe(true);
  });

  test("narrow: the right dock is a drawer a newly opened panel opens and a canvas press closes", async () => {
    const s = await mountShell(800);
    expect(s.cls()).toBe("narrow");
    expect(s.is("[data-test-right]")).toBe(false);
    expect(s.is("[data-test-left]")).toBe(false);

    await s.invoke(`paged.panel.show.${OTHER}`);
    expect(s.is("[data-test-other]")).toBe(true);
    expect(
      s.q("[data-right-column]")!.getAttribute("data-dock-presentation"),
    ).toBe("drawer");

    await s.pressCanvas();
    expect(s.is("[data-test-other]")).toBe(false);
    // The canvas never left.
    expect(s.is("[data-test-canvas]")).toBe(true);
  });
});

describe("the adaptive workspace's switch", () => {
  test("off, the cockpit keeps both docks docked at a laptop width; on again, it adapts; the choice is remembered", async () => {
    covers(
      "command:paged.view.adaptiveWorkspace",
      "setting:paged.adaptiveWorkspace",
    );
    const s = await mountShell(1200);
    expect(s.cls()).toBe("laptop");
    await s.invoke("paged.view.adaptiveWorkspace");
    expect(s.cls()).toBe("wide");
    expect(s.is("[data-test-left]")).toBe(true);
    expect(s.q("[data-dock-rail]")).toBeNull();
    expect(localStorage.getItem("paged.adaptiveWorkspace")).toBe("off");
    await s.invoke("paged.view.adaptiveWorkspace");
    expect(s.cls()).toBe("laptop");
    expect(localStorage.getItem("paged.adaptiveWorkspace")).toBe("on");
  });

  test("a stored off is read on the next start", async () => {
    covers("setting:paged.adaptiveWorkspace");
    localStorage.setItem("paged.adaptiveWorkspace", "off");
    const s = await mountShell(900);
    expect(s.cls()).toBe("wide");
    expect(s.is("[data-test-right]")).toBe(true);
  });
});

describe("the dock dividers (DockSplitter)", () => {
  test("a separator with the dock's width as its value; the arrows move it, Enter and a double-click restore the default", async () => {
    const s = await mountShell(1500);
    const sep = () => s.q('[data-dock-splitter="right"]')!;
    const width = () => s.q("[data-right-column]")!.style.width;
    expect(sep().getAttribute("role")).toBe("separator");
    expect(sep().getAttribute("aria-orientation")).toBe("vertical");
    expect(sep().getAttribute("aria-valuenow")).toBe("320");
    expect(sep().getAttribute("aria-valuemin")).toBe("240");
    expect(width()).toBe("320px");

    // The right dock grows when its divider moves left.
    await act(async () => {
      fireEvent.keyDown(sep(), { key: "ArrowLeft" });
    });
    await s.settle();
    expect(sep().getAttribute("aria-valuenow")).toBe("328");
    expect(width()).toBe("328px");
    await act(async () => {
      fireEvent.keyDown(sep(), { key: "End" });
    });
    await s.settle();
    expect(Number(sep().getAttribute("aria-valuenow"))).toBe(
      Number(sep().getAttribute("aria-valuemax")),
    );
    await act(async () => {
      fireEvent.keyDown(sep(), { key: "Enter" });
    });
    await s.settle();
    expect(width()).toBe("320px");
    await act(async () => {
      fireEvent.keyDown(sep(), { key: "Home" });
    });
    await s.settle();
    expect(width()).toBe("240px");
    await act(async () => {
      fireEvent.doubleClick(sep());
    });
    await s.settle();
    expect(width()).toBe("320px");
    // The left dock's divider: it grows to the right.
    const left = s.q('[data-dock-splitter="left"]')!;
    await act(async () => {
      fireEvent.keyDown(left, { key: "ArrowRight", shiftKey: true });
    });
    await s.settle();
    expect(s.q("[data-left-panel]")!.style.width).toBe("302px");
  });
});

describe("the Focus workspace", () => {
  test("hides everything but the canvas and the tool rail, and the same command brings the layout back", async () => {
    covers("command:paged.view.focusWorkspace");
    const s = await mountShell(1500);
    const chrome = () => ({
      header: s.is("header"),
      toolRail: s.is("[data-tool-rail]"),
      left: s.is("[data-test-left]"),
      right: s.is("[data-test-right]"),
      modeBar: s.is("[data-mode-switcher]"),
      canvas: s.is("[data-test-canvas]"),
      exit: s.is("[data-focus-exit]"),
    });
    const before = chrome();
    expect(before).toEqual({
      header: true,
      toolRail: true,
      left: true,
      right: true,
      modeBar: true,
      canvas: true,
      exit: false,
    });
    const left = s.q("[data-test-left]");
    await s.invoke(FOCUS_WORKSPACE_COMMAND);
    expect(chrome()).toEqual({
      header: false,
      toolRail: true,
      left: false,
      right: false,
      modeBar: false,
      canvas: true,
      exit: true,
    });
    await s.invoke(FOCUS_WORKSPACE_COMMAND);
    expect(chrome()).toEqual(before);
    // Kept while hidden, not mounted again (ADR 240).
    expect(s.q("[data-test-left]")).toBe(left);

    // A layout the Tab toggles changed comes back as it was: Focus is a
    // flag over the layout, not a change to it.
    await s.invoke("paged.chrome.togglePanels");
    await s.invoke(FOCUS_WORKSPACE_COMMAND);
    await s.click("[data-focus-exit]");
    expect(chrome()).toEqual({ ...before, left: false, right: false });
  });

  test("Cmd+. and Ctrl+. are its chord; the context toolbar's Focus pill runs it", async () => {
    covers(
      "keybinding:cmd+.→paged.view.focusWorkspace",
      "keybinding:ctrl+.→paged.view.focusWorkspace",
    );
    const s = await mountShell(1500);
    const bound = s.registries.keybindings
      .list()
      .filter((b) => b.command === FOCUS_WORKSPACE_COMMAND)
      .map((b) => b.key)
      .sort();
    expect(bound).toEqual(["cmd+.", "ctrl+."]);
    await s.click('[data-view-pill="ui-expand"]');
    expect(s.is("[data-focus-exit]")).toBe(true);
    expect(s.is("header")).toBe(false);
  });
});

describe("the mode bar (F-23)", () => {
  test("a placeholder mode is not offered beside the working modes", async () => {
    const s = await mountShell(1500);
    expect(s.q('[data-mode-option="design"]')).not.toBeNull();
    expect(s.q('[data-mode-option="export"]')).not.toBeNull();
    expect(s.q('[data-mode-option="review"]')).toBeNull();
  });
});
