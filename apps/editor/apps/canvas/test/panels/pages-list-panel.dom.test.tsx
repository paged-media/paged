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

// Pages list (paged.pages-list): one row per page with its size; a click
// selects the row (the target of Delete / Duplicate / Move) AND moves the
// camera to the page. New inserts after the selected row (or at the end)
// and selects the new page; Duplicate copies the selected page and
// selects the copy; Delete removes it; Move earlier / later reorder it
// through the typed core command movePage.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { PagesListPanel } from "../../src/panels/pages-list-panel";
import { fitCamera, layoutPages } from "../../src/ui/layout";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import {
  cameraLandsOn,
  routeShellEvents,
  rows,
  structureIdml,
  STRUCTURE,
  withViewport,
} from "./support/structure";

afterEach(unmountAll);

const mount = async (
  document: "none" | "blank" | Uint8Array = structureIdml(),
) => {
  const h = await mountPanel(PagesListPanel, {
    id: "paged.pages-list",
    document,
  });
  routeShellEvents(h);
  return h;
};

const btn = (root: Element, key: string) =>
  root.querySelector<HTMLButtonElement>(`[data-toolbar-btn="${key}"]`)!;
const row = (root: Element, key: string) =>
  root.querySelector<HTMLElement>(`[data-list-row="${key}"]`)!;
const pageIds = async (h: PanelHarness<unknown>) =>
  ((await h.client.collection("pages")) as Array<{ selfId: string }>).map(
    (p) => p.selfId,
  );

describe("Pages list panel: states", () => {
  test("no document: the empty state; only New is live", async () => {
    covers("panel:paged.pages-list");
    const h = await mount("none");
    expect(h.root.querySelector("[data-empty-pages]")?.textContent).toBe(
      "No pages.",
    );
    expect(btn(h.root, "ui-plus").disabled).toBe(false);
    for (const k of [
      "ui-x",
      "ui-component",
      "move-page-earlier",
      "move-page-later",
    ])
      expect(btn(h.root, k).disabled).toBe(true);
  });

  test("lists every page with its size; nothing selected, so the row verbs say select one first", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    expect(
      rows(h.root).map((r) => [r.key, r.primary, r.secondary, r.selected]),
    ).toEqual([
      [STRUCTURE.page1, "Page 1", "612 × 792 pt", false],
      [STRUCTURE.page2, "Page 2", "612 × 792 pt", false],
    ]);
    expect(btn(h.root, "ui-x").getAttribute("aria-label")).toBe(
      "Delete page (select one first)",
    );
    expect(btn(h.root, "ui-component").getAttribute("aria-label")).toBe(
      "Duplicate page (select one first)",
    );
  });

  test("a click selects the row (and a second click clears it); the verbs come alive", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page1));
    expect(row(h.root, STRUCTURE.page1).getAttribute("data-selected")).toBe(
      "true",
    );
    expect(btn(h.root, "ui-x").getAttribute("aria-label")).toBe("Delete page");
    expect(btn(h.root, "ui-component").disabled).toBe(false);
    // Page 1 is first: it cannot move earlier.
    expect(btn(h.root, "move-page-earlier").disabled).toBe(true);
    expect(btn(h.root, "move-page-later").disabled).toBe(false);
    await h.click(row(h.root, STRUCTURE.page1));
    expect(
      row(h.root, STRUCTURE.page1).getAttribute("data-selected"),
    ).toBeNull();
  });

  test("a click also moves the camera to that page", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    await withViewport(h, [800, 600]);
    await h.click(row(h.root, STRUCTURE.page2));
    const rect = layoutPages(h.handle!.pageSizesPt)[1];
    await cameraLandsOn(h, fitCamera(800, 600, rect));
  });
});

describe("Pages list panel: controls", () => {
  test("New with nothing selected appends a page and selects it", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    const from = h.mark();
    await h.click(btn(h.root, "ui-plus"));
    expect(h.mutations(from)).toEqual([
      {
        op: "insertPage",
        args: { afterPageId: STRUCTURE.page2, masterId: null },
      },
    ] as never);
    const ids = await pageIds(h);
    expect(ids).toHaveLength(3);
    expect(rows(h.root).map((r) => r.key)).toEqual(ids);
    expect(rows(h.root)[2].selected).toBe(true);
  });

  test("New with a row selected inserts after it", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page1));
    const from = h.mark();
    await h.click(btn(h.root, "ui-plus"));
    expect(h.mutations(from)).toEqual([
      {
        op: "insertPage",
        args: { afterPageId: STRUCTURE.page1, masterId: null },
      },
    ] as never);
    const ids = await pageIds(h);
    expect(ids[0]).toBe(STRUCTURE.page1);
    expect(ids[2]).toBe(STRUCTURE.page2);
    expect(rows(h.root)[1]).toMatchObject({ key: ids[1], selected: true });
  });

  test("Duplicate copies the selected page and selects the copy", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page1));
    const from = h.mark();
    await h.click(btn(h.root, "ui-component"));
    expect(h.mutations(from)).toEqual([
      { op: "duplicatePage", args: { page: STRUCTURE.page1 } },
    ] as never);
    const ids = await pageIds(h);
    expect(ids).toHaveLength(3);
    const copy = rows(h.root).find((r) => r.selected);
    expect(copy?.key).not.toBe(STRUCTURE.page1);
    expect(ids).toContain(copy!.key);
  });

  test("Delete removes the selected page and clears the selection; one undo brings it back", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page2));
    const from = h.mark();
    await h.click(btn(h.root, "ui-x"));
    expect(h.mutations(from)).toEqual([
      { op: "deletePage", args: { pageId: STRUCTURE.page2 } },
    ] as never);
    expect(await pageIds(h)).toEqual([STRUCTURE.page1]);
    expect(rows(h.root).map((r) => r.key)).toEqual([STRUCTURE.page1]);
    expect(btn(h.root, "ui-x").disabled).toBe(true);
    await h.act(() => h.client.undo());
    expect(await pageIds(h)).toEqual([STRUCTURE.page1, STRUCTURE.page2]);
  });

  test("Move later puts the page after the next one (movePage with after)", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page1));
    const from = h.mark();
    await h.click(btn(h.root, "move-page-later"));
    expect(h.mutations(from)).toEqual([
      {
        op: "movePage",
        args: { page: STRUCTURE.page1, after: STRUCTURE.page2 },
      },
    ] as never);
    expect(await pageIds(h)).toEqual([STRUCTURE.page2, STRUCTURE.page1]);
    expect(rows(h.root).map((r) => r.key)).toEqual([
      STRUCTURE.page2,
      STRUCTURE.page1,
    ]);
  });

  test("Move earlier on the second page makes it first (movePage without after)", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    await h.click(row(h.root, STRUCTURE.page2));
    const from = h.mark();
    await h.click(btn(h.root, "move-page-earlier"));
    expect(h.mutations(from)).toEqual([
      { op: "movePage", args: { page: STRUCTURE.page2 } },
    ] as never);
    expect(await pageIds(h)).toEqual([STRUCTURE.page2, STRUCTURE.page1]);
  });

  test("the disabled verbs send nothing", async () => {
    covers("panel:paged.pages-list");
    const h = await mount();
    const from = h.mark();
    for (const k of [
      "ui-x",
      "ui-component",
      "move-page-earlier",
      "move-page-later",
    ])
      await h.click(btn(h.root, k));
    expect(h.mutations(from)).toEqual([]);
  });
});
