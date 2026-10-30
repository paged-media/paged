// The pixel warps' pure halves (WP5.6, image ADR 483): what the Warp,
// Puppet Warp and Liquify dialogs draw on the canvas and hand the engine,
// and the Perspective Crop tool's geometry — no wasm, no canvas.

import { describe, expect, it } from "bun:test";

import {
  liquifyStrokes,
  puppetPins,
  strokeCount,
  warpMesh,
  warpPreset,
  warpRect,
  STYLE_CUSTOM,
} from "../src/filters-warp";
import { liquifyWire } from "../src/warp-engine";
import {
  patchPoint,
  warpCanvasHit,
  warpCanvasShapes,
  type WarpCanvasEnv,
} from "../src/warp-canvas";
import {
  createPerspectiveCropMachine,
  perspectiveCropSize,
} from "../src/perspective-crop-tool";

const FIT = { pageId: "p1", originX: 10, originY: 20, scale: 0.5 };
const ctx = { width: 200, height: 100, fg: [0, 0, 0], bg: [1, 1, 1], resource: () => null } as const;

function env(over: Partial<WarpCanvasEnv> = {}): WarpCanvasEnv {
  return {
    width: 200,
    height: 100,
    mesh: () => warpMesh({ warpStyleMesh: () => [] }, { rect: [0, 0, 1, 1] }, ctx),
    edges: () => [0, 0, 10, 10, 10, 10, 20, 0],
    restPoint: (at) => [at[0] - 5, at[1]],
    brushAt: null,
    ...over,
  };
}

describe("the warps on the canvas [image.editor.transform-warp]", () => {
  it("the warp rectangle and its identity mesh follow the bounds", () => {
    const v = warpPreset({ x: 20, y: 10, w: 100, h: 50 }, 200, 100);
    expect(warpRect(v, ctx)).toEqual({ x: 20, y: 10, w: 100, h: 50 });
    const m = warpMesh({ warpStyleMesh: () => [] }, v, ctx);
    expect(m.slice(0, 2)).toEqual([20, 10]);
    expect(m.slice(30)).toEqual([120, 60]);
    // The identity patch passes through its corners and its centre.
    expect(patchPoint(m, 0.5, 0.5)[0]).toBeCloseTo(70);
    // A named style asks the engine; a malformed answer is the identity.
    let asked = "";
    const styled = warpMesh(
      {
        warpStyleMesh: (s) => {
          asked = s.style;
          return new Array(32).fill(1);
        },
      },
      { ...v, style: 2, bend: 50 },
      ctx,
    );
    expect(asked).toBe("arc");
    expect(styled).toHaveLength(32);
  });

  it("warp: eight grid curves and sixteen handles; a handle drag makes it custom", () => {
    const shapes = warpCanvasShapes("warp", { rect: [0, 0, 1, 1] }, env(), FIT);
    expect(shapes.filter((s) => "points" in s)).toHaveLength(8);
    expect(shapes.filter((s) => "kind" in s && s.kind === "handle")).toHaveLength(16);
    const drag = warpCanvasHit("warp", { rect: [0, 0, 1, 1] }, env(), [199, 99], false);
    const patch = drag!.move([150, 80])!;
    expect(patch.style).toBe(STYLE_CUSTOM);
    expect((patch.mesh as number[]).slice(30)).toEqual([0.75, 0.8]);
    expect(warpCanvasHit("warp", { rect: [0, 0, 1, 1] }, env(), [50, 50], false)).toBeNull();
  });

  it("puppet: a click adds a pin at its rest point; Alt on a pin removes it", () => {
    const add = warpCanvasHit("puppetWarp", { pins: [] }, env(), [100, 50], false)!;
    const p = add.move([100, 50])!.pins as number[];
    expect(p).toEqual([0.475, 0.5, 0.5, 0.5]);
    const moved = add.move([120, 50])!.pins as number[];
    expect(moved[2]).toBeCloseTo(0.6);
    expect(puppetPins({ pins: moved }, 200, 100)).toEqual([
      { at: [95, 50], to: [120, 50] },
    ]);
    const del = warpCanvasHit("puppetWarp", { pins: p }, env(), [100, 50], true)!;
    expect(del.move([100, 50])).toEqual({ pins: [] });
    expect(del.move([100, 50])).toBeNull();
    const shapes = warpCanvasShapes("puppetWarp", { pins: p, showMesh: true }, env(), FIT);
    expect(shapes).toHaveLength(3);
  });

  it("liquify: a drag is one stroke in image fractions; px and the wire follow", () => {
    const v = { tool: 3, size: 50, pressure: 100, density: 50, rate: 80, strokes: [] };
    const d = warpCanvasHit("liquify", v, env(), [20, 10], false)!;
    d.move([20, 10]);
    d.move([20.2, 10]);
    const s = d.move([40, 10])!.strokes as number[];
    expect(strokeCount(s)).toBe(1);
    const px = liquifyStrokes({ strokes: s }, 200, 100);
    expect(px).toEqual([
      {
        tool: "twirlClockwise",
        size: 50,
        pressure: 1,
        density: 0.5,
        rate: 0.8,
        points: [
          [20, 10],
          [40, 10],
        ],
      },
    ]);
    expect([...liquifyWire(px)]).toEqual([3, 50, 1, 0.5, 0.800000011920929, 2, 20, 10, 40, 10]);
    const shapes = warpCanvasShapes("liquify", v, env({ brushAt: [40, 10] }), FIT);
    expect(shapes).toHaveLength(1);
  });
});

describe("the Perspective Crop tool's geometry [image.editor.transform-warp]", () => {
  it("a drag draws the quad, a corner moves alone, inside moves it whole", () => {
    const m = createPerspectiveCropMachine();
    m.down([10, 10], 2);
    m.move([110, 60]);
    m.up();
    expect(m.quad()).toEqual([
      [10, 10],
      [110, 10],
      [110, 60],
      [10, 60],
    ]);
    m.down([109, 11], 2);
    m.move([90, 10]);
    m.up();
    expect(m.quad()![1]).toEqual([90, 10]);
    m.down([50, 30], 2);
    m.move([60, 30]);
    m.up();
    expect(m.quad()![0]).toEqual([20, 10]);
    expect(m.grid()).toHaveLength(4);
    expect(perspectiveCropSize(m.quad()!)).toEqual({ width: 90, height: 52 });
    m.clear();
    expect(m.quad()).toBeNull();
    // A click alone leaves no quad.
    m.down([5, 5], 2);
    m.up();
    expect(m.quad()).toBeNull();
  });
});
