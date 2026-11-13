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

// Protocol 80 through the editor's client, on the real engine: the press
// in one round trip (engine ADR 1303), the edit scope (ADR 1301), a scrub
// as one undo step (ADR 1304), and the IDML export's losses (ADR 1305).

import { afterEach, describe, expect, test } from "bun:test";

import type { ElementId, GestureModifiers } from "@paged-media/client";
import { gestureFixture, GESTURE_TARGETS as T } from "@paged-media/test-kit";

import { createHeadlessEditor, type HeadlessEditor } from "./harness";

let ed: HeadlessEditor | null = null;
afterEach(async () => {
  await ed?.dispose();
  ed = null;
});

const NO_SNAP: GestureModifiers = {
  shift: false,
  alt: false,
  disableSnap: true,
};
const FRAME = T.frame.id as ElementId;

/** The frame's left edge on its page: bounds through the transform. */
async function frameLeft(e: HeadlessEditor): Promise<number> {
  const [g] = await e.client.elementGeometry([FRAME]);
  return g!.bounds[1] + (g!.itemTransform?.[4] ?? 0);
}

async function undoDepth(e: HeadlessEditor): Promise<number> {
  return (await e.client.undoLog()).undoLen;
}

describe("protocol 80 through the client", () => {
  test("UXI-T58 — a press hits, selects and begins in one round trip; moves made before the answer start from the down point, one undo step @feat:editor-tools.move.translate @level:gesture", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const left = await frameLeft(ed);
    const depth = await undoDepth(ed);
    const press = ed.client.beginGestureAt({
      pageId: T.pageId,
      point: [T.frame.at[0], T.frame.at[1]],
      modifiers: NO_SNAP,
      select: "replace",
      target: { kind: "outermost" },
    });
    // The client holds writes behind the press from the moment it is sent.
    expect(ed.client.gestureActive).toBe(true);
    const out = await press;
    expect(out.hit.element).toEqual(FRAME);
    expect(out.selection).toEqual([FRAME]);
    expect(out.marquee).toBe(false);
    expect(out.refused).toBeNull();
    expect(out.handle).not.toBeNull();
    await ed.client.updateGesture(out.handle!, [24, 0], NO_SNAP, "json");
    await ed.client.commitGesture(out.handle!);
    expect(ed.client.gestureActive).toBe(false);
    expect(await frameLeft(ed)).toBeCloseTo(left + 24, 3);
    expect(await undoDepth(ed)).toBe(depth + 1);

    const empty = await ed.client.beginGestureAt({
      pageId: T.pageId,
      point: [T.empty.at[0], T.empty.at[1]],
    });
    expect(empty.marquee).toBe(true);
    expect(empty.handle).toBeNull();
    expect(ed.client.gestureActive).toBe(false);
  });

  test("UXI-T44 — the edit scope of a group holds its members and not what lies beside it; a press outside it changes nothing @feat:editor-tools.select.click-marquee @level:gesture", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const group = T.group.id as ElementId;
    const childA = T.group.childA as ElementId;
    const childB = T.group.childB as ElementId;
    expect(
      await ed.client.scopeContains(group, [childA, childB, FRAME]),
    ).toEqual([true, true, false]);
    const scope = await ed.client.editScope(group);
    expect(scope.found).toBe(true);
    expect(scope.contains(group)).toBe(true);
    expect(scope.contains(childA)).toBe(true);
    expect(scope.contains(FRAME)).toBe(false);
    expect(await ed.client.editScope(group)).toBe(scope); // cached
    const depth = await undoDepth(ed);
    const out = await ed.client.beginGestureAt({
      pageId: T.pageId,
      point: [T.frame.at[0], T.frame.at[1]],
      scope: group,
      target: { kind: "inGroup", id: T.group.id.id },
    });
    expect(out.outOfScope).toBe(true);
    expect(out.handle).toBeNull();
    expect(out.selection).toEqual([]);
    expect(await undoDepth(ed)).toBe(depth);
  });

  test("a scrub with one coalesce key is one undo step; undo returns to before its first write", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const left = await frameLeft(ed);
    const depth = await undoDepth(ed);
    const [g] = await ed.client.elementGeometry([FRAME]);
    const base = g!.itemTransform ?? [1, 0, 0, 1, 0, 0];
    for (const dx of [5, 10, 15, 20]) {
      const reply = await ed.client.mutate(
        {
          op: "moveFrame",
          args: {
            frameId: T.frame.id.id,
            transform: [
              base[0],
              base[1],
              base[2],
              base[3],
              base[4] + dx,
              base[5],
            ],
          },
        },
        { coalesce: "scrub:x" },
      );
      expect(reply.kind).toBe("mutationApplied");
    }
    expect(await ed.client.endCoalesce()).not.toBeNull();
    expect(await undoDepth(ed)).toBe(depth + 1);
    expect(await frameLeft(ed)).toBeCloseTo(left + 20, 3);
    await ed.client.undo();
    expect(await frameLeft(ed)).toBeCloseTo(left, 3);
  });

  test("exportIdml answers the package with the losses it could not carry", async () => {
    ed = await createHeadlessEditor({ idml: gestureFixture("targets") });
    const out = await ed.client.exportIdml();
    expect(Array.from(out.bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
    expect(Array.isArray(out.lost)).toBe(true);
    expect(Array.isArray(ed.state.document.handle?.losses ?? [])).toBe(true);
  });
});
