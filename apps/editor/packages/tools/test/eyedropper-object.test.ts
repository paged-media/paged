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

// The Eyedropper's OBJECT mode: click an element, its fill, stroke and
// opacity land on the selection in one batch; Alt+click samples only; a
// click on nothing is a no-op; a target is written only the members its own
// snapshot exposes.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import {
  clearEyedropperSample,
  createEyedropperHandler,
  EYEDROPPER_TOOL_ID,
  getEyedropperSample,
} from "../src/handlers/eyedropper-tool";
import { harness } from "./support";

const SOURCE = { kind: "rectangle", id: "src" } as ElementId;
const RECT = { kind: "rectangle", id: "r1" } as ElementId;
const LINE = { kind: "graphicLine", id: "l1" } as ElementId;

const entry = (path: string, type: string, value: unknown) => ({
  path,
  value: { type, value },
});

const SOURCE_ENTRIES = [
  entry("frameFillColor", "colorRef", "Color/Red"),
  entry("frameFillTint", "length", 40),
  entry("frameStrokeColor", "colorRef", "Color/Black"),
  entry("frameStrokeWeight", "length", 3),
  entry("frameOpacity", "length", 50),
];

function objectMode(selection: ElementId[]) {
  const h = harness({
    selection,
    hitTest: () => SOURCE,
    toolSettings: { [EYEDROPPER_TOOL_ID]: { mode: "object" } },
  });
  const client = h.fake.shell.client as Record<string, unknown>;
  client.elementProperties = async (id: ElementId) => ({
    id,
    kind: id.kind,
    entries:
      id === SOURCE
        ? SOURCE_ENTRIES
        : id.kind === "graphicLine"
          ? [
              entry("frameStrokeColor", "colorRef", null),
              entry("frameStrokeWeight", "length", 1),
              entry("frameOpacity", "length", 100),
            ]
          : SOURCE_ENTRIES,
  });
  return h;
}

describe("Eyedropper: object mode", () => {
  it("a click copies fill, stroke and opacity onto the selection as ONE batch @level:gesture", async () => {
    covers("tool:paged.tool.eyedropper", "setting:paged.tool.eyedropper.mode");
    clearEyedropperSample();
    const { fake, g } = objectMode([RECT]);
    await g.tool(createEyedropperHandler).click([300, 400]).settle();
    const writes = fake.mutations();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      op: "batch",
      args: {
        ops: [
          ["frameFillColor", { type: "colorRef", value: "Color/Red" }],
          ["frameFillTint", { type: "length", value: 40 }],
          ["frameStrokeColor", { type: "colorRef", value: "Color/Black" }],
          ["frameStrokeWeight", { type: "length", value: 3 }],
          ["frameOpacity", { type: "length", value: 50 }],
        ].map(([path, value]) => ({
          op: "setElementProperty",
          args: { elementId: RECT, path, value },
        })),
      },
    } as never);
  });

  it("a graphic line is written only what it exposes: no fill @level:gesture", async () => {
    const { fake, g } = objectMode([LINE]);
    await g.tool(createEyedropperHandler).click([300, 400]).settle();
    const paths = (
      fake.mutations()[0] as { args: { ops: { args: { path: string } }[] } }
    ).args.ops.map((o) => o.args.path);
    expect(paths).toEqual([
      "frameStrokeColor",
      "frameStrokeWeight",
      "frameOpacity",
    ]);
  });

  it("Alt+click samples only; the source itself is never rewritten @level:gesture", async () => {
    clearEyedropperSample();
    const alt = objectMode([RECT]);
    await alt.g
      .tool(createEyedropperHandler)
      .click([300, 400], { mods: ["alt"] })
      .settle();
    expect(alt.fake.mutations()).toEqual([]);
    expect(getEyedropperSample()?.fillColor).toBe("Color/Red");
    const self = objectMode([SOURCE]);
    await self.g.tool(createEyedropperHandler).click([300, 400]).settle();
    expect(self.fake.mutations()).toEqual([]);
  });

  it("nothing under the click is a no-op @level:gesture", async () => {
    const h = harness({
      selection: [RECT],
      toolSettings: { [EYEDROPPER_TOOL_ID]: { mode: "object" } },
    });
    await h.g.tool(createEyedropperHandler).click([300, 400]).settle();
    expect(h.fake.mutations()).toEqual([]);
  });
});
