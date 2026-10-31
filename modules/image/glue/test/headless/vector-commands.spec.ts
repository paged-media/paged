// The PATHS and VECTOR MASK commands (WP5.11, image ADR 476) against the
// REAL canvas engine (the headless host): the integration twin of
// vector-commands.spec.ts. Each command changes the image's paths or a
// layer's vector mask and sends the DOCUMENT nothing; the GPU verbs
// (Fill Path, Stroke Path) decline without a device and change nothing.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { bundleOnHeadless, C, imageShape } from "../command-kit";
import type { Geometry } from "../../src/vector-engine";

async function ingested() {
  const k = await bundleOnHeadless();
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

const vm = (k: K) =>
  k.session.state().layers.layers[k.session.state().layers.active].vectorMask;
const paths = (k: K) => k.session.masking().state().info.paths;

describe("[image.paths.vectors] Paths and vector mask commands on the headless host", () => {
  it("saveWorkPath saves the Pen's work path; the document is untouched", async () => {
    covers("command:media.paged.image.command.saveWorkPath");
    const k = await ingested();
    await k.session.vectors().addShape(RECT, "path");
    expect(paths(k)).toEqual([expect.objectContaining({ work: true })]);
    await k.run(`${C}.saveWorkPath`);
    expect(paths(k)).toEqual([
      expect.objectContaining({ name: "Path 1", work: false }),
    ]);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("fillPath and strokePath need WebGPU and change nothing without it", async () => {
    covers("command:media.paged.image.command.fillPath");
    covers("command:media.paged.image.command.strokePath");
    const k = await ingested();
    await k.session.vectors().addShape(RECT, "path");
    const before = imageShape(k.session);
    await k.run(`${C}.fillPath`);
    expect(k.session.state().status).toContain("WebGPU");
    await k.run(`${C}.strokePath`);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.changes()).toBe(0);
    k.dispose();
  });

  it("the vector mask verbs edit the active layer's mask, one step each", async () => {
    covers("command:media.paged.image.command.vectorMaskRevealAll");
    covers("command:media.paged.image.command.vectorMaskHideAll");
    covers("command:media.paged.image.command.vectorMaskCurrentPath");
    covers("command:media.paged.image.command.vectorMaskToggle");
    covers("command:media.paged.image.command.vectorMaskInvert");
    covers("command:media.paged.image.command.vectorMaskRasterize");
    covers("command:media.paged.image.command.vectorMaskDelete");
    const k = await ingested();
    const depth = () => k.session.state().history?.depth ?? 0;
    const d = depth();
    await k.run(`${C}.vectorMaskRevealAll`);
    expect(vm(k)).toMatchObject({ invert: true, subpaths: 0 });
    await k.run(`${C}.vectorMaskDelete`);
    expect(vm(k)).toBeNull();
    await k.run(`${C}.vectorMaskHideAll`);
    expect(vm(k)).toMatchObject({ invert: false, subpaths: 0 });
    await k.run(`${C}.vectorMaskDelete`);
    await k.session.vectors().addShape(RECT, "path");
    await k.run(`${C}.vectorMaskCurrentPath`);
    expect(vm(k)).toMatchObject({ enabled: true, subpaths: 1, anchors: 4 });
    await k.run(`${C}.vectorMaskToggle`);
    expect(vm(k)?.enabled).toBe(false);
    await k.run(`${C}.vectorMaskToggle`);
    await k.run(`${C}.vectorMaskInvert`);
    expect(vm(k)?.invert).toBe(true);
    await k.run(`${C}.vectorMaskRasterize`);
    expect(vm(k)).toBeNull();
    // 4 add/delete, the work path, 5 vector mask steps.
    expect(depth()).toBe(d + 10);
    expect(k.changes()).toBe(0);
    k.dispose();
  });
});
