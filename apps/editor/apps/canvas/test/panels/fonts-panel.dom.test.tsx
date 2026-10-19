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

// Fonts (paged.fonts): the families the document uses, each with its
// reference count, a resolution dot and a "missing" badge when the
// engine substituted it; filter tabs All / In use / Missing.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { covers } from "@paged-media/test-kit";

import { FontsPanel } from "../../src/panels/fonts-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { rows, structureIdml, STRUCTURE } from "./support/structure";

afterEach(unmountAll);

const INTER = join(import.meta.dir, "../../public/fonts/Inter.ttf");

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(FontsPanel, { id: "paged.fonts", document });

const tab = (root: Element, name: string) =>
  root.querySelector<HTMLButtonElement>(`[data-font-filter="${name}"]`)!;

async function registerInter(h: PanelHarness<unknown>): Promise<void> {
  const bytes = new Uint8Array(readFileSync(INTER));
  await h.act(() => h.client.registerFont("Inter", bytes));
}

describe("Fonts panel: states", () => {
  test("no document: the empty state, the tabs, All active", async () => {
    covers("panel:paged.fonts");
    const h = await mount("none");
    expect(h.root.querySelector("[data-empty-fonts]")?.textContent).toBe(
      "No fonts in use.",
    );
    expect(tab(h.root, "All").getAttribute("data-active")).toBe("true");
  });

  test("a missing family: its count, the substituted note, the badge, the Missing count", async () => {
    covers("panel:paged.fonts");
    const h = await mount();
    expect(rows(h.root)).toEqual([
      {
        key: STRUCTURE.font,
        primary: STRUCTURE.font,
        secondary: "1 ref · substituted",
        badge: "missing",
        selected: false,
      },
    ]);
    expect(
      tab(h.root, "Missing").querySelector("[data-missing-count]")?.textContent,
    ).toBe("1");
  });

  test("a resolved family: no badge, no Missing count", async () => {
    covers("panel:paged.fonts");
    const h = await mountPanel(FontsPanel, {
      id: "paged.fonts",
      document: structureIdml({ font: "Inter" }),
    });
    await registerInter(h);
    // The panel re-reads on the next document change (see PN-106).
    await h.mutate({
      op: "insertText",
      args: { storyId: STRUCTURE.story, offset: 0, text: "x" },
    } as never);
    expect(rows(h.root).map((r) => [r.primary, r.secondary, r.badge])).toEqual([
      ["Inter", "1 ref", null],
    ]);
    expect(h.root.querySelector("[data-missing-count]")).toBeNull();
  });
});

describe("Fonts panel: the filter tabs", () => {
  test("Missing shows only missing families, and says so when there are none", async () => {
    covers("panel:paged.fonts");
    const h = await mount();
    await h.click(tab(h.root, "Missing"));
    expect(tab(h.root, "Missing").getAttribute("data-active")).toBe("true");
    expect(tab(h.root, "All").getAttribute("data-active")).toBe("false");
    expect(rows(h.root).map((r) => r.primary)).toEqual([STRUCTURE.font]);
  });

  test("Missing with every family resolved: the all-resolved note", async () => {
    covers("panel:paged.fonts");
    const h = await mountPanel(FontsPanel, {
      id: "paged.fonts",
      document: structureIdml({ font: "Inter" }),
    });
    await registerInter(h);
    await h.mutate({
      op: "insertText",
      args: { storyId: STRUCTURE.story, offset: 0, text: "x" },
    } as never);
    await h.click(tab(h.root, "Missing"));
    expect(
      h.root.querySelector("[data-fonts-missing-empty]")?.textContent,
    ).toBe("No missing fonts — every referenced family resolved.");
  });

  test("In use and All list the same families (the registry is the in-use set)", async () => {
    covers("panel:paged.fonts");
    const h = await mount();
    const all = rows(h.root).map((r) => r.primary);
    await h.click(tab(h.root, "In use"));
    expect(tab(h.root, "In use").getAttribute("data-active")).toBe("true");
    expect(rows(h.root).map((r) => r.primary)).toEqual(all);
  });

  test("the tabs filter in the panel only: nothing is sent to the engine", async () => {
    covers("panel:paged.fonts");
    const h = await mount();
    const from = h.mark();
    for (const name of ["Missing", "In use", "All"]) {
      await h.click(tab(h.root, name));
    }
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Fonts panel: findings", () => {
  // useCollection re-reads on mutation / undo / redo / script / load, not
  // on fontRegistered: a family the user just supplied still reads
  // "missing" until something else edits the document.
  test.failing(
    "PN-106: registering a missing family's font updates the list at once",
    async () => {
      covers("panel:paged.fonts");
      const h = await mountPanel(FontsPanel, {
        id: "paged.fonts",
        document: structureIdml({ font: "Inter" }),
      });
      expect(rows(h.root)[0].badge).toBe("missing");
      await registerInter(h);
      expect(rows(h.root)[0].badge).toBeNull();
    },
  );
});
