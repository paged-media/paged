/*
 * This file is part of paged (https://paged.media).
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

// The RECOLOR ARTWORK, COLOR GUIDE and IMAGE TRACE panels (WP6.5, WP6.6),
// RENDERED (happy-dom) against the real engine: what each shows for the
// selection, that its preview is the plan, and that its buttons change
// the DOCUMENT through the same appliers the commands use — one undo
// step each.

import { t } from "@paged-media/strings";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";

import type { ElementId, MutationInput } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers, waitFor } from "@paged-media/test-kit";

import {
  drawBundle,
  imageTraceOf,
  COLOR_GUIDE_PANEL_ID,
  COLOR_GUIDE_PANEL_NOTE,
  IMAGE_TRACE_PANEL_ID,
  IMAGE_TRACE_PANEL_NOTE,
  RECOLOR_PANEL_ID,
  RECOLOR_PANEL_NOTE,
} from "../../src";
import { imageItem, packageWithSpread, pngBytes } from "../fixtures/build-idml";
import { ringPixels } from "../fixtures/corpus";
import { openHost } from "../headless/host";
import { installPngRealm } from "../headless/raster-realm";
import {
  mountContributed,
  settle,
  squareItem,
  teardownPanels,
} from "./harness";

const P = (id: string) => ({ kind: "polygon", id }) as ElementId;
const A = P("ca");
const B = P("cb");
const IMG = { kind: "rectangle", id: "uimg" } as ElementId;

const doc = () =>
  packageWithSpread(
    squareItem("ca", 40, 40, 60) +
      squareItem("cb", 140, 40, 60) +
      imageItem(
        "uimg",
        "300 40 396 136",
        "file:ring-48.png",
        pngBytes(48, 48, ringPixels(48)),
        {
          width: 48,
          height: 48,
        },
      ),
  );

const sw = (selfId: string, name: string, value: number[]): MutationInput => ({
  op: "createSwatch",
  args: { spec: { selfId, name, space: "RGB", value } },
});
const fill = (id: ElementId, ref: string): MutationInput => ({
  op: "setElementProperty",
  args: {
    elementId: id,
    path: "frameFillColor",
    value: { type: "colorRef", value: ref },
  },
});

async function fillOf(h: HeadlessHost, id: ElementId): Promise<unknown> {
  const props = await h.host.document.elementProperties(id);
  return (
    props?.entries.find((e) => e.path === "frameFillColor")?.value?.value ??
    null
  );
}

describe("the colour and trace panels", () => {
  let h: HeadlessHost;
  let uninstall: () => void;
  beforeAll(async () => {
    uninstall = installPngRealm();
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => {
    h?.dispose();
    uninstall?.();
  });
  beforeEach(async () => {
    await h.load(doc());
    await h.host.document.mutate({
      op: "batch",
      args: {
        ops: [
          sw("Color/ured", "#ff0000", [255, 0, 0]),
          sw("Color/ublue", "#0000ff", [0, 0, 255]),
          fill(A, "Color/ured"),
          fill(B, "Color/ublue"),
        ] as never,
      },
    });
  });
  afterEach(() => teardownPanels(h));

  it("RECOLOR ARTWORK: the colour group, the wheel's handles, a preview row per colour, and Apply in one undo step", async () => {
    covers("panel:media.paged.draw.panel.recolorArtwork");
    const panel = await mountContributed(h, RECOLOR_PANEL_ID);
    expect(panel.text()).toContain("Select artwork to recolour.");
    await h.host.selection.set([A, B]);
    await settle();
    const ready = await mountContributed(h, RECOLOR_PANEL_ID);
    expect(
      ready.attr("[data-draw-recolor-panel]", "data-draw-recolor-panel"),
    ).toBe("2");
    expect(ready.text()).toContain("2 colours in the selection");
    expect(ready.count("[data-draw-recolor-row]")).toBe(2);
    // Complementary of red: two handles on the wheel.
    expect(ready.count("[data-draw-recolor-handle]")).toBe(2);
    ready.change("[data-draw-recolor-rule]", "triadic");
    expect(ready.count("[data-draw-recolor-handle]")).toBe(3);
    // The preview names the new colour of the blue row.
    expect(
      ready.attr(
        '[data-draw-recolor-row="Color/ublue"]',
        "data-draw-recolor-to",
      ),
    ).toMatch(/^#/);
    await ready.click("[data-draw-recolor-apply]");
    expect(await fillOf(h, B)).not.toBe("Color/ublue");
    await h.host.document.undo();
    await settle();
    expect(await fillOf(h, B)).toBe("Color/ublue");
    // REDUCE to one colour: the blue row becomes red; Apply mints nothing.
    ready.change("[data-draw-recolor-mode-select]", "reduce");
    ready.change("[data-draw-recolor-reduce]", "1");
    expect(
      ready.attr(
        '[data-draw-recolor-row="Color/ublue"]',
        "data-draw-recolor-to",
      ),
    ).toBe("#ff0000");
    expect(ready.get("[data-draw-recolor-note]").textContent).toBe(
      t(RECOLOR_PANEL_NOTE),
    );
  });

  it("COLOR GUIDE: the fill's harmony and its variations; a click fills the selection", async () => {
    covers("panel:media.paged.draw.panel.colorGuide");
    await h.host.selection.set([A]);
    const panel = await mountContributed(h, COLOR_GUIDE_PANEL_ID);
    expect(
      panel.attr("[data-draw-color-guide-panel]", "data-draw-color-guide-base"),
    ).toBe("#ff0000");
    expect(panel.count("[data-draw-color-guide-harmony-chip]")).toBe(2);
    // Two harmony colours × seven variations.
    expect(panel.count("[data-draw-color-guide-chip]")).toBe(14);
    panel.change("[data-draw-color-guide-rule]", "tetradic");
    expect(panel.count("[data-draw-color-guide-chip]")).toBe(28);
    // Click the complement (the second harmony chip).
    const chips = panel.all("[data-draw-color-guide-harmony-chip]");
    const hex = chips[1]!.getAttribute("data-draw-color-guide-harmony-chip");
    await panel.click(`[data-draw-color-guide-harmony-chip="${hex}"]`);
    const ref = String(await fillOf(h, A));
    expect(ref).not.toBe("Color/ured");
    expect(
      (await h.host.document.swatchDisplay([ref]))[0]?.rgbHex.toLowerCase(),
    ).toBe(hex);
    expect(panel.get("[data-draw-color-guide-note]").textContent).toBe(
      t(COLOR_GUIDE_PANEL_NOTE),
    );
  });

  it("IMAGE TRACE: a preset sets the options, Trace and Re-trace act on the selected image", async () => {
    covers("panel:media.paged.draw.panel.imageTrace");
    await h.host.selection.set([IMG]);
    const panel = await mountContributed(h, IMAGE_TRACE_PANEL_ID);
    expect(
      panel.attr(
        "[data-draw-image-trace-panel]",
        "data-draw-image-trace-preset",
      ),
    ).toBe("default");
    expect(panel.disabled("[data-draw-image-trace-retrace]")).toBe(true);
    panel.change("[data-draw-image-trace-preset-select]", "blackAndWhiteLogo");
    expect(
      panel.attr(
        "[data-draw-image-trace-panel]",
        "data-draw-image-trace-preset",
      ),
    ).toBe("blackAndWhiteLogo");
    expect(
      (panel.get("[data-draw-image-trace-mode]") as HTMLSelectElement).value,
    ).toBe("bw");
    // Changing one option makes it Custom.
    panel.change("[data-draw-image-trace-threshold]", "100");
    expect(
      panel.attr(
        "[data-draw-image-trace-panel]",
        "data-draw-image-trace-preset",
      ),
    ).toBe("custom");
    panel.change("[data-draw-image-trace-preset-select]", "lineArt");
    await panel.click("[data-draw-image-trace-run]");
    const presetNow = async () =>
      imageTraceOf(await h.host.document.getMetadata(IMG))?.preset ?? null;
    await waitFor(async () => expect(await presetNow()).toBe("lineArt"));
    await h.host.selection.set([IMG]);
    await waitFor(() =>
      expect(panel.disabled("[data-draw-image-trace-retrace]")).toBe(false),
    );
    expect(panel.text()).toContain("Selected trace: Line art");
    panel.change("[data-draw-image-trace-preset-select]", "silhouettes");
    await panel.click("[data-draw-image-trace-retrace]");
    await waitFor(async () => expect(await presetNow()).toBe("silhouettes"));
    expect(panel.get("[data-draw-image-trace-note]").textContent).toBe(
      t(IMAGE_TRACE_PANEL_NOTE),
    );
  });
});
