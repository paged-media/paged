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

// Reflect and Transform again (`paged.transform.*`), ported from the cases
// paged.draw's own copy was held to: R ∘ M per element (the write REPLACES a
// transform), a group in its parent's frame, copy ordering, a page-space
// axis point, the session's last transform and re-centring.

import { describe, expect, test } from "bun:test";

import {
  createCommandRegistry,
  createEditorScope,
  TRANSFORM_MEMORY,
} from "@paged-media/shell";
import { compose, reflectMatrix, type Affine } from "@paged-media/helpers";
import { covers } from "@paged-media/test-kit";

import {
  buildReflectCommands,
  PAGED_TRANSFORM_AGAIN,
  PAGED_TRANSFORM_REFLECT_HORIZONTAL,
  PAGED_TRANSFORM_REFLECT_OPTIONS,
  PAGED_TRANSFORM_REFLECT_VERTICAL,
  PAGED_TRANSFORM_ROTATE_90_CCW,
  PAGED_TRANSFORM_ROTATE_90_CW,
  PAGED_TRANSFORM_ROTATE_STEP_CCW,
  PAGED_TRANSFORM_ROTATE_STEP_CW,
  PAGED_TRANSFORM_SCALE_DOWN,
  PAGED_TRANSFORM_SCALE_UP,
  planTransform,
  rotationRecord,
  reflectPayloadOf,
  REFLECT_MENU_ITEMS,
  spreadPivotOf,
} from "../../../src/reflect-commands";
import { apply, type SpreadTarget } from "../../../src/transform-targets";

const near = (got: readonly number[], want: readonly number[]) => {
  expect(got).toHaveLength(want.length);
  got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
};

const item = (
  address: string,
  box: [number, number, number, number],
  composed: Affine | null = null,
): SpreadTarget => ({
  address,
  box,
  pageId: "p1",
  spreadId: "s1",
  composed,
});

const valueOf = (op: unknown) => (op as { value: number[] }).value;

describe("planTransform: the writes of a reflect [editor-shell.transform-reflect]", () => {
  test("a page item is written R ∘ M about the centre of the selection's box", () => {
    covers("command:paged.transform.reflectHorizontal");
    const turned: Affine = [0, 1, -1, 0, 40, 0];
    const ops = planTransform(
      [item("rectangle:a", [0, 100, 20, 200], turned)],
      { kind: "reflect", angleDeg: 90, copy: false },
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: "set",
      address: "rectangle:a",
      path: "frameTransform",
    });
    // Writing R alone would lose the rotation M carries: R ∘ M keeps it.
    near(valueOf(ops[0]), compose(reflectMatrix(90, [150, 10]), turned));
  });

  test("the centre is the union's: two items mirror about ONE axis", () => {
    covers("command:paged.transform.reflectVertical");
    const ops = planTransform(
      [item("rectangle:a", [0, 0, 10, 10]), item("oval:b", [90, 90, 110, 110])],
      { kind: "reflect", angleDeg: 0, copy: false },
    );
    near(valueOf(ops[0]), [1, 0, 0, -1, 0, 110]);
    near(valueOf(ops[1]), [1, 0, 0, -1, 0, 110]);
  });

  test("a top-level group is written R ∘ G through setGroupTransform", () => {
    covers("command:paged.transform.reflectHorizontal");
    const stored: Affine = [1, 0, 0, 1, 10, 0];
    const g: SpreadTarget = {
      ...item("group:g", [100, 100, 160, 200], stored),
      group: { stored },
    };
    const ops = planTransform([g], {
      kind: "reflect",
      angleDeg: 90,
      copy: false,
    });
    expect(ops[0]).toMatchObject({
      op: "invoke",
      command: "core.setGroupTransform",
      args: { groupId: "group:g" },
    });
    near(
      (ops[0] as { args: { transform: number[] } }).args.transform,
      compose(reflectMatrix(90, [150, 130]), stored),
    );
  });

  test("a NESTED group in a parent turned 90 degrees: the page mirror lands as a page mirror", () => {
    covers("command:paged.transform.reflectHorizontal");
    // The parent: a quarter turn about (200, 200), (x, y) -> (400 - y, x).
    const parent: Affine = [0, 1, -1, 0, 400, 0];
    const inner: Affine = [1, 0, 0, 1, 10, 0];
    const composed = compose(parent, inner);
    const g: SpreadTarget = {
      ...item("group:inner", [100, 100, 160, 200], composed),
      group: { stored: inner },
    };
    const ops = planTransform([g], {
      kind: "reflect",
      angleDeg: 90,
      copy: false,
    });
    const written = (ops[0] as { args: { transform: number[] } }).args
      .transform as unknown as Affine;
    // Seen from the quarter-turned frame it is a top / bottom flip.
    near(written, [1, 0, 0, -1, 10, 500]);
    // What the user sees: the group through its parent lands mirrored.
    const now = compose(parent, written);
    near(now, compose(reflectMatrix(90, [150, 130]), composed));
    for (const [x, y] of [
      [0, 0],
      [40, 0],
      [-25, 13],
    ] as const) {
      const [bx, by] = apply(composed, x, y);
      const [ax, ay] = apply(now, x, y);
      expect(ax).toBeCloseTo(300 - bx, 6);
      expect(ay).toBeCloseTo(by, 6);
    }
  });

  test("a copy puts ONE duplicateElements first and reflects the sources", () => {
    covers("command:paged.transform.reflectHorizontal");
    const ops = planTransform(
      [item("rectangle:a", [0, 0, 10, 10]), item("oval:b", [0, 20, 10, 30])],
      { kind: "reflect", angleDeg: 90, copy: true },
    );
    expect(ops).toHaveLength(3);
    expect(ops[0]).toEqual({
      op: "invoke",
      command: "core.duplicateElements",
      args: { elementIds: ["rectangle:a", "oval:b"], offset: [0, 0] },
    });
    expect(ops[1]).toMatchObject({ address: "rectangle:a" });
    expect(ops[2]).toMatchObject({ address: "oval:b" });
  });

  test("a PAGE-space axis point is taken to the spread by the page's origin", () => {
    covers("command:paged.transform.reflectHorizontal");
    const t = {
      ...item("rectangle:a", [0, 500, 10, 520]),
      origin: [400, 0] as const,
    };
    expect(spreadPivotOf([100, 5], [t])).toEqual([500, 5]);
    expect(
      spreadPivotOf([100, 5], [item("rectangle:a", [0, 0, 1, 1])]),
    ).toEqual([100, 5]);
    const ops = planTransform(
      [t],
      { kind: "reflect", angleDeg: 90, copy: false },
      [100, 5],
    );
    // Mirror about x = 500 (page 100 + origin 400).
    near(valueOf(ops[0]), [-1, 0, 0, 1, 1000, 0]);
  });

  test("a linear record is re-centred on the target it is applied to", () => {
    covers("command:paged.transform.again");
    const half = {
      kind: "linear" as const,
      linear: [-1, 0, 0, -1] as const,
      copy: false as const,
    };
    const ops = planTransform([item("rectangle:a", [0, 0, 10, 20])], half);
    // A half turn about (10, 5): the centre stays.
    const m = valueOf(ops[0]) as unknown as Affine;
    near(apply(m, 10, 5), [10, 5]);
    near(apply(m, 0, 0), [20, 10]);
  });

  test("no geometry, no writes", () => {
    covers("command:paged.transform.reflectHorizontal");
    expect(
      planTransform([], { kind: "reflect", angleDeg: 90, copy: false }),
    ).toEqual([]);
  });
});

describe("the payload", () => {
  test("is sanitised: finite numbers, a pair, string targets", () => {
    covers("command:paged.transform.reflectHorizontal");
    expect(reflectPayloadOf(undefined)).toEqual({ copy: false });
    expect(
      reflectPayloadOf({
        angleDeg: 45,
        copy: true,
        pivot: [1, 2],
        targets: ["a:1"],
      }),
    ).toEqual({ angleDeg: 45, copy: true, pivot: [1, 2], targets: ["a:1"] });
    expect(
      reflectPayloadOf({
        angleDeg: NaN,
        copy: "yes",
        pivot: [1],
        targets: [1],
      }),
    ).toEqual({ copy: false });
  });
});

describe("the commands through the registry [editor-shell.transform-reflect]", () => {
  function harness(opts: { refuse?: boolean } = {}) {
    const batches: Array<{ ops: unknown[]; label?: string }> = [];
    const opened: Array<readonly string[]> = [];
    let selection: string[] = ["rectangle:a"];
    let boxes: Record<string, [number, number, number, number]> = {
      "rectangle:a": [0, 0, 10, 10],
    };
    const client = {
      async elementGeometry(ids: { kind: string; id: unknown }[]) {
        return ids.map((id) => ({
          id,
          pageId: "p1",
          spreadId: "s1",
          bounds: boxes[`${id.kind}:${String(id.id)}`] ?? [0, 0, 10, 10],
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
    const scope = createEditorScope();
    const memory = scope.get(TRANSFORM_MEMORY);
    const registry = createCommandRegistry(() => ({ client, scope }));
    for (const c of buildReflectCommands({
      objects: {
        async batch(ops, o) {
          batches.push({ ops: [...ops], label: o?.label });
          return opts.refuse
            ? { applied: false, undoSteps: 0, reason: "refused" }
            : { applied: true, undoSteps: 1 };
        },
      },
      selectionOf: () => selection,
      elementIdOf: (address) => {
        const [kind, id] = address.split(":");
        return { kind, id } as never;
      },
      openOptions: (_p, addresses) => opened.push(addresses),
    }))
      registry.register(c);
    return {
      registry,
      memory,
      batches,
      opened,
      select(next: string[], b: typeof boxes) {
        selection = next;
        boxes = b;
      },
    };
  }

  test("Reflect horizontally is ONE batch, one undo step, and is remembered", async () => {
    covers("command:paged.transform.reflectHorizontal");
    const h = harness();
    const r = await h.registry.invoke(PAGED_TRANSFORM_REFLECT_HORIZONTAL);
    expect(r).toEqual({ applied: true, undoSteps: 1 });
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.label).toBe("reflect");
    near(valueOf(h.batches[0]!.ops[0]), [-1, 0, 0, 1, 10, 0]);
    expect(h.memory.last()).toEqual({
      kind: "reflect",
      angleDeg: 90,
      copy: false,
    });
  });

  test("Reflect vertically mirrors top and bottom; a payload overrides the axis", async () => {
    covers("command:paged.transform.reflectVertical");
    const h = harness();
    await h.registry.invoke(PAGED_TRANSFORM_REFLECT_VERTICAL);
    near(valueOf(h.batches[0]!.ops[0]), [1, 0, 0, -1, 0, 10]);
    await h.registry.invoke(PAGED_TRANSFORM_REFLECT_VERTICAL, {
      angleDeg: 90,
      copy: true,
    });
    expect(h.batches[1]!.ops[0]).toMatchObject({
      command: "core.duplicateElements",
    });
    expect(h.memory.last()).toMatchObject({ angleDeg: 90, copy: true });
  });

  test("an engine refusal is not remembered; an empty selection writes nothing", async () => {
    covers("command:paged.transform.reflectHorizontal");
    const refused = harness({ refuse: true });
    expect(
      await refused.registry.invoke(PAGED_TRANSFORM_REFLECT_HORIZONTAL),
    ).toMatchObject({ applied: false });
    expect(refused.memory.last()).toBeNull();
    const h = harness();
    h.select([], {});
    expect(await h.registry.invoke(PAGED_TRANSFORM_REFLECT_HORIZONTAL)).toEqual(
      { applied: false, undoSteps: 0 },
    );
    expect(h.batches).toEqual([]);
  });

  test("Transform again repeats the last reflect about the NEW selection's centre", async () => {
    covers("command:paged.transform.again");
    const h = harness();
    await h.registry.invoke(PAGED_TRANSFORM_REFLECT_HORIZONTAL);
    h.select(["oval:b"], { "oval:b": [100, 100, 120, 140] });
    const r = await h.registry.invoke(PAGED_TRANSFORM_AGAIN);
    expect(r).toEqual({ applied: true, undoSteps: 1 });
    // Mirrored about its own centre x = 120, not about x = 5.
    near(valueOf(h.batches[1]!.ops[0]), [-1, 0, 0, 1, 240, 0]);
  });

  test("Transform again repeats a Rotate / Scale / Shear tool's linear part", async () => {
    covers("command:paged.transform.again");
    const h = harness();
    h.memory.remember({ kind: "linear", linear: [2, 0, 0, 2], copy: false });
    await h.registry.invoke(PAGED_TRANSFORM_AGAIN);
    // Doubled about the centre (5, 5).
    near(valueOf(h.batches[0]!.ops[0]), [2, 0, 0, 2, -5, -5]);
    expect(h.batches[0]!.label).toBe("transform again");
  });

  test("Transform again with nothing remembered is a no-op", async () => {
    covers("command:paged.transform.again");
    const h = harness();
    expect(await h.registry.invoke(PAGED_TRANSFORM_AGAIN)).toEqual({
      applied: false,
      undoSteps: 0,
    });
    expect(h.batches).toEqual([]);
  });

  test("Reflect… opens the dialog over the selection", async () => {
    covers("command:paged.transform.reflectOptions");
    const h = harness();
    await h.registry.invoke(PAGED_TRANSFORM_REFLECT_OPTIONS);
    expect(h.opened).toEqual([["rectangle:a"]]);
    h.select([], {});
    await h.registry.invoke(PAGED_TRANSFORM_REFLECT_OPTIONS);
    expect(h.opened).toHaveLength(1);
  });

  test("the four commands sit in Object > Transform [editor-shell.transform-reflect]", () => {
    covers("menu:Object/Transform/Reflect horizontally");
    covers("menu:Object/Transform/Reflect vertically");
    covers("menu:Object/Transform/Reflect…");
    covers("menu:Object/Transform/Transform again");
    expect(REFLECT_MENU_ITEMS.map((m) => [m.path, m.command])).toEqual([
      [
        "Object/Transform/Reflect horizontally",
        PAGED_TRANSFORM_REFLECT_HORIZONTAL,
      ],
      ["Object/Transform/Reflect vertically", PAGED_TRANSFORM_REFLECT_VERTICAL],
      ["Object/Transform/Reflect…", PAGED_TRANSFORM_REFLECT_OPTIONS],
      ["Object/Transform/Transform again", PAGED_TRANSFORM_AGAIN],
      ["Object/Transform/Rotate 90° clockwise", PAGED_TRANSFORM_ROTATE_90_CW],
      [
        "Object/Transform/Rotate 90° counterclockwise",
        PAGED_TRANSFORM_ROTATE_90_CCW,
      ],
      ["Object/Transform/Rotate 15° clockwise", PAGED_TRANSFORM_ROTATE_STEP_CW],
      [
        "Object/Transform/Rotate 15° counterclockwise",
        PAGED_TRANSFORM_ROTATE_STEP_CCW,
      ],
      ["Object/Transform/Scale up 10%", PAGED_TRANSFORM_SCALE_UP],
      ["Object/Transform/Scale down 10%", PAGED_TRANSFORM_SCALE_DOWN],
    ]);
  });

  // Editor ADR "An accessible object tree" (UXI-A11Y-006): the keyboard's
  // turn and size, about the selection's centre, one batch each.
  test("Rotate 90° clockwise turns about the selection's centre, one batch named rotate, remembered", async () => {
    covers("command:paged.transform.rotate90Clockwise");
    const h = harness();
    const r = await h.registry.invoke(PAGED_TRANSFORM_ROTATE_90_CW);
    expect(r).toEqual({ applied: true, undoSteps: 1 });
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]!.label).toBe("rotate");
    // +x turns toward +y (clockwise on screen); the centre (5, 5) stays.
    near(valueOf(h.batches[0]!.ops[0]), [0, 1, -1, 0, 10, 0]);
    expect(h.memory.last()).toEqual(rotationRecord(90));
  });

  test("the rotate steps and quarter turns undo each other; the scale steps scale about the centre", async () => {
    covers("command:paged.transform.rotate90Counterclockwise");
    covers("command:paged.transform.rotateStepClockwise");
    covers("command:paged.transform.rotateStepCounterclockwise");
    covers("command:paged.transform.scaleUp");
    covers("command:paged.transform.scaleDown");
    const h = harness();
    await h.registry.invoke(PAGED_TRANSFORM_ROTATE_90_CCW);
    near(valueOf(h.batches[0]!.ops[0]), [0, -1, 1, 0, 0, 10]);
    await h.registry.invoke(PAGED_TRANSFORM_ROTATE_STEP_CW);
    await h.registry.invoke(PAGED_TRANSFORM_ROTATE_STEP_CCW);
    const cw = valueOf(h.batches[1]!.ops[0]);
    const ccw = valueOf(h.batches[2]!.ops[0]);
    near(cw.slice(0, 4), [
      Math.cos(Math.PI / 12),
      Math.sin(Math.PI / 12),
      -Math.sin(Math.PI / 12),
      Math.cos(Math.PI / 12),
    ]);
    near(ccw.slice(0, 4), [cw[0]!, -cw[1]!, -cw[2]!, cw[3]!]);
    await h.registry.invoke(PAGED_TRANSFORM_SCALE_UP);
    near(valueOf(h.batches[3]!.ops[0]), [1.1, 0, 0, 1.1, -0.5, -0.5]);
    expect(h.batches[3]!.label).toBe("scale");
    await h.registry.invoke(PAGED_TRANSFORM_SCALE_DOWN);
    near(valueOf(h.batches[4]!.ops[0]), [0.9, 0, 0, 0.9, 0.5, 0.5]);
    // Nothing selected: nothing written.
    h.select([], {});
    await h.registry.invoke(PAGED_TRANSFORM_SCALE_UP);
    expect(h.batches).toHaveLength(5);
  });
});
