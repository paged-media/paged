// The PATHS and VECTOR MASK commands (WP5.11, image ADR 476) on the fake
// editor with the real image engine: Save Work Path, Fill Path, Stroke
// Path, and Layer ▸ Vector Mask's verbs — each one undo step on the
// image's list, nothing sent to the document. Fill and Stroke Path paint
// on the GPU, which Node lacks: they are followed past that gate with
// recorders (`spyOn`), and their refusal without one is asserted too.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnFake, C, imageShape, spyOn } from "./command-kit";
import type { Geometry } from "../src/vector-engine";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

const RECT: Geometry = {
  subpaths: [
    {
      closed: true,
      op: 1,
      rule: 1,
      anchors: [
        0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 2, 0, 2, 2, 2, 2, 2, 2, 0, 2, 0, 2, 0, 2,
      ],
    },
  ],
};

/** A work path over the left half, as the Pen would leave it. */
async function workPath(k: K) {
  expect(await k.session.vectors().addShape(RECT, "path")).toBe(true);
  return k.session
    .masking()
    .state()
    .info.paths.find((p) => p.work)!;
}
const step = (k: K) => k.session.state().history?.undoSteps.at(-1);
const depth = (k: K) => k.session.state().history?.depth ?? 0;
const active = (k: K) =>
  k.session.state().layers.layers[k.session.state().layers.active];

describe("[image.paths.vectors] the Paths panel's commands", () => {
  it("saveWorkPath names the work path, one step", async () => {
    covers("command:media.paged.image.command.saveWorkPath");
    const k = await ingested();
    await k.run(`${C}.saveWorkPath`);
    expect(k.session.state().status).toContain("no work path");
    const w = await workPath(k);
    const d = depth(k);
    await k.run(`${C}.saveWorkPath`);
    const p = k.session.masking().state().info.paths;
    expect(p).toEqual([
      expect.objectContaining({ id: w.id, name: "Path 1", work: false }),
    ]);
    expect(depth(k)).toBe(d + 1);
    expect(step(k)).toBe("Save path");
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("fillPath fills the target path with the foreground colour through its drawing", async () => {
    covers("command:media.paged.image.command.fillPath");
    const k = await ingested();
    await k.run(`${C}.fillPath`);
    expect(k.session.state().status).toContain("Choose a path");
    await workPath(k);
    // Without WebGPU the fill declines, unchanged.
    const before = imageShape(k.session);
    await k.run(`${C}.fillPath`);
    expect(k.session.state().status).toContain("WebGPU");
    expect(imageShape(k.session)).toEqual(before);
    // Past the gate: one pixel edit through the geometry door.
    const calls = spyOn(k.session, { applyEffect: true });
    await k.run(`${C}.fillPath`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Work Path");
    k.dispose();
  });

  it("strokePath runs one brush stroke along every subpath, lifting between them", async () => {
    covers("command:media.paged.image.command.strokePath");
    const k = await ingested();
    await workPath(k);
    const before = imageShape(k.session);
    await k.run(`${C}.strokePath`);
    expect(k.session.state().status).toContain("GPU");
    expect(imageShape(k.session)).toEqual(before);
    const calls = spyOn(k.session, {
      brushBegin: true,
      brushExtend: true,
      brushCommit: true,
    });
    let lifts = 0;
    k.session.masking().engine()!.brushLift = () => void lifts++;
    await k.run(`${C}.strokePath`);
    expect(calls[0]).toBe('brushBegin("brush")');
    expect(calls.at(-1)).toBe("brushCommit()");
    expect(
      calls.filter((c) => c.startsWith("brushExtend")).length,
    ).toBeGreaterThan(4);
    expect(lifts).toBe(1);
    k.dispose();
  });
});

describe("[image.paths.vectors] Layer ▸ Vector Mask", () => {
  it("reveal all, hide all, current path, toggle, invert, rasterize and delete — one step each", async () => {
    covers("command:media.paged.image.command.vectorMaskRevealAll");
    covers("command:media.paged.image.command.vectorMaskHideAll");
    covers("command:media.paged.image.command.vectorMaskCurrentPath");
    covers("command:media.paged.image.command.vectorMaskToggle");
    covers("command:media.paged.image.command.vectorMaskInvert");
    covers("command:media.paged.image.command.vectorMaskRasterize");
    covers("command:media.paged.image.command.vectorMaskDelete");
    const k = await ingested();
    // Without a mask the switches say so.
    await k.run(`${C}.vectorMaskToggle`);
    expect(k.session.state().status).toContain("no vector mask");
    let d = depth(k);
    await k.run(`${C}.vectorMaskRevealAll`);
    expect(active(k).vectorMask).toMatchObject({
      enabled: true,
      invert: true,
      subpaths: 0,
    });
    expect(depth(k)).toBe(++d);
    // A second one is refused, nothing recorded.
    await k.run(`${C}.vectorMaskHideAll`);
    expect(k.session.state().status).toContain("already has a vector mask");
    expect(depth(k)).toBe(d);
    await k.run(`${C}.vectorMaskDelete`);
    expect(active(k).vectorMask).toBeNull();
    expect(depth(k)).toBe(++d);
    await k.run(`${C}.vectorMaskHideAll`);
    expect(active(k).vectorMask).toMatchObject({ invert: false, subpaths: 0 });
    await k.run(`${C}.vectorMaskDelete`);
    d += 2;
    // From the current (work) path.
    await workPath(k);
    d++;
    await k.run(`${C}.vectorMaskCurrentPath`);
    expect(active(k).vectorMask).toMatchObject({
      enabled: true,
      subpaths: 1,
      anchors: 4,
    });
    expect(depth(k)).toBe(++d);
    expect(step(k)).toBe("Add vector mask");
    await k.run(`${C}.vectorMaskToggle`);
    expect(active(k).vectorMask?.enabled).toBe(false);
    expect(step(k)).toBe("Disable vector mask");
    await k.run(`${C}.vectorMaskToggle`);
    expect(active(k).vectorMask?.enabled).toBe(true);
    await k.run(`${C}.vectorMaskInvert`);
    expect(active(k).vectorMask?.invert).toBe(true);
    expect(step(k)).toBe("Invert vector mask");
    expect(depth(k)).toBe(d + 3);
    await k.run(`${C}.vectorMaskRasterize`);
    expect(active(k).vectorMask).toBeNull();
    expect(active(k).hasMask).toBe(true);
    expect(step(k)).toBe("Rasterize vector mask");
    expect(depth(k)).toBe(d + 4);
    // (Undo re-folds the stack, which needs WebGPU; the steps' undo is
    // image-js `layers::vector_ops`'s test.)
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("the Pen edits the vector mask once it is the target", async () => {
    const k = await ingested();
    await k.run(`${C}.vectorMaskHideAll`);
    const v = k.session.vectors();
    v.selectVectorMask(k.session.state().layers.active);
    expect(await v.addShape(RECT, "path")).toBe(true);
    expect(active(k).vectorMask).toMatchObject({ subpaths: 1, anchors: 4 });
    expect(step(k)).toBe("Edit vector mask");
    // No work path was made: the mask was the target.
    expect(k.session.masking().state().info.paths).toHaveLength(0);
    k.dispose();
  });
});
