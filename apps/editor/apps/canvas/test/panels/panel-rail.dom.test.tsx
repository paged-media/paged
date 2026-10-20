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

// The panel rail always brings its panel into view (editor ADR 271).
// Filming the home film, the rail's Swatches button "did nothing": the
// button switched the tab of a dock the user could not see, and with that
// panel already active it closed it.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";

import { CockpitPanelHeader, PanelRail, RightDock } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const Titled = (title: string) =>
  function Panel() {
    return <CockpitPanelHeader title={title} />;
  };

const IDS = [
  ["paged.properties", "Properties"],
  ["paged.swatches", "Swatches"],
  ["paged.layers", "Layers"],
  ["t.d", "Delta"],
  ["t.e", "Epsilon"],
  ["t.f", "Zeta"],
  ["t.g", "Eta"],
  ["t.h", "Theta"],
] as const;

/** The dock beside the rail, with the shell's hidden-panels state. */
function Cockpit({ startHidden }: { startHidden: boolean }) {
  const [hidden, setHidden] = useState(startHidden);
  return (
    <div>
      <button type="button" data-test-hide onClick={() => setHidden(true)}>
        Hide
      </button>
      <div data-test-dock hidden={hidden}>
        <RightDock />
      </div>
      <PanelRail
        items={[
          {
            panelId: "paged.swatches",
            title: "Swatches",
            icon: "panel-swatches",
          },
          { panelId: "paged.layers", title: "Layers", icon: "panel-layers" },
        ]}
        panelsHidden={hidden}
        onRevealPanels={() => setHidden(false)}
      />
    </div>
  );
}

const mount = (startHidden = false) =>
  mountPanel(() => <Cockpit startHidden={startHidden} />, {
    id: "test.rail",
    registries: (r) => {
      for (const [id, title] of IDS)
        r.panels.register({ id, title, component: Titled(title) });
      r.modes.register({
        id: "design",
        title: "Design",
        icon: "x",
        order: 1,
        slots: { left: "paged.properties", tabs: IDS.map(([id]) => id) },
      });
    },
  });

const active = (h: PanelHarness<unknown>) =>
  h.root.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    ?.dataset.dockTab ?? null;
const dockHidden = (h: PanelHarness<unknown>) =>
  h.root.querySelector<HTMLElement>("[data-test-dock]")!.hidden;
const press = async (h: PanelHarness<unknown>, id: string) => {
  const b = h.root.querySelector<HTMLElement>(
    `[data-panel-rail-item="${id}"]`,
  )!;
  await h.act(() => {
    fireEvent.click(b);
  });
};

describe("the panel rail (ADR 271)", () => {
  test("with many tabs open, a rail button makes its panel the active, visible one", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    expect(active(h)).toBe("paged.properties");
    await press(h, "paged.swatches");
    expect(active(h)).toBe("paged.swatches");
    const panel = h.root.querySelector<HTMLElement>(
      '[data-dock-panel="paged.swatches"]',
    );
    expect(panel?.textContent).toContain("Swatches");
    // Pressed again while visible, it closes, as before.
    await press(h, "paged.swatches");
    expect(active(h)).not.toBe("paged.swatches");
  });

  test("with the panels hidden, a rail button shows them again with its panel active", async () => {
    covers("panel:paged.swatches");
    const h = await mount(true);
    expect(dockHidden(h)).toBe(true);
    await press(h, "paged.swatches");
    expect(dockHidden(h)).toBe(false);
    expect(active(h)).toBe("paged.swatches");
  });

  test("with the panels hidden and its panel already active, the button shows it instead of closing it", async () => {
    covers("panel:paged.swatches");
    const h = await mount();
    await press(h, "paged.swatches");
    expect(active(h)).toBe("paged.swatches");
    // Shift+Tab: the dock hides, the rail stays.
    await h.act(() => {
      fireEvent.click(h.root.querySelector("[data-test-hide]")!);
    });
    expect(dockHidden(h)).toBe(true);
    await press(h, "paged.swatches");
    expect(dockHidden(h)).toBe(false);
    expect(active(h)).toBe("paged.swatches");
  });
});
