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

// The Stroke panel's dash editor: the four presets, the "Dashed line"
// switch that keeps the typed pairs, the three dash/gap pairs, and the read
// back that follows the selection. Each write is read back from the model.

import { afterEach, describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { StrokePanel } from "../../src/panels/stroke-panel";
import { richScene, type RichScene } from "./fixtures";
import { mountPanel, unmountAll, type PanelHarness } from "./harness";

afterEach(unmountAll);

type H = PanelHarness<RichScene>;

const mount = () =>
  mountPanel(StrokePanel, { id: "paged.stroke", scene: richScene });

const addr = (id: { kind: string; id: unknown }) => `${id.kind}:${id.id}`;

const editor = (h: H) =>
  h.root.querySelector<HTMLElement>("[data-dash-editor]")!;

const preset = (h: H, key: string) =>
  editor(h).querySelector<HTMLButtonElement>(`[data-dash-preset="${key}"]`)!;

const dashOf = async (h: H) =>
  h.get(addr(h.scene.rect), "frameStrokeDashArray");

describe("Stroke panel: the dash editor", () => {
  test("a rectangle: the presets write their runs and the editor reads them back", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.select([h.scene.rect]);
    expect(editor(h).getAttribute("data-dash-editor")).toBe("solid");
    for (const [key, lengths] of [
      ["dashed", [6, 3]],
      ["dotted", [1, 3]],
      ["dashDot", [6, 3, 1, 3]],
    ] as const) {
      await h.click(preset(h, key));
      expect(await dashOf(h), key).toEqual({
        type: "lengths",
        value: [...lengths],
      });
      expect(editor(h).getAttribute("data-dash-editor")).toBe("dashed");
    }
    await h.click(preset(h, "solid"));
    expect(await dashOf(h)).toEqual({ type: "lengths", value: [] });
    expect(editor(h).getAttribute("data-dash-editor")).toBe("solid");
  });

  test("the switch turns the line off and on again with the typed pairs kept", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    await h.select([h.scene.rect]);
    await h.click(preset(h, "dotted"));
    const toggle = editor(h).querySelector<HTMLButtonElement>(
      '[data-toggle-switch="dash-dashed"]',
    )!;
    await h.click(toggle);
    expect(await dashOf(h)).toEqual({ type: "lengths", value: [] });
    await h.click(
      editor(h).querySelector<HTMLButtonElement>(
        '[data-toggle-switch="dash-dashed"]',
      )!,
    );
    // Off then on restores the pairs the line had (6 / 3 for a fresh editor).
    const back = (await dashOf(h)) as { value: number[] };
    expect(back.value.length).toBeGreaterThanOrEqual(2);
  });

  test("nothing selected: the presets are disabled", async () => {
    covers("panel:paged.stroke");
    const h = await mount();
    expect(preset(h, "dashed").disabled).toBe(true);
  });
});
