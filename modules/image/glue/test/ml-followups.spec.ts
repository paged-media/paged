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

// WP8.2 follow-ups (image ADR 486): face-aware Liquify, the contextual task
// bar and Generative Fill's reference images, over the REAL image wasm and
// the SDK's fake provider (landmarks: one face in the centre third, five
// points). Nothing downloads and no model is bundled.

import { describe, expect, it } from "bun:test";

import { createMlRegistry, fakeMlProvider } from "@paged-media/plugin-sdk";
import { covers } from "@paged-media/test-kit";

import {
  FACE_SLIDERS,
  canonicalPoints,
  faceCount,
  faceStrokes,
  facesToList,
} from "../src/faces-liquify";
import {
  FACES_FOUND,
  FACES_UNAVAILABLE,
  liquifyFaceStrokes,
  WARP_FILTERS,
  liquifyStrokes,
} from "../src/filters-warp";
import { MAX_REFERENCES } from "../src/ml-features";
import { referenceCandidates } from "../src/binding-provider/links-provider";
import { bundleOnFake, C } from "./command-kit";

async function ingested(withModel = true) {
  const ml = createMlRegistry();
  const fake = fakeMlProvider();
  if (withModel) fake.attach(ml.register(fake));
  const k = await bundleOnFake({ ml });
  await k.ingest();
  return { k, ml, fake };
}
type K = Awaited<ReturnType<typeof ingested>>["k"];
const filter = (k: K) => {
  const d = k.session.state().dialog;
  if (d?.kind !== "filter") throw new Error("no dialog");
  return d.filter;
};
const status = (k: K) => (filter(k).values.facesStatus as number[])[0];

describe("[image.ml.face-liquify] face-aware Liquify", () => {
  it("detects the faces when the dialog opens and keeps five points per face", async () => {
    covers("command:media.paged.image.command.filterLiquify");
    const { k, fake } = await ingested();
    await k.run(`${C}.filterLiquify`);
    await k.session.openWarpDialog("liquify");
    expect(status(k)).toBe(FACES_FOUND);
    expect(fake.calls.filter((c) => c.capability === "landmarks")).toHaveLength(
      2,
    );
    const faces = filter(k).values.faces as number[];
    expect(faceCount(faces)).toBe(1);
    // 4×2 px image: the box is the centre third; the first point the left eye.
    for (const v of faces.slice(0, 4)) expect(v).toBeCloseTo(1 / 3);
    expect(faces[4]).toBeCloseTo((4 / 3 + (4 / 3) * 0.3) / 4);
    expect(await k.session.cancelFilterDialog()).toBe(true);
    k.dispose();
  });

  it("the sliders turn into ordinary Liquify strokes and OK is one undo step", async () => {
    const { k } = await ingested();
    await k.session.openWarpDialog("liquify");
    expect(liquifyFaceStrokes(filter(k).values, 4, 2)).toEqual([]);
    k.session.setFilterValues({
      faceEyes: 60,
      faceNose: -30,
      faceSmile: 50,
      faceWidth: 40,
      faceChin: 20,
      faceForehead: -20,
    });
    const strokes = liquifyFaceStrokes(filter(k).values, 4, 2);
    // two eyes, a nose, two mouth corners, two cheeks, a chin, a forehead
    expect(strokes).toHaveLength(9);
    expect(strokes.filter((s) => s.tool === "bloat")).toHaveLength(2);
    expect(strokes.filter((s) => s.tool === "pucker")).toHaveLength(1);
    expect(strokes.filter((s) => s.tool === "forwardWarp")).toHaveLength(6);
    // The hand-made strokes stay separate.
    expect(liquifyStrokes(filter(k).values, 4, 2)).toEqual([]);
    // OK runs the filter once: the face strokes ride after the hand-made
    // ones in ONE applyLiquify (the dialog's single undo step).
    const def = WARP_FILTERS.find((f) => f.id === "liquify")!;
    const applied: unknown[][] = [];
    const engine = {
      applyLiquify: async (_h: number, s: unknown[]) => {
        applied.push(s);
        return {};
      },
    };
    await def.run(engine as never, 1, filter(k).values, {
      width: 4,
      height: 2,
    } as never);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toHaveLength(9);
    await k.session.cancelFilterDialog();
    k.dispose();
  });

  it("falls back with a clear hint when no landmarks model is available", async () => {
    const { k } = await ingested(false);
    await k.session.openWarpDialog("liquify");
    expect(status(k)).toBe(FACES_UNAVAILABLE);
    expect(filter(k).values.faces).toEqual([]);
    await k.session.ml().detectFaces();
    expect(k.session.state().status).toMatch(/landmarks model/);
    // The sliders move nothing, and the dialog still works for brush strokes.
    k.session.setFilterValues({ faceEyes: 80 });
    expect(liquifyFaceStrokes(filter(k).values, 4, 2)).toEqual([]);
    expect(await k.session.cancelFilterDialog()).toBe(true);
    k.dispose();
  });

  it("the face maths: slider signs, 68-point layouts, unknown layouts", () => {
    const zero = Object.fromEntries(FACE_SLIDERS.map((s) => [s, 0])) as Record<
      (typeof FACE_SLIDERS)[number],
      number
    >;
    const face = {
      box: { x: 100, y: 100, width: 100, height: 120 },
      points: [
        { x: 130, y: 140 },
        { x: 170, y: 140 },
        { x: 150, y: 170 },
        { x: 130, y: 195 },
        { x: 170, y: 195 },
      ],
    };
    const list = facesToList([face], 400, 400);
    expect(list).toHaveLength(14);
    const wider = faceStrokes(list, { ...zero, faceWidth: 100 }, 400, 400);
    expect(wider).toHaveLength(2);
    // positive widens: the left cheek moves left, the right one right
    expect(wider[0]!.points[1]![0]).toBeLessThan(wider[0]!.points[0]![0]);
    expect(wider[1]!.points[1]![0]).toBeGreaterThan(wider[1]!.points[0]![0]);
    const narrower = faceStrokes(list, { ...zero, faceWidth: -100 }, 400, 400);
    expect(narrower[0]!.points[1]![0]).toBeGreaterThan(
      narrower[0]!.points[0]![0],
    );
    const smile = faceStrokes(list, { ...zero, faceSmile: 100 }, 400, 400);
    expect(smile[0]!.points[1]![1]).toBeLessThan(smile[0]!.points[0]![1]);
    const longChin = faceStrokes(list, { ...zero, faceChin: 100 }, 400, 400);
    expect(longChin[0]!.points[1]![1]).toBeGreaterThan(
      longChin[0]!.points[0]![1],
    );
    const p68 = Array.from({ length: 68 }, (_, i) => ({ x: i, y: i * 2 }));
    expect(canonicalPoints({ box: face.box, points: p68 })).toHaveLength(5);
    expect(canonicalPoints({ box: face.box, points: p68.slice(0, 20) })).toBe(
      null,
    );
    expect(
      facesToList([{ box: face.box, points: p68.slice(0, 20) }], 400, 400),
    ).toEqual([]);
  });
});

describe("[image.ml.reference-images] reference images for Generative Fill", () => {
  it("sends the picked smart objects' pixels as ml.edit references", async () => {
    const { k, fake } = await ingested();
    // Two smart objects made from the image's own layer.
    expect(referenceCandidates(k.session)).toEqual([]);
    const ids = k.session.state().layers.layers.map((l) => l.id);
    expect(k.session.ml().setReferences([ids[0]!])).toBe(true);
    expect(k.session.state().ml.references).toEqual([ids[0]!]);
    // Select the left half, then fill.
    const m = k.session.selectionMachine()!;
    m.begin("rect", [0, 0], "replace");
    m.update([2, 2]);
    m.end();
    await k.session.ml().generativeFill("a lake");
    const edit = fake.calls.find((c) => c.capability === "edit")!.request as {
      references?: unknown[];
    };
    expect(edit.references).toHaveLength(1);
    k.dispose();
  });

  it("takes at most ten and skips a layer that is gone", async () => {
    const { k, fake } = await ingested();
    const eleven = Array.from(
      { length: MAX_REFERENCES + 1 },
      (_, i) => i + 100,
    );
    expect(k.session.ml().setReferences(eleven)).toBe(false);
    expect(k.session.state().status).toMatch(/10/);
    k.session.ml().setReferences([9999]);
    const m = k.session.selectionMachine()!;
    m.begin("rect", [0, 0], "replace");
    m.update([2, 2]);
    m.end();
    await k.session.ml().generativeFill("a lake");
    const edit = fake.calls.find((c) => c.capability === "edit")!.request as {
      references?: unknown[];
    };
    expect(edit.references).toBeUndefined();
    k.dispose();
  });
});

describe("[image.ml.reference-images] the command", () => {
  it("generativeFill takes references from its payload", async () => {
    covers("command:media.paged.image.command.generativeFill");
    const { k, fake } = await ingested();
    const m = k.session.selectionMachine()!;
    m.begin("rect", [0, 0], "replace");
    m.update([2, 2]);
    m.end();
    const id = k.session.state().layers.layers[0]!.id;
    await k.run(`${C}.generativeFill`, { prompt: "a lake", references: [id] });
    await new Promise((r) => setTimeout(r, 50));
    const edit = fake.calls.find((c) => c.capability === "edit")!.request as {
      references?: unknown[];
    };
    expect(edit.references).toHaveLength(1);
    k.dispose();
  });
});
