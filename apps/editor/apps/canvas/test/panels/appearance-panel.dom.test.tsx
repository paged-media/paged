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
// opens to its own target's stack.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  APPEARANCE_SECTIONS,
  AppearancePanel,
} from "../../src/panels/appearance-panel";
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
    expect(sections(h)).toEqual(APPEARANCE_SECTIONS.map((s) => s.id));
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
});
