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

// Editor ADR 309 — Transparency (paged.transparency): blend and opacity
// on the selection; the opacity mask — Make from two selected items (the
// top one masks), the thumbnail of the artwork alone, Clip, Invert and
// the mode (each one write, one undo step), Edit Mask (the artwork is
// selected while it masks) and Release.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import type { ElementId, Mutation } from "@paged-media/client";

import { TransparencyPanel } from "../../src/panels/transparency-panel";
import {
  apply,
  shapesScene,
  type ShapesScene,
  type SceneBuilder,
} from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr, bool, len, set, text } from "./support/frames";

afterEach(unmountAll);

type Scene = ShapesScene & { art: ElementId };
type H = PanelHarness<Scene>;

/** The shapes, and a black rectangle over the plain one: the artwork. */
const scene: SceneBuilder<Scene> = async (ctx) => {
  const shapes = await shapesScene(ctx);
  const made = await apply(ctx.client, {
    op: "insertFrame",
    args: { pageId: shapes.pageId, bounds: [420, 100, 480, 180] },
  } as Mutation);
  const art = made.createdId!;
  await apply(ctx.client, {
    op: "setElementProperty",
    args: {
      elementId: art,
      path: "frameFillColor",
      value: { type: "colorRef", value: "Color/Black" },
    },
  } as Mutation);
  return { ...shapes, art };
};

const mount = () =>
  mountPanel(TransparencyPanel, { id: "paged.transparency", scene });

const q = <E extends Element = HTMLElement>(h: H, sel: string) =>
  h.root.querySelector<E>(sel);
const action = (h: H, a: string) =>
  q<HTMLButtonElement>(h, `[data-mask-action="${a}"]`);
const state = (h: H) =>
  q(h, "[data-transparency-panel]")!.getAttribute("data-mask-state");
const pill = (h: H, name: string) =>
  q<HTMLButtonElement>(h, `[data-toggle-switch="${name}"]`)!;

async function makeMask(h: H) {
  await h.select([h.scene.rect, h.scene.art]);
  await h.click(action(h, "make")!);
  // The engine holds the relation; the target is selected again.
  expect(await h.get(addr(h.scene.rect), "opacityMask")).toEqual(
    text(String(h.scene.art.id)),
  );
}

describe("Transparency panel", () => {
  test("blend and opacity write the selection", async () => {
    covers("panel:paged.transparency");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(state(h)).toBe("none");
    let from = h.mark();
    await h.choose(
      q<HTMLSelectElement>(h, "select[data-transparency-blend]")!,
      "Multiply",
    );
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameBlendMode", text("Multiply")),
    ] as never);
    from = h.mark();
    await h.typeInto(
      q<HTMLInputElement>(h, 'input[aria-label="Opacity"]')!,
      "40",
    );
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameOpacity", len(40)),
    ] as never);
  });

  test("the blend list is the schema row's", async () => {
    covers("panel:paged.transparency");
    const h = await mount();
    await h.select([h.scene.rect]);
    const modes = [
      ...q<HTMLSelectElement>(h, "select[data-transparency-blend]")!.options,
    ].map((o) => o.value);
    expect(modes).toContain("Luminosity");
    expect(modes).toContain("Multiply");
  });

  test("Make needs two items; the top one becomes the mask", async () => {
    covers("panel:paged.transparency");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(action(h, "make")!.disabled).toBe(true);
    await makeMask(h);
    expect(state(h)).toBe("masked");
    expect(action(h, "release")).not.toBeNull();
    expect(q(h, "[data-mask-thumbnail]")).not.toBeNull();
    // The artwork left the page's paint order.
    await h.act(() => h.client.undo());
    expect(await h.get(addr(h.scene.rect), "opacityMask")).toEqual(text(""));
  });

  test("Clip, Invert and the mode: one write and one undo step each", async () => {
    covers("panel:paged.transparency");
    const h = await mount();
    await makeMask(h);
    const target = addr(h.scene.rect);
    expect(pill(h, "mask:clip").getAttribute("aria-checked")).toBe("true");
    let from = h.mark();
    await h.click(pill(h, "mask:clip"));
    expect(h.mutations(from)).toEqual([
      set(target, "opacityMaskClip", bool(false)),
    ] as never);
    expect(await h.get(target, "opacityMaskClip")).toEqual(bool(false));
    from = h.mark();
    await h.click(pill(h, "mask:invert"));
    expect(h.mutations(from)).toHaveLength(1);
    expect(await h.get(target, "opacityMaskInvert")).toEqual(bool(true));
    from = h.mark();
    await h.choose(q<HTMLSelectElement>(h, "select[data-mask-mode]")!, "alpha");
    expect(h.mutations(from)).toHaveLength(1);
    expect(await h.get(target, "opacityMaskType")).toEqual(text("alpha"));
    await h.act(() => h.client.undo());
    await h.act(() => h.client.undo());
    expect(await h.get(target, "opacityMaskInvert")).toEqual(bool(false));
    expect(await h.get(target, "opacityMaskClip")).toEqual(bool(false));
    await h.act(() => h.client.undo());
    expect(await h.get(target, "opacityMaskClip")).toEqual(bool(true));
    // Still the same mask.
    expect(await h.get(target, "opacityMask")).toEqual(
      text(String(h.scene.art.id)),
    );
  });

  test("Edit Mask selects the artwork while it masks; Stop returns", async () => {
    covers("panel:paged.transparency");
    const h = await mount();
    await makeMask(h);
    await h.click(action(h, "edit")!);
    expect(state(h)).toBe("editing");
    expect(h.paged.selection.elementSelection).toEqual([h.scene.art]);
    // A panel edits the artwork: its fill, through the object model.
    await h.mutate({
      op: "set",
      args: {
        address: addr(h.scene.art),
        path: "frameFillColor",
        value: { type: "colorRef", value: "Color/Paper" },
      },
    } as Mutation);
    expect(await h.get(addr(h.scene.rect), "opacityMask")).toEqual(
      text(String(h.scene.art.id)),
    );
    await h.click(action(h, "stop")!);
    expect(state(h)).toBe("masked");
    expect(h.paged.selection.elementSelection).toEqual([h.scene.rect]);
  });

  test("Release gives the artwork back", async () => {
    covers("panel:paged.transparency");
    const h = await mount();
    await makeMask(h);
    const from = h.mark();
    await h.click(action(h, "release")!);
    expect(h.mutations(from)).toEqual([
      { op: "releaseOpacityMask", args: { targetId: h.scene.rect } },
    ] as never);
    expect(await h.get(addr(h.scene.rect), "opacityMask")).toEqual(text(""));
    expect(state(h)).toBe("none");
  });
});
