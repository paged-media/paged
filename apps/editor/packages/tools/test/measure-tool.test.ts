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

// The Measure tool: a drag publishes the segment and its readout as one
// preview, writes nothing, and Esc clears it; the origin snaps to the nearest
// point on the path under the press.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import {
  createMeasureHandler,
  measureReadoutLabel,
  measureTextPreview,
} from "../src/handlers/measure-tool";
import { harness, lastPreview, previews } from "./support";

const PATH = { kind: "polygon", id: "p1" } as ElementId;

describe("Measure tool", () => {
  it("a drag measures the segment and shows its readout; nothing is written @level:gesture", async () => {
    covers("tool:paged.tool.measure");
    const { fake, g } = harness();
    await g
      .tool(createMeasureHandler)
      .drag({ from: [100, 100], to: [160, 180] })
      .settle();
    expect(fake.mutations()).toEqual([]);
    const shapes = fake.currentPreview() as unknown as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(shapes)).toBe(true);
    const text = shapes.find((s) => s.kind === "text");
    expect(text?.text).toBe("100.00 pt · 53.1°");
    expect(shapes.find((s) => "points" in s)).toBeDefined();
  });

  it("the label and the text primitive: distance, angle, a plate, off the line's midpoint @level:gesture", () => {
    const readout = {
      from: [0, 0],
      to: [30, 40],
      dx: 30,
      dy: 40,
      distance: 50,
      angleDeg: 53.13,
    } as never;
    expect(measureReadoutLabel(readout)).toBe("50.00 pt · 53.1°");
    const t = measureTextPreview("pg", readout);
    expect(t).toMatchObject({
      kind: "text",
      pageId: "pg",
      anchor: "middle",
      background: true,
    });
    // The midpoint (15, 20) pushed 10 pt along the normal (-0.8, 0.6).
    expect(t.x).toBeCloseTo(7, 6);
    expect(t.y).toBeCloseTo(26, 6);
  });

  it("the origin snaps to the nearest point on the path under the press @level:gesture", async () => {
    const { g, fake } = harness({ hitTest: () => PATH });
    (fake.shell.client as Record<string, unknown>).send = async (r: {
      kind: string;
    }) =>
      r.kind === "hitTest"
        ? { kind: "hitResult", payload: { element: PATH, itemTransform: null } }
        : r.kind === "requestNearestPathPoint"
          ? {
              kind: "nearestPathPoint",
              payload: { result: { point: [103, 100], distance: 3 } },
            }
          : { kind: "error", payload: {} };
    await g
      .tool(createMeasureHandler)
      .drag({ from: [100, 100], to: [160, 100] })
      .settle();
    const shapes = fake.currentPreview() as unknown as Array<
      Record<string, unknown>
    >;
    const line = shapes.find((s) => "points" in s) as {
      points: [number, number][];
    };
    expect(line.points[0]).toEqual([103, 100]);
    expect(previews(fake).length + (lastPreview(fake) ? 1 : 0)).toBeGreaterThan(
      0,
    );
  });
});
