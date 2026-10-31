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

// The BRUSHES panel (WP6.4, draw ADR 366), RENDERED (happy-dom) against
// the real engine: the libraries and their brushes, a click that brushes
// the selection's stroke (one undo step), Brush Options for the brush
// the selection carries, Remove, New brush from the selection, and the
// width profile library.

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
import { covers } from "@paged-media/test-kit";

import { BRUSHES_PANEL_ID, BRUSHES_PANEL_NOTE, drawBundle } from "../../src";
import { readStroke } from "../../src/commands/brushes";
import { packageWithSpread } from "../fixtures/build-idml";
import { openHost } from "../headless/host";
import {
  lineItem,
  mountContributed,
  settle,
  squareItem,
  teardownPanels,
} from "./harness";

const P = (id: string) => ({ kind: "polygon", id }) as ElementId;
const LINE = P("pl");
const SQUARE = P("ps");

const strokeOps = (id: ElementId): MutationInput[] => [
  {
    op: "setElementProperty",
    args: {
      elementId: id,
      path: "frameStrokeColor",
      value: { type: "colorRef", value: "Color/Black" },
    },
  },
  {
    op: "setElementProperty",
    args: {
      elementId: id,
      path: "frameStrokeWeight",
      value: { type: "length", value: 4 },
    },
  },
];

describe("the Brushes panel", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(
      packageWithSpread(
        lineItem("pl", 40, 200, 340, 240) + squareItem("ps", 60, 40, 60),
      ),
    );
    await h.host.document.mutate({
      op: "batch",
      args: { ops: [...strokeOps(LINE), ...strokeOps(SQUARE)] as never },
    });
  });
  afterEach(() => teardownPanels(h));

  const stack = async (id: ElementId) => (await readStroke(h.host, id)).stack;

  it("lists a library's brushes; a click brushes the stroke in one undo step [plugin-draw.brushes-width]", async () => {
    covers("panel:media.paged.draw.panel.brushes");
    const panel = await mountContributed(h, BRUSHES_PANEL_ID);
    expect(panel.count("[data-draw-brush]")).toBe(4);
    expect(panel.count("[data-draw-brush-options-none]")).toBe(1);
    panel.change("[data-draw-brushes-library]", "artistic");
    expect(panel.count('[data-draw-brush-type="bristle"]')).toBe(2);
    panel.change("[data-draw-brushes-library]", "basic");
    await h.host.selection.set([LINE]);
    await settle();
    await panel.click('[data-draw-brush="tapered"]');
    expect((await stack(LINE)).map((e) => e.kind)).toEqual(["brush"]);
    await h.host.document.undo();
    await settle();
    expect(await stack(LINE)).toEqual([]);
    expect(panel.get("[data-draw-brushes-note]").textContent).toBe(
      t(BRUSHES_PANEL_NOTE),
    );
  });

  it("Brush options edit the selection's brush; Remove takes it off", async () => {
    await h.host.selection.set([LINE]);
    const panel = await mountContributed(h, BRUSHES_PANEL_ID);
    await panel.click('[data-draw-brush="dots"]');
    await settle();
    expect(
      panel.attr("[data-draw-brush-options]", "data-draw-brush-options"),
    ).toBe("scatter");
    panel.change('[data-draw-brush-option="spacingPct"]', "250");
    await panel.click("[data-draw-brush-options-apply]");
    expect((await stack(LINE))[0]!.spacingPct).toBe(250);
    await panel.click("[data-draw-brush-remove]");
    expect(await stack(LINE)).toEqual([]);
  });

  it("a width profile from the library; New brush from the selection lands in the document library", async () => {
    await h.host.selection.set([LINE]);
    const panel = await mountContributed(h, BRUSHES_PANEL_ID);
    expect(panel.count("[data-draw-width-profile]")).toBe(7);
    await panel.click('[data-draw-width-profile="lens"]');
    const wp = (await stack(LINE)).find((e) => e.kind === "widthProfile")!;
    expect(wp.widthPoints).toEqual([
      [0, 0],
      [0.5, 1],
      [1, 0],
    ]);
    await h.host.selection.set([SQUARE]);
    await settle();
    panel.change("[data-draw-brush-new-type]", "scatter");
    await panel.click("[data-draw-brush-new]");
    await settle();
    expect(
      panel.get("[data-draw-brushes-library]") as HTMLSelectElement,
    ).toHaveProperty("value", "document");
    expect(panel.count('[data-draw-brush-type="scatter"]')).toBe(1);
  });
});
