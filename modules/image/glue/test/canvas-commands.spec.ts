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

// @feat: image.object-model
//
// The targeted canvas commands (plan G4), with no engine: the pixel moves
// on a stored stack (canvas-ops.ts), and what each typed command lowers
// to on `host.objects`. The headless spec runs them on the real engine.

import { describe, expect, it } from "bun:test";
import type {
  ObjectOp,
  ObjectsSurface,
  ObjectWriteResult,
} from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { applyCanvasOp, canvasOpProblem } from "../src/object-model/canvas-ops";
import { typedCommands } from "../src/object-model/contribute";
import { stackFromImage } from "../src/object-model/pgil";

const C = "media.paged.image.command";
const P = "plugin:media.paged.image";
const IMAGE = `${P}/image/urect`;

/** A 3×2 image whose pixel (x, y) has red = 10·x + y + 1. */
const W = 3;
const H = 2;
const pixels = () => {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      px.set([10 * x + y + 1, 0, 0, 255], (y * W + x) * 4);
  return px;
};
/** The red channel, row by row. */
const reds = (px: Uint8Array, w: number, h: number) =>
  Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => px[(y * w + x) * 4]!),
  );

describe("canvas operations on a stored stack (pure)", () => {
  const stack = () => stackFromImage(W, H, pixels());

  it("a quarter turn clockwise, and back", () => {
    const s = stack();
    applyCanvasOp(s, { kind: "rotateCw" });
    expect([s.width, s.height]).toEqual([2, 3]);
    expect(reds(s.layers[0]!.pixels, 2, 3)).toEqual([
      [2, 1],
      [12, 11],
      [22, 21],
    ]);
    applyCanvasOp(s, { kind: "rotateCcw" });
    expect(reds(s.layers[0]!.pixels, W, H)).toEqual(reds(pixels(), W, H));
  });

  it("flips, crops and resizes the canvas", () => {
    const f = stack();
    applyCanvasOp(f, { kind: "flipHorizontal" });
    expect(reds(f.layers[0]!.pixels, W, H)).toEqual([
      [21, 11, 1],
      [22, 12, 2],
    ]);
    const c = stack();
    applyCanvasOp(c, { kind: "crop", x: 1, y: 1, width: 2, height: 1 });
    expect(reds(c.layers[0]!.pixels, 2, 1)).toEqual([[12, 22]]);
    const r = stack();
    r.layers[0]!.mask = new Uint8Array(W * H).fill(0);
    applyCanvasOp(r, { kind: "canvas", width: 5, height: 2, anchor: "right" });
    expect(reds(r.layers[0]!.pixels, 5, 2)).toEqual([
      [0, 0, 1, 11, 21],
      [0, 0, 2, 12, 22],
    ]);
    // A layer mask's new area reveals.
    expect(Array.from(r.layers[0]!.mask!.subarray(0, 5))).toEqual([
      255, 255, 0, 0, 0,
    ]);
  });

  it("names what it refuses", () => {
    const s = stack();
    expect(
      canvasOpProblem(s, { kind: "crop", x: 2, y: 0, width: 2, height: 1 }),
    ).toBe("the crop must lie inside the 3×2 canvas");
    s.layers[0]!.kind = "smart";
    expect(canvasOpProblem(s, { kind: "rotate180" })).toMatch(/smart object/);
  });
});

describe("the typed commands lower to host.objects writes (unit)", () => {
  const untyped = [
    "rotateCw",
    "rotateCcw",
    "rotate180",
    "flipHorizontal",
    "flipVertical",
    "median",
  ].map((s) => ({
    id: `${C}.${s}`,
    title: s,
    handler: () => undefined,
  }));
  /** The commands over a recording `objects`; nothing is open in the
   *  editor. */
  const rig = () => {
    const writes: ObjectOp[][] = [];
    const ok: ObjectWriteResult = { applied: true, undoSteps: 1 } as never;
    const objects = {
      set: async (address: string, path: string, value: unknown) => {
        writes.push([{ op: "set", address, path, value }]);
        return ok;
      },
      batch: async (ops: readonly ObjectOp[]) => {
        writes.push([...ops]);
        return ok;
      },
      get: async (_a: string, path: string) =>
        path === "nextLayerId"
          ? { kind: "value", value: 7 }
          : { kind: "absent" },
    } as unknown as ObjectsSurface;
    const commands = typedCommands(
      untyped,
      async () => {
        throw new Error("no codec needed");
      },
      () => false,
    );
    const run = (id: string, args: unknown) =>
      commands.find((c) => c.id === `${C}.${id}`)!.handler({ objects }, args);
    return { writes, run };
  };

  it("rotate and flip on a named image write its transform", async () => {
    covers("command:media.paged.image.command.rotateCw");
    covers("command:media.paged.image.command.rotateCcw");
    covers("command:media.paged.image.command.rotate180");
    covers("command:media.paged.image.command.flipHorizontal");
    covers("command:media.paged.image.command.flipVertical");
    for (const op of [
      "rotateCw",
      "rotateCcw",
      "rotate180",
      "flipHorizontal",
      "flipVertical",
    ]) {
      const r = rig();
      await r.run(op, { image: IMAGE });
      expect(r.writes).toEqual([
        [{ op: "set", address: IMAGE, path: "transform", value: op }],
      ]);
    }
  });

  it("cropImage and canvasSize write the image's crop and canvasSize", async () => {
    covers("command:media.paged.image.command.cropImage");
    covers("command:media.paged.image.command.canvasSize");
    const r = rig();
    await r.run("cropImage", { image: IMAGE, bounds: [0, 1, 2, 3] });
    await r.run("canvasSize", {
      image: IMAGE,
      width: 4,
      height: 2,
      anchor: "top",
    });
    expect(r.writes).toEqual([
      [{ op: "set", address: IMAGE, path: "crop", value: [0, 1, 2, 3] }],
      [
        {
          op: "set",
          address: IMAGE,
          path: "canvasSize",
          value: { width: 4, height: 2, anchor: "top" },
        },
      ],
    ]);
  });

  it("applyAdjustment creates one adjustment layer and names it, in one batch", async () => {
    covers("command:media.paged.image.command.applyAdjustment");
    const r = rig();
    await r.run("applyAdjustment", {
      image: IMAGE,
      name: "Warm",
      params: { "whiteBalance.temp": 0.2 },
    });
    expect(r.writes).toEqual([
      [
        {
          op: "create",
          kind: `${P}/adjustment`,
          within: IMAGE,
          props: { "whiteBalance.temp": 0.2 },
        },
        {
          op: "set",
          address: `${P}/layer/urect/7`,
          path: "name",
          value: "Warm",
        },
      ],
    ]);
    await expect(
      r.run("applyAdjustment", { image: `${P}/layer/urect/1`, params: {} }),
    ).rejects.toThrow(/^invalidValue: /);
  });

  it("an interactive twin with nothing open refuses with a code", async () => {
    const r = rig();
    expect(() => r.run("median", {})).toThrow(/^unmapped: /);
    await expect(r.run("rotateCw", {})).rejects.toThrow(
      /^unmapped: .*name the image to run it headless/,
    );
    expect(r.writes).toEqual([]);
  });
});
