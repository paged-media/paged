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

// Plan G4 — a recipe rebuilds itself when an edit changes its source, as
// part of that edit's undo step (engine ADR 1004, `mutate(…, { amend })`):
// edit a repeat's source on a real engine, see the instances rebuilt, and
// one undo restore the source and the old instances together.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  applyMakeObjectsOnPath,
  applyMakeRepeat,
  applyUpdateObjectsOnPath,
  drawBundle,
  readRepeatLibrary,
  recipeAutoUpdateOf,
  setRecipeAutoUpdate,
} from "../../src";
import { F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

const INNER = { kind: "polygon", id: F6_RING_PAIR.innerId } as ElementId;

describe("paged.draw — the automatic recipe update", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(F6_RING_PAIR.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  const idle = () => recipeAutoUpdateOf(h.host)!.idle();

  const instances = async (): Promise<ElementId[]> => {
    const [record] = (await readRepeatLibrary(h.host)).repeats;
    return (record?.instances ?? []).map(
      (i) => ({ kind: i.kind, id: i.id }) as ElementId,
    );
  };

  const anchorsOf = async (ids: readonly ElementId[]) => {
    const out: number[][] = [];
    for (const id of ids)
      for (const a of (await h.host.document.pathAnchors(id))?.anchors ?? [])
        out.push([...a.anchor]);
    return out;
  };

  const moveSourceAnchor = async (dx: number) => {
    const table = await h.host.document.pathAnchors(INNER);
    const [x, y] = table!.anchors[0]!.anchor;
    return h.host.document.mutate({
      op: "pathPointSet",
      args: {
        elementId: INNER,
        index: 0,
        role: "anchor",
        position: [x + dx, y + dx],
      },
    });
  };

  it("the host can amend a step", () => {
    expect(h.host.supports("document.mutate.amend@1")).toBe(true);
    expect(recipeAutoUpdateOf(h.host)).toBeDefined();
  });

  it("an edit of a source rebuilds the repeat in the same undo step", async () => {
    await h.host.selection.set([INNER]);
    const made = await applyMakeRepeat(h.host, "radial", {
      count: 3,
      radiusPt: 120,
      startDeg: -90,
    });
    expect(made).toHaveLength(2);
    await idle();
    const before = await instances();
    const beforeAnchors = await anchorsOf(before);
    const sourceBefore = await anchorsOf([INNER]);

    const moved = await moveSourceAnchor(-20);
    expect(moved.applied).toBe(true);
    await idle();
    expect(recipeAutoUpdateOf(h.host)!.lastRebuilt()).toEqual([
      "plugin:media.paged.draw/repeat/rep-1",
    ]);
    const after = await instances();
    expect(after.map((i) => i.id)).not.toContain(before[0]!.id);
    expect(await anchorsOf(after)).not.toEqual(beforeAnchors);
    const sourceAfter = await anchorsOf([INNER]);

    // ONE undo: the source and the old instances come back together…
    await h.host.document.undo();
    await idle();
    expect(await anchorsOf([INNER])).toEqual(sourceBefore);
    expect(await anchorsOf(before)).toEqual(beforeAnchors);
    expect(await anchorsOf(after)).toEqual([]);

    // …and nothing rebuilt on the undo, so the redo is still there and
    // replays the edit with its rebuild.
    await h.host.document.redo();
    await idle();
    expect(await anchorsOf([INNER])).toEqual(sourceAfter);
    expect((await anchorsOf(after)).length).toBeGreaterThan(0);
    expect(await anchorsOf(before)).toEqual([]);
  });

  it("an edit of a source with the update off rebuilds nothing", async () => {
    setRecipeAutoUpdate(h.host, false);
    try {
      const before = await instances();
      const was = await anchorsOf(before);
      expect((await moveSourceAnchor(10)).applied).toBe(true);
      await idle();
      expect(await anchorsOf(before)).toEqual(was);
    } finally {
      setRecipeAutoUpdate(h.host, true);
    }
  });

  it("an edit sent right after switching the update back on rebuilds", async () => {
    await idle();
    setRecipeAutoUpdate(h.host, false);
    await idle();
    const before = await instances();
    // Off, an edit rebuilds nothing…
    expect((await moveSourceAnchor(3)).applied).toBe(true);
    await idle();
    expect((await instances()).map((i) => i.id)).toEqual(
      before.map((i) => i.id),
    );
    // …switched on, an edit sent at once rebuilds: the prints kept from
    // before the switch-off are what it is compared against (re-taking
    // them raced the edit, the editor's checkbox spec).
    setRecipeAutoUpdate(h.host, true);
    expect((await moveSourceAnchor(5)).applied).toBe(true);
    await idle();
    const after = await instances();
    expect(after.map((i) => i.id)).not.toContain(before[0]!.id);
  });

  // Engine ADR 1004 amendment: a script run is one step its reply names.
  it("a script's edit of a source rebuilds the repeat in the script's step", async () => {
    await idle();
    const before = await instances();
    const beforeAnchors = await anchorsOf(before);
    const props = JSON.stringify(
      await h.host.document.elementProperties(INNER),
    );
    const run = await h.runScript(
      `paged.set("polygon:${F6_RING_PAIR.innerId}", "frameOpacity", 40);`,
    );
    expect(run.error).toBeNull();
    await idle();
    expect(recipeAutoUpdateOf(h.host)!.lastRebuilt()).toEqual([
      "plugin:media.paged.draw/repeat/rep-1",
    ]);
    const after = await instances();
    expect(after.map((i) => i.id)).not.toContain(before[0]!.id);
    // ONE undo: the script's write and the rebuild.
    await h.host.document.undo();
    await idle();
    expect(JSON.stringify(await h.host.document.elementProperties(INNER))).toBe(
      props,
    );
    expect(await anchorsOf(before)).toEqual(beforeAnchors);
    expect(await anchorsOf(after)).toEqual([]);
  });

  // Extensions ADR 337 amendment: a parameter write's follow-up.
  it("a typed parameter write rebuilds the artwork in the write's undo step", async () => {
    await idle();
    const address = "plugin:media.paged.draw/repeat/rep-1";
    const count = async () =>
      ((await h.objects.get(address, "count")) as { value: number }).value;
    const was = await count();
    const before = await instances();
    const beforeAnchors = await anchorsOf(before);
    const out = await h.objects.set(address, "count", was + 1);
    expect(out).toMatchObject({ applied: true, undoSteps: 1 });
    await idle();
    expect(await count()).toBe(was + 1);
    // The artwork followed: one more copy (the engine may reuse freed ids).
    const after = await instances();
    expect(after).toHaveLength(before.length + 1);
    // ONE undo: the old parameter and the old instances.
    await h.host.document.undo();
    await idle();
    expect(await count()).toBe(was);
    expect((await instances()).map((i) => i.id)).toEqual(
      before.map((i) => i.id),
    );
    expect(await anchorsOf(before)).toEqual(beforeAnchors);
    expect(await anchorsOf([after.at(-1)!])).toEqual([]);
  });

  it("a parameter write with the update off changes the recipe only", async () => {
    await idle();
    setRecipeAutoUpdate(h.host, false);
    try {
      const address = "plugin:media.paged.draw/repeat/rep-1";
      const before = await instances();
      const was = await anchorsOf(before);
      const out = await h.objects.set(address, "radiusPt", 90);
      expect(out).toMatchObject({ applied: true, undoSteps: 1 });
      await idle();
      expect((await instances()).map((i) => i.id)).toEqual(
        before.map((i) => i.id),
      );
      expect(await anchorsOf(before)).toEqual(was);
      await h.host.document.undo();
      await idle();
    } finally {
      setRecipeAutoUpdate(h.host, true);
    }
  });

  // A recipe whose own Update moves its sources: the automatic update
  // takes the step as the rebuild it is, not as an edit to follow.
  it("a manual Update of objects on a path is not placed once more by the automatic update", async () => {
    await idle();
    const square = (x: number, y: number) =>
      [
        [x, y],
        [x + 60, y],
        [x + 60, y + 60],
        [x, y + 60],
      ].map((p) => ({ anchor: p, left: p, right: p }));
    const mint = async (x: number, y: number): Promise<ElementId> => {
      const out = await h.host.document.mutate({
        op: "insertPath",
        args: {
          pageId: F6_RING_PAIR.pageId,
          anchors: square(x, y),
          open: false,
        },
      } as never);
      if (!out.applied || !out.createdId) throw new Error("insertPath failed");
      return out.createdId;
    };
    const a = await mint(20, 20);
    const b = await mint(20, 120);
    const path = { kind: "polygon", id: F6_RING_PAIR.openId } as ElementId;
    await h.host.selection.set([a, b, path]);
    expect(
      await applyMakeObjectsOnPath(h.host, { alignToPath: false }),
    ).toHaveLength(2);
    await idle();
    const transformOf = async (id: ElementId) =>
      (await h.host.document.elementGeometry([id]))[0]?.itemTransform;
    const placedBefore = await transformOf(a);

    // The Update moves the objects (now turned along the path)…
    const rebuiltBefore = recipeAutoUpdateOf(h.host)!.lastRebuilt();
    const updated = await applyUpdateObjectsOnPath(h.host, {
      alignToPath: true,
    });
    expect(updated).toHaveLength(2);
    await idle();
    const placed = await transformOf(a);
    expect(placed).not.toEqual(placedBefore);
    // …and the automatic update rebuilt nothing on top of it.
    expect(recipeAutoUpdateOf(h.host)!.lastRebuilt()).toBe(rebuiltBefore);

    // An edit of the path is still followed, in its own step.
    const table = await h.host.document.pathAnchors(path);
    const [x, y] = table!.anchors[0]!.anchor;
    const moved = await h.host.document.mutate({
      op: "pathPointSet",
      args: {
        elementId: path,
        index: 0,
        role: "anchor",
        position: [x + 20, y - 10],
      },
    });
    expect(moved.applied).toBe(true);
    await idle();
    expect(recipeAutoUpdateOf(h.host)!.lastRebuilt()).toEqual([
      "plugin:media.paged.draw/objectsOnPath/op-1",
    ]);
    expect(await transformOf(a)).not.toEqual(placed);
  });
});
