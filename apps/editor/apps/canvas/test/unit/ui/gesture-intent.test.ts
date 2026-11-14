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

// Editor ADR 1240, amendment 1 — the canvas's measure of a committed
// gesture: the targets read after the commit (an Alt move's copies, the
// items the commit added), measured against what they were before.

import { describe, expect, test } from "bun:test";

import type {
  ElementGeometryItem,
  ElementId,
  SceneTreeNode,
} from "@paged-media/client";

import {
  freshItems,
  measureCommitted,
  measuredGesture,
  sceneItemKeys,
} from "../../../src/ui/gesture-intent";

const rect = (id: string) => ({ kind: "rectangle", id }) as ElementId;
const geo = (
  id: ElementId,
  bounds: number[],
  t: number[] | null = null,
): ElementGeometryItem =>
  ({ id, bounds, itemTransform: t, pageId: "p1" }) as ElementGeometryItem;
const node = (id: ElementId, children: SceneTreeNode[] = []) =>
  ({ id, children }) as SceneTreeNode;

function client(
  geometry: Record<string, ElementGeometryItem>,
  tree: SceneTreeNode[],
) {
  const asked: string[][] = [];
  return {
    asked,
    elementGeometry: async (ids: ElementId[]) => {
      asked.push(ids.map((i) => String(i.id)));
      return ids.map((i) => geometry[String(i.id)]!).filter(Boolean);
    },
    sceneTree: async () => tree,
  };
}

describe("the canvas's measure of a committed gesture", () => {
  test("the gestures a step repeats", () => {
    expect(measuredGesture({ kind: "translate" })).toBe("translate");
    expect(measuredGesture({ kind: "rotate" })).toBe("rotate");
    expect(measuredGesture({ kind: "translateContent" } as never)).toBeNull();
  });

  test("a move reads its targets after the commit", async () => {
    const c = client(
      { a: geo(rect("a"), [0, 0, 10, 10], [1, 0, 0, 1, 12, 3]) },
      [],
    );
    expect(
      await measureCommitted(c, {
        spec: { kind: "translate" },
        target: [rect("a")],
        modifiers: { shift: false, alt: false },
        before: [geo(rect("a"), [0, 0, 10, 10])],
      }),
    ).toEqual({ kind: "move", dx: 12, dy: 3, copy: false });
    expect(c.asked).toEqual([["a"]]);
  });

  test("an Alt move is measured on the items its commit added", async () => {
    const before = new Set(["rectangle:a", "rectangle:b"]);
    const tree = [
      node(rect("a")),
      node(rect("b")),
      node({ kind: "group", id: "g" } as ElementId, [node(rect("m"))]),
    ];
    // Outermost only: the new group, not its member.
    expect(freshItems(before, tree)).toEqual([
      { kind: "group", id: "g" } as ElementId,
    ]);
    const c = client(
      {
        a: geo(rect("a"), [0, 0, 10, 10]),
        c: geo(rect("c"), [0, 0, 10, 10], [1, 0, 0, 1, 40, 0]),
      },
      [node(rect("a")), node(rect("c"))],
    );
    expect(
      await measureCommitted(c, {
        spec: { kind: "translate" },
        target: [rect("a")],
        modifiers: { shift: false, alt: true },
        before: [geo(rect("a"), [0, 0, 10, 10])],
        sceneBefore: sceneItemKeys(client({}, [node(rect("a"))])),
      }),
    ).toEqual({ kind: "move", dx: 40, dy: 0, copy: true });
    expect(c.asked).toEqual([["c"]]);
  });

  test("an Alt move that copied nothing (a selection that cannot be copied) is the move it was", async () => {
    const c = client(
      { a: geo(rect("a"), [0, 0, 10, 10], [1, 0, 0, 1, 5, 0]) },
      [node(rect("a"))],
    );
    expect(
      await measureCommitted(c, {
        spec: { kind: "translate" },
        target: [rect("a")],
        modifiers: { shift: false, alt: true },
        before: [geo(rect("a"), [0, 0, 10, 10])],
        sceneBefore: Promise.resolve(new Set(["rectangle:a"])),
      }),
    ).toEqual({ kind: "move", dx: 5, dy: 0, copy: false });
  });

  test("a scale names its handle; a resize's is in its spec", async () => {
    const c = client({ a: geo(rect("a"), [0, 0, 20, 30]) }, []);
    expect(
      await measureCommitted(c, {
        spec: { kind: "resize", handle: "east" } as never,
        target: [rect("a")],
        modifiers: { shift: false, alt: false },
        before: [geo(rect("a"), [0, 0, 20, 10])],
      }),
    ).toEqual({ kind: "resize", width: 30, anchor: "west" });
    expect(
      await measureCommitted(c, {
        spec: { kind: "scale" },
        handle: "south",
        target: [rect("a")],
        modifiers: { shift: false, alt: false },
        before: [geo(rect("a"), [0, 0, 10, 30])],
      }),
    ).toEqual({ kind: "scale", height: 20, anchor: "north" });
  });
});
