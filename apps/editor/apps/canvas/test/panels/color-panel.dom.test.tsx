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

// Color (paged.color): the Fill and Tint fields on the selection, the
// mixer (channels per space, hex, tint; Apply and Add to Swatches), the
// applied colour's readout, and the hand-off to the colour wheel. With
// nothing selected, Apply targets the document's default fill (W2.5).
// The mixer's sliders and the wheel's drag are browser work; the typed
// fields are asserted here.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { cockpitActions } from "@paged-media/shell";

import { ColorPanel } from "../../src/panels/color-panel";
import { ColorWheelPanel } from "../../src/panels/color-wheel-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { settleTimers } from "./support/styles";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(ColorPanel, { id: "paged.color", scene: richScene });

const panel = (h: H) => h.root.querySelector("[data-color-panel]")!;
const channelInputs = (h: H) => [
  ...h.root.querySelectorAll<HTMLInputElement>("[data-mixer-channel] input"),
];
const rectAddress = (h: H) => `rectangle:${String(h.scene.rect.id)}`;

/** The swatches the engine holds, newest last. */
const swatchIds = async (h: H) =>
  ((await h.client.collection("swatches")) as Array<{ selfId: string }>).map(
    (s) => s.selfId,
  );

describe("Color panel: states", () => {
  test("nothing selected: the panel targets the document default fill and says so", async () => {
    covers("panel:paged.color");
    const h = await mount();
    expect(panel(h).getAttribute("data-target")).toBe("document-default");
    expect(h.root.querySelector("[data-doc-default-hint]")).not.toBeNull();
    expect(
      (h.field("frameFillColor").querySelector("select") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
  });

  test("a frame selected: the panel targets the selection", async () => {
    covers("panel:paged.color");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(panel(h).getAttribute("data-target")).toBe("selection");
    expect(h.root.querySelector("[data-doc-default-hint]")).toBeNull();
  });

  test("the mixer starts on CMYK process black, four channels, the preview resolved by the engine", async () => {
    covers("panel:paged.color");
    const h = await mount();
    await settleTimers(h);
    expect(
      h.root
        .querySelector('[data-mixer-space="CMYK"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
    expect(channelInputs(h).map((i) => i.value)).toEqual([
      "0",
      "0",
      "0",
      "100",
    ]);
    expect(h.sent("requestColorCompute").length).toBeGreaterThan(0);
    expect(
      h.root.querySelector<HTMLInputElement>("[data-mixer-hex]")!.value,
    ).not.toBe("808080");
  });
});

describe("Color panel: controls", () => {
  test("Fill: picking a swatch sets the selection's fill and the readout follows", async () => {
    covers("panel:paged.color");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.choose("frameFillColor", h.scene.red);
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address: rectAddress(h),
          path: "frameFillColor",
          value: { type: "colorRef", value: h.scene.red },
        },
      },
    ] as never);
    expect(await h.get(rectAddress(h), "frameFillColor")).toEqual({
      type: "colorRef",
      value: h.scene.red,
    });
    const preview = h.root.querySelector("[data-color-preview]");
    expect(preview?.textContent).toContain("Red");
    expect(preview?.querySelector("[data-color-cmyk]")?.textContent).toBe(
      "0% / 100% / 100% / 0%",
    );
  });

  test("Tint: typing 40 writes frameFillTint 40", async () => {
    covers("panel:paged.color");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto("frameFillTint", "40");
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { address: string; path: string; value: { value: number } };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toMatchObject({
      address: rectAddress(h),
      path: "frameFillTint",
    });
    expect(sent[0].args.value.value).toBe(40);
    expect(
      (await h.get(rectAddress(h), "frameFillTint")) as { value: number },
    ).toMatchObject({ value: 40 });
  });

  test("Apply with a frame selected: an unnamed swatch from the channels, applied as the fill", async () => {
    covers("panel:paged.color");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.typeInto(channelInputs(h)[0], "60");
    const from = h.mark();
    await h.click(h.root.querySelector("[data-mixer-apply]")!);
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: Record<string, unknown>;
    }>;
    expect(sent[0]).toEqual({
      op: "createSwatch",
      args: {
        spec: {
          selfId: null,
          name: null,
          space: "CMYK",
          value: [60, 0, 0, 100],
          model: "Process",
          alternateSpace: null,
          alternateValue: [],
          tint: null,
          alpha: null,
        },
      },
    });
    const created = (await swatchIds(h)).at(-1)!;
    expect(sent[1]).toEqual({
      op: "set",
      args: {
        address: rectAddress(h),
        path: "frameFillColor",
        value: { type: "colorRef", value: created },
      },
    });
    expect(await h.get(rectAddress(h), "frameFillColor")).toEqual({
      type: "colorRef",
      value: created,
    });
  });

  test("Apply with nothing selected: the new swatch becomes the document default fill", async () => {
    covers("panel:paged.color");
    const h = await mount();
    await h.typeInto(channelInputs(h)[1], "30");
    const from = h.mark();
    await h.click(h.root.querySelector("[data-mixer-apply]")!);
    const created = (await swatchIds(h)).at(-1)!;
    expect(
      (h.mutations(from) as unknown as Array<{ op: string }>).map((m) => m.op),
    ).toContain("createSwatch");
    expect((await h.client.documentMeta()).defaultFillColor).toBe(created);
    expect(h.root.querySelector("[data-color-preview]")).not.toBeNull();
  });

  test("+ Add to Swatches names the mixed colour New swatch and adds it", async () => {
    covers("panel:paged.color");
    const h = await mount();
    await h.typeInto(channelInputs(h)[2], "80");
    const before = (await swatchIds(h)).length;
    const from = h.mark();
    await h.click(h.root.querySelector("[data-mixer-add-swatch]")!);
    expect(h.mutations(from)).toEqual([
      {
        op: "createSwatch",
        args: {
          spec: {
            selfId: null,
            name: "New swatch",
            space: "CMYK",
            value: [0, 0, 80, 100],
            model: "Process",
            alternateSpace: null,
            alternateValue: [],
            tint: null,
            alpha: null,
          },
        },
      },
    ] as never);
    expect((await swatchIds(h)).length).toBe(before + 1);
  });

  test("the space tabs show that space's channels: RGB has three", async () => {
    covers("panel:paged.color");
    const h = await mount();
    await h.click(h.root.querySelector('[data-mixer-space="RGB"]')!);
    expect(channelInputs(h)).toHaveLength(3);
    await h.click(h.root.querySelector('[data-mixer-space="Gray"]')!);
    expect(channelInputs(h)).toHaveLength(1);
  });

  test("hex: typing ff0000 makes the mixed colour RGB red, and Add to Swatches carries it", async () => {
    covers("panel:paged.color");
    const h = await mount();
    const hex = h.root.querySelector<HTMLInputElement>("[data-mixer-hex]")!;
    await h.typeInto(hex, "ff0000");
    const from = h.mark();
    await h.click(h.root.querySelector("[data-mixer-add-swatch]")!);
    const sent = h.mutations(from) as unknown as Array<{
      args: { spec: { space: string; value: number[] } };
    }>;
    expect(sent[0].args.spec.space).toBe("RGB");
    expect(sent[0].args.spec.value).toEqual([255, 0, 0]);
  });

  test("Open color wheel brings up the Color Wheel panel", async () => {
    covers("panel:paged.color");
    const h = await mount();
    h.registries.panels.register({
      id: "paged.color-wheel",
      title: "Color Wheel",
      component: ColorWheelPanel,
    });
    await h.click(h.root.querySelector("[data-open-color-wheel]")!);
    expect(cockpitActions.activeTab?.()).toBe("paged.color-wheel");
  });
});
