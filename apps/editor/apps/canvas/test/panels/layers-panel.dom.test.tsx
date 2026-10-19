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

// Layers (paged.layers): the document's layers, front at top, with each
// row's Hide / Lock / Move selection here / Printable / Delete actions,
// inline rename (double-click), drag-reorder, New layer, and Layer
// Options. Every write goes through a host command the panel registers
// while it is mounted (paged.layers.*); each is driven both through its
// control and through the command registry, asserted as the exact
// mutation and the layers collection (or the item's itemLayer) after.

import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import { LayersPanel } from "../../src/panels/layers-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr, set, text } from "./support/frames";

afterEach(unmountAll);

/** The helpers need no scene: they take any mount. */
type AnyH = PanelHarness<unknown>;
type Layer = {
  selfId: string;
  name: string;
  visible: boolean;
  locked: boolean;
  printable: boolean;
  z: number;
};

const mount = () =>
  mountPanel(LayersPanel, { id: "paged.layers", scene: richScene });

const layers = async (h: AnyH) =>
  (await h.client.collection("layers")) as Layer[];
const layer = async (h: AnyH, id: string) =>
  (await layers(h)).find((l) => l.selfId === id);
const rows = (h: AnyH) =>
  [...h.root.querySelectorAll<HTMLElement>("[data-list-row]")].map((r) =>
    r.getAttribute("data-list-row"),
  );
const row = (h: AnyH, id: string) =>
  h.root.querySelector<HTMLElement>(`[data-list-row="${CSS.escape(id)}"]`)!;
/** A row's action, found by its current label ("Hide" / "Show", …). */
const labelled = (h: AnyH, id: string, label: string) =>
  [
    ...row(h, id).querySelectorAll<HTMLButtonElement>("[data-list-action]"),
  ].find((b) => b.textContent === label);

const LAYER_COMMANDS = [
  "paged.layers.reorder",
  "paged.layers.assignSelection",
  "paged.layers.togglePrintable",
  "paged.layers.rename",
  "paged.layers.toggleVisible",
  "paged.layers.toggleLocked",
  "paged.layers.remove",
  "paged.layers.add",
];

/** Drag one row onto another (the HTML5 drag events the list handles). */
async function drag(h: AnyH, from: string, to: string) {
  let data = "";
  const dataTransfer = {
    setData: (_type: string, v: string) => {
      data = v;
    },
    getData: () => data,
    effectAllowed: "",
    dropEffect: "",
  };
  await h.act(() => {
    fireEvent.dragStart(row(h, from), { dataTransfer });
  });
  await h.act(() => {
    fireEvent.dragOver(row(h, to), { dataTransfer });
  });
  await h.act(() => {
    fireEvent.drop(row(h, to), { dataTransfer });
  });
}

describe("Layers panel: states", () => {
  test("no document: no rows, and New layer is offered", async () => {
    covers("panel:paged.layers");
    const h = await mountPanel(LayersPanel, {
      id: "paged.layers",
      document: "none",
    });
    expect(rows(h)).toEqual([]);
    expect(h.root.querySelector('[data-action="add-layer"]')).not.toBeNull();
    expect(
      h.root.querySelector("[data-layers]")?.getAttribute("data-layers-source"),
    ).toBe("core");
  });

  test("a document with one layer: its row, its state on its actions", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    expect(rows(h)).toEqual([h.scene.layer]);
    expect(row(h, h.scene.layer).textContent).toContain("Artwork");
    expect(labelled(h, h.scene.layer, "Hide")).toBeDefined();
    expect(labelled(h, h.scene.layer, "Lock")).toBeDefined();
    expect(labelled(h, h.scene.layer, "Printable")).toBeDefined();
  });

  test("while mounted the panel's eight commands are registered", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    for (const id of LAYER_COMMANDS) {
      expect(h.registries.commands.get(id)).toBeDefined();
    }
  });

  test("Move selection here is disabled with nothing selected", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    expect(labelled(h, h.scene.layer, "Move selection here")!.disabled).toBe(
      true,
    );
    await h.select([h.scene.rect]);
    expect(labelled(h, h.scene.layer, "Move selection here")!.disabled).toBe(
      false,
    );
  });
});

describe("Layers panel: every action, through its control", () => {
  test("New layer: layerInsert at the back, and its row appears at the bottom", async () => {
    covers("panel:paged.layers", "command:paged.layers.add");
    const h = await mount();
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="add-layer"]')!);
    expect(h.mutations(from)).toEqual([
      { op: "layerInsert", args: { position: 0, name: "Layer" } },
    ] as never);
    const all = await layers(h);
    expect(all.map((l) => l.name)).toEqual(["Layer", "Artwork"]);
    // Front at top: the new back layer is the last row.
    expect(rows(h)).toEqual([h.scene.layer, all[0].selfId]);
  });

  test("Hide / Show: toggles layerVisible, and the action reads the new state", async () => {
    covers("panel:paged.layers", "command:paged.layers.toggleVisible");
    const h = await mount();
    const id = h.scene.layer;
    let from = h.mark();
    await h.click(labelled(h, id, "Hide")!);
    expect(h.mutations(from)).toEqual([
      set(`layer:${id}`, "layerVisible", { type: "bool", value: false }),
    ] as never);
    expect((await layer(h, id))?.visible).toBe(false);
    expect(labelled(h, id, "Show")).toBeDefined();
    from = h.mark();
    await h.click(labelled(h, id, "Show")!);
    expect((await layer(h, id))?.visible).toBe(true);
    expect(h.mutations(from)).toHaveLength(1);
  });

  test("Lock / Unlock: toggles layerLocked", async () => {
    covers("panel:paged.layers", "command:paged.layers.toggleLocked");
    const h = await mount();
    const id = h.scene.layer;
    const from = h.mark();
    await h.click(labelled(h, id, "Lock")!);
    expect(h.mutations(from)).toEqual([
      set(`layer:${id}`, "layerLocked", { type: "bool", value: true }),
    ] as never);
    expect((await layer(h, id))?.locked).toBe(true);
    expect(labelled(h, id, "Unlock")).toBeDefined();
  });

  test("Printable / Not printable: toggles layerPrintable", async () => {
    covers("panel:paged.layers", "command:paged.layers.togglePrintable");
    const h = await mount();
    const id = h.scene.layer;
    const from = h.mark();
    await h.click(labelled(h, id, "Printable")!);
    expect(h.mutations(from)).toEqual([
      set(`layer:${id}`, "layerPrintable", { type: "bool", value: false }),
    ] as never);
    expect((await layer(h, id))?.printable).toBe(false);
    expect(labelled(h, id, "Not printable")).toBeDefined();
  });

  test("Delete: layerRemove, and the row goes", async () => {
    covers("panel:paged.layers", "command:paged.layers.remove");
    const h = await mount();
    const id = h.scene.layer;
    const from = h.mark();
    await h.click(labelled(h, id, "Delete")!);
    expect(h.mutations(from)).toEqual([
      { op: "layerRemove", args: { layerId: id } },
    ] as never);
    expect(await layers(h)).toEqual([]);
    expect(rows(h)).toEqual([]);
  });

  test("Move selection here: the selected frame's itemLayer becomes the layer", async () => {
    covers("panel:paged.layers", "command:paged.layers.assignSelection");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.click(labelled(h, h.scene.layer, "Move selection here")!);
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "itemLayer", text(h.scene.layer)),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "itemLayer")).toEqual(
      text(h.scene.layer),
    );
  });

  test("Move selection here with two frames: one batch, one undo step", async () => {
    covers("panel:paged.layers", "command:paged.layers.assignSelection");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.textFrame]);
    const from = h.mark();
    await h.click(labelled(h, h.scene.layer, "Move selection here")!);
    expect(h.mutations(from)).toEqual([
      {
        op: "batch",
        args: {
          ops: [
            set(addr(h.scene.rect), "itemLayer", text(h.scene.layer)),
            set(addr(h.scene.textFrame), "itemLayer", text(h.scene.layer)),
          ],
        },
      },
    ] as never);
    await h.act(() => h.client.undo());
    expect(await h.get(addr(h.scene.rect), "itemLayer")).toEqual(text(""));
    expect(await h.get(addr(h.scene.textFrame), "itemLayer")).toEqual(text(""));
  });

  test("Rename: double-click the name, type, Enter writes layerName", async () => {
    covers("panel:paged.layers", "command:paged.layers.rename");
    const h = await mount();
    const id = h.scene.layer;
    await h.user.dblClick(
      row(h, id).querySelector<HTMLElement>("[data-list-row-select]")!,
    );
    await h.settle();
    const input = row(h, id).querySelector<HTMLInputElement>(
      "[data-list-rename]",
    )!;
    expect(input.value).toBe("Artwork");
    const from = h.mark();
    await h.user.clear(input);
    await h.user.type(input, "Art{Enter}");
    await h.settle();
    expect(h.mutations(from)).toEqual([
      set(`layer:${id}`, "layerName", text("Art")),
    ] as never);
    expect((await layer(h, id))?.name).toBe("Art");
    expect(row(h, id).textContent).toContain("Art");
  });

  test("Rename: Escape leaves the name as it was and sends nothing", async () => {
    covers("panel:paged.layers", "command:paged.layers.rename");
    const h = await mount();
    const id = h.scene.layer;
    await h.user.dblClick(
      row(h, id).querySelector<HTMLElement>("[data-list-row-select]")!,
    );
    await h.settle();
    const input = row(h, id).querySelector<HTMLInputElement>(
      "[data-list-rename]",
    )!;
    const from = h.mark();
    await h.user.type(input, "zzz{Escape}");
    await h.settle();
    expect(h.mutations(from)).toEqual([]);
    expect((await layer(h, id))?.name).toBe("Artwork");
  });

  test("Reorder: dragging the front layer onto the back one moves it to the back", async () => {
    covers("panel:paged.layers", "command:paged.layers.reorder");
    const h = await mount();
    await h.mutate({
      op: "layerInsert",
      args: { position: 0, name: "Back" },
    } as never);
    const back = (await layers(h)).find((l) => l.name === "Back")!.selfId;
    expect(rows(h)).toEqual([h.scene.layer, back]);
    const from = h.mark();
    await drag(h, h.scene.layer, back);
    expect(h.invoked("paged.layers.reorder")).toEqual([
      {
        id: "paged.layers.reorder",
        payload: {
          id: h.scene.layer,
          fromIndex: 1,
          toIndex: 0,
          parentId: null,
        },
      },
    ]);
    expect(h.mutations(from)).toEqual([
      { op: "layerMove", args: { layerId: h.scene.layer, newIndex: 0 } },
    ] as never);
    expect((await layers(h)).map((l) => l.name)).toEqual(["Artwork", "Back"]);
    expect(rows(h)).toEqual([back, h.scene.layer]);
  });

  test("clicking a row selects it", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    await h.click(
      row(h, h.scene.layer).querySelector("[data-list-row-select]")!,
    );
    expect(row(h, h.scene.layer).getAttribute("data-selected")).toBe("true");
  });
});

describe("Layers panel: every command, through the registry", () => {
  test("add / toggleVisible / toggleLocked / togglePrintable / rename / remove", async () => {
    covers(
      "panel:paged.layers",
      "command:paged.layers.add",
      "command:paged.layers.toggleVisible",
      "command:paged.layers.toggleLocked",
      "command:paged.layers.togglePrintable",
      "command:paged.layers.rename",
      "command:paged.layers.remove",
    );
    const h = await mount();
    const id = h.scene.layer;
    const run = (cmd: string, payload?: unknown) =>
      h.act(() => h.registries.commands.invoke(cmd, payload));
    await run("paged.layers.add");
    expect((await layers(h)).length).toBe(2);
    await run("paged.layers.toggleVisible", id);
    await run("paged.layers.toggleLocked", id);
    await run("paged.layers.togglePrintable", id);
    await run("paged.layers.rename", { id, name: "Renamed" });
    expect(await layer(h, id)).toMatchObject({
      name: "Renamed",
      visible: false,
      locked: true,
      printable: false,
    });
    await run("paged.layers.remove", id);
    expect(await layer(h, id)).toBeUndefined();
  });

  test("reorder and assignSelection", async () => {
    covers(
      "panel:paged.layers",
      "command:paged.layers.reorder",
      "command:paged.layers.assignSelection",
    );
    const h = await mount();
    const id = h.scene.layer;
    await h.mutate({
      op: "layerInsert",
      args: { position: 0, name: "Back" },
    } as never);
    await h.act(() =>
      h.registries.commands.invoke("paged.layers.reorder", { id, toIndex: 0 }),
    );
    expect((await layers(h)).map((l) => l.name)).toEqual(["Artwork", "Back"]);
    await h.select([h.scene.oval]);
    await h.act(() =>
      h.registries.commands.invoke("paged.layers.assignSelection", id),
    );
    expect(await h.get(addr(h.scene.oval), "itemLayer")).toEqual(text(id));
  });

  test("a payload the command cannot read does nothing", async () => {
    covers(
      "panel:paged.layers",
      "command:paged.layers.toggleVisible",
      "command:paged.layers.rename",
    );
    const h = await mount();
    const from = h.mark();
    await h.act(() =>
      h.registries.commands.invoke("paged.layers.toggleVisible", "Layer/none"),
    );
    await h.act(() =>
      h.registries.commands.invoke("paged.layers.rename", {
        id: h.scene.layer,
      }),
    );
    expect(h.mutations(from)).toEqual([]);
  });
});

describe("Layers panel: Layer Options", () => {
  test("the section edits the layer's name and flags, and shows the selection's layer", async () => {
    covers("panel:paged.layers");
    const h = await mount();
    await h.click(h.view.getByRole("button", { name: "Layer Options" }));
    const opts = h.root.querySelector("[data-layer-options]")!;
    expect(opts.getAttribute("data-layer-options")).toBe(
      `layer:${h.scene.layer}`,
    );
    let from = h.mark();
    await h.typeInto("layerName", "Art 2");
    expect(h.mutations(from)).toEqual([
      set(`layer:${h.scene.layer}`, "layerName", text("Art 2")),
    ] as never);
    expect((await layer(h, h.scene.layer))?.name).toBe("Art 2");
    from = h.mark();
    await h.click(h.field("layerLocked").querySelector('[role="switch"]')!);
    expect(h.mutations(from)).toEqual([
      set(`layer:${h.scene.layer}`, "layerLocked", {
        type: "bool",
        value: true,
      }),
    ] as never);
    expect((await layer(h, h.scene.layer))?.locked).toBe(true);
  });
});
