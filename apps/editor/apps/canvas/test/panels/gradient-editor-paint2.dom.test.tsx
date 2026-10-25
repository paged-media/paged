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

// Paint model v2 in the ramp editor (engine ADR 1007): each stop's
// opacity, an inline colour instead of a swatch, the Conic type, and
// "Apply to" Fill / Stroke with the stroke's Within / Along / Across
// mapping. Every edit is ONE mutation (one undo step).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import { fireEvent } from "@testing-library/react";

import { GradientsPanel } from "../../src/panels/gradients-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(GradientsPanel, { id: "paged.gradients", scene: richScene });

const rect = (h: H) => `rectangle:${String(h.scene.rect.id)}`;
const stopRows = (h: H) => [
  ...h.root.querySelectorAll<HTMLElement>("[data-gradient-stop-row]"),
];
type Edit = {
  op: string;
  args: {
    spec: {
      kind: string;
      stops: Array<{
        stopColor: string;
        locationPct: number;
        opacityPct?: number;
        color?: { space: string; value: number[] };
      }>;
    };
  };
};
const edits = (h: H, from: number) =>
  (h.mutations(from) as unknown as Edit[]).filter(
    (m) => m.op === "editGradient",
  );

describe("Gradient editor: paint v2 [color-swatches.paint-v2]", () => {
  test("a stop's opacity field fades that stop in one edit, and undo restores it", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    const from = h.mark();
    await h.typeInto(
      stopRows(h)[1].querySelector<HTMLInputElement>("[data-stop-opacity]")!,
      "0",
    );
    const sent = edits(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args.spec.stops[1]).toMatchObject({ opacityPct: 0 });
    expect(sent[0].args.spec.stops[0].opacityPct).toBeUndefined();
    const d = await h.client.gradientDetail(h.scene.gradient);
    expect(d?.stops[1].opacityPct).toBe(0);
    await h.act(() => h.client.undo());
    expect(
      (await h.client.gradientDetail(h.scene.gradient))?.stops[1].opacityPct ??
        null,
    ).toBeNull();
  });

  test("Inline colour… gives the stop its own colour, which the picker then edits", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    const from = h.mark();
    await h.choose(
      stopRows(h)[0].querySelector<HTMLSelectElement>(
        '[data-action="stop-swatch"]',
      )!,
      "__inline__",
    );
    let sent = edits(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args.spec.stops[0].stopColor).toBe("");
    expect(sent[0].args.spec.stops[0].color?.space).toBe("RGB");
    expect(stopRows(h)[0].getAttribute("data-inline")).toBe("true");
    const picker = stopRows(h)[0].querySelector<HTMLInputElement>(
      "[data-stop-inline-colour]",
    )!;
    const from2 = h.mark();
    await h.act(() =>
      fireEvent.change(picker, { target: { value: "#ff0000" } }),
    );
    sent = edits(h, from2);
    expect(sent).toHaveLength(1);
    expect(sent[0].args.spec.stops[0].color).toEqual({
      space: "RGB",
      value: [255, 0, 0],
    });
    const d = await h.client.gradientDetail(h.scene.gradient);
    expect(d?.stops[0].resolvedRgbHex.toLowerCase()).toBe("#ff0000");
  });

  test("Conic: one edit with the conic kind; the model reads conic", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    const from = h.mark();
    await h.click(h.root.querySelector('[data-gradient-kind="conic"]')!);
    const sent = edits(h, from);
    expect(sent).toHaveLength(1);
    expect(sent[0].args.spec.kind).toBe("Conic");
    expect((await h.client.gradientDetail(h.scene.gradient))?.kind).toBe(
      "conic",
    );
  });

  test("Apply to Stroke puts the gradient on the selection's stroke; Along maps it", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(h.root.querySelector('[data-gradient-target="stroke"]')!);
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="apply-gradient"]')!);
    expect(await h.get(rect(h), "frameStrokeColor")).toEqual({
      type: "colorRef",
      value: h.scene.gradient,
    });
    expect(h.mutations(from)).toHaveLength(1);
    const row = h.root.querySelector("[data-gradient-stroke-mode-row]")!;
    expect(
      row
        .querySelector('[data-gradient-stroke-mode="Within"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
    await h.click(row.querySelector('[data-gradient-stroke-mode="Along"]')!);
    expect(await h.get(rect(h), "frameGradientStrokeMode")).toEqual({
      type: "text",
      value: "Along",
    });
    await h.act(() => h.client.undo());
    expect(await h.get(rect(h), "frameGradientStrokeMode")).toEqual({
      type: "text",
      value: "Within",
    });
  });

  test("Apply to Fill puts the gradient on the fill; nothing selected disables it", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    const apply = () =>
      h.root.querySelector<HTMLButtonElement>(
        '[data-action="apply-gradient"]',
      )!;
    expect(apply().disabled).toBe(true);
    await h.select([h.scene.rect]);
    await h.click(apply());
    expect(await h.get(rect(h), "frameFillColor")).toEqual({
      type: "colorRef",
      value: h.scene.gradient,
    });
  });
});
