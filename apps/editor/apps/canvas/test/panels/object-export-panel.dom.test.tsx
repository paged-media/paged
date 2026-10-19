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

// Object Export Options (paged.object-export): a CONCEPT panel. The tab
// switcher is live local state; every field is a seam, rendered disabled,
// and nothing reaches the engine in any state.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ObjectExportPanel } from "../../src/panels/concept/object-export-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = () =>
  mountPanel(ObjectExportPanel, {
    id: "paged.object-export",
    scene: richScene,
  });

const tab = (h: PanelHarness<unknown>, name: string) =>
  h.view.getByRole("tab", { name });

/** Every form control in the panel body except the tabs. */
const fields = (h: PanelHarness<unknown>) => [
  ...h.root.querySelectorAll<HTMLInputElement>(
    "select, textarea, input, [role=switch]",
  ),
];

describe("Object Export Options", () => {
  test("says it is a concept; Alt Text is the open tab", async () => {
    covers("panel:paged.object-export");
    const h = await mount();
    expect(h.root.querySelector("[data-object-export-panel]")).not.toBe(null);
    expect(h.root.textContent).toContain("Concept");
    expect(tab(h, "Alt Text").getAttribute("aria-selected")).toBe("true");
    expect(tab(h, "Tagged PDF").getAttribute("aria-selected")).toBe("false");
  });

  for (const name of ["Alt Text", "Tagged PDF", "EPUB & HTML"]) {
    test(`${name}: every field is a disabled seam`, async () => {
      covers("panel:paged.object-export");
      const h = await mount();
      await h.select([h.scene.rect]);
      await h.click(tab(h, name));
      expect(tab(h, name).getAttribute("aria-selected")).toBe("true");
      const all = fields(h);
      expect(all.length).toBeGreaterThan(0);
      for (const el of all) {
        expect(el.hasAttribute("data-seam")).toBe(true);
        expect((el as HTMLInputElement).disabled).toBe(true);
      }
    });
  }

  test("switching tabs and touching the seams sends nothing", async () => {
    covers("panel:paged.object-export");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    for (const name of ["Tagged PDF", "EPUB & HTML", "Alt Text"]) {
      await h.click(tab(h, name));
      for (const el of fields(h)) await h.click(el);
    }
    expect(h.mutations(from)).toEqual([]);
  });
});
