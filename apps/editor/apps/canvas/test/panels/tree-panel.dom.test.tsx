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

// The object tree (paged.tree; editor ADR "An accessible object tree",
// D-13): the spreads and their page items as a virtualized WAI-ARIA tree.
// Rows carry their level, place and set size; names say type, page and
// lock / visibility; a canvas selection marks and reveals its row, and the
// keyboard selects through the engine as a canvas click does. Nothing here
// changes the document.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { fireEvent } from "@testing-library/react";
import { computeAccessibleName } from "dom-accessibility-api";
import type { ElementId, Mutation } from "@paged-media/client";

import { TreePanel } from "../../src/panels/tree-panel";
import {
  OBJECT_TREE_ROW_PX,
  buildObjectTree,
  revealed,
  parentsOf,
  scrollToShow,
  visibleRows,
} from "../../src/ui/A11yObjectTree";
import { a11yProblems } from "./a11y";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = () =>
  mountPanel(TreePanel, { id: "paged.tree", scene: richScene });

const key = (id: { kind: string; id: unknown }) => `${id.kind}:${id.id}`;
const tree = (h: PanelHarness<unknown>) =>
  h.root.querySelector<HTMLElement>('[role="tree"]')!;
const row = (h: PanelHarness<unknown>, k: string) =>
  h.root.querySelector<HTMLElement>(`[data-object-key="${k}"]`);
const rows = (h: PanelHarness<unknown>) => [
  ...h.root.querySelectorAll<HTMLElement>('[role="treeitem"]'),
];
const nameOf = (el: Element | null) => (el ? computeAccessibleName(el) : "");
const activeKey = (h: PanelHarness<unknown>) => {
  const id = tree(h).getAttribute("aria-activedescendant");
  return id
    ? h.root.querySelector(`#${id}`)?.getAttribute("data-object-key")
    : null;
};
const key_ = (
  h: PanelHarness<unknown>,
  k: string,
  init: KeyboardEventInit = {},
) =>
  h.act(async () => {
    fireEvent.keyDown(tree(h), { key: k, ...init });
  });
/** Wait until the rows in view have their facts (lock, visibility, page). */
const factsRead = async (h: PanelHarness<unknown>, k: string) => {
  for (let i = 0; i < 50; i++) {
    await h.settle();
    if (nameOf(row(h, k)).includes("page")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("the object tree: the model", () => {
  test("spreads are named after their page; items front first; groups hold their members", () => {
    const strings = {
      t: (k: string, p?: Record<string, unknown>) =>
        `${k}${JSON.stringify(p ?? {})}`,
    };
    const id = (kind: string, n: string) => ({ kind, id: n }) as ElementId;
    const nodes = buildObjectTree(
      [
        {
          kind: "Spread",
          label: "Spread s1",
          children: [
            {
              kind: "Page",
              label: "1",
              children: [
                {
                  id: id("rectangle", "back"),
                  kind: "Rectangle",
                  label: "Rectangle back",
                  children: [],
                },
                {
                  id: id("group", "g"),
                  kind: "Group",
                  label: "Group g",
                  children: [
                    {
                      id: id("oval", "a"),
                      kind: "Oval",
                      label: "Oval a",
                      children: [],
                    },
                    {
                      id: id("oval", "b"),
                      kind: "Oval",
                      label: "Oval b",
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ] as never,
      1,
      strings,
    );
    expect(nodes.map((n) => n.key)).toEqual(["spread:0"]);
    expect(nodes[0]!.label).toContain("app.objectTree.page");
    // Front first: the group (drawn last) leads, its members front first.
    expect(nodes[0]!.children.map((n) => n.key)).toEqual([
      "group:g",
      "rectangle:back",
    ]);
    expect(nodes[0]!.children[0]!.children.map((n) => n.key)).toEqual([
      "oval:b",
      "oval:a",
    ]);

    // Spreads open, groups closed until opened; places and set sizes.
    const closed = visibleRows(nodes, new Map());
    expect(
      closed.map((r) => [r.node.key, r.level, r.posInSet, r.setSize]),
    ).toEqual([
      ["spread:0", 1, 1, 1],
      ["group:g", 2, 1, 2],
      ["rectangle:back", 2, 2, 2],
    ]);
    const parents = parentsOf(nodes);
    const open = revealed(new Map(), parents, "oval:a");
    expect(visibleRows(nodes, open).map((r) => r.node.key)).toEqual([
      "spread:0",
      "group:g",
      "oval:b",
      "oval:a",
      "rectangle:back",
    ]);
    // The window keeps the active row on screen.
    expect(scrollToShow(10, 0, 5 * OBJECT_TREE_ROW_PX)).toBe(
      6 * OBJECT_TREE_ROW_PX,
    );
    expect(
      scrollToShow(2, 6 * OBJECT_TREE_ROW_PX, 5 * OBJECT_TREE_ROW_PX),
    ).toBe(2 * OBJECT_TREE_ROW_PX);
  });
});

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

  test("a document: a tree of spreads and items with levels, places and set sizes", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const s = h.scene;
    const t = tree(h);
    expect(t.getAttribute("aria-label")).toBe("Document objects");
    expect(t.getAttribute("aria-multiselectable")).toBe("true");
    expect(t.tabIndex).toBe(0);
    const spreads = rows(h).filter((r) => r.getAttribute("aria-level") === "1");
    expect(spreads).toHaveLength(2);
    expect(spreads[0]!.getAttribute("aria-expanded")).toBe("true");
    for (const id of [
      s.textFrame,
      s.rect,
      s.oval,
      s.group,
      s.locked,
      s.hidden,
      s.tableFrame,
    ]) {
      const r = row(h, key(id))!;
      expect(r).not.toBeNull();
      expect(r.getAttribute("aria-level")).toBe("2");
      expect(Number(r.getAttribute("aria-setsize"))).toBeGreaterThan(1);
      expect(r.getAttribute("aria-selected")).toBe("false");
    }
    // A group's members wait until it is opened.
    expect(row(h, key(s.group))!.getAttribute("aria-expanded")).toBe("false");
    expect(row(h, key(s.groupA))).toBeNull();
    // Names say the type.
    expect(nameOf(row(h, key(s.rect)))).toMatch(/^Rectangle /);
    expect(nameOf(row(h, key(s.textFrame)))).toMatch(/^Text frame /);
    expect(nameOf(row(h, key(s.group)))).toMatch(/^Group /);
  });

  test("names say the page and whether an item is locked or hidden", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const s = h.scene;
    await factsRead(h, key(s.locked));
    expect(nameOf(row(h, key(s.locked)))).toMatch(/page 1, locked$/);
    expect(row(h, key(s.locked))!.hasAttribute("data-locked")).toBe(true);
    expect(nameOf(row(h, key(s.hidden)))).toMatch(/page 1, hidden$/);
    expect(nameOf(row(h, key(s.rect)))).not.toMatch(/locked|hidden/);
  });

  test("the reach basics: one tab stop, every row named", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    expect(a11yProblems(h.root)).toEqual([]);
  });

  test("a canvas selection is the selected row, revealed inside its group", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    await h.select([h.scene.groupA]);
    const r = row(h, key(h.scene.groupA))!;
    expect(r).not.toBeNull();
    expect(r.getAttribute("aria-selected")).toBe("true");
    expect(row(h, key(h.scene.group))!.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(activeKey(h)).toBe(key(h.scene.groupA));
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
    for (let i = 0; i < 20 && !row(h, key(id)); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await h.settle();
    }
    expect(row(h, key(id))).not.toBeNull();
    await h.act(() => h.client.undo());
    for (let i = 0; i < 20 && row(h, key(id)); i++) {
      await new Promise((r) => setTimeout(r, 20));
      await h.settle();
    }
    expect(row(h, key(id))).toBeNull();
  });

  test("virtualized: a page of many items draws a window of rows, every row counted", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const ops = Array.from(
      { length: 150 },
      (_, i): Mutation =>
        ({
          op: "insertFrame",
          args: {
            pageId: h.scene.page2Id,
            bounds: [
              10 + (i % 30) * 20,
              10 + Math.floor(i / 30) * 20,
              25 + (i % 30) * 20,
              25 + Math.floor(i / 30) * 20,
            ],
          },
        }) as never,
    );
    await h.mutate({ op: "batch", args: { ops } } as never);
    let page2: HTMLElement | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await h.settle();
      page2 = rows(h).find(
        (r) =>
          r.getAttribute("aria-level") === "1" &&
          r.getAttribute("aria-posinset") === "2",
      );
      const items = rows(h).filter((r) => r.getAttribute("aria-level") === "2");
      if (items.some((r) => Number(r.getAttribute("aria-setsize")) >= 150))
        break;
    }
    const items = rows(h).filter((r) => r.getAttribute("aria-level") === "2");
    // Far fewer rows in the DOM than the tree holds…
    expect(rows(h).length).toBeLessThan(80);
    // …and each row still says how many siblings it has.
    expect(
      Math.max(...items.map((r) => Number(r.getAttribute("aria-setsize")))),
    ).toBeGreaterThanOrEqual(150);
    expect(
      page2 === undefined || page2.getAttribute("aria-level") === "1",
    ).toBe(true);
    // End reaches the last row: it is drawn, active, and the window moved.
    tree(h).focus();
    await key_(h, "End");
    const last = activeKey(h)!;
    expect(row(h, last)).not.toBeNull();
    expect(row(h, last)!.getAttribute("aria-posinset")).toBe(
      row(h, last)!.getAttribute("aria-setsize"),
    );
  });
});

describe("Tree panel: the keyboard", () => {
  test("arrows walk the rows; Right opens a group and enters it; Left climbs and closes", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const s = h.scene;
    tree(h).focus();
    await h.act(async () => {
      fireEvent.focus(tree(h));
    });
    expect(activeKey(h)).toBe("spread:0");
    await key_(h, "ArrowDown");
    const second = activeKey(h);
    expect(second).not.toBe("spread:0");
    await key_(h, "ArrowUp");
    expect(activeKey(h)).toBe("spread:0");
    // To the group, open it, step into its first member, climb, close.
    for (let i = 0; i < 20 && activeKey(h) !== key(s.group); i++)
      await key_(h, "ArrowDown");
    expect(activeKey(h)).toBe(key(s.group));
    await key_(h, "ArrowRight");
    expect(row(h, key(s.group))!.getAttribute("aria-expanded")).toBe("true");
    await key_(h, "ArrowRight");
    expect([key(s.groupA), key(s.groupB)]).toContain(activeKey(h)!);
    await key_(h, "ArrowLeft");
    expect(activeKey(h)).toBe(key(s.group));
    await key_(h, "ArrowLeft");
    expect(row(h, key(s.group))!.getAttribute("aria-expanded")).toBe("false");
    await key_(h, "Home");
    expect(activeKey(h)).toBe("spread:0");
  });

  test("UXI-T69 — Enter selects the active row's item: the engine, the canvas mirror and the inspector see one selection, and nothing changes in the document @feat:editor-shell.panels.tree @level:happy", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const s = h.scene;
    tree(h).focus();
    for (let i = 0; i < 20 && activeKey(h) !== key(s.locked); i++)
      await key_(h, "ArrowDown");
    expect(activeKey(h)).toBe(key(s.locked));
    const from = h.mark();
    await key_(h, "Enter");
    await h.settle();
    expect(h.sent("setElementSelection", from).map((m) => m.payload)).toEqual([
      { ids: [s.locked], mode: "replace" },
    ]);
    // A locked object is selectable for inspection (D-08).
    expect(h.paged.selection.elementSelection).toEqual([s.locked]);
    expect(h.paged.selection.elementGeometry.map((g) => g.id)).toEqual([
      s.locked,
    ]);
    expect(row(h, key(s.locked))!.getAttribute("aria-selected")).toBe("true");
    expect(h.mutations(from)).toEqual([]);
  });

  test("Shift+Space toggles an item into the selection and out again", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const s = h.scene;
    await h.select([s.rect]);
    tree(h).focus();
    for (let i = 0; i < 20 && activeKey(h) !== key(s.oval); i++)
      await key_(h, "ArrowDown");
    for (let i = 0; i < 20 && activeKey(h) !== key(s.oval); i++)
      await key_(h, "ArrowUp");
    expect(activeKey(h)).toBe(key(s.oval));
    const from = h.mark();
    await key_(h, " ", { shiftKey: true });
    await h.settle();
    expect(h.paged.selection.elementSelection.map(key).sort()).toEqual(
      [key(s.rect), key(s.oval)].sort(),
    );
    await key_(h, " ", { shiftKey: true });
    await h.settle();
    expect(h.paged.selection.elementSelection.map(key)).toEqual([key(s.rect)]);
    expect(
      h
        .sent("setElementSelection", from)
        .map((m) => (m.payload as { mode: string }).mode),
    ).toEqual(["toggle", "toggle"]);
    expect(h.mutations(from)).toEqual([]);
  });

  test("a click on a row selects it", async () => {
    covers("panel:paged.tree");
    const h = await mount();
    const from = h.mark();
    await h.click(row(h, key(h.scene.rect))!);
    await h.settle();
    expect(h.paged.selection.elementSelection).toEqual([h.scene.rect]);
    expect(h.mutations(from)).toEqual([]);
  });
});
