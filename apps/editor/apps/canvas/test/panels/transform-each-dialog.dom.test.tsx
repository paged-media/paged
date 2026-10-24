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

// Object ▸ Transform ▸ Transform each… (WP4.4), over the real engine: the
// dialog runs paged.object.transformEach over the selection it opened
// with — each object about its own reference point, ONE undo step — and
// its preview applies the command for real, taking it back before every
// change and on Cancel / Escape.

import { afterEach, describe, expect, test } from "bun:test";
import { createCommandRegistry } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  buildTransformEachDialogCommands,
  TRANSFORM_EACH_MENU_ITEMS,
  TransformEachDialog,
} from "../../src/panels/transform-each-dialog";
import { TRANSFORM_EACH_COMMAND } from "../../src/transform-each-plan";
import { buildTransformCommands } from "../../src/transform-commands";
import { transformBounds, type Affine } from "../../src/transform-targets";
import { shapesScene, type ShapesScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr } from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<ShapesScene>;

const q = <T extends Element = HTMLElement>(h: H, sel: string) =>
  document.querySelector<T>(sel) ?? h.root.querySelector<T>(sel);

async function mount(selected: (s: ShapesScene) => unknown[]) {
  const h = await mountPanel(TransformEachDialog, {
    id: "paged.object.transformEach",
    scene: shapesScene,
  });
  for (const c of buildTransformCommands(h.objects.registry))
    h.registries.commands.register(c);
  if (!h.registries.commands.get("paged.editor.undo")) {
    h.registries.commands.register({
      id: "paged.editor.undo",
      title: "Undo",
      category: "Edit",
      handler: () => h.client.undo(),
    });
  }
  const ids = selected(h.scene);
  // The menu row's command opens the dialog over the selection.
  const registry = createCommandRegistry(() => ({
    scope: h.scope,
    selection: { elementSelection: ids },
  }));
  for (const c of buildTransformEachDialogCommands(() =>
    ids.map((id) => addr(id as never)),
  ))
    registry.register(c);
  await h.act(() => registry.invoke("paged.object.transformEachDialog"));
  await h.settle();
  return h;
}

/** Let the preview's debounce and its writes run. */
async function idle(h: H) {
  for (let i = 0; i < 4; i++) {
    await h.act(() => new Promise((r) => setTimeout(r, 90)));
    await h.settle();
  }
}

async function shown(h: H, id: ShapesScene["rect"]) {
  const [g] = await h.client.elementGeometry([id]);
  return transformBounds(
    g!.bounds as [number, number, number, number],
    (g!.itemTransform ?? null) as Affine | null,
  ).map((v) => Math.round(v * 100) / 100);
}

const input = (h: H, label: string) =>
  q<HTMLInputElement>(h, `input[aria-label="${label}"]`)!;
const check = (h: H, name: string) =>
  q<HTMLInputElement>(h, `[data-transform-each-check="${name}"]`)!;

describe("Transform each… [editor-shell.align-transform-each]", () => {
  test("the Object ▸ Transform menu row opens the dialog", async () => {
    covers(
      "menu:Object/Transform/Transform each…",
      "command:paged.object.transformEachDialog",
    );
    expect(TRANSFORM_EACH_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      ["Object/Transform/Transform each…", "paged.object.transformEachDialog"],
    ]);
    const h = await mount((s) => [s.rect]);
    expect(q(h, "[data-transform-each-dialog]")).not.toBeNull();
    await h.click(q(h, "[data-transform-each-cancel]")!);
    await idle(h);
    expect(q(h, "[data-transform-each-dialog]")).toBeNull();
  });

  test("OK scales every object about its own centre, in ONE undo step", async () => {
    covers(
      "command:paged.object.transformEach",
      "command:paged.object.transformEachDialog",
    );
    const h = await mount((s) => [s.rect, s.oval]);
    await h.typeInto(input(h, "Scale Horizontal"), "50");
    await h.typeInto(input(h, "Scale Vertical"), "50");
    const from = h.mark();
    await h.click(q(h, "[data-transform-each-ok]")!);
    await idle(h);
    expect(q(h, "[data-transform-each-dialog]")).toBeNull();
    expect(h.invoked(TRANSFORM_EACH_COMMAND)).toHaveLength(1);
    expect(h.mutations(from)).toHaveLength(1);
    // rect [400, 72, 500, 200] → centre (136, 450); oval about its own.
    expect(await shown(h, h.scene.rect)).toEqual([425, 104, 475, 168]);
    expect(await shown(h, h.scene.oval)).toEqual([425, 325, 475, 375]);
    await h.act(() => h.client.undo());
    expect(await shown(h, h.scene.rect)).toEqual([400, 72, 500, 200]);
    expect(await shown(h, h.scene.oval)).toEqual([400, 300, 500, 400]);
  });

  test("the reference point and reflect: a top-left move and a flip about it", async () => {
    covers("command:paged.object.transformEach");
    const h = await mount((s) => [s.rect]);
    await h.click(q(h, '[data-reference-cell="0"]')!);
    await h.click(check(h, "reflect-y"));
    await h.click(q(h, "[data-transform-each-ok]")!);
    await idle(h);
    // Mirrored left ↔ right about its left edge (x 72).
    expect(await shown(h, h.scene.rect)).toEqual([400, -56, 500, 72]);
  });

  test("Preview applies for real, re-applies on a change, and Cancel takes it back", async () => {
    covers("command:paged.object.transformEach");
    const h = await mount((s) => [s.rect]);
    await h.typeInto(input(h, "Move Horizontal"), "10");
    await idle(h);
    // No preview yet: nothing written.
    expect(h.invoked(TRANSFORM_EACH_COMMAND)).toHaveLength(0);
    await h.click(check(h, "preview"));
    await idle(h);
    expect(await shown(h, h.scene.rect)).toEqual([400, 82, 500, 210]);
    await h.typeInto(input(h, "Move Horizontal"), "20");
    await idle(h);
    // The first preview was taken back before the second: moved 20, not 30.
    expect(await shown(h, h.scene.rect)).toEqual([400, 92, 500, 220]);
    await h.click(q(h, "[data-transform-each-cancel]")!);
    await idle(h);
    expect(q(h, "[data-transform-each-dialog]")).toBeNull();
    expect(await shown(h, h.scene.rect)).toEqual([400, 72, 500, 200]);
  });

  test("OK keeps the previewed step: one undo puts everything back", async () => {
    covers("command:paged.object.transformEach");
    const h = await mount((s) => [s.rect]);
    await h.click(check(h, "preview"));
    await h.typeInto(input(h, "Move Vertical"), "15");
    await idle(h);
    const calls = h.invoked(TRANSFORM_EACH_COMMAND).length;
    await h.click(q(h, "[data-transform-each-ok]")!);
    await idle(h);
    // OK applied nothing more: the preview is the step.
    expect(h.invoked(TRANSFORM_EACH_COMMAND)).toHaveLength(calls);
    expect(await shown(h, h.scene.rect)).toEqual([415, 72, 515, 200]);
    await h.act(() => h.client.undo());
    expect(await shown(h, h.scene.rect)).toEqual([400, 72, 500, 200]);
  });

  test("Escape cancels a preview", async () => {
    covers("command:paged.object.transformEach");
    const h = await mount((s) => [s.rect]);
    await h.click(check(h, "preview"));
    await h.typeInto(input(h, "Angle"), "90");
    await idle(h);
    expect(await shown(h, h.scene.rect)).not.toEqual([400, 72, 500, 200]);
    await h.act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await idle(h);
    expect(q(h, "[data-transform-each-dialog]")).toBeNull();
    expect(await shown(h, h.scene.rect)).toEqual([400, 72, 500, 200]);
  });
});
