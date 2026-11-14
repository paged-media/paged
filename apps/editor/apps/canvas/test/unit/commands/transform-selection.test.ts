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

// Editor ADR 1240, amendment 1 — `paged.object.transformSelection`, what a
// recorded canvas gesture replays through: the same move, copy, resize,
// scale or turn on whatever selection a replay hands it, as one batch.

import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  planTransformSelection,
  resizedBounds,
  rotationAbout,
  TRANSFORM_SELECTION_COMMAND,
  transformSelectionRefusal,
} from "../../../src/transform-selection-plan";
import { buildTransformCommands } from "../../../src/transform-commands";
import {
  apply,
  type Affine,
  type SpreadTarget,
} from "../../../src/transform-targets";

const item = (
  address: string,
  b: [number, number, number, number],
  composed: Affine | null = null,
): SpreadTarget => ({
  address,
  box: b,
  inner: b,
  pageId: "p1",
  spreadId: "s1",
  composed,
});

const near = (got: readonly number[], want: readonly number[]) =>
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
const valueOf = (op: unknown) => (op as { value: number[] }).value;

describe("Transform the selection: the plan [editor-shell.panels.actions]", () => {
  test("a move translates every target by (dx, dy) pt", () => {
    covers("command:paged.object.transformSelection");
    const ops = planTransformSelection(
      { targets: [], transform: "move", dx: 24, dy: -6 },
      [item("rectangle:a", [0, 0, 10, 10]), item("oval:b", [20, 20, 30, 30])],
    );
    expect(ops).toEqual([
      {
        op: "set",
        address: "rectangle:a",
        path: "frameTransform",
        value: [1, 0, 0, 1, 24, -6],
      },
      {
        op: "set",
        address: "oval:b",
        path: "frameTransform",
        value: [1, 0, 0, 1, 24, -6],
      },
    ]);
  });

  test("a copy is one duplicate of the targets at the offset", () => {
    covers("command:paged.object.transformSelection");
    expect(
      planTransformSelection(
        { targets: [], transform: "duplicate", dx: 30, dy: 0 },
        [item("rectangle:a", [0, 0, 10, 10])],
      ),
    ).toEqual([
      {
        op: "invoke",
        command: "core.duplicateElements",
        args: { elementIds: ["rectangle:a"], offset: [30, 0] },
      },
    ]);
  });

  test("a resize makes each frame's own box the size, its anchor kept", () => {
    covers("command:paged.object.transformSelection");
    expect(resizedBounds([100, 420, 180, 540], "northWest", 150, 100)).toEqual([
      100, 420, 200, 570,
    ]);
    expect(resizedBounds([100, 420, 180, 540], "southEast", 150, 100)).toEqual([
      80, 390, 180, 540,
    ]);
    // A side left out keeps its size; the centre stays the centre.
    expect(resizedBounds([0, 0, 50, 100], "center", undefined, 70)).toEqual([
      -10, 0, 60, 100,
    ]);
    const ops = planTransformSelection(
      {
        targets: [],
        transform: "resize",
        width: 150,
        height: 100,
        anchor: "northWest",
      },
      [item("rectangle:a", [0, 0, 10, 10])],
    );
    expect(ops).toEqual([
      {
        op: "invoke",
        command: "core.resizeFrame",
        args: { frameId: "rectangle:a", bounds: [0, 0, 100, 150] },
      },
    ]);
  });

  test("a group has no box of its own: its resize scales it about the anchor", () => {
    covers("command:paged.object.transformSelection");
    const group: SpreadTarget = {
      ...item("group:g", [0, 0, 20, 40]),
      inner: undefined,
      group: { stored: null },
    };
    const [op] = planTransformSelection(
      {
        targets: [],
        transform: "resize",
        width: 80,
        anchor: "northWest",
      },
      [group],
    );
    expect(op).toMatchObject({
      op: "invoke",
      command: "core.setGroupTransform",
    });
    near(
      (op as { args: { transform: number[] } }).args.transform,
      [2, 0, 0, 1, 0, 0],
    );
  });

  test("a scale takes the selection's box to the size about its anchor", () => {
    covers("command:paged.object.transformSelection");
    const ops = planTransformSelection(
      {
        targets: [],
        transform: "scale",
        width: 60,
        height: 60,
        anchor: "southEast",
      },
      [
        item("rectangle:a", [0, 0, 10, 10]),
        item("rectangle:b", [10, 10, 30, 30]),
      ],
    );
    const m = valueOf(ops[0]) as unknown as Affine;
    // The south-east corner (30, 30) stays; the box doubles.
    near(apply(m, 30, 30), [30, 30]);
    near(apply(m, 0, 0), [-30, -30]);
    expect(ops).toHaveLength(2);
  });

  test("a turn is about the selection's centre, clockwise on the page", () => {
    covers("command:paged.object.transformSelection");
    const r = rotationAbout(90, [5, 5]);
    near(apply(r, 5, 5), [5, 5]);
    // +x turns toward +y (down on the page).
    near(apply(r, 6, 5), [5, 6]);
    const ops = planTransformSelection(
      { targets: [], transform: "rotate", angle: 90 },
      [item("rectangle:a", [0, 0, 10, 10])],
    );
    near(valueOf(ops[0]), [0, 1, -1, 0, 10, 0]);
  });

  test("args a transform cannot do are refused by name; nothing to do is no op", () => {
    covers("command:paged.object.transformSelection");
    expect(
      transformSelectionRefusal({ targets: [], transform: "move" }),
    ).toMatch(/needs dx or dy/);
    expect(
      transformSelectionRefusal({
        targets: [],
        transform: "resize",
        width: -1,
      }),
    ).toMatch(/positive/);
    expect(
      transformSelectionRefusal({ targets: [], transform: "rotate" }),
    ).toMatch(/angle/);
    expect(
      planTransformSelection({ targets: [], transform: "move", dx: 0, dy: 0 }, [
        item("rectangle:a", [0, 0, 10, 10]),
      ]),
    ).toEqual([]);
    expect(
      planTransformSelection({ targets: [], transform: "move", dx: 5 }, []),
    ).toEqual([]);
  });
});

describe("paged.object.transformSelection through the registry [editor-shell.panels.actions]", () => {
  function harness() {
    const batches: Array<{ ops: unknown[]; label?: string }> = [];
    const client = {
      async elementGeometry(ids: { kind: string; id: unknown }[]) {
        return ids.map((id) => ({
          id,
          pageId: "p1",
          spreadId: "s1",
          bounds: [0, 0, 10, 20],
          itemTransform: null,
        }));
      },
      async elementProperties() {
        return null;
      },
      async collection() {
        return [];
      },
    };
    const registry = createCommandRegistry(() => ({ client }));
    for (const c of buildTransformCommands({
      async batch(ops, opts) {
        batches.push({ ops: [...ops], label: opts?.label });
        return { applied: true, undoSteps: 1 };
      },
    }))
      registry.register(c);
    return { registry, batches };
  }

  test("the selection's transform in ONE batch", async () => {
    covers("command:paged.object.transformSelection");
    const h = harness();
    const r = await h.registry.invoke(TRANSFORM_SELECTION_COMMAND, {
      targets: ["rectangle:a", "oval:b"],
      transform: "resize",
      height: 40,
      anchor: "north",
    });
    expect(r).toEqual({ applied: true, undoSteps: 1 });
    expect(h.batches).toEqual([
      {
        label: "transform selection resize",
        ops: [
          {
            op: "invoke",
            command: "core.resizeFrame",
            args: { frameId: "rectangle:a", bounds: [0, 0, 40, 20] },
          },
          {
            op: "invoke",
            command: "core.resizeFrame",
            args: { frameId: "oval:b", bounds: [0, 0, 40, 20] },
          },
        ],
      },
    ]);
  });

  test("a payload that does not conform is refused before anything runs", async () => {
    covers("command:paged.object.transformSelection");
    const h = harness();
    await expect(
      h.registry.invoke(TRANSFORM_SELECTION_COMMAND, {
        targets: ["rectangle:a"],
        transform: "shear",
      }),
    ).rejects.toThrow(/invalidValue/);
    await expect(
      h.registry.invoke(TRANSFORM_SELECTION_COMMAND, {
        targets: ["rectangle:a"],
        transform: "rotate",
      }),
    ).rejects.toThrow(/rotate needs an angle/);
    expect(h.batches).toEqual([]);
  });
});
