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

// Editor ADR 1240, amendment 1 — what a committed canvas gesture did to the
// selection, measured from the document's geometry (`UXI-MUT-013`): in
// points and degrees on the page, whatever the zoom, and handed to the
// observers of the coordinator's committed sessions.

import { describe, expect, test } from "bun:test";

import { createInteractionCoordinator } from "../../src/interaction/coordinator";
import {
  anchorOf,
  anchorPoint,
  measureTransformIntent,
  type MeasuredGeometry,
} from "../../src/interaction/transform-intent";
import {
  gestureStepTitle,
  stepFromIntent,
  TRANSFORM_SELECTION_COMMAND,
} from "../../src/actions/model";
import {
  applyParams,
  isObjectAddress,
  NO_SELECTION,
  parameterLeaves,
} from "../../src/actions/intent";

const frame = (
  bounds: [number, number, number, number],
  itemTransform: number[] | null = null,
  pageOrigin: [number, number] | null = null,
): MeasuredGeometry => ({ bounds, itemTransform, pageOrigin });

const turn = (deg: number, tx = 0, ty = 0): number[] => {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), tx, ty];
};

describe("measuring a committed gesture", () => {
  test("a move is the selection's displacement in pt, whatever page origin it sits under", () => {
    expect(
      measureTransformIntent({
        gesture: "translate",
        alt: false,
        before: [frame([100, 420, 180, 540], null, [-612, -396])],
        after: [
          frame([100, 420, 180, 540], [1, 0, 0, 1, 24.5, -12], [-612, -396]),
        ],
      }),
    ).toEqual({ kind: "move", dx: 24.5, dy: -12, copy: false });
    // Several objects: the box around them moved.
    expect(
      measureTransformIntent({
        gesture: "translate",
        alt: false,
        before: [frame([0, 0, 10, 10]), frame([20, 20, 30, 30])],
        after: [
          frame([0, 0, 10, 10], [1, 0, 0, 1, 5, 5]),
          frame([20, 20, 30, 30], [1, 0, 0, 1, 5, 5]),
        ],
      }),
    ).toEqual({ kind: "move", dx: 5, dy: 5, copy: false });
  });

  test("an Alt move that copied is a copy offset from the originals", () => {
    expect(
      measureTransformIntent({
        gesture: "translate",
        alt: true,
        copied: true,
        before: [frame([0, 0, 10, 10])],
        after: [frame([0, 0, 10, 10], [1, 0, 0, 1, 30, 0])],
      }),
    ).toEqual({ kind: "move", dx: 30, dy: 0, copy: true });
  });

  test("a drag that went nowhere is no step", () => {
    expect(
      measureTransformIntent({
        gesture: "translate",
        alt: false,
        before: [frame([0, 0, 10, 10])],
        after: [frame([0, 0, 10, 10])],
      }),
    ).toBeNull();
    expect(
      measureTransformIntent({
        gesture: "rotate",
        alt: false,
        before: [frame([0, 0, 10, 10])],
        after: [],
      }),
    ).toBeNull();
  });

  test("a frame's resize is its own new size, the sides its handle moved, the opposite handle kept", () => {
    expect(
      measureTransformIntent({
        gesture: "resize",
        handle: "southEast",
        alt: false,
        before: [frame([100, 420, 180, 540])],
        after: [frame([100, 420, 200.25, 570])],
      }),
    ).toEqual({
      kind: "resize",
      width: 150,
      height: 100.25,
      anchor: "northWest",
    });
    // A side handle: only that side's size.
    expect(
      measureTransformIntent({
        gesture: "resize",
        handle: "east",
        alt: false,
        before: [frame([0, 0, 50, 100])],
        after: [frame([0, 0, 50, 140])],
      }),
    ).toEqual({ kind: "resize", width: 140, anchor: "west" });
    // Alt: from the centre. A turned frame's own box, not its outline.
    expect(
      measureTransformIntent({
        gesture: "resize",
        handle: "north",
        alt: true,
        before: [frame([0, 0, 50, 100], turn(30))],
        after: [frame([-10, 0, 60, 100], turn(30))],
      }),
    ).toEqual({ kind: "resize", height: 70, anchor: "center" });
  });

  test("a scale is the selection box's new size about the kept handle", () => {
    expect(
      measureTransformIntent({
        gesture: "scale",
        handle: "northWest",
        alt: false,
        before: [frame([0, 0, 10, 10]), frame([10, 10, 20, 20])],
        after: [
          frame([0, 0, 10, 10], [1.5, 0, 0, 1.5, -10, -10]),
          frame([10, 10, 20, 20], [1.5, 0, 0, 1.5, -10, -10]),
        ],
      }),
    ).toEqual({ kind: "scale", width: 30, height: 30, anchor: "southEast" });
  });

  test("a rotation is the turn in degrees clockwise on the page, normalised", () => {
    expect(
      measureTransformIntent({
        gesture: "rotate",
        alt: false,
        before: [frame([0, 0, 10, 10], turn(10, 3, 4))],
        after: [frame([0, 0, 10, 10], turn(55, 1, 2))],
      }),
    ).toEqual({ kind: "rotate", angle: 45 });
    expect(
      measureTransformIntent({
        gesture: "rotate",
        alt: false,
        before: [frame([0, 0, 10, 10], turn(170))],
        after: [frame([0, 0, 10, 10], turn(-170))],
      }),
    ).toEqual({ kind: "rotate", angle: 20 });
  });

  test("anchors: the opposite handle, the centre with Alt; their points on a box", () => {
    expect(anchorOf("southEast", false)).toBe("northWest");
    expect(anchorOf("west", false)).toBe("east");
    expect(anchorOf("west", true)).toBe("center");
    expect(anchorPoint([10, 20, 50, 80], "northWest")).toEqual([20, 10]);
    expect(anchorPoint([10, 20, 50, 80], "south")).toEqual([50, 50]);
    expect(anchorPoint([10, 20, 50, 80], "center")).toEqual([50, 30]);
  });
});

describe("a committed session carries its intent", () => {
  test("observers hear a commit with its intent; nobody observing, nothing is measured", () => {
    const c = createInteractionCoordinator({ trace: true });
    expect(c.observesCommits()).toBe(false);
    const heard: unknown[] = [];
    const off = c.onCommitted((x) => heard.push([x.session.owner, x.intent]));
    expect(c.observesCommits()).toBe(true);

    const move = { kind: "move", dx: 12, dy: 0, copy: false } as const;
    const s = c.begin({ owner: "canvas-transform", mutating: true })!;
    c.end(s, "commit", undefined, move);
    expect(s.intent).toEqual(move);
    expect(heard).toEqual([["canvas-transform", move]]);
    // The trace says what kind it was, nothing more.
    const end = c.trace.entries().find((e) => e.event === "end")!;
    expect(end.intent).toBe("move");

    // A cancel or an abort carries none, and nothing is heard.
    const t = c.begin({ owner: "canvas-transform", mutating: true })!;
    c.end(t, "cancel", "escape", move);
    expect(t.intent).toBeNull();
    // A commit without one is not heard either.
    const u = c.begin({ owner: "canvas-select" })!;
    c.end(u, "commit");
    expect(heard).toHaveLength(1);

    off();
    expect(c.observesCommits()).toBe(false);
  });

  test("the step it records names the selection, never ids, and its numbers are parameters", () => {
    const step = stepFromIntent(
      { kind: "resize", width: 150, height: 100, anchor: "northWest" },
      { selection: { elements: ["rectangle:u1"], text: null }, context: null },
    );
    expect(step.command).toBe(TRANSFORM_SELECTION_COMMAND);
    expect(step.verdict).toBe("portable");
    expect(step.context).toBeNull();
    expect(step.payload).toEqual({
      targets: { $selection: "elements" },
      transform: "resize",
      width: 150,
      height: 100,
      anchor: "northWest",
    });
    expect(step.title).toBe(
      "Resize to 150 × 100 pt, keeping the top left corner",
    );
    expect(
      stepFromIntent(
        { kind: "move", dx: -6, dy: 24.125, copy: true },
        { selection: NO_SELECTION, context: "sheet" },
      ),
    ).toMatchObject({
      payload: { transform: "duplicate", dx: -6, dy: 24.125 },
      context: "sheet",
      title: "Copy the selection, offset -6 pt, 24.13 pt",
    });
    // Each number is a value the user can make a parameter and change.
    const move = stepFromIntent(
      { kind: "move", dx: 24, dy: 0, copy: false },
      { selection: NO_SELECTION, context: null },
    );
    expect(
      parameterLeaves(move.payload, isObjectAddress).map((l) => l.path),
    ).toEqual([["transform"], ["dx"], ["dy"]]);
    expect(
      applyParams(move.payload, 0, [
        { id: "p1", label: "dx", step: 0, path: ["dx"], value: 36 },
      ]),
    ).toEqual({
      targets: { $selection: "elements" },
      transform: "move",
      dx: 36,
      dy: 0,
    });
    expect(gestureStepTitle({ kind: "rotate", angle: -15 })).toBe(
      "Rotate the selection 15° counterclockwise about its center",
    );
    expect(
      gestureStepTitle({ kind: "scale", width: 40, anchor: "center" }),
    ).toBe("Scale the selection to a width of 40 pt, keeping the center");
  });
});
