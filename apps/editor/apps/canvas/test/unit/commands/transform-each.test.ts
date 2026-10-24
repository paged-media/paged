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

// WP4.4 — Transform Each (`paged.object.transformEach`): every object
// about its own reference point, scale → rotate → move, reflect, a seeded
// random, one batch.

import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "@paged-media/shell";
import { covers } from "@paged-media/test-kit";

import {
  planTransformEach,
  referencePointOf,
  REFERENCE_POINTS,
  seededRandom,
  TRANSFORM_EACH_COMMAND,
  TRANSFORM_EACH_DEFAULTS,
  transformEachMatrix,
  transformEachParams,
  type TransformEachParams,
} from "../../../src/transform-each-plan";
import { buildTransformCommands } from "../../../src/transform-commands";
import {
  apply,
  type Affine,
  type SpreadTarget,
} from "../../../src/transform-targets";

const box = (
  address: string,
  b: [number, number, number, number],
  composed: Affine | null = null,
): SpreadTarget => ({
  address,
  box: b,
  pageId: "p1",
  spreadId: "s1",
  composed,
});

const params = (p: Partial<TransformEachParams>): TransformEachParams => ({
  ...TRANSFORM_EACH_DEFAULTS,
  ...p,
});

const near = (got: readonly number[], want: readonly number[]) =>
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));

const valueOf = (op: unknown) => (op as { value: number[] }).value;

describe("Transform Each: the matrices [editor-shell.align-transform-each]", () => {
  test("the nine reference points of a box", () => {
    covers("command:paged.object.transformEach");
    const b: [number, number, number, number] = [10, 20, 30, 60];
    expect(REFERENCE_POINTS.map((r) => referencePointOf(b, r))).toEqual([
      [20, 10],
      [40, 10],
      [60, 10],
      [20, 20],
      [40, 20],
      [60, 20],
      [20, 30],
      [40, 30],
      [60, 30],
    ]);
  });

  test("scale about the reference point keeps that point fixed", () => {
    covers("command:paged.object.transformEach");
    const m = transformEachMatrix([10, 10], {
      ...params({ scaleH: 200, scaleV: 50 }),
    });
    near(apply(m, 10, 10), [10, 10]);
    near(apply(m, 20, 20), [30, 15]);
  });

  test("a positive angle turns counter-clockwise on screen (y down)", () => {
    covers("command:paged.object.transformEach");
    const m = transformEachMatrix([0, 0], params({ angle: 90 }));
    // +x turns to −y (up on screen).
    near(apply(m, 1, 0), [0, -1]);
  });

  test("reflect X flips top and bottom, reflect Y left and right", () => {
    covers("command:paged.object.transformEach");
    const x = transformEachMatrix([0, 10], params({ reflectX: true }));
    near(apply(x, 5, 0), [5, 20]);
    const y = transformEachMatrix([10, 0], params({ reflectY: true }));
    near(apply(y, 0, 5), [20, 5]);
  });

  test("scale, then rotate, then move", () => {
    covers("command:paged.object.transformEach");
    const m = transformEachMatrix(
      [0, 0],
      params({ scaleH: 200, scaleV: 200, angle: 90, moveH: 5, moveV: 7 }),
    );
    // (1, 0) → scaled (2, 0) → turned (0, −2) → moved (5, 5).
    near(apply(m, 1, 0), [5, 5]);
  });
});

describe("Transform Each: the plan [editor-shell.align-transform-each]", () => {
  const a = box("rectangle:a", [0, 0, 10, 10]);
  const b = box("rectangle:b", [0, 100, 20, 120]);

  test("each object turns about its OWN centre", () => {
    covers("command:paged.object.transformEach");
    const ops = planTransformEach(params({ angle: 180 }), [a, b]);
    expect(ops).toHaveLength(2);
    near(valueOf(ops[0]), [-1, 0, 0, -1, 10, 10]);
    near(valueOf(ops[1]), [-1, 0, 0, -1, 220, 20]);
    expect(ops.map((o) => (o as { path: string }).path)).toEqual([
      "frameTransform",
      "frameTransform",
    ]);
  });

  test("the transform composes onto the object's own (a rotated frame keeps its turn)", () => {
    covers("command:paged.object.transformEach");
    const turned = box("rectangle:t", [0, 0, 10, 10], [0, 1, -1, 0, 10, 0]);
    const [op] = planTransformEach(params({ moveH: 5 }), [turned]);
    expect(valueOf(op)).toEqual([0, 1, -1, 0, 15, 0]);
  });

  test("a group is written through setGroupTransform", () => {
    covers("command:paged.object.transformEach");
    const g: SpreadTarget = {
      ...box("group:g", [0, 0, 10, 10]),
      group: { stored: null },
    };
    expect(planTransformEach(params({ moveV: 3 }), [g])).toEqual([
      {
        op: "invoke",
        command: "core.setGroupTransform",
        args: { groupId: "group:g", transform: [1, 0, 0, 1, 0, 3] },
      },
    ]);
  });

  test("the identity writes nothing", () => {
    covers("command:paged.object.transformEach");
    expect(planTransformEach(TRANSFORM_EACH_DEFAULTS, [a, b])).toEqual([]);
  });

  test("random: the same seed, the same amounts; each between neutral and the value", () => {
    covers("command:paged.object.transformEach");
    const p = params({ random: true, moveH: 100, seed: 42 });
    const once = planTransformEach(p, [a, b]);
    expect(planTransformEach(p, [a, b])).toEqual(once);
    expect(planTransformEach({ ...p, seed: 43 }, [a, b])).not.toEqual(once);
    for (const op of once) {
      const tx = valueOf(op)[4]!;
      expect(tx).toBeGreaterThanOrEqual(0);
      expect(tx).toBeLessThanOrEqual(100);
    }
    // The two objects draw different amounts.
    expect(valueOf(once[0])[4]).not.toBe(valueOf(once[1])[4]);
    const r = seededRandom(7);
    const draws = [r(), r(), r()];
    expect(draws.every((d) => d >= 0 && d < 1)).toBe(true);
    const again = seededRandom(7);
    expect([again(), again(), again()]).toEqual(draws);
  });

  test("missing args take the defaults", () => {
    covers("command:paged.object.transformEach");
    expect(transformEachParams({ angle: 15 })).toEqual({
      ...TRANSFORM_EACH_DEFAULTS,
      angle: 15,
    });
  });
});

describe("paged.object.transformEach through the registry [editor-shell.align-transform-each]", () => {
  function harness() {
    const batches: Array<{ ops: unknown[]; label?: string }> = [];
    const client = {
      async elementGeometry(ids: { kind: string; id: unknown }[]) {
        return ids.map((id) => ({
          id,
          pageId: "p1",
          spreadId: "s1",
          bounds: [0, 0, 10, 10],
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

  test("the whole selection in ONE batch", async () => {
    covers("command:paged.object.transformEach");
    const h = harness();
    const r = await h.registry.invoke(TRANSFORM_EACH_COMMAND, {
      targets: ["rectangle:a", "oval:b"],
      scaleH: 50,
      scaleV: 50,
      reference: "topLeft",
    });
    expect(r).toEqual({ applied: true, undoSteps: 1 });
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.label).toBe("transform each");
    expect(h.batches[0]!.ops).toEqual([
      {
        op: "set",
        address: "rectangle:a",
        path: "frameTransform",
        value: [0.5, 0, 0, 0.5, 0, 0],
      },
      {
        op: "set",
        address: "oval:b",
        path: "frameTransform",
        value: [0.5, 0, 0, 0.5, 0, 0],
      },
    ]);
  });

  test("nothing to change: zero undo steps; bad args refused", async () => {
    covers("command:paged.object.transformEach");
    const h = harness();
    expect(
      await h.registry.invoke(TRANSFORM_EACH_COMMAND, {
        targets: ["rectangle:a"],
      }),
    ).toEqual({ applied: true, undoSteps: 0 });
    await expect(
      h.registry.invoke(TRANSFORM_EACH_COMMAND, {
        targets: ["rectangle:a"],
        reference: "nowhere",
      }),
    ).rejects.toThrow(/invalidValue/);
    expect(h.batches).toEqual([]);
  });
});
