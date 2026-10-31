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

// Picture adjustments (paged.picture-adjustments), engine ADR 1037: the
// image frame's filter stack. Every control writes the WHOLE stack once
// (one undo step); the model reads it back.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import {
  OPEN_IN_IMAGE_EDITOR_COMMAND_ID,
  PictureAdjustmentsPanel,
  parsePoints,
} from "../../src/panels/picture-adjustments-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";
import { addr, batch, set } from "./support/frames";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const PATH = "frameImageAdjustments";
const stack = (value: unknown[]) => ({ type: "imageAdjustments", value });

const mount = () =>
  mountPanel(PictureAdjustmentsPanel, {
    id: "paged.picture-adjustments",
    scene: richScene,
  });

const q = <T extends Element = HTMLElement>(h: H, sel: string) =>
  h.root.querySelector<T>(sel)!;
const rows = (h: H) =>
  [...h.root.querySelectorAll("[data-adjust-row]")].map((r) =>
    r.getAttribute("data-adjust-row"),
  );

describe("Picture adjustments [images-graphics.image-filter-stack]", () => {
  test("nothing selected: every control disabled", async () => {
    covers("panel:paged.picture-adjustments");
    const h = await mount();
    expect(q<HTMLSelectElement>(h, "[data-adjust-add]").disabled).toBe(true);
    expect(q<HTMLSelectElement>(h, "[data-adjust-preset]").disabled).toBe(true);
    expect(q<HTMLButtonElement>(h, "[data-adjust-reset]").disabled).toBe(true);
    expect(q(h, "[data-adjust-empty]").textContent).toBe(
      "Select an image frame to adjust its picture.",
    );
  });

  test("Add writes the stack, it reads back, one undo removes it", async () => {
    covers("panel:paged.picture-adjustments");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(q(h, "[data-adjust-empty]").textContent).toBe(
      "No adjustments. The picture is drawn as placed.",
    );
    const from = h.mark();
    await h.choose(q(h, "[data-adjust-add]"), "invert");
    expect(h.mutations(from)).toEqual([
      set(addr(h.scene.rect), PATH, stack([{ op: "invert" }])),
    ] as never);
    expect(await h.get(addr(h.scene.rect), PATH)).toEqual(
      stack([{ op: "invert" }]),
    );
    expect(rows(h)).toEqual(["invert"]);
    await h.act(() => h.client.undo());
    await h.settle();
    expect(await h.get(addr(h.scene.rect), PATH)).toEqual(stack([]));
    expect(rows(h)).toEqual([]);
  });

  test("a field commits on Enter; reorder, remove and reset rewrite the list", async () => {
    covers("panel:paged.picture-adjustments");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.choose(q(h, "[data-adjust-add]"), "exposure");
    await h.choose(q(h, "[data-adjust-add]"), "threshold");
    expect(rows(h)).toEqual(["exposure", "threshold"]);

    const from = h.mark();
    await h.typeInto(
      q<HTMLInputElement>(
        h,
        '[data-adjust-row="exposure"] [data-adjust-field="ev"]',
      ),
      "1.5",
    );
    expect(h.mutations(from)).toEqual([
      set(
        addr(h.scene.rect),
        PATH,
        stack([
          { op: "exposure", ev: 1.5 },
          { op: "threshold", level: 0.5 },
        ]),
      ),
    ] as never);

    await h.click(q(h, '[data-adjust-row="threshold"] [data-adjust-up]'));
    expect(rows(h)).toEqual(["threshold", "exposure"]);
    await h.click(q(h, '[data-adjust-row="threshold"] [data-adjust-remove]'));
    expect(await h.get(addr(h.scene.rect), PATH)).toEqual(
      stack([{ op: "exposure", ev: 1.5 }]),
    );
    await h.click(q(h, "[data-adjust-reset]"));
    expect(await h.get(addr(h.scene.rect), PATH)).toEqual(stack([]));
  });

  test("a preset appends its ops; an out-of-range value is clamped", async () => {
    covers("panel:paged.picture-adjustments");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.choose(q(h, "[data-adjust-preset]"), "noir");
    expect(rows(h)).toEqual(["blackWhite", "curves"]);
    await h.choose(q(h, "[data-adjust-add]"), "blur");
    await h.typeInto(
      q<HTMLInputElement>(
        h,
        '[data-adjust-row="blur"] [data-adjust-field="radius"]',
      ),
      "500",
    );
    const v = (await h.get(addr(h.scene.rect), PATH)) as {
      value: Array<Record<string, unknown>>;
    };
    expect(v.value[2]).toEqual({ op: "blur", radius: 64 });
  });

  test("two frames: one batch writes both stacks", async () => {
    covers("panel:paged.picture-adjustments");
    const h = await mount();
    await h.select([h.scene.rect, h.scene.groupA]);
    const from = h.mark();
    await h.choose(q(h, "[data-adjust-add]"), "invert");
    expect(h.mutations(from)).toEqual([
      batch(
        set(addr(h.scene.rect), PATH, stack([{ op: "invert" }])),
        set(addr(h.scene.groupA), PATH, stack([{ op: "invert" }])),
      ),
    ] as never);
  });

  test("Open in Image editor runs the image module's command, disabled without it", async () => {
    covers("panel:paged.picture-adjustments");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(q<HTMLButtonElement>(h, "[data-adjust-open-image]").disabled).toBe(
      true,
    );
    const calls = h.spyCommand(OPEN_IN_IMAGE_EDITOR_COMMAND_ID);
    await h.settle();
    expect(q<HTMLButtonElement>(h, "[data-adjust-open-image]").disabled).toBe(
      false,
    );
    await h.click(q(h, "[data-adjust-open-image]"));
    expect(calls.length).toBe(1);
  });
});

describe("Picture adjustments: curve points", () => {
  test("parsePoints reads pairs and refuses anything else", () => {
    expect(parsePoints("0 0, 0.5 0.6, 1 1")).toEqual([
      [0, 0],
      [0.5, 0.6],
      [1, 1],
    ]);
    expect(parsePoints("0 0, 2 1")).toBeNull();
    expect(parsePoints("0")).toBeNull();
  });
});
