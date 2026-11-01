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

// Editor ADR 309 — Appearance (paged.appearance): the selection's stroke,
// fill, the object's effect stack and its opacity as one list; a paint row
// opens to its own target's stack. Editor ADR 312 — every fill and stroke
// of the item's native appearance (engine ADR 1043) is a row, front-most
// first, and each gesture is one `frameAppearance` write.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  APPEARANCE_SECTIONS,
  AppearancePanel,
} from "../../src/panels/appearance-panel";
import { layersOf } from "../../src/panels/appearance-layers";
import { shapesScene, type ShapesScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr, len } from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<ShapesScene>;

const mount = () =>
  mountPanel(AppearancePanel, { id: "paged.appearance", scene: shapesScene });

const sections = (h: H) =>
  [...h.root.querySelectorAll("[data-appearance-section]")].map((s) =>
    s.getAttribute("data-appearance-section"),
  );

const layerKinds = (v: unknown) => (layersOf(v) ?? []).map((l) => l.kind);

const action = (h: H, hook: string, scope = "") =>
  h.root.querySelector<HTMLButtonElement>(
    `${scope} [data-appearance-action="${hook}"]`.trim(),
  )!;

const kinds = (v: unknown) =>
  (
    (v as { value?: { entries?: Array<{ kind: string }> } })?.value?.entries ??
    []
  ).map((e) => e.kind);

describe("Appearance panel", () => {
  test("nothing selected: it says so", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    expect(
      h.root.querySelector('[data-appearance-panel="empty"]'),
    ).not.toBeNull();
  });

  test("a rectangle: stroke, fill, effects and opacity, in that order", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(APPEARANCE_SECTIONS.map((s) => s.id)).toEqual([
      "paint",
      "effects",
      "opacity",
    ]);
    expect(sections(h)).toEqual(["stroke", "fill", "effects", "opacity"]);
  });

  test("the effects row is the object stack: an effect added there lands in the engine", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    await h.select([h.scene.rect]);
    const add = h.root.querySelector<HTMLSelectElement>(
      '[data-appearance-section="effects"] select[data-effect-stack-add]',
    )!;
    const groups = [...add.querySelectorAll("optgroup")].map((g) =>
      g.getAttribute("data-effect-category"),
    );
    expect(groups).toContain("stylize");
    expect(groups).toContain("blur");
    const from = h.mark();
    await h.choose(add, "gaussianBlur");
    expect(h.mutations(from)).toHaveLength(1);
    expect(kinds(await h.get(addr(h.scene.rect), "frameEffectStack"))).toEqual([
      "gaussianBlur",
    ]);
  });

  test("a paint row opens to its own target's stack (InDesign's effects only)", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(
      h.root.querySelector('[data-appearance-target-toggle="fill"]')!,
    );
    const add = h.root.querySelector<HTMLSelectElement>(
      '[data-appearance-target-stack="fill"] select[data-effect-stack-add]',
    )!;
    const offered = [...add.options].map((o) => o.value).filter(Boolean);
    expect(offered).toContain("innerGlow");
    expect(offered).not.toContain("gaussianBlur");
    await h.choose(add, "innerGlow");
    expect(
      kinds(await h.get(addr(h.scene.rect), "frameFillEffectStack")),
    ).toEqual(["innerGlow"]);
  });

  test("opacity and stroke weight write the selection", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.typeInto(
      h.root.querySelector<HTMLInputElement>(
        '[data-appearance-section="opacity"] input',
      )!,
      "70",
    );
    expect(await h.get(addr(h.scene.rect), "frameOpacity")).toEqual(len(70));
    await h.typeInto(
      h.root.querySelector<HTMLInputElement>('input[aria-label="Weight"]')!,
      "4",
    );
    expect(await h.get(addr(h.scene.rect), "frameStrokeWeight")).toEqual(
      len(4),
    );
  });

  test("Add new fill: one write puts a fill above the frame's own fill, and it is a row [frames-paths.native-appearance]", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.click(action(h, "add-fill", "[data-appearance-actions]"));
    expect(h.mutations(from)).toHaveLength(1);
    const v = await h.get(addr(h.scene.rect), "frameAppearance");
    expect(layerKinds(v)).toEqual(["frameFill", "fill", "frameStroke"]);
    const added = layersOf(v)![1]!;
    expect(added.enabled).not.toBe(false);
    expect(typeof added.color).toBe("string");
    await h.settle();
    // Front-most first: the frame's stroke, the new fill, the frame's fill.
    expect(sections(h)).toEqual([
      "stroke",
      "layer",
      "fill",
      "effects",
      "opacity",
    ]);
    const row = h.root.querySelector('[data-appearance-section="layer"]')!;
    expect(row.getAttribute("data-appearance-kind")).toBe("fill");
    expect(row.getAttribute("data-appearance-layer")).toBe("1");
  });

  test("Add new stroke goes above the frame's stroke, with a weight", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(action(h, "add-stroke", "[data-appearance-actions]"));
    const layers = layersOf(
      await h.get(addr(h.scene.rect), "frameAppearance"),
    )!;
    expect(layers.map((l) => l.kind)).toEqual([
      "frameFill",
      "frameStroke",
      "stroke",
    ]);
    expect(layers[2]!.weight).toBeGreaterThan(0);
    await h.settle();
    expect(sections(h).slice(0, 3)).toEqual(["layer", "stroke", "fill"]);
  });

  test("a layer's opacity, switch, move and delete are each one write; the own paint cannot be deleted", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(action(h, "add-fill", "[data-appearance-actions]"));
    await h.settle();
    const layer = '[data-appearance-section="layer"]';
    // The placeholders' delete is off.
    expect(
      action(h, "remove", '[data-appearance-section="fill"]').disabled,
    ).toBe(true);
    expect(
      action(h, "remove", '[data-appearance-section="stroke"]').disabled,
    ).toBe(true);

    let from = h.mark();
    await h.typeInto(
      h.root.querySelector<HTMLInputElement>(
        `${layer} input[aria-label="Opacity"]`,
      )!,
      "40",
    );
    expect(h.mutations(from)).toHaveLength(1);
    expect(
      layersOf(await h.get(addr(h.scene.rect), "frameAppearance"))![1]!
        .opacityPct,
    ).toBe(40);

    from = h.mark();
    await h.click(action(h, "toggle", layer));
    expect(h.mutations(from)).toHaveLength(1);
    expect(
      layersOf(await h.get(addr(h.scene.rect), "frameAppearance"))![1]!.enabled,
    ).toBe(false);
    await h.settle();

    // Up: towards the front, above the frame's stroke.
    await h.click(action(h, "up", layer));
    expect(
      layerKinds(await h.get(addr(h.scene.rect), "frameAppearance")),
    ).toEqual(["frameFill", "frameStroke", "fill"]);
    await h.settle();
    expect(sections(h).slice(0, 3)).toEqual(["layer", "stroke", "fill"]);

    from = h.mark();
    await h.click(action(h, "remove", layer));
    expect(h.mutations(from)).toHaveLength(1);
    // Placeholders alone in the implied order are stored as empty.
    expect(
      layerKinds(await h.get(addr(h.scene.rect), "frameAppearance")),
    ).toEqual([]);
  });

  test("the frame's own fill moves above its stroke; Clear appearance restores the item", async () => {
    covers("panel:paged.appearance");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(action(h, "up", '[data-appearance-section="fill"]'));
    expect(
      layerKinds(await h.get(addr(h.scene.rect), "frameAppearance")),
    ).toEqual(["frameStroke", "frameFill"]);
    await h.settle();
    expect(sections(h).slice(0, 2)).toEqual(["fill", "stroke"]);
    await h.click(action(h, "clear", "[data-appearance-actions]"));
    expect(
      layerKinds(await h.get(addr(h.scene.rect), "frameAppearance")),
    ).toEqual([]);
    await h.settle();
    expect(sections(h).slice(0, 2)).toEqual(["stroke", "fill"]);
  });
});
