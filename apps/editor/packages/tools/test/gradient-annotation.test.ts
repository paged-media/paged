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

// The Gradient tool's annotation: the selection's gradient axis with a
// marker per stop; a drag of a marker writes the one stop through
// `editGradient`; a press anywhere else stays the axis drag.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";
import { gradientSpecWithStop } from "@paged-media/helpers";

import {
  createGradientSwatchHandler,
  GRADIENT_SWATCH_TOOL_ID,
} from "../src/handlers/gradient-tool";
import { harness } from "./support";

const RECT = { kind: "rectangle", id: "r1" } as ElementId;

const DETAIL = {
  selfId: "Gradient/g1",
  name: "g1",
  kind: "linear",
  stops: [
    { stopColorRef: "Color/Black", locationPct: 0, midpointPct: 50 },
    { stopColorRef: "Color/Paper", locationPct: 100, opacityPct: 80 },
  ],
};

function annotated() {
  const h = harness({
    selection: [RECT],
    toolSettings: { [GRADIENT_SWATCH_TOOL_ID]: { mode: "linear" } },
  });
  const client = h.fake.shell.client as Record<string, unknown>;
  client.elementProperties = async () => ({
    entries: [
      {
        path: "frameFillColor",
        value: { type: "colorRef", value: "Gradient/g1" },
      },
      { path: "frameGradientFillAngle", value: { type: "length", value: 0 } },
      {
        path: "frameGradientFillLength",
        value: { type: "length", value: 100 },
      },
    ],
  });
  client.elementGeometry = async () => [
    {
      id: RECT,
      pageId: "page-1",
      bounds: [0, 0, 100, 200],
      itemTransform: null,
    },
  ];
  client.gradientDetail = async () => DETAIL;
  client.subscribe = () => () => undefined;
  return h;
}

describe("gradient spec of a moved stop", () => {
  it("moves one location and keeps every other field @level:gesture", () => {
    expect(gradientSpecWithStop(DETAIL, 1, 60)).toEqual({
      selfId: "Gradient/g1",
      name: "g1",
      kind: "Linear",
      stops: [
        { stopColor: "Color/Black", locationPct: 0, midpointPct: 50 },
        { stopColor: "Color/Paper", locationPct: 60, opacityPct: 80 },
      ],
    });
    expect(
      gradientSpecWithStop({ ...DETAIL, kind: "unknown" }, 1, 60),
    ).toBeNull();
    expect(gradientSpecWithStop(DETAIL, 5, 60)).toBeNull();
  });
});

describe("Gradient tool: annotation", () => {
  it("shows the axis and a marker per stop; dragging a marker writes editGradient @level:gesture", async () => {
    covers("tool:paged.tool.gradientSwatch");
    const { fake, g } = annotated();
    // Frame centre (100, 50); the axis runs along +x for 100 pt, so the
    // stops sit at x = 100 and x = 200.
    await g.tool(createGradientSwatchHandler).settle();
    const shapes = fake.currentPreview() as unknown as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(shapes)).toBe(true);
    expect(shapes.filter((s) => s.close === true)).toHaveLength(2);
    await g.drag({ from: [200, 50], to: [160, 50] }).settle();
    const writes = fake.mutations() as unknown as Array<{
      op: string;
      args: { gradientId: string; spec: { stops: { locationPct: number }[] } };
    }>;
    expect(writes).toHaveLength(1);
    expect(writes[0]!.op).toBe("editGradient");
    expect(writes[0]!.args.gradientId).toBe("Gradient/g1");
    expect(writes[0]!.args.spec.stops[1]!.locationPct).toBeCloseTo(60, 0);
  });

  it("a press away from the markers is still the axis drag @level:gesture", async () => {
    const { fake, g } = annotated();
    await g
      .tool(createGradientSwatchHandler)
      .drag({ from: [20, 120], to: [120, 120] })
      .settle();
    const ops = fake.mutations() as unknown as Array<{ op: string }>;
    expect(ops.map((m) => m.op)).toEqual(["batch"]);
  });
});
