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

// Plan G4, the rest of draw's row: the width profile as a typed command
// (and the Path Options section that types one), and the update of the
// recipes a changed source feeds — both through `host.objects.invoke` on
// a real engine, as a script or `paged-node invoke` reaches them.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import {
  applyMakeRepeat,
  drawBundle,
  readRepeatLibrary,
  recipesSourcedBy,
  widthProfileOf,
} from "../../src";
import {
  applyPathOptions,
  sanitizePathOptions,
  widthProfilePayloadOf,
} from "../../src/commands/path-options";
import { commandHandler } from "../../src/command-registry";
import { F1_MULTI_SHAPE, F6_RING_PAIR } from "../fixtures/corpus";
import { openHost } from "./host";

const C = "media.paged.draw.command";
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const INNER = { kind: "polygon", id: F6_RING_PAIR.innerId } as ElementId;

describe("the width profile, pure", () => {
  it("a profile is a non-empty list of widths ≥ 0, not all zero", () => {
    expect(widthProfileOf({ widths: [0, 8, 0] })).toEqual([0, 8, 0]);
    expect(widthProfileOf({ widths: [3] })).toEqual([3]);
    for (const bad of [
      undefined,
      {},
      { widths: [] },
      { widths: [1, -1] },
      { widths: [0, 0] },
      { widths: [1, "2"] },
      { widths: Array.from({ length: 257 }, () => 1) },
    ])
      expect(() => widthProfileOf(bad)).toThrow(/^failed: /);
  });

  it("the Path Options section is a three-stop profile, sanitised", () => {
    const o = sanitizePathOptions({
      widthProfile: { start: -2, middle: 9, end: "x" },
    });
    expect(o.widthProfile).toEqual({ start: 0, middle: 9, end: 1 });
    expect(widthProfilePayloadOf(o.widthProfile)).toEqual({
      widths: [0, 9, 1],
    });
  });

  it("a recipe's sources are read off the links its make wrote", () => {
    expect(
      recipesSourcedBy({
        data: {
          repeatSource: { repeat: "rep-1", index: 0 },
          blendKey: { blend: "bl-2", index: 1 },
        },
      } as never),
    ).toEqual([
      { kind: "repeat", id: "rep-1" },
      { kind: "blend", id: "bl-2" },
    ]);
    // A generated instance is not a source.
    expect(
      recipesSourcedBy({
        data: { repeatInstance: { repeat: "rep-1", index: 0 } },
      } as never),
    ).toEqual([]);
    expect(recipesSourcedBy(null)).toEqual([]);
  });
});

describe("paged.draw — widthProfile as a typed command", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  it("outlines the open path at the profile — one undo step", async () => {
    covers("command:media.paged.draw.command.widthProfile");
    const before = await h.host.document.pathAnchors(POLY);
    expect(before!.subpathOpen?.[0]).toBe(true);
    const r = await h.objects.invoke(`${C}.widthProfile`, {
      targets: ["polygon:upoly"],
      widths: [0, 8, 0],
    });
    expect(r).toEqual({ outlined: 1 });
    const after = await h.host.document.pathAnchors(POLY);
    expect(after!.subpathOpen?.[0]).toBe(false);
    expect(after!.anchors.length).toBeGreaterThanOrEqual(4);
    await h.host.document.undo();
    const back = await h.host.document.pathAnchors(POLY);
    expect(back!.anchors).toEqual(before!.anchors);
    expect(back!.subpathOpen?.[0]).toBe(true);
  });

  it("a closed path is refused with a reason; so is a bad profile", async () => {
    await expect(
      h.objects.invoke(`${C}.widthProfile`, {
        targets: ["rectangle:urect"],
        widths: [2, 6],
      }),
    ).rejects.toThrow(/single-contour open path/);
    await expect(
      h.objects.invoke(`${C}.widthProfile`, {
        targets: ["polygon:upoly"],
        widths: [],
      }),
    ).rejects.toThrow(/^failed: /);
  });

  it("run bare on a host that cannot raise a panel, it applies the profile last applied there", async () => {
    await h.host.selection.set([POLY]);
    await commandHandler(h.host, `${C}.widthProfile`)!(undefined, undefined);
    expect((await h.host.document.pathAnchors(POLY))!.subpathOpen?.[0]).toBe(
      false,
    );
    await h.host.document.undo();
  });

  it("the Path Options section's Apply runs the same command", async () => {
    await h.host.selection.set([POLY]);
    await applyPathOptions(h.host, "widthProfile", {
      start: 1,
      middle: 6,
      end: 1,
    });
    expect((await h.host.document.pathAnchors(POLY))!.subpathOpen?.[0]).toBe(
      false,
    );
    await h.host.document.undo();
    expect((await h.host.document.pathAnchors(POLY))!.subpathOpen?.[0]).toBe(
      true,
    );
  });
});

describe("paged.draw — updateLinkedRecipes", () => {
  let h: HeadlessHost;
  beforeAll(async () => {
    h = await openHost();
    await h.load(F6_RING_PAIR.bytes());
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());

  const instanceAnchors = async (ids: readonly ElementId[]) => {
    const out: number[][] = [];
    for (const id of ids)
      for (const a of (await h.host.document.pathAnchors(id))?.anchors ?? [])
        out.push([...a.anchor]);
    return out;
  };

  it("rebuilds the repeat whose source changed, from the source", async () => {
    covers("command:media.paged.draw.command.updateLinkedRecipes");
    await h.host.selection.set([INNER]);
    const first = await applyMakeRepeat(h.host, "radial", {
      count: 3,
      radiusPt: 120,
      startDeg: -90,
    });
    expect(first).toHaveLength(2);
    const was = await instanceAnchors(first);

    // Edit the SOURCE: move its first anchor.
    const table = await h.host.document.pathAnchors(INNER);
    const [x, y] = table!.anchors[0]!.anchor;
    const moved = await h.host.document.mutate({
      op: "pathPointSet",
      args: {
        elementId: INNER,
        index: 0,
        role: "anchor",
        position: [x - 20, y - 20],
      },
    });
    expect(moved.applied).toBe(true);
    // Nothing updates itself…
    expect(await instanceAnchors(first)).toEqual(was);

    // …until the source's recipes are updated.
    const r = await h.objects.invoke(`${C}.updateLinkedRecipes`, {
      targets: [`polygon:${F6_RING_PAIR.innerId}`],
      all: false,
    });
    expect(r).toEqual(["plugin:media.paged.draw/repeat/rep-1"]);
    const [record] = (await readRepeatLibrary(h.host)).repeats;
    const now = record!.instances.map(
      (i) => ({ kind: i.kind, id: i.id }) as ElementId,
    );
    expect(now.map((i) => i.id)).not.toContain(first[0]!.id);
    expect(await instanceAnchors(now)).not.toEqual(was);
  });

  it("all: true updates every recipe; a selection that feeds none is refused", async () => {
    const r = await h.objects.invoke(`${C}.updateLinkedRecipes`, {
      targets: [],
      all: true,
    });
    expect(r).toEqual(["plugin:media.paged.draw/repeat/rep-1"]);
    await expect(
      h.objects.invoke(`${C}.updateLinkedRecipes`, {
        targets: ["polygon:uouter"],
        all: false,
      }),
    ).rejects.toThrow(/nothing selected is the source of a recipe/);
    // Run bare (the menu row), it changes nothing and does not throw.
    expect(
      await commandHandler(h.host, `${C}.updateLinkedRecipes`)!(
        undefined,
        undefined,
      ),
    ).toEqual([]);
  });
});
