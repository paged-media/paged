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

// Effects (paged.effects): opacity and blend mode per transparency target
// (Object, Stroke, Fill, and the content: Text or Graphic), the eight
// effect families (each an enable pill that opens its fields), and a
// group's Isolate blending / Knockout group.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { EffectsPanel } from "../../src/panels/effects-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr, batch, bool, len, set, text } from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(EffectsPanel, { id: "paged.effects", scene: richScene });

const opacity = (h: H) =>
  h.root.querySelector<HTMLInputElement>('input[aria-label="opacity"]')!;
const blend = (h: H) =>
  h.root.querySelector<HTMLSelectElement>("select[data-blend-mode]")!;
const targets = (h: H) =>
  [...h.root.querySelectorAll("[data-effects-target]")].map(
    (t) => t.textContent,
  );
const target = (h: H, id: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-effects-target="${id}"]`)!;
const summary = (h: H, id: string) =>
  h.root.querySelector(`[data-effects-target-summary="${id}"]`)?.textContent;
const pill = (h: H, name: string) =>
  h.root.querySelector<HTMLButtonElement>(`[data-toggle-switch="${name}"]`)!;

const FAMILIES: ReadonlyArray<[string, string]> = [
  ["Drop shadow", "frameDropShadow"],
  ["Inner shadow", "frameInnerShadowEnabled"],
  ["Outer glow", "frameOuterGlowEnabled"],
  ["Inner glow", "frameInnerGlowEnabled"],
  ["Bevel and emboss", "frameBevelEnabled"],
  ["Satin", "frameSatinEnabled"],
  ["Feather", "frameFeatherEnabled"],
  ["Directional feather", "frameDirectionalFeatherEnabled"],
];

describe("Effects panel: states", () => {
  test("nothing selected: opacity, blend and every pill disabled", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    expect(opacity(h).disabled).toBe(true);
    expect(blend(h).disabled).toBe(true);
    for (const [name] of FAMILIES) expect(pill(h, name).disabled).toBe(true);
  });

  test("a rectangle: 100 % Normal, four targets with its content as Graphic", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(opacity(h).value).toBe("100 %");
    expect(blend(h).value).toBe("Normal");
    expect(targets(h).map((t) => t?.replace(/Normal 100%$/, ""))).toEqual([
      "Object",
      "Stroke",
      "Fill",
      "Graphic",
    ]);
    expect(summary(h, "object")).toBe("Normal 100%");
    for (const [name] of FAMILIES) {
      expect(pill(h, name).getAttribute("aria-checked")).toBe("false");
    }
  });

  test("a text frame: the content target is Text", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.textFrame]);
    expect(target(h, "content").textContent).toContain("Text");
  });

  test("a group: only the Object target, and the group options live", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.group]);
    expect(targets(h).map((t) => t?.replace(/Normal 100%$/, ""))).toEqual([
      "Object",
    ]);
    expect(pill(h, "Isolate blending").disabled).toBe(false);
    expect(pill(h, "Knockout group").disabled).toBe(false);
  });

  test("a frame: the group options are disabled", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(pill(h, "Isolate blending").disabled).toBe(true);
    expect(pill(h, "Knockout group").disabled).toBe(true);
  });
});

describe("Effects panel: every control writes the selection", () => {
  test("Opacity on the Object target writes frameOpacity", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.typeInto(opacity(h), "60");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameOpacity", len(60)),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameOpacity")).toEqual(len(60));
    expect(summary(h, "object")).toBe("Normal 60%");
  });

  test("Blend on the Object target writes frameBlendMode", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.choose(blend(h), "Multiply");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameBlendMode", text("Multiply")),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameBlendMode")).toEqual(
      text("Multiply"),
    );
    expect(summary(h, "object")).toBe("Multiply 100%");
  });

  for (const [id, opacityPath, blendPath] of [
    ["stroke", "frameStrokeOpacity", "frameStrokeBlendMode"],
    ["fill", "frameFillOpacity", "frameFillBlendMode"],
    ["content", "frameContentOpacity", "frameContentBlendMode"],
  ] as const) {
    test(`the ${id} target: opacity and blend write ${opacityPath} / ${blendPath}`, async () => {
      covers("panel:paged.effects");
      const h = await mount();
      await h.select([h.scene.rect]);
      await h.click(target(h, id));
      expect(target(h, id).getAttribute("aria-checked")).toBe("true");
      expect(
        h.root
          .querySelector("[data-effects-target-active]")
          ?.getAttribute("data-effects-target-active"),
      ).toBe(id);
      let from = h.mark();
      await h.typeInto(opacity(h), "50");
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.rect), opacityPath, len(50)),
      ] as never);
      from = h.mark();
      await h.choose(blend(h), "Screen");
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.rect), blendPath, text("Screen")),
      ] as never);
      expect(summary(h, id)).toBe("Screen 50%");
      expect(summary(h, "object")).toBe("Normal 100%");
    });
  }

  for (const [name, path] of FAMILIES) {
    test(`${name}: the pill writes ${path} and opens its fields`, async () => {
      covers("panel:paged.effects");
      const h = await mount();
      await h.select([h.scene.rect]);
      expect(h.root.querySelector(`[data-effect-fields="${name}"]`)).toBeNull();
      const from = h.mark();
      await h.click(pill(h, name));
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.rect), path, bool(true)),
      ] as never);
      expect(await h.get(addr(h.scene.rect), path)).toEqual(bool(true));
      expect(pill(h, name).getAttribute("aria-checked")).toBe("true");
      expect(
        h.root.querySelector(`[data-effect-fields="${name}"]`),
      ).not.toBeNull();
    });
  }

  test("an open effect's field writes its path (drop shadow X offset)", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(pill(h, "Drop shadow"));
    const from = h.mark();
    await h.typeInto("frameDropShadowXOffset", "5");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameDropShadowXOffset", len(5)),
    ] as never);
    expect(await h.get(addr(h.scene.rect), "frameDropShadowXOffset")).toEqual(
      len(5),
    );
  });

  for (const [label, path] of [
    ["Isolate blending", "groupIsolateBlending"],
    ["Knockout group", "groupKnockout"],
  ] as const) {
    test(`a group's ${label} writes ${path}`, async () => {
      covers("panel:paged.effects");
      const h = await mount();
      await h.select([h.scene.group]);
      const from = h.mark();
      await h.click(pill(h, label));
      expect(h.mutations(from)).toEqual([
        set(addr(h.scene.group), path, bool(true)),
      ] as never);
      expect(await h.get(addr(h.scene.group), path)).toEqual(bool(true));
    });
  }

  test("two frames: one batch, one undo restores both", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA]);
    const before = await h.get(addr(h.scene.rect), "frameBlendMode");
    const from = h.mark();
    await h.choose(blend(h), "Darken");
    expect(h.mutations(from)).toEqual([
      batch(
        set(addr(h.scene.rect), "frameBlendMode", text("Darken")),
        set(addr(h.scene.groupA), "frameBlendMode", text("Darken")),
      ),
    ] as never);
    await h.act(() => h.client.undo());
    expect(await h.get(addr(h.scene.rect), "frameBlendMode")).toEqual(before);
    expect(await h.get(addr(h.scene.groupA), "frameBlendMode")).toEqual(before);
  });
});

describe("Effects panel: the 27 blend modes [effects-transparency.blend-modes-27]", () => {
  test("the menu lists the engine's 27 in Photoshop's six groups", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.rect]);
    const options = [...blend(h).querySelectorAll("option")];
    expect(options.map((o) => o.value)).toEqual([
      "Normal",
      "Dissolve",
      "Darken",
      "Multiply",
      "ColorBurn",
      "LinearBurn",
      "DarkerColor",
      "Lighten",
      "Screen",
      "ColorDodge",
      "LinearDodge",
      "LighterColor",
      "Overlay",
      "SoftLight",
      "HardLight",
      "VividLight",
      "LinearLight",
      "PinLight",
      "HardMix",
      "Difference",
      "Exclusion",
      "Subtract",
      "Divide",
      "Hue",
      "Saturation",
      "Color",
      "Luminosity",
    ]);
    expect(blend(h).querySelectorAll("hr").length).toBe(5);
    // The eleven InDesign cannot store carry the marker; the sixteen not.
    const marked = options.filter((o) => o.hasAttribute("data-not-in-idml"));
    expect(marked.length).toBe(11);
    expect(marked.every((o) => o.textContent?.endsWith("\u2020"))).toBe(true);
    expect(
      options.find((o) => o.value === "LinearBurn")?.getAttribute("title"),
    ).toBe("InDesign can't store this mode: IDML gets Multiply");
    expect(h.root.querySelector("[data-blend-not-in-idml]")).toBeNull();
  });

  test("Linear Burn writes frameBlendMode and notes what IDML gets", async () => {
    covers("panel:paged.effects");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.choose(blend(h), "LinearBurn");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), "frameBlendMode", text("LinearBurn")),
    ] as never);
    expect(blend(h).value).toBe("LinearBurn");
    expect(summary(h, "object")).toBe("Linear burn 100%");
    expect(
      h.root.querySelector("[data-blend-not-in-idml]")?.textContent,
    ).toContain("IDML gets Multiply");
  });
});
