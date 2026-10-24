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

// WP4.10 — the host colour panels over an edit context whose colours are
// its OWN (paged.image's foreground / background): the Color panel's
// fill / stroke wells read and write the owner's raw colours through the
// binding seam, a Swatches click hands the owner a swatch (Alt: the
// stroke well), and the mixer shows the colour in every space with the
// gamut verdict. The provider here is a stand-in with the image
// provider's shape (the real one is held to it in the image glue specs).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { createBindingProviderRegistry } from "@paged-media/plugin-sdk";
import type { BindingPropertyWrite, Value } from "@paged-media/plugin-api";

import { ColorPanel } from "../../src/panels/color-panel";
import { SwatchesPanel } from "../../src/panels/swatches-panel";
import { richScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { settleTimers } from "./support/styles";

afterEach(unmountAll);

const PLUGIN = "test.raster";
const CTX = "rasterImage";

/** An owner of two raw colours, as paged.image is. */
function rasterOwner() {
  const colours: Record<string, number[]> = {
    frameFillColor: [200, 40, 20],
    frameStrokeColor: [255, 255, 255],
  };
  const writes: BindingPropertyWrite[] = [];
  const registry = createBindingProviderRegistry();
  registry.register({
    plugin: PLUGIN,
    contextType: CTX,
    provider: {
      provides: { paths: ["frameFillColor", "frameStrokeColor"] },
      readProperty: ({ path }) => ({
        kind: "value",
        value: {
          type: "swatchColor",
          value: { space: "RGB", value: colours[path], model: "Process" },
        } as Value,
      }),
      writeProperty: (w) => {
        writes.push(w);
        if (w.value.type === "swatchColor")
          colours[w.path] = w.value.value.value;
        return {
          kind: "applied",
          outcome: { applied: true, createdId: null, pageIds: [] },
        };
      },
    },
  });
  registry.setContextActive(PLUGIN, CTX, null, true);
  return { registry, writes, colours };
}

const channels = (h: PanelHarness<unknown>) =>
  [
    ...h.root.querySelectorAll<HTMLInputElement>("[data-mixer-channel] input"),
  ].map((i) => i.value);

const channelInput = (h: PanelHarness<unknown>, key: string) =>
  h.root.querySelector<HTMLInputElement>(
    `[data-mixer-channel="${key}"] input`,
  )!;

describe("Color panel over a raster edit context [editor-shell.raster-color-binding]", () => {
  test("the wells are the owner's colours; a channel edit writes the fill well as RGB, mints no swatch", async () => {
    covers("panel:paged.color");
    const o = rasterOwner();
    const h = await mountPanel(ColorPanel, {
      id: "paged.color",
      bindingProviders: o.registry,
    });
    await settleTimers(h);
    expect(
      h.root.querySelector("[data-color-panel]")?.getAttribute("data-target"),
    ).toBe("edit-context");
    expect(
      h.root
        .querySelector('[data-color-well="fill"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(channels(h)).toEqual(["200", "40", "20"]);
    const from = h.mark();
    await h.typeInto(channelInput(h, "g"), "90");
    await settleTimers(h);
    expect(o.writes.at(-1)).toMatchObject({
      path: "frameFillColor",
      value: {
        type: "swatchColor",
        value: { space: "RGB", value: [200, 90, 20] },
      },
    });
    expect(h.mutations(from).filter((m) => m.op === "createSwatch")).toEqual(
      [],
    );
  });

  test("the stroke well edits the second colour", async () => {
    covers("panel:paged.color");
    const o = rasterOwner();
    const h = await mountPanel(ColorPanel, {
      id: "paged.color",
      bindingProviders: o.registry,
    });
    await h.click(h.root.querySelector('[data-color-well="stroke"]')!);
    await settleTimers(h);
    expect(channels(h)).toEqual(["255", "255", "255"]);
    await h.typeInto(channelInput(h, "r"), "0");
    await settleTimers(h);
    expect(o.writes.at(-1)).toMatchObject({
      path: "frameStrokeColor",
      value: { value: { value: [0, 255, 255] } },
    });
  });

  test("the picker shows the colour in CMYK (marked as a simple conversion), Lab and HSB, with the gamut verdict", async () => {
    covers("panel:paged.color");
    const o = rasterOwner();
    const h = await mountPanel(ColorPanel, {
      id: "paged.color",
      bindingProviders: o.registry,
    });
    await settleTimers(h);
    await h.click(h.root.querySelector('[data-mixer-space="CMYK"]')!);
    // Naive CMYK of rgb(200, 40, 20).
    expect(channels(h)).toEqual(["0", "80", "90", "22"]);
    expect(h.root.querySelector("[data-mixer-naive-cmyk]")).not.toBeNull();
    await h.click(h.root.querySelector('[data-mixer-space="LAB"]')!);
    const [l, a, b] = channels(h).map(Number);
    expect(l).toBeGreaterThan(40);
    expect(l).toBeLessThan(50);
    expect(a).toBeGreaterThan(50);
    expect(b).toBeGreaterThan(40);
    await h.click(h.root.querySelector('[data-mixer-space="HSB"]')!);
    expect(channels(h)[0]).toBe("7");
    // The verdict is the engine's (the document's CMYK working space);
    // the note shows exactly when the triangle does.
    expect(!!h.root.querySelector("[data-mixer-gamut-note]")).toBe(
      !!h.root.querySelector('[data-gamut="out"]'),
    );
  });

  test("an out-of-gamut RGB colour is flagged by the engine's gamut check", async () => {
    covers("panel:paged.color");
    const o = rasterOwner();
    o.colours.frameFillColor = [0, 255, 0];
    const h = await mountPanel(ColorPanel, {
      id: "paged.color",
      bindingProviders: o.registry,
    });
    await settleTimers(h);
    const sent = h.sent("requestColorCompute");
    expect(sent.length).toBeGreaterThan(0);
    const reply = await h.client.colorCompute({
      space: "RGB",
      value: [0, 255, 0],
    });
    expect(!!h.root.querySelector('[data-gamut="out"]')).toBe(reply.outOfGamut);
    expect(!!h.root.querySelector("[data-mixer-gamut-note]")).toBe(
      reply.outOfGamut,
    );
  });
});

describe("Swatches over a raster edit context [editor-shell.raster-color-binding]", () => {
  test("a click hands the swatch to the owner's fill well, Alt-click to the stroke well", async () => {
    covers("panel:paged.swatches");
    const o = rasterOwner();
    const h = await mountPanel(SwatchesPanel, {
      id: "paged.swatches",
      scene: richScene,
      bindingProviders: o.registry,
    });
    const red = h.root.querySelector<HTMLElement>(
      `[data-swatch-id="${h.scene.red}"] [data-swatch-apply]`,
    )!;
    expect(red).not.toBeNull();
    await h.click(red);
    expect(o.writes.at(-1)).toMatchObject({
      path: "frameFillColor",
      value: { type: "colorRef", value: h.scene.red },
    });
    await h.user.keyboard("{Alt>}");
    await h.user.click(red);
    await h.user.keyboard("{/Alt}");
    await h.settle();
    expect(o.writes.at(-1)).toMatchObject({
      path: "frameStrokeColor",
      value: { type: "colorRef", value: h.scene.red },
    });
  });

  test("over core a swatch name is not an apply target (the composition's select applies)", async () => {
    covers("panel:paged.swatches");
    const h = await mountPanel(SwatchesPanel, {
      id: "paged.swatches",
      scene: richScene,
    });
    expect(h.root.querySelector("[data-swatch-apply]")).toBeNull();
  });
});
