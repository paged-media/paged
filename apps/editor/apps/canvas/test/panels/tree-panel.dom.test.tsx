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

// Tree (paged.tree): the scene tree (spreads, pages, page items). A click
// on an item row selects it on the canvas; the canvas selection shows as
// the highlighted row. Spread and page rows are not selectable.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { TreePanel } from "../../src/panels/tree-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = () =>
  mountPanel(TreePanel, { id: "paged.tree", scene: richScene });

const key = (id: { kind: string; id: unknown }) => `${id.kind}:${id.id}`;
const row = (root: Element, k: string) =>
  root.querySelector<HTMLButtonElement>(`[data-tree-row="${k}"]`)!;
const highlighted = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll<HTMLElement>("[data-tree-row]")]
    .filter((r) => r.className.includes("bg-muted text-foreground"))
    .map((r) => r.getAttribute("data-tree-row"));

describe("Tree panel: states", () => {
  test("no document: says so", async () => {
    covers("panel:paged.tree");
    const h = await mountPanel(TreePanel, {
      id: "paged.tree",
      document: "none",
    });
    expect(h.root.querySelector('[data-tree="empty"]')?.textContent).toBe(
      "No document loaded.",
    );
  });

  test("a document: spreads, pages and every item, items nested under the group", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const s = h.scene;
    expect(h.root.querySelectorAll('[data-tree-row="Spread"]')).toHaveLength(2);
    expect(h.root.querySelectorAll('[data-tree-row="Page"]')).toHaveLength(2);
    for (const id of [
      s.textFrame,
      s.rect,
      s.oval,
      s.group,
      s.locked,
      s.hidden,
      s.tableFrame,
    ])
      expect(row(h.root, key(id))).not.toBeNull();
    const groupItem = row(h.root, key(s.group)).closest("li")!;
    expect(
      groupItem.querySelector(`[data-tree-row="${key(s.groupA)}"]`),
    ).not.toBeNull();
    expect(
      groupItem.querySelector(`[data-tree-row="${key(s.groupB)}"]`),
    ).not.toBeNull();
  });

  test("spread and page rows are disabled", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    for (const r of h.root.querySelectorAll<HTMLButtonElement>(
      '[data-tree-row="Spread"], [data-tree-row="Page"]',
    ))
      expect(r.disabled).toBe(true);
  });

  test("the canvas selection is the highlighted row", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    expect(highlighted(h)).toEqual([]);
    await h.select([h.scene.oval]);
    expect(highlighted(h)).toEqual([key(h.scene.oval)]);
  });

  test("follows the model: a frame inserted gets a row, an undo removes it", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const reply = await h.mutate({
      op: "insertFrame",
      args: { pageId: h.scene.page2Id, bounds: [10, 10, 50, 50] },
    } as never);
    const id = (
      reply as { payload: { createdId: { kind: string; id: string } } }
    ).payload.createdId;
    expect(row(h.root, key(id))).not.toBeNull();
    await h.act(() => h.client.undo());
    expect(row(h.root, key(id))).toBeNull();
  });
});

describe("Tree panel: controls", () => {
  test("a click on an item row selects it (engine and canvas mirror)", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const from = h.mark();
    await h.click(row(h.root, key(h.scene.rect)));
    expect(h.sent("setElementSelection", from).map((m) => m.payload)).toEqual([
      { ids: [h.scene.rect], mode: "replace" },
    ]);
    expect(h.paged.selection.elementSelection).toEqual([h.scene.rect]);
    expect(h.paged.selection.elementGeometry.map((g) => g.id)).toEqual([
      h.scene.rect,
    ]);
    expect(highlighted(h)).toEqual([key(h.scene.rect)]);
  });

  test("a click on a group's child selects the child itself", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    await h.click(row(h.root, key(h.scene.groupA)));
    expect(h.paged.selection.elementSelection).toEqual([h.scene.groupA]);
  });

  test("selecting changes nothing in the document", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const from = h.mark();
    await h.click(row(h.root, key(h.scene.oval)));
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Tree panel: findings", () => {
  // The highlight keys off a ONE-element selection only: select two
  // frames on the canvas and the Tree marks neither.
  test.failing(
    "PN-108: every selected item's row is highlighted, not only a lone one",
    async () => {
      covers("panel:paged.tree");
      const h = await mount();
      await h.select([h.scene.rect, h.scene.oval]);
      expect(highlighted(h).sort()).toEqual(
        [key(h.scene.rect), key(h.scene.oval)].sort(),
      );
    },
  );
});
