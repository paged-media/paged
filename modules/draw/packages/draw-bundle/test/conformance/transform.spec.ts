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

// REFLECT and TRANSFORM AGAIN through the REAL engine wasm. Pins:
//   (1) a reflection mirrors each object about the SELECTION's centre,
//       read back as page-space anchors;
//   (2) it is COMPOSED onto the object's own transform — a rotated object
//       stays rotated (frameTransform replaces, so writing R alone would
//       lose the rotation);
//   (3) a GROUP moves through setGroupTransform, its members following;
//   (4) the whole selection is ONE batch, ONE undo step;
//   (5) Transform again repeats the last reflection about the NEW
//       selection's centre; with nothing remembered it does nothing;
//   (6) COPY (engine 0.65, `duplicateElements`): ONE batch duplicates
//       the selection in place and reflects the sources, so the original
//       stays where it was and its mirror image appears — ONE undo. (On
//       0.64 the op did not exist and COPY was refused by name; the
//       refusal path is pinned against a host whose vocabulary lacks it.)

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CommandContribution, ElementId, PathAnchorsResult } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";
import { affineReflect, affineRotate, composeAffine } from "@paged-media/draw-geometry";

import {
  applyReflect,
  applyTransformAgain,
  drawBundle,
  forgetLastTransform,
  lastSelectionTransform,
  transformBatchFor,
  COPY_UNAVAILABLE_NOTE,
  REFLECT_HORIZONTAL_COMMAND_ID,
  REFLECT_VERTICAL_COMMAND_ID,
  TRANSFORM_AGAIN_COMMAND_ID,
} from "../../src";
import { MENU_ENTRIES } from "../../src/menu";
import { packageWithSpread, pathItem } from "../fixtures/build-idml";
import { poly, squareItem } from "../panels/panel-document";
import { countingHost } from "../perf/counting-host";
import { openHost } from "./host";

/** tri: a right triangle (100,100) (200,100) (100,160) — asymmetric, so a
 *  mirror is visible. sq: a 40 pt square at (300, 100). */
const TRI = poly("tri");
const SQ = poly("sq");
const DOC = () =>
  packageWithSpread(
    pathItem("Polygon", "tri", "100 100 160 200", false, [
      { a: [100, 100] },
      { a: [200, 100] },
      { a: [100, 160] },
    ]) + squareItem("sq", 300, 100, 40),
  );

/** Every anchor of `id` in PAGE space. */
async function pageAnchors(h: HeadlessHost, id: ElementId): Promise<[number, number][]> {
  const t = (await h.host.document.pathAnchors(id)) as PathAnchorsResult;
  const m = t.itemTransform ?? [1, 0, 0, 1, 0, 0];
  return t.anchors.map((a) => [
    m[0] * a.anchor[0] + m[2] * a.anchor[1] + m[4],
    m[1] * a.anchor[0] + m[3] * a.anchor[1] + m[5],
  ]);
}

const near = (got: [number, number][], want: [number, number][]) => {
  expect(got).toHaveLength(want.length);
  got.forEach((p, i) => {
    expect(p[0]).toBeCloseTo(want[i]![0], 3);
    expect(p[1]).toBeCloseTo(want[i]![1], 3);
  });
};

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command ${id}`);
  return rec.value as CommandContribution;
}

describe("draw conformance — Reflect and Transform again", () => {
  let h: HeadlessHost;

  beforeAll(async () => {
    h = await openHost();
    h.loadBundle(drawBundle);
  });
  afterAll(() => h?.dispose());
  beforeEach(async () => {
    await h.load(DOC());
    forgetLastTransform();
    await h.host.selection.set([]);
  });

  it("is on the menu: Reflect ×2, Reflect…, Transform again", () => {
    expect(MENU_ENTRIES.filter(([path]) => path.startsWith("Draw/Transform/")).map(([p]) => p)).toEqual([
      "Draw/Transform/Reflect horizontally",
      "Draw/Transform/Reflect vertically",
      "Draw/Transform/Reflect…",
      "Draw/Transform/Transform again",
    ]);
  });

  it("Reflect HORIZONTALLY mirrors left ↔ right about the selection's centre — ONE batch, ONE undo", async () => {
    await h.host.selection.set([TRI]);
    const { host, work } = countingHost(h.host);
    const done = await applyReflect(host, 90);
    expect(done.applied).toBe(true);
    expect(work.mutations).toEqual([{ op: "batch", ops: 1 }]);
    // Centre x = 150: x → 300 − x.
    near(await pageAnchors(h, TRI), [
      [200, 100],
      [100, 100],
      [200, 160],
    ]);
    await h.host.document.undo();
    near(await pageAnchors(h, TRI), [
      [100, 100],
      [200, 100],
      [100, 160],
    ]);
  });

  it("Reflect VERTICALLY (the command) mirrors top ↔ bottom", async () => {
    await h.host.selection.set([TRI]);
    await commandFor(h, REFLECT_VERTICAL_COMMAND_ID).handler(undefined);
    // Centre y = 130: y → 260 − y.
    near(await pageAnchors(h, TRI), [
      [100, 160],
      [200, 160],
      [100, 100],
    ]);
  });

  it("a TYPED angle (payload): 45° swaps the axes about the centre", async () => {
    await h.host.selection.set([TRI]);
    await commandFor(h, REFLECT_HORIZONTAL_COMMAND_ID).handler(undefined, { angleDeg: 45 });
    // Across the 45° line through (150, 130): (x, y) → (y + 20, x − 20).
    near(await pageAnchors(h, TRI), [
      [120, 80],
      [120, 180],
      [180, 80],
    ]);
  });

  it("TWO objects mirror about the SELECTION's centre, both in one undo step", async () => {
    await h.host.selection.set([TRI, SQ]);
    const { host, work } = countingHost(h.host);
    await applyReflect(host, 90);
    expect(work.mutations).toEqual([{ op: "batch", ops: 2 }]);
    // The union spans x 100..340, centre 220: x → 440 − x.
    near(await pageAnchors(h, SQ), [
      [140, 100],
      [100, 100],
      [100, 140],
      [140, 140],
    ]);
    near((await pageAnchors(h, TRI)).slice(0, 1), [[340, 100]]);
    await h.host.document.undo();
    near((await pageAnchors(h, SQ)).slice(0, 1), [[300, 100]]);
    near((await pageAnchors(h, TRI)).slice(0, 1), [[100, 100]]);
  });

  it("it COMPOSES onto the object's own transform: a rotated object stays rotated", async () => {
    const rot = affineRotate(30, [150, 130]);
    const set = await h.host.document.mutate({
      op: "setElementProperty",
      args: { elementId: TRI, path: "frameTransform", value: { type: "transform", value: [...rot] } },
    });
    expect(set.applied).toBe(true);
    const before = await pageAnchors(h, TRI);
    await h.host.selection.set([TRI]);
    await applyReflect(h.host, 90);
    const [g] = await h.host.document.elementGeometry([TRI]);
    // The centre of the ROTATED box is still (150, 130) only if the box is
    // symmetric — so take the reflection the command used: about the
    // page box's centre.
    const xs = before.map((p) => p[0]);
    const ys = before.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    // The command reads the FRAME box (bounds through the transform), not
    // the anchors' hull; for a frame whose bounds are its anchors' hull
    // they agree.
    const expected = composeAffine(affineReflect(90, [cx, cy]), rot);
    g!.itemTransform!.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 3));
    // And each anchor is the old one mirrored.
    near(
      await pageAnchors(h, TRI),
      before.map(([x, y]) => [2 * cx - x, y] as [number, number]),
    );
  });

  it("a GROUP moves through setGroupTransform and its members follow", async () => {
    const made = await h.host.document.mutate({ op: "createGroup", args: { memberIds: [TRI, SQ] } });
    expect(made.applied).toBe(true);
    const group = (made as { createdId: ElementId }).createdId;
    await h.host.selection.set([group]);
    const sent: unknown[] = [];
    const { host } = countingHost(h.host);
    const spy = new Proxy(host, {
      get(target, prop, receiver) {
        if (prop === "document") {
          return new Proxy(target.document, {
            get(d, p, r) {
              if (p === "mutate") {
                return (m: unknown) => {
                  sent.push(m);
                  return d.mutate(m as never);
                };
              }
              return Reflect.get(d, p, r) as unknown;
            },
          });
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const done = await applyReflect(spy, 90);
    expect(done.applied).toBe(true);
    const ops = (sent[0] as { args: { ops: { op: string; args: { groupId?: string } }[] } }).args.ops;
    expect(ops.map((o) => o.op)).toEqual(["setGroupTransform"]);
    expect(ops[0]!.args.groupId).toBe(String(group.id));
    // Group spans x 100..340: centre 220, x → 440 − x.
    near((await pageAnchors(h, SQ)).slice(0, 1), [[140, 100]]);
    near((await pageAnchors(h, TRI)).slice(0, 1), [[340, 100]]);
    await h.host.document.undo();
    near((await pageAnchors(h, SQ)).slice(0, 1), [[300, 100]]);
  });

  it("TRANSFORM AGAIN repeats the last reflection about the NEW selection's centre", async () => {
    await h.host.selection.set([TRI]);
    await applyReflect(h.host, 90);
    expect(lastSelectionTransform()).toEqual({ kind: "reflect", angleDeg: 90, copy: false });
    await h.host.selection.set([SQ]);
    const beforeTri = await pageAnchors(h, TRI);
    await commandFor(h, TRANSFORM_AGAIN_COMMAND_ID).handler(undefined);
    // The square mirrored about ITS centre (320): its corners swap.
    near(await pageAnchors(h, SQ), [
      [340, 100],
      [300, 100],
      [300, 140],
      [340, 140],
    ]);
    // …and the triangle was not touched again.
    near(await pageAnchors(h, TRI), beforeTri);
  });

  it("Transform again with nothing remembered does NOTHING", async () => {
    await h.host.selection.set([TRI]);
    const { host, work } = countingHost(h.host);
    const done = await applyTransformAgain(host);
    expect(done.applied).toBe(false);
    expect(work.mutations).toEqual([]);
  });

  it("COPY (0.65): the original stays, its mirror image appears, in ONE batch and ONE undo step", async () => {
    const leafKeys = async () => {
      const out: string[] = [];
      const walk = (nodes: { id?: ElementId | null; children?: unknown[] }[]) => {
        for (const n of nodes) {
          if (n.children?.length) walk(n.children as never);
          else if (n.id) out.push(`${n.id.kind}:${String(n.id.id)}`);
        }
      };
      walk((await h.host.document.tree()) as never);
      return out;
    };
    await h.host.selection.set([TRI]);
    const before = await pageAnchors(h, TRI);
    const keysBefore = await leafKeys();
    const { host, work } = countingHost(h.host);
    const done = await applyReflect(host, 90, true);
    expect(done.applied).toBe(true);
    expect(work.mutations.map((m) => m.op)).toEqual(["mediaPagedDrawOpProbe", "batch"]);
    const keysAfter = await leafKeys();
    const added = keysAfter.filter((k) => !keysBefore.includes(k));
    expect(added).toHaveLength(1);
    // One of the two is where the triangle was, the other is mirrored
    // about the vertical axis through the selection's centre (x = 150).
    const copy = { kind: "polygon", id: added[0]!.slice("polygon:".length) } as ElementId;
    const shapes = [await pageAnchors(h, TRI), await pageAnchors(h, copy)];
    const mirrored = before.map(([x, y]) => [300 - x, y] as [number, number]);
    const isAt = (got: [number, number][], want: [number, number][]) =>
      got.every((p, i) => Math.abs(p[0] - want[i]![0]) < 1e-3 && Math.abs(p[1] - want[i]![1]) < 1e-3);
    expect(shapes.filter((s) => isAt(s, before))).toHaveLength(1);
    expect(shapes.filter((s) => isAt(s, mirrored))).toHaveLength(1);
    expect(lastSelectionTransform()).toEqual({ kind: "reflect", angleDeg: 90, copy: true });
    await h.host.document.undo();
    expect(await leafKeys()).toEqual(keysBefore);
    near(await pageAnchors(h, TRI), before);
  });

  it("COPY on an engine WITHOUT duplicateElements is REFUSED by name; only the probe reaches it; nothing is remembered", async () => {
    // The 0.64 vocabulary, played back: the probe's refusal lists the
    // engine's ops, and this one leaves `duplicateElements` out.
    const old = new Proxy(h.host, {
      get(obj, prop, receiver) {
        if (prop !== "document") return Reflect.get(obj, prop, receiver) as unknown;
        return new Proxy(obj.document, {
          get(doc, key, r) {
            if (key !== "mutate") return Reflect.get(doc, key, r) as unknown;
            return async (m: { op: string }) => {
              const out = await doc.mutate(m as never);
              if (m.op !== "mediaPagedDrawOpProbe") return out;
              return JSON.parse(JSON.stringify(out).replace(/`duplicateElements`, ?|duplicateElements, ?/g, ""));
            };
          },
        });
      },
    });
    await h.host.selection.set([TRI]);
    const before = await pageAnchors(h, TRI);
    const { host, work } = countingHost(old);
    const done = await applyReflect(host, 90, true);
    expect(done).toEqual({ applied: false, targets: [], refusal: COPY_UNAVAILABLE_NOTE });
    expect(work.mutations.map((m) => m.op)).toEqual(["mediaPagedDrawOpProbe"]);
    near(await pageAnchors(h, TRI), before);
    expect(lastSelectionTransform()).toBeNull();
  });

  it("the COPY batch an 0.65 engine would be sent: duplicate (offset 0) FIRST, then the sources reflected", () => {
    const batch = transformBatchFor(
      [
        { id: TRI, matrix: null, box: [100, 100, 160, 200], group: false },
        { id: { kind: "group", id: "g1" } as ElementId, matrix: null, box: [0, 0, 1, 1], group: true },
      ],
      [-1, 0, 0, 1, 300, 0],
      true,
    ) as { args: { ops: { op: string; args: Record<string, unknown> }[] } };
    expect(batch.args.ops.map((o) => o.op)).toEqual([
      "duplicateElements",
      "setElementProperty",
      "setGroupTransform",
    ]);
    expect(batch.args.ops[0]!.args).toEqual({
      elementIds: [TRI, { kind: "group", id: "g1" }],
      offset: [0, 0],
    });
  });
});
