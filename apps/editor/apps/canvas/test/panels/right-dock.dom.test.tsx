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

// The right dock's tab strip is an ARIA tablist and a panel's title is a
// heading (UX audit F-50, ADR 259).

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { CockpitPanelHeader, RightDock } from "@paged-media/shell";

import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const Titled = (title: string) =>
  function Panel() {
    return <CockpitPanelHeader title={title} />;
  };

const mount = () =>
  mountPanel(() => <RightDock />, {
    id: "test.dock",
    registries: (r) => {
      for (const [id, title] of [
        ["t.a", "Alpha"],
        ["t.b", "Beta"],
        ["t.c", "Gamma"],
      ] as const)
        r.panels.register({ id, title, component: Titled(title) });
      r.modes.register({
        id: "design",
        title: "Design",
        icon: "x",
        order: 1,
        slots: { tabs: ["t.a", "t.b", "t.c"] },
      });
    },
  });

const tabs = (h: PanelHarness<unknown>) => [
  ...h.root.querySelectorAll<HTMLElement>('[role="tab"]'),
];
const selected = (h: PanelHarness<unknown>) =>
  tabs(h)
    .filter((t) => t.getAttribute("aria-selected") === "true")
    .map((t) => t.dataset.dockTab);
const key = async (h: PanelHarness<unknown>, k: string) => {
  const strip = h.root.querySelector('[role="tablist"]')!;
  await h.act(() => {
    fireEvent.keyDown(strip, { key: k });
  });
};

describe("the right dock (F-50)", () => {
  test("the strip is a tablist; one tab is selected and is the one tab stop; titles are headings", async () => {
    const h = await mount();
    expect(h.root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs(h).map((t) => t.dataset.dockTab)).toEqual([
      "t.a",
      "t.b",
      "t.c",
    ]);
    expect(selected(h)).toEqual(["t.a"]);
    expect(tabs(h).map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    const first = tabs(h)[0]!;
    const panel = h.root.ownerDocument.getElementById(
      first.getAttribute("aria-controls")!,
    );
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(first.id);
    expect(panel?.querySelector("h2")?.textContent).toBe("Alpha");
  });

  test("the arrows, Home and End move to a tab and open it; Delete closes it", async () => {
    const h = await mount();
    await key(h, "ArrowRight");
    expect(selected(h)).toEqual(["t.b"]);
    await key(h, "End");
    expect(selected(h)).toEqual(["t.c"]);
    await key(h, "ArrowRight");
    expect(selected(h)).toEqual(["t.a"]);
    await key(h, "ArrowLeft");
    expect(selected(h)).toEqual(["t.c"]);
    await key(h, "Home");
    expect(selected(h)).toEqual(["t.a"]);
    await key(h, "Delete");
    expect(tabs(h).map((t) => t.dataset.dockTab)).toEqual(["t.b", "t.c"]);
  });
});
