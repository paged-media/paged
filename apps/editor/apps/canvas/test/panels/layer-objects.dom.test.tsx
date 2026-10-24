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

// Layers (paged.layers), WP4.6 — the objects under each layer: groups
// nested with expand / collapse, a row click selects, Locate object opens
// the tree down to the selection, the target circle (filled for a
// non-default appearance) targets the item for the Effects panel, and a
// drag reorders within a container or moves to another layer, as one
// undo step.

import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import type { ElementId, Mutation, SceneTreeNode } from "@paged-media/client";

import {
  buildLayerTree,
  dropMutation,
  elementKey,
  layerColour,
  readItem,
  type ObjectNode,
} from "../../src/panels/layer-objects";
import { LayersPanel } from "../../src/panels/layers-panel";
import { shapesScene, type ShapesScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<ShapesScene>;

const mount = () =>
  mountPanel(LayersPanel, { id: "paged.layers", scene: shapesScene });

const objRow = (h: H, id: ElementId) =>
  h.root.querySelector<HTMLElement>(
    `[data-object-row="${CSS.escape(elementKey(id))}"]`,
  );
const objRows = (h: H) =>
  [...h.root.querySelectorAll<HTMLElement>("[data-object-row]")].map(
    (r) => r.dataset.objectRow!,
  );

async function ready(h: H) {
  for (let i = 0; i < 100; i++) {
    if (h.root.querySelector('[data-layer-objects="ready"]')) {
      await h.settle();
      return;
    }
    await h.act(() => new Promise((r) => setTimeout(r, 20)));
  }
  throw new Error("the objects tree never read");
}

/** Wait out the tree's debounced re-read after an edit. */
async function reread(h: H) {
  await h.act(() => new Promise((r) => setTimeout(r, 150)));
  await h.settle();
}

async function drag(h: H, from: HTMLElement, to: HTMLElement) {
  let data = "";
  const dataTransfer = {
    setData: (_t: string, v: string) => {
      data = v;
    },
    getData: () => data,
    effectAllowed: "",
    dropEffect: "",
  };
  await h.act(() => fireEvent.dragStart(from, { dataTransfer }));
  await h.act(() => fireEvent.dragOver(to, { dataTransfer }));
  await h.act(() => fireEvent.drop(to, { dataTransfer }));
  await h.settle();
}

const topLevelOrder = async (h: H) =>
  (await h.client.sceneTree())
    .flatMap((s) => s.children ?? [])
    .flatMap((p) => p.children ?? [])
    .map((n) => (n.id ? elementKey(n.id) : "?"));

describe("Layers objects: the tree's arithmetic", () => {
  const rect = (id: string): SceneTreeNode => ({
    id: { kind: "rectangle", id } as ElementId,
    kind: "Rectangle",
    label: `Rectangle ${id}`,
  });
  const roots: SceneTreeNode[] = [
    {
      kind: "Spread",
      label: "Spread 1",
      children: [
        {
          kind: "Page",
          label: "1",
          children: [
            rect("a"),
            {
              id: { kind: "group", id: "g" } as ElementId,
              kind: "Group",
              label: "Group g",
              children: [rect("m1"), rect("m2")],
            },
            rect("b"),
          ],
        },
      ],
    },
  ];
  const layers = [
    {
      selfId: "L0",
      name: "Back",
      visible: true,
      locked: false,
      printable: true,
      z: 0,
    },
    {
      selfId: "L1",
      name: "Front",
      visible: true,
      locked: false,
      printable: true,
      z: 1,
    },
  ];
  const facts = new Map([
    ["rectangle:a", { layerId: "L0", appearance: false }],
    ["rectangle:m1", { layerId: "L1", appearance: true }],
    ["rectangle:m2", { layerId: "L1", appearance: false }],
    ["rectangle:b", { layerId: "", appearance: false }],
  ]);

  test("layers front first, items front first, groups on their members' layer", () => {
    const tree = buildLayerTree(roots, layers, facts);
    expect(tree.map((b) => b.layer.selfId)).toEqual(["L1", "L0"]);
    expect(tree[0]!.items.map((n) => n.key)).toEqual(["group:g"]);
    expect(tree[0]!.items[0]!.children.map((n) => n.key)).toEqual([
      "rectangle:m2",
      "rectangle:m1",
    ]);
    // A layer-less item is filed on the backmost layer.
    expect(tree[1]!.items.map((n) => n.key)).toEqual([
      "rectangle:b",
      "rectangle:a",
    ]);
    expect(tree[1]!.items[0]!.slot).toBe(2);
    expect(tree[1]!.colour).toBe(layerColour(0));
  });

  test("an appearance is opacity, the object's blend mode or an effect switched on", () => {
    const e = (path: string, value: unknown) => ({ path, value }) as never;
    expect(
      readItem([e("frameOpacity", { type: "length", value: 100 })]),
    ).toEqual({
      layerId: null,
      appearance: false,
    });
    expect(
      readItem([e("frameOpacity", { type: "length", value: 40 })]).appearance,
    ).toBe(true);
    expect(
      readItem([e("frameBlendMode", { type: "text", value: "Multiply" })])
        .appearance,
    ).toBe(true);
    // A switched-off effect's own blend mode is no appearance.
    expect(
      readItem([
        e("frameDropShadowBlendMode", { type: "text", value: "Multiply" }),
      ]).appearance,
    ).toBe(false);
    expect(
      readItem([e("frameOuterGlowEnabled", { type: "bool", value: true })])
        .appearance,
    ).toBe(true);
    expect(
      readItem([e("itemLayer", { type: "text", value: "L3" })]).layerId,
    ).toBe("L3");
  });

  test("a drop's mutation: a slot, a layer, both as one batch, or nothing", () => {
    const tree = buildLayerTree(roots, layers, facts);
    const a = tree[1]!.items[1]!;
    const b = tree[1]!.items[0]!;
    const g = tree[0]!.items[0]!;
    expect(dropMutation(a, { kind: "item", node: b })).toEqual({
      op: "reorderElement",
      args: { elementId: a.id, to: { index: 2 } },
    } as Mutation);
    expect(dropMutation(a, { kind: "item", node: a })).toBeNull();
    // Into another container (a group's member): not a move the engine has.
    expect(
      dropMutation(a, { kind: "item", node: g.children[0] as ObjectNode }),
    ).toBeNull();
    // Onto a layer: every leaf of a group moves (a group has no layer).
    const toBack = dropMutation(g, { kind: "layer", layerId: "L0" }) as {
      op: string;
      args: { ops: Array<{ args: { elementId: ElementId } }> };
    };
    expect(toBack.op).toBe("batch");
    expect(toBack.args.ops.map((o) => elementKey(o.args.elementId))).toEqual([
      "rectangle:m2",
      "rectangle:m1",
    ]);
    // Onto an item on another layer: its layer AND its slot, one batch.
    const across = dropMutation(g, { kind: "item", node: a }) as {
      op: string;
      args: { ops: Mutation[] };
    };
    expect(across.op).toBe("batch");
    expect(across.args.ops.at(-1)).toEqual({
      op: "reorderElement",
      args: { elementId: g.id, to: { index: 0 } },
    } as Mutation);
  });
});

describe("Layers objects: the panel", () => {
  test("each item sits under its layer; a group expands to its members", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    await ready(h);
    // A blank document has no <Layer>: its items sit under the stand-in.
    expect(await h.client.collection("layers")).toEqual([]);
    const layer = { selfId: "" };
    expect(
      h.root.querySelector('[data-object-layer=""]')?.textContent,
    ).toContain("No layer");
    expect(objRow(h, h.scene.group)).not.toBeNull();
    expect(objRow(h, h.scene.groupA)).toBeNull();
    await h.click(
      h.root.querySelector(
        `[data-object-twisty="${CSS.escape(elementKey(h.scene.group))}"]`,
      )!,
    );
    expect(objRow(h, h.scene.groupA)).not.toBeNull();
    expect(objRow(h, h.scene.groupB)).not.toBeNull();
    // Front first: the last item made (the hidden rect) is on top.
    expect(objRows(h)[0]).toBe(elementKey(h.scene.hidden));
    // The layer collapses and opens again.
    await h.click(
      h.root.querySelector(
        `[data-layer-twisty="${CSS.escape(layer.selfId)}"]`,
      )!,
    );
    expect(objRows(h)).toEqual([]);
  });

  test("a row click selects its item", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    await ready(h);
    await h.click(objRow(h, h.scene.oval)!);
    expect(objRow(h, h.scene.oval)!.hasAttribute("data-selected")).toBe(true);
    const sent = h.sent("setElementSelection").at(-1) as unknown as {
      payload: { ids: ElementId[] };
    };
    expect(JSON.stringify(sent)).toContain(String(h.scene.oval.id));
  });

  test("Locate object opens the tree down to the selection", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    await ready(h);
    const locate = h.root.querySelector<HTMLButtonElement>(
      '[data-action="locate-object"]',
    )!;
    expect(locate.disabled).toBe(true);
    await h.select([h.scene.groupB]);
    expect(objRow(h, h.scene.groupB)).toBeNull();
    await h.click(locate);
    const row = objRow(h, h.scene.groupB)!;
    expect(row).not.toBeNull();
    expect(row.hasAttribute("data-located")).toBe(true);
    expect(row.hasAttribute("data-selected")).toBe(true);
  });

  test("the target circle fills for an appearance and targets the Effects panel", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    const shown = h.spyCommand("paged.panel.show.paged.effects");
    await ready(h);
    const target = () =>
      h.root.querySelector<HTMLElement>(
        `[data-object-target="${CSS.escape(elementKey(h.scene.rect))}"]`,
      )!;
    expect(target().dataset.appearance).toBe("empty");
    await h.mutate({
      op: "setElementProperty",
      args: {
        elementId: h.scene.rect,
        path: "frameOpacity",
        value: { type: "length", value: 50 },
      },
    } as Mutation);
    await reread(h);
    expect(target().dataset.appearance).toBe("filled");
    await h.click(target());
    await h.settle();
    expect(shown.length).toBe(1);
    expect(objRow(h, h.scene.rect)!.hasAttribute("data-selected")).toBe(true);
  });

  test("a drag onto an item takes its stacking slot, as one undo step", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    await ready(h);
    const before = await topLevelOrder(h);
    const rectKey = elementKey(h.scene.rect);
    const ovalKey = elementKey(h.scene.oval);
    expect(before.indexOf(rectKey)).toBeLessThan(before.indexOf(ovalKey));
    const mark = h.mark();
    // Drag the rect onto the oval: it goes to the oval's slot (in front).
    await drag(h, objRow(h, h.scene.rect)!, objRow(h, h.scene.oval)!);
    expect(h.mutations(mark)).toHaveLength(1);
    expect(h.mutations(mark)[0]).toMatchObject({ op: "reorderElement" });
    const after = await topLevelOrder(h);
    expect(after.indexOf(rectKey)).toBe(before.indexOf(ovalKey));
    expect(after.indexOf(ovalKey)).toBeLessThan(after.indexOf(rectKey));
    await h.act(() => h.client.undo());
    expect(await topLevelOrder(h)).toEqual(before);
  });

  test("a drag onto a layer row moves the item to that layer", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    await h.mutate({
      op: "layerInsert",
      args: { position: 0, name: "Back" },
    } as Mutation);
    await h.mutate({
      op: "layerInsert",
      args: { position: 1, name: "Front" },
    } as Mutation);
    await ready(h);
    await reread(h);
    const layers = (await h.client.collection("layers")) as Array<{
      selfId: string;
      name: string;
    }>;
    const front = layers.find((l) => l.name === "Front")!;
    const to = h.root.querySelector<HTMLElement>(
      `[data-object-layer="${CSS.escape(front.selfId)}"]`,
    )!;
    await drag(h, objRow(h, h.scene.oval)!, to);
    expect((await h.props(h.scene.oval)).itemLayer).toEqual({
      type: "text",
      value: front.selfId,
    });
    await reread(h);
    // Its row is now under the front layer, which is drawn first.
    const frontBlock = to.parentElement!;
    expect(
      frontBlock.querySelector(
        `[data-object-row="${CSS.escape(elementKey(h.scene.oval))}"]`,
      ),
    ).not.toBeNull();
    // Front at top, with the second colour of the sequence (it is the
    // second layer from the back).
    expect(
      h.root
        .querySelector(`[data-layer-colour]`)
        ?.getAttribute("data-layer-colour"),
    ).toBe(layerColour(1));
    expect(
      [...h.root.querySelectorAll("[data-object-layer]")].map((e) =>
        e.getAttribute("data-object-layer"),
      ),
    ).toEqual([front.selfId, layers.find((l) => l.name === "Back")!.selfId]);
  });
});
