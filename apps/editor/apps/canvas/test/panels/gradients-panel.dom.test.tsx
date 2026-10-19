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

// Gradients (paged.gradients): the Fill picker over the document's
// gradients with the per-frame Angle and Length, "New gradient…" through
// the typed core command form, and the ramp editor below, which edits the
// gradient RESOURCE: type, reverse, each stop's swatch and location,
// each committed as ONE editGradient of the whole ramp. Dragging stops and
// clicking the ramp to add one are browser work (they need layout).

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";
import type { ComponentType } from "react";

import { CoreCommandDialog } from "../../src/core-command-dialog";
import { GradientsPanel } from "../../src/panels/gradients-panel";
import {
  apply,
  richScene,
  type RichScene,
  type SceneContext,
} from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { runCoreCommand } from "./support/styles";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

function WithForm() {
  return (
    <>
      <GradientsPanel />
      <CoreCommandDialog />
    </>
  );
}

const mount = () =>
  mountPanel(WithForm as ComponentType<never>, {
    id: "paged.gradients",
    scene: richScene,
  });

/** The rich scene with a third stop (Spot at 50) on Fade. */
const threeStops = async (ctx: SceneContext): Promise<RichScene> => {
  const s = await richScene(ctx);
  await apply(ctx.client, threeStopEdit(s) as never);
  return s;
};
const threeStopEdit = (s: RichScene) => ({
  op: "editGradient",
  args: {
    gradientId: s.gradient,
    spec: {
      selfId: s.gradient,
      name: "Fade",
      kind: "Linear",
      stops: [
        { stopColor: "Color/Black", locationPct: 0 },
        { stopColor: s.spot, locationPct: 50 },
        { stopColor: s.red, locationPct: 100 },
      ],
    },
  },
});

const rect = (h: H) => `rectangle:${String(h.scene.rect.id)}`;
const stopRows = (h: H) => [
  ...h.root.querySelectorAll<HTMLElement>("[data-gradient-stop-row]"),
];
const lastEdit = (h: H, from: number) =>
  (
    h.mutations(from) as unknown as Array<{
      op: string;
      args: {
        gradientId: string;
        spec: {
          kind: string;
          name: string;
          stops: Array<{ stopColor: string; locationPct: number }>;
        };
      };
    }>
  ).filter((m) => m.op === "editGradient");

describe("Gradients panel: states", () => {
  test("no document: the editor says there are no gradients; Fill has no target", async () => {
    covers("panel:paged.gradients");
    const h = await mountPanel(GradientsPanel, {
      id: "paged.gradients",
      document: "none",
    });
    expect(
      h.root.querySelector('[data-gradient-editor="empty"]'),
    ).not.toBeNull();
    expect(
      (h.field("frameFillColor").querySelector("select") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
  });

  test("the document's gradient opens in the editor with its stops, and a two-stop ramp cannot lose one", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    expect(
      h.root.querySelector<HTMLSelectElement>(
        "[data-gradient-select] select, select[data-gradient-select]",
      )?.value,
    ).toBe(h.scene.gradient);
    expect(
      h.root
        .querySelector('[data-gradient-kind="linear"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
    const rows = stopRows(h);
    expect(
      rows.map((r) => r.querySelector<HTMLSelectElement>("select")!.value),
    ).toEqual(["Color/Black", h.scene.red]);
    expect(
      rows.map(
        (r) => r.querySelector<HTMLInputElement>("[data-stop-location]")!.value,
      ),
    ).toEqual(["0", "100"]);
    for (const r of rows) {
      expect(
        r.querySelector<HTMLButtonElement>('[data-action="remove-stop"]')!
          .disabled,
      ).toBe(true);
    }
  });
});

describe("Gradients panel: controls", () => {
  test("Fill: picking the gradient sets the frame's fill to it", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    await h.select([h.scene.rect]);
    const from = h.mark();
    await h.choose("frameFillColor", h.scene.gradient);
    expect(h.mutations(from)).toEqual([
      {
        op: "set",
        args: {
          address: rect(h),
          path: "frameFillColor",
          value: { type: "colorRef", value: h.scene.gradient },
        },
      },
    ] as never);
    expect(await h.get(rect(h), "frameFillColor")).toEqual({
      type: "colorRef",
      value: h.scene.gradient,
    });
  });

  for (const [path, text, value] of [
    ["frameGradientFillAngle", "45", 45],
    ["frameGradientFillLength", "120", 120],
  ] as const) {
    test(`${path}: typing ${text} writes it on the frame`, async () => {
      covers("panel:paged.gradients");
      const h = await mount();
      await h.select([h.scene.rect]);
      const from = h.mark();
      await h.typeInto(path, text);
      const sent = h.mutations(from) as unknown as Array<{
        args: { address: string; path: string; value: { value: number } };
      }>;
      expect(sent).toHaveLength(1);
      expect(sent[0].args).toMatchObject({ address: rect(h), path });
      expect(sent[0].args.value.value).toBe(value);
      expect(await h.get(rect(h), path)).toMatchObject({ value });
    });
  }

  test("New gradient… opens the typed command form; Run creates a Paper-to-Black linear gradient", async () => {
    covers("panel:paged.gradients", "command:paged.core.createGradient");
    const h = await mount();
    await h.click(
      h.root.querySelector('[data-core-command-button="createGradient"]')!,
    );
    const from = h.mark();
    await runCoreCommand(h);
    const sent = h.mutations(from) as unknown as Array<{
      op: string;
      args: { spec: Record<string, unknown> };
    }>;
    expect(sent.map((m) => m.op)).toEqual(["createGradient"]);
    expect(sent[0].args.spec).toMatchObject({
      name: "New gradient",
      kind: "Linear",
      stops: [
        { stopColor: "Color/Paper", locationPct: 0 },
        { stopColor: "Color/Black", locationPct: 100 },
      ],
    });
    const names = (
      (await h.client.collection("gradients")) as Array<{ name: string }>
    ).map((g) => g.name);
    expect(names).toContain("New gradient");
  });

  test("Radial: one editGradient of the whole ramp with the new type; the model is radial", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    const from = h.mark();
    await h.click(h.root.querySelector('[data-gradient-kind="radial"]')!);
    const edits = lastEdit(h, from);
    expect(edits).toHaveLength(1);
    expect(edits[0].args.gradientId).toBe(h.scene.gradient);
    expect(edits[0].args.spec).toMatchObject({
      name: "Fade",
      kind: "Radial",
      stops: [
        { stopColor: "Color/Black", locationPct: 0 },
        { stopColor: h.scene.red, locationPct: 100 },
      ],
    });
    expect((await h.client.gradientDetail(h.scene.gradient))?.kind).toBe(
      "radial",
    );
    expect(
      h.root
        .querySelector('[data-gradient-kind="radial"]')
        ?.getAttribute("data-active"),
    ).toBe("true");
  });

  test("Reverse mirrors the stop locations in one edit", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    const from = h.mark();
    await h.click(h.root.querySelector('[data-action="reverse-gradient"]')!);
    const edits = lastEdit(h, from);
    expect(edits).toHaveLength(1);
    expect(edits[0].args.spec.stops).toMatchObject([
      { stopColor: h.scene.red, locationPct: 0 },
      { stopColor: "Color/Black", locationPct: 100 },
    ]);
    const detail = await h.client.gradientDetail(h.scene.gradient);
    expect(detail?.stops.map((s) => s.stopColorRef)).toEqual([
      h.scene.red,
      "Color/Black",
    ]);
  });

  test("a stop's swatch picker re-colours that stop", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    const from = h.mark();
    await h.choose(
      stopRows(h)[1].querySelector("select") as HTMLElement,
      h.scene.spot,
    );
    const edits = lastEdit(h, from);
    expect(edits).toHaveLength(1);
    expect(edits[0].args.spec.stops[1]).toMatchObject({
      stopColor: h.scene.spot,
      locationPct: 100,
    });
    expect(
      (await h.client.gradientDetail(h.scene.gradient))?.stops[1].stopColorRef,
    ).toBe(h.scene.spot);
  });

  test("a stop's location field moves that stop (Enter commits)", async () => {
    covers("panel:paged.gradients");
    const h = await mount();
    const from = h.mark();
    await h.typeInto(
      stopRows(h)[1].querySelector<HTMLInputElement>("[data-stop-location]")!,
      "70",
    );
    const edits = lastEdit(h, from);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[0].args.spec.stops[1].locationPct).toBe(70);
    expect(
      (await h.client.gradientDetail(h.scene.gradient))?.stops[1].locationPct,
    ).toBe(70);
  });

  test("with three stops, a stop can be removed (one edit with the other two)", async () => {
    covers("panel:paged.gradients");
    const h = await mountPanel(WithForm as ComponentType<never>, {
      id: "paged.gradients",
      scene: threeStops,
    });
    expect(stopRows(h)).toHaveLength(3);
    const from = h.mark();
    await h.click(stopRows(h)[1].querySelector('[data-action="remove-stop"]')!);
    const edits = lastEdit(h, from);
    expect(edits).toHaveLength(1);
    expect(edits[0].args.spec.stops.map((s) => s.stopColor)).toEqual([
      "Color/Black",
      h.scene.red,
    ]);
    expect(stopRows(h)).toHaveLength(2);
  });
});

describe("Gradients panel: findings", () => {
  // The editor loads a gradient's stops when it is picked, and only
  // then: an edit from elsewhere (Gradient Options, a script, an undo of
  // one of its own edits) leaves it showing the old ramp, and its next
  // commit writes that old ramp back over the change.
  test.failing(
    "PN-160: the ramp editor follows the gradient when it changes elsewhere",
    async () => {
      covers("panel:paged.gradients");
      const h = await mount();
      await h.mutate(threeStopEdit(h.scene) as never);
      expect(stopRows(h)).toHaveLength(3);
    },
  );

  // UX audit F-22 (internal identifiers shown to users): the ramp's stop
  // handles are named by the swatch's IDML id.
  test.failing(
    "PN-156 (UX F-22): the ramp's stops are named by their swatch's name, not its id",
    async () => {
      covers("panel:paged.gradients");
      const h = await mount();
      const names = [...h.root.querySelectorAll("[data-ramp-stop]")].map(
        (b) => b.getAttribute("title") ?? "",
      );
      expect(names.some((n) => n.startsWith("Color/"))).toBe(false);
    },
  );
});
