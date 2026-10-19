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

// The data suite's built-in seams (paged.data-source "Data suite
// (preview)", paged.data-grid "Generated pages"): developer-only panels
// kept as honest stubs beside the live paged.data plugin panels. Asserted:
// they say what is missing, the one control on them (the Source section's
// fold) does what it shows, and they send nothing to the engine.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  DataGridPanel,
  DataSourcePanel,
} from "../../src/panels/cockpit/data-views";
import { BUILT_IN_PANELS } from "../../src/panels/built-in-panels";
import { mountPanel, unmountAll } from "./harness";
import { comingSoonTitles, enabledControls } from "./support/cockpit";

afterEach(unmountAll);

describe("Data suite (preview) panel", () => {
  test("is a developer surface, titled so it is not mistaken for the live data panels", async () => {
    covers("panel:paged.data-source");
    const entry = BUILT_IN_PANELS.find((p) => p.id === "paged.data-source")!;
    expect(entry.devOnly).toBe(true);
    expect(entry.title).toBe("Data suite (preview)");
    const h = await mountPanel(DataSourcePanel, { id: "paged.data-source" });
    expect(h.root.textContent).toContain("Data suite (preview)");
  });

  test("the source reads not connected and the records are coming soon", async () => {
    covers("panel:paged.data-source");
    const h = await mountPanel(DataSourcePanel, { id: "paged.data-source" });
    expect(h.root.querySelector("[data-tone]")?.textContent).toBe(
      "not connected",
    );
    expect(comingSoonTitles(h.root)).toEqual(["Records & fields coming soon"]);
  });

  test("its only control folds the Source section, and nothing reaches the engine", async () => {
    covers("panel:paged.data-source");
    const h = await mountPanel(DataSourcePanel, { id: "paged.data-source" });
    const controls = enabledControls(h.root);
    expect(controls.map((c) => c.textContent?.startsWith("Source"))).toEqual([
      true,
    ]);
    const blurb = "Connect a structured source (PIM, CSV, API).";
    expect(h.root.textContent).toContain(blurb);
    const from = h.mark();
    await h.click(controls[0]);
    expect(h.root.textContent).not.toContain(blurb);
    await h.click(controls[0]);
    expect(h.root.textContent).toContain(blurb);
    expect(h.sent(undefined, from)).toEqual([]);
  });

  test("no document: the same seam", async () => {
    covers("panel:paged.data-source");
    const h = await mountPanel(DataSourcePanel, {
      id: "paged.data-source",
      document: "none",
    });
    expect(comingSoonTitles(h.root)).toEqual(["Records & fields coming soon"]);
  });
});

describe("Generated pages panel", () => {
  test("is a developer surface with one honest card and no control", async () => {
    covers("panel:paged.data-grid");
    const entry = BUILT_IN_PANELS.find((p) => p.id === "paged.data-grid")!;
    expect(entry.devOnly).toBe(true);
    for (const document of ["none", "blank"] as const) {
      const h = await mountPanel(DataGridPanel, {
        id: "paged.data-grid",
        document,
      });
      expect(comingSoonTitles(h.root)).toEqual([
        "Generated layout preview coming soon",
      ]);
      expect(enabledControls(h.root)).toEqual([]);
      expect(h.mutations()).toEqual([]);
      h.unmount();
    }
  });
});
