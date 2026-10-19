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

// Document Map (paged.document-map, Design mode's left panel): the
// spreads with their page ranges and per-page status chips, search, a
// click that fits the camera on the spread, the sections as chips with
// Add section, and the Publication Health footer.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { covers } from "@paged-media/test-kit";

import { DocumentMapPanel } from "../../src/panels/cockpit/document-map-panel";
import { fitCamera, layoutPages } from "../../src/ui/layout";
import { mountPanel, unmountAll } from "./harness";
import {
  cameraLandsOn,
  routeShellEvents,
  structureIdml,
  STRUCTURE,
  withViewport,
} from "./support/structure";

afterEach(unmountAll);

const mount = (document: "none" | "blank" | Uint8Array = structureIdml()) =>
  mountPanel(DocumentMapPanel, { id: "paged.document-map", document });

const spreads = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>("[data-document-map-spread]")].map(
    (r) => r.getAttribute("data-document-map-spread"),
  );
const spread = (root: Element, key: string) =>
  root.querySelector<HTMLElement>(`[data-document-map-spread="${key}"]`)!;
const chips = (root: Element) =>
  [...root.querySelectorAll("[data-page-chip]")].map((c) => [
    c.getAttribute("data-page-chip"),
    c.textContent,
  ]);
const footer = (root: Element) =>
  root.querySelector("[data-publication-health-footer]")!.textContent ?? "";
const search = (root: Element) =>
  root.querySelector<HTMLInputElement>("[data-document-map-search]")!;
const S1 = `${STRUCTURE.page1}-spread`;
const S2 = `${STRUCTURE.page2}-spread`;

describe("Document Map: states", () => {
  test("no document: says so, no Add section", async () => {
    covers("panel:paged.document-map");
    const h = await mount("none");
    expect(h.root.textContent).toContain("No document loaded.");
    expect(h.root.querySelector("[data-add-section]")).toBeNull();
    expect(spreads(h.root)).toEqual([]);
  });

  test("a document: one row per spread with its page range", async () => {
    covers("panel:paged.document-map");
    const h = await mount();
    expect(spreads(h.root)).toEqual([S1, S2]);
    expect(
      h.root.querySelector(`[data-spread-meta="${S1}"]`)?.textContent,
    ).toBe("1");
    expect(
      h.root.querySelector(`[data-spread-meta="${S2}"]`)?.textContent,
    ).toBe("2");
  });

  test("status chips: the missing link on its page, the missing font as a document-level seam on the first row", async () => {
    covers("panel:paged.document-map");
    const h = await mount();
    expect(chips(h.root)).toEqual([
      ["missing-links", "1 missing link"],
      ["fonts-seam", "fonts: doc-level"],
    ]);
    const missing = h.root.querySelector('[data-page-chip="missing-links"]')!;
    expect(missing.getAttribute("data-page-chip-spread")).toBe(S1);
  });

  test("an overset story adds the overset seam chip", async () => {
    covers("panel:paged.document-map");
    const h = await mount(structureIdml({ font: "Inter" }));
    const inter = new Uint8Array(
      readFileSync(join(import.meta.dir, "../../public/fonts/Inter.ttf")),
    );
    await h.act(() => h.client.registerFont("Inter", inter));
    await h.mutate({
      op: "insertText",
      args: { storyId: STRUCTURE.story, offset: 0, text: "word ".repeat(800) },
    } as never);
    expect(chips(h.root).map((c) => c[0])).toContain("overset-seam");
  });

  test("the health footer counts pages, stories, frames, links and the risks", async () => {
    covers("panel:paged.document-map");
    const h = await mount();
    const text = footer(h.root);
    for (const part of [
      "2Pages",
      "1Stories",
      "2Frames",
      "1Placed links",
      "1Missing links",
      "1Missing fonts",
      "0Overset stories",
    ])
      expect(text).toContain(part);
    expect(
      h.root
        .querySelector('[data-status-pill="map-x4-readiness"]')
        ?.getAttribute("data-tone"),
    ).toBe("warn");
  });

  test("follows the model: a page inserted is a second row", async () => {
    covers("panel:paged.document-map");
    const h = await mount("blank");
    routeShellEvents(h);
    expect(spreads(h.root)).toHaveLength(1);
    await h.mutate({
      op: "insertPage",
      args: { afterPageId: h.handle!.pageIds[0], masterId: null },
    } as never);
    expect(spreads(h.root)).toHaveLength(2);
  });
});

describe("Document Map: controls", () => {
  test("search filters the rows by name or range, and clearing it brings them back", async () => {
    covers("panel:paged.document-map");
    const h = await mount();
    await h.user.type(search(h.root), "2");
    expect(spreads(h.root)).toEqual([S2]);
    await h.user.clear(search(h.root));
    expect(spreads(h.root)).toEqual([S1, S2]);
    await h.user.type(search(h.root), "no such page");
    expect(spreads(h.root)).toEqual([]);
  });

  test("a row click selects the spread and fits the camera on its first page", async () => {
    covers("panel:paged.document-map");
    const h = await mount();
    await withViewport(h, [800, 600]);
    const from = h.mark();
    await h.click(spread(h.root, S2));
    expect(spread(h.root, S2).getAttribute("data-selected")).toBe("true");
    await cameraLandsOn(
      h,
      fitCamera(800, 600, layoutPages(h.handle!.pageSizesPt)[1]),
    );
    expect(h.mutations(from)).toEqual([]);
  });

  test("the missing-link chip jumps to its page", async () => {
    covers("panel:paged.document-map");
    const h = await mount();
    await withViewport(h, [800, 600]);
    await h.click(h.root.querySelector('[data-page-chip="missing-links"]')!);
    expect(spread(h.root, S1).getAttribute("data-selected")).toBe("true");
    await cameraLandsOn(
      h,
      fitCamera(800, 600, layoutPages(h.handle!.pageSizesPt)[0]),
    );
  });

  test("Add section starts a section at the first page, and its chip appears", async () => {
    covers("panel:paged.document-map");
    const h = await mount();
    const from = h.mark();
    await h.click(h.root.querySelector("[data-add-section]")!);
    expect(h.mutations(from)).toEqual([
      {
        op: "insertSection",
        args: {
          atPage: STRUCTURE.page1,
          prefix: null,
          numberingStyle: null,
          startAt: null,
        },
      },
    ] as never);
    const model = (await h.client.collection("sections")) as unknown[];
    expect(model).toHaveLength(1);
    const chip = h.root.querySelector<HTMLButtonElement>(
      "[data-section-chip]",
    )!;
    expect(chip.textContent).toBe("§1–2");
    expect(chip.title).toBe("(no prefix) · 1, 2, 3 · pages 1–2");
    expect(
      h.root.querySelector<HTMLButtonElement>("[data-add-section]")!.disabled,
    ).toBe(false);
  });

  test("a section chip jumps to the section's first page", async () => {
    covers("panel:paged.document-map");
    const h = await mount();
    await h.mutate({
      op: "insertSection",
      args: { atPage: STRUCTURE.page2, prefix: "B-" },
    } as never);
    await withViewport(h, [800, 600]);
    const chip = [
      ...h.root.querySelectorAll<HTMLButtonElement>("[data-section-chip]"),
    ].find((c) => c.textContent?.startsWith("B-"))!;
    await h.click(chip);
    await cameraLandsOn(
      h,
      fitCamera(800, 600, layoutPages(h.handle!.pageSizesPt)[1]),
    );
  });
});
