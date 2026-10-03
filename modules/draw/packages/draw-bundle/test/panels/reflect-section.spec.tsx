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

// @vitest-environment jsdom

// The REFLECT section of the Path Options panel, rendered against the
// real engine: the ANGLE typed is the axis the selection is mirrored
// across (read back as page anchors), Apply is one undo step and is what
// Transform again repeats, and Copy is OFFERED only where the engine has
// `duplicateElements` — on this engine (0.64) it is disabled and says why.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ElementId, PathAnchorsResult } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  forgetLastTransform,
  lastSelectionTransform,
  makePathOptionsPanel,
  REFLECT_COPY_UNAVAILABLE_NOTE,
  REFLECT_SECTION_NOTE,
} from "../../src";
import { pathItem } from "../fixtures/build-idml";
import { openHost } from "../conformance/host";
import { drive, mountPanel, panelDocument, poly, teardownPanels } from "./harness";

const TRI = poly("rtri");
const SEEDS = pathItem("Polygon", "rtri", "100 100 160 200", false, [
  { a: [100, 100] },
  { a: [200, 100] },
  { a: [100, 160] },
]);

const field = (name: string) => `[data-draw-pathopts-field="${name}"]`;
const HEADER = `[data-draw-pathopts-header="reflect"]`;
const APPLY = `[data-draw-pathopts-apply="reflect"]`;

async function firstAnchor(h: HeadlessHost, id: ElementId): Promise<[number, number]> {
  const t = (await h.host.document.pathAnchors(id)) as PathAnchorsResult;
  const m = t.itemTransform ?? [1, 0, 0, 1, 0, 0];
  const [x, y] = t.anchors[0]!.anchor;
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

describe("the Reflect section — rendered against the engine", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(panelDocument(SEEDS));
    forgetLastTransform();
  });
  afterEach(() => teardownPanels(h));

  it("the ANGLE typed is the axis: 0° mirrors top ↔ bottom, in ONE undo step, and Transform again remembers it", async () => {
    const panel = await mountPanel(h, makePathOptionsPanel);
    await panel.click(HEADER);
    expect(panel.get("[data-draw-pathopts-reflect-note]").textContent).toBe(REFLECT_SECTION_NOTE);
    expect(panel.disabled(APPLY)).toBe(true);
    await drive(() => h.host.selection.set([TRI]), panel.work);
    expect(panel.get(APPLY).textContent).toBe("Reflect 1 object");
    panel.change(field("reflect.angleDeg"), "0");
    panel.reset();
    await panel.click(APPLY);
    expect(panel.work.mutations.filter((m) => m.op === "batch")).toEqual([{ op: "batch", ops: 1 }]);
    // Centre y = 130: the first anchor (100, 100) lands at (100, 160).
    const p = await firstAnchor(h, TRI);
    expect(p[0]).toBeCloseTo(100, 3);
    expect(p[1]).toBeCloseTo(160, 3);
    expect(lastSelectionTransform()).toEqual({ kind: "reflect", angleDeg: 0, copy: false });
    await drive(() => h.host.document.undo(), panel.work);
    const back = await firstAnchor(h, TRI);
    expect(back[1]).toBeCloseTo(100, 3);
  });

  it("COPY is offered only where the engine can copy: here it is disabled, and the section says why", async () => {
    const panel = await mountPanel(h, makePathOptionsPanel);
    await panel.click(HEADER);
    expect(panel.get<HTMLInputElement>(`[data-draw-pathopts-toggle="reflect.copy"]`).disabled).toBe(true);
    expect(panel.get("[data-draw-pathopts-reflect-copy-note]").textContent).toBe(
      REFLECT_COPY_UNAVAILABLE_NOTE,
    );
  });
});
