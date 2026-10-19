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

// The two schema consumer proofs (devOnly): panels declared as a
// PanelSchema and rendered through the host's SchemaPanelRenderer inside
// the app's catalog registry, as main.tsx's HostSchemaPanelRenderer does
// for every bundle schema panel. Each registers its demo commands while
// mounted; the tests drive them through the rendered list and through the
// registry.

import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent } from "@testing-library/react";
import { covers } from "@paged-media/test-kit";

import {
  DEMO_APPLY_STROKE_COMMAND,
  SchemaListDemoPanel,
} from "../../src/panels/schema-list-demo-panel";
import {
  DEMO_MOVE_LAYER_COMMAND,
  DEMO_RENAME_LAYER_COMMAND,
  SchemaTreeDemoPanel,
} from "../../src/panels/schema-tree-demo-panel";
import { apply, richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const listMount = () =>
  mountPanel(SchemaListDemoPanel, {
    id: "paged.schema-list-demo",
    scene: richScene,
  });

const rowsOf = (scope: Element) =>
  [...scope.querySelectorAll<HTMLElement>("[data-list-row]")].map((r) =>
    r.getAttribute("data-list-row"),
  );

describe("Swatch list (schema), paged.schema-list-demo", () => {
  test("one row per swatch of the document, Fill needs a selection", async () => {
    covers("panel:paged.schema-list-demo");
    const h = await listMount();
    const swatches = (await h.client.collection("swatches")) as Array<{
      selfId: string;
    }>;
    expect(rowsOf(h.root)).toEqual(swatches.map((s) => s.selfId));
    const fill = h.view.getByRole("button", {
      name: "Fill: Red",
    }) as HTMLButtonElement;
    expect(fill.disabled).toBe(true);
    await h.select([h.scene.rect]);
    expect(fill.disabled).toBe(false);
  });

  test("selecting a row publishes the selection binding (the readout shows)", async () => {
    covers("panel:paged.schema-list-demo");
    const h = await listMount();
    // (The panel's local bindings are module state, so a row selected by
    // an earlier test in this process can still be published here; the
    // assertion is that a click publishes one.)
    await h.click(
      h.root.querySelector(
        `[data-list-row="${h.scene.red}"] [data-list-row-select]`,
      )!,
    );
    expect(h.root.textContent).toContain("swatch row selected");
  });

  test("Fill applies the row's swatch to the selection (an applyEntity write)", async () => {
    covers("panel:paged.schema-list-demo");
    const h = await listMount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.click(h.view.getByRole("button", { name: "Fill: Red" }));
    const address = `rectangle:${String(h.scene.rect.id)}`;
    expect(h.mutations(from)).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: h.scene.rect,
          path: "frameFillColor",
          value: { type: "colorRef", value: h.scene.red },
        },
      },
    ] as never);
    expect(await h.get(address, "frameFillColor")).toEqual({
      type: "colorRef",
      value: h.scene.red,
    });
  });

  test("Stroke runs the panel's command with the row id, which strokes the selection", async () => {
    covers(
      "panel:paged.schema-list-demo",
      "command:paged.demo.applySwatchStroke",
    );
    const h = await listMount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.click(h.view.getByRole("button", { name: "Stroke: Spot" }));
    expect(h.invoked(DEMO_APPLY_STROKE_COMMAND)).toEqual([
      { id: DEMO_APPLY_STROKE_COMMAND, payload: h.scene.spot },
    ]);
    expect(h.mutations(from)).toEqual([
      {
        op: "setElementProperty",
        args: {
          elementId: h.scene.rect,
          path: "frameStrokeColor",
          value: { type: "colorRef", value: h.scene.spot },
        },
      },
    ] as never);
    expect((await h.props(h.scene.rect)).frameStrokeColor).toEqual({
      type: "colorRef",
      value: h.scene.spot,
    });
  });

  test("the command through the registry does the same, and refuses a payload that is not an id", async () => {
    covers(
      "command:paged.demo.applySwatchStroke",
      "panel:paged.schema-list-demo",
    );
    const h = await listMount();
    await h.select([h.scene.oval]);
    let from = h.mark();
    await h.act(() =>
      h.registries.commands.invoke(DEMO_APPLY_STROKE_COMMAND, h.scene.red),
    );
    expect(h.mutations(from)).toHaveLength(1);
    expect((await h.props(h.scene.oval)).frameStrokeColor).toEqual({
      type: "colorRef",
      value: h.scene.red,
    });
    from = h.mark();
    await h.act(() =>
      h.registries.commands.invoke(DEMO_APPLY_STROKE_COMMAND, 42),
    );
    expect(h.mutations(from)).toEqual([]);
  });

  // Every panel write over a multi-selection is one batch (one undo step),
  // the demo command's too.
  test("PN-356: Stroke over two frames is one batch, one undo step", async () => {
    covers(
      "panel:paged.schema-list-demo",
      "command:paged.demo.applySwatchStroke",
    );
    const h = await listMount();
    await h.select([h.scene.rect, h.scene.groupA]);
    const from = h.mark();
    await h.click(h.view.getByRole("button", { name: "Stroke: Red" }));
    expect(h.mutations(from)).toHaveLength(1);
  });
});

const treeMount = () =>
  mountPanel(SchemaTreeDemoPanel, {
    id: "paged.schema-tree-demo",
    scene: async (ctx) => {
      const scene = await richScene(ctx);
      await apply(ctx.client, {
        op: "layerInsert",
        args: { position: 1, name: "Second" },
      } as never);
      return scene;
    },
  });

const section = (h: H, title: string) =>
  h.root.querySelector<HTMLElement>(`[data-schema-section="${title}"]`)!;

/** An HTML5 drag of one row onto another, as the list leaf handles it. */
function drag(from: Element, to: Element) {
  const data = new Map<string, string>();
  const dataTransfer = {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    effectAllowed: "move",
    dropEffect: "move",
  };
  fireEvent.dragStart(from, { dataTransfer });
  fireEvent.dragOver(to, { dataTransfer });
  fireEvent.drop(to, { dataTransfer });
  fireEvent.dragEnd(from, { dataTransfer });
}

describe("Structure (schema tree), paged.schema-tree-demo", () => {
  test("the structure tree mirrors the engine's scene tree, nested", async () => {
    covers("panel:paged.schema-tree-demo");
    const h = await treeMount();
    const rows = rowsOf(section(h, "Structure"));
    expect(rows).toContain(String(h.scene.rect.id));
    const group = section(h, "Structure").querySelector(
      `[data-list-row="${String(h.scene.group.id)}"]`,
    )!;
    const child = section(h, "Structure").querySelector(
      `[data-list-row="${String(h.scene.groupA.id)}"]`,
    )!;
    expect(Number(child.getAttribute("data-list-depth"))).toBe(
      Number(group.getAttribute("data-list-depth")) + 1,
    );
  });

  test("a twisty collapses a node's children, and the collapsed list starts closed", async () => {
    covers("panel:paged.schema-tree-demo");
    const h = await treeMount();
    const structure = section(h, "Structure");
    const groupId = String(h.scene.group.id);
    expect(rowsOf(structure)).toContain(String(h.scene.groupA.id));
    await h.click(structure.querySelector(`[data-list-twisty="${groupId}"]`)!);
    expect(rowsOf(structure)).not.toContain(String(h.scene.groupA.id));
    expect(rowsOf(section(h, "Collapsed"))).not.toContain(
      String(h.scene.rect.id),
    );
  });

  test("dragging a frame onto another reorders it in the engine", async () => {
    covers("panel:paged.schema-tree-demo");
    const h = await treeMount();
    const structure = section(h, "Structure");
    const row = (id: unknown) =>
      structure.querySelector(`[data-list-row="${String(id)}"]`)!;
    const from = h.mark();
    await h.act(() => drag(row(h.scene.rect.id), row(h.scene.oval.id)));
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { elementId: unknown };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("reorderElement");
    expect(sent[0].args.elementId).toEqual(h.scene.rect);
  });

  test("a layer renamed in place runs the rename command, which renames the layer", async () => {
    covers("panel:paged.schema-tree-demo", "command:paged.demo.renameLayer");
    const h = await treeMount();
    const layers = section(h, "Layers");
    await h.user.dblClick(
      layers.querySelector(
        `[data-list-row="${h.scene.layer}"] [data-list-row-select]`,
      )!,
    );
    const input = layers.querySelector<HTMLInputElement>("[data-list-rename]")!;
    await h.user.clear(input);
    const from = h.mark();
    await h.user.type(input, "Art{Enter}");
    await h.settle();
    expect(h.invoked(DEMO_RENAME_LAYER_COMMAND).map((i) => i.payload)).toEqual([
      { id: h.scene.layer, name: "Art" },
    ]);
    expect(h.mutations(from)).toEqual([
      { op: "layerSetName", args: { layerId: h.scene.layer, name: "Art" } },
    ] as never);
    const names = (
      (await h.client.collection("layers")) as Array<{
        selfId: string;
        name: string;
      }>
    ).find((l) => l.selfId === h.scene.layer)?.name;
    expect(names).toBe("Art");
  });

  test("dragging a layer runs the move command, which moves the layer", async () => {
    covers("panel:paged.schema-tree-demo", "command:paged.demo.moveLayer");
    const h = await treeMount();
    const layers = section(h, "Layers");
    const ids = rowsOf(layers);
    expect(ids).toHaveLength(2);
    const before = ids;
    const from = h.mark();
    await h.act(() =>
      drag(
        layers.querySelector(`[data-list-row="${ids[0]}"]`)!,
        layers.querySelector(`[data-list-row="${ids[1]}"]`)!,
      ),
    );
    expect(h.invoked(DEMO_MOVE_LAYER_COMMAND)).toHaveLength(1);
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { layerId: string };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("layerMove");
    expect(sent[0].args.layerId).toBe(before[0]);
    expect(rowsOf(section(h, "Layers"))).toEqual([before[1], before[0]]);
  });

  // The inline rename opens only on a double-click; a keyboard user has
  // no way to start it.
  test.failing(
    "PN-357: a layer's inline rename can be started from the keyboard",
    async () => {
      covers("panel:paged.schema-tree-demo");
      const h = await treeMount();
      const layers = section(h, "Layers");
      const select = layers.querySelector<HTMLElement>(
        `[data-list-row="${h.scene.layer}"] [data-list-row-select]`,
      )!;
      select.focus();
      await h.user.keyboard("{F2}");
      await h.settle();
      if (!layers.querySelector("[data-list-rename]")) {
        await h.user.keyboard("{Enter}");
        await h.settle();
      }
      expect(layers.querySelector("[data-list-rename]")).not.toBeNull();
    },
  );
});
