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

// Color Wheel (paged.color-wheel): the HSV wheel with synced HEX / RGB /
// CMYK / HSL fields and colour-theory harmonies. Its writes are swatches:
// a double-click on the chip adds the current colour, "Add to Swatches"
// adds the harmony palette as ONE batch (one undo step). Dragging on the
// wheel is browser work; the typed fields and buttons are asserted here.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { ColorWheelPanel } from "../../src/panels/color-wheel-panel";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

const mount = () =>
  mountPanel(ColorWheelPanel, { id: "paged.color-wheel", document: "blank" });

const field = (h: PanelHarness<unknown>, label: string) =>
  h.root.querySelector<HTMLInputElement>(`[data-wheel-field="${label}"]`)!;
const palette = (h: PanelHarness<unknown>) =>
  [...h.root.querySelectorAll<HTMLElement>("[data-wheel-palette-swatch]")].map(
    (b) => b.getAttribute("title"),
  );
const swatchNames = async (h: PanelHarness<unknown>) =>
  ((await h.client.collection("swatches")) as Array<{ name: string }>).map(
    (s) => s.name,
  );

describe("Color Wheel panel: states", () => {
  test("opens on HEX with a triadic harmony of three colours", async () => {
    covers("panel:paged.color-wheel");
    const h = await mount();
    expect(
      h.root
        .querySelector('[data-wheel-model="HEX"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
    expect(
      h.root
        .querySelector('[data-wheel-harmony="Triadic"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
    expect(palette(h)).toHaveLength(3);
    expect(field(h, "HEX").value).toMatch(/^#[0-9A-F]{6}$/);
  });

  test("no document: the wheel still authors colours (nothing is sent until a swatch is added)", async () => {
    covers("panel:paged.color-wheel");
    const h = await mountPanel(ColorWheelPanel, {
      id: "paged.color-wheel",
      document: "none",
    });
    expect(h.sent("mutate")).toEqual([]);
    expect(field(h, "HEX")).not.toBeNull();
  });
});

describe("Color Wheel panel: controls", () => {
  test("HEX: typing #FF0000 makes red the base colour of the palette", async () => {
    covers("panel:paged.color-wheel");
    const h = await mount();
    await h.typeInto(field(h, "HEX"), "#FF0000");
    expect(field(h, "HEX").value).toBe("#FF0000");
    expect(palette(h)[0]).toBe("#FF0000");
  });

  test("the model tabs show that model's fields, in sync: RGB of red is 255 0 0", async () => {
    covers("panel:paged.color-wheel");
    const h = await mount();
    await h.typeInto(field(h, "HEX"), "#FF0000");
    await h.click(h.root.querySelector('[data-wheel-model="RGB"]')!);
    expect(["R", "G", "B"].map((l) => field(h, l)?.value)).toEqual([
      "255",
      "0",
      "0",
    ]);
    await h.typeInto(field(h, "G"), "255");
    await h.click(h.root.querySelector('[data-wheel-model="HEX"]')!);
    expect(field(h, "HEX").value).toBe("#FFFF00");
  });

  test("a harmony button changes the palette: Complementary has two colours", async () => {
    covers("panel:paged.color-wheel");
    const h = await mount();
    await h.click(
      h.root.querySelector('[data-wheel-harmony="Complementary"]')!,
    );
    expect(palette(h)).toHaveLength(2);
    await h.click(h.root.querySelector('[data-wheel-harmony="Tetradic"]')!);
    expect(palette(h)).toHaveLength(4);
  });

  test("a palette colour becomes the base colour when clicked", async () => {
    covers("panel:paged.color-wheel");
    const h = await mount();
    const second = palette(h)[1]!;
    await h.click(h.root.querySelector('[data-wheel-palette-swatch="1"]')!);
    expect(field(h, "HEX").value).toBe(second);
  });

  test("Add to Swatches: the palette as ONE batch of createSwatch, named by hex; one undo removes it all", async () => {
    covers("panel:paged.color-wheel");
    const h = await mount();
    await h.typeInto(field(h, "HEX"), "#FF0000");
    const colours = palette(h) as string[];
    const before = await swatchNames(h);
    const from = h.mark();
    await h.click(h.root.querySelector("[data-wheel-add-palette]")!);
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: {
        ops: Array<{ op: string; args: { spec: Record<string, unknown> } }>;
      };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("batch");
    expect(sent[0].args.ops.map((o) => o.op)).toEqual(
      colours.map(() => "createSwatch"),
    );
    expect(sent[0].args.ops[0].args.spec).toEqual({
      selfId: null,
      name: "FF0000",
      space: "RGB",
      value: [255, 0, 0],
      model: "Process",
      alternateSpace: null,
      alternateValue: [],
      tint: null,
      alpha: null,
    });
    const after = await swatchNames(h);
    for (const c of colours) expect(after).toContain(c.replace("#", ""));
    await h.act(() => h.client.undo());
    expect(await swatchNames(h)).toEqual(before);
  });

  test("double-click on the chip adds the base colour as one swatch", async () => {
    covers("panel:paged.color-wheel");
    const h = await mount();
    await h.typeInto(field(h, "HEX"), "#00FF00");
    const from = h.mark();
    await h.user.dblClick(h.root.querySelector("[data-wheel-chip]")!);
    await h.settle();
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { spec: { name: string; value: number[] } };
    }>;
    expect(sent.map((m) => m.op)).toEqual(["createSwatch"]);
    expect(sent[0].args.spec.name).toBe("00FF00");
    expect(sent[0].args.spec.value).toEqual([0, 255, 0]);
    expect(await swatchNames(h)).toContain("00FF00");
  });
});
