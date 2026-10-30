// paged.image's WP5.6 surface — Edit ▸ Transform ▸ Free distort /
// Perspective / Warp…, Edit ▸ Puppet warp…, Edit ▸ Content-aware scale…,
// Image ▸ Filter ▸ Liquify…, the Perspective Crop tool and its Apply —
// through the registered handlers over the fake editor and the real
// image-js wasm in Node (image ADR 483).
//
// Node has no WebGPU: a warp dialog opens with its geometry and its
// preview declines honestly; the canvas still edits the dialog's values
// (Puppet Warp's pins, Liquify's strokes, Warp's mesh), which is what is
// asserted here. What the kernels compute is proved in Rust
// (image-conformance `family_warp.rs`, image-js `warps.rs`).

import { describe, expect, it } from "bun:test";

import { covers, gestures } from "@paged-media/test-kit";

import { STYLE_CUSTOM } from "../src/filters-warp";
import { bundleOnFake, C, PANEL_ID, imageShape, spyOn } from "./command-kit";

const T = "media.paged.image.tool";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const matrixOf = (call: string, name: string) =>
  JSON.parse(call.slice(`${name}(`.length, -1)) as number[];

describe("WP5.6 Edit ▸ Transform [image.editor.transform-warp]", () => {
  it("Free distort opens the box in that mode: a plain corner drag is projective @level:gesture", async () => {
    covers("command:media.paged.image.command.transformDistort");
    const k = await ingested();
    const calls = spyOn(k.session, { transformLayer: true });
    await k.run(`${C}.transformDistort`);
    await tick();
    await tick();
    await gestures(k.toolTarget)
      .tool(`${T}.transform`)
      .settle()
      .drag({ from: [200, 100], to: [230, 120] })
      .key("Enter")
      .settle();
    expect(calls).toHaveLength(1);
    const m = matrixOf(calls[0]!, "transformLayer");
    expect(Math.abs(m[6]!) + Math.abs(m[7]!)).toBeGreaterThan(0);
    // The dragged corner (4, 2) px lands on (230, 120) pt = (4.6, 2.4) px;
    // the opposite corner stays.
    const at = (x: number, y: number) => {
      const w = m[6]! * x + m[7]! * y + m[8]!;
      return [(m[0]! * x + m[1]! * y + m[2]!) / w, (m[3]! * x + m[4]! * y + m[5]!) / w];
    };
    expect(at(4, 2)[0]).toBeCloseTo(4.6);
    expect(at(4, 2)[1]).toBeCloseTo(2.4);
    expect(at(0, 0)[0]).toBeCloseTo(0);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("Perspective opens the box in that mode: a corner drag mirrors its neighbour @level:gesture", async () => {
    covers("command:media.paged.image.command.transformPerspective");
    const k = await ingested();
    const calls = spyOn(k.session, { transformLayer: true });
    await k.run(`${C}.transformPerspective`);
    await tick();
    await tick();
    await gestures(k.toolTarget)
      .tool(`${T}.transform`)
      .settle()
      .drag({ from: [200, 0], to: [180, 0] })
      .key("Enter")
      .settle();
    expect(calls).toHaveLength(1);
    const m = matrixOf(calls[0]!, "transformLayer");
    expect(Math.abs(m[6]!) + Math.abs(m[7]!)).toBeGreaterThan(0);
    k.dispose();
  });

  it("Warp… opens the dialog over what the layer covers; a mesh point dragged on the canvas makes it custom @level:gesture", async () => {
    covers("command:media.paged.image.command.transformWarp");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.transformWarp`);
    expect(k.opened).toContain(PANEL_ID);
    const d = k.session.state().dialog;
    if (d?.kind !== "filter") throw new Error("no dialog");
    expect(d.filter.id).toBe("warp");
    // No GPU here, so the bounds fall back to the canvas.
    expect(d.filter.values.rect).toEqual([0, 0, 1, 1]);
    expect(d.filter.values.mesh).toEqual([]);
    // The bottom-right control point is the image's corner (4, 2) px; any
    // image tool's press goes to the dialog first (canvas-capture.ts).
    const s = k.session;
    expect(s.canvasPointer("down", [4, 2])).toBe(true);
    s.canvasPointer("move", [3.5, 1.5]);
    s.canvasPointer("up", [3.5, 1.5]);
    const v = k.session.state().dialog;
    if (v?.kind !== "filter") throw new Error("dialog closed");
    expect(v.filter.values.style).toBe(STYLE_CUSTOM);
    const mesh = v.filter.values.mesh as number[];
    expect(mesh).toHaveLength(32);
    expect(mesh[30]).toBeCloseTo(0.875);
    expect(mesh[31]).toBeCloseTo(0.75);
    expect(await k.session.cancelFilterDialog()).toBe(true);
    expect(imageShape(k.session)).toEqual(before);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

describe("WP5.6 Puppet warp, Liquify, Content-aware scale [image.editor.transform-warp]", () => {
  it("Puppet warp… opens with no pins; clicks add pins, a drag moves one, Alt-click removes it @level:gesture", async () => {
    covers("command:media.paged.image.command.puppetWarp");
    const k = await ingested();
    await k.run(`${C}.puppetWarp`);
    const pins = () => {
      const d = k.session.state().dialog;
      if (d?.kind !== "filter") throw new Error("no dialog");
      return d.filter.values.pins as number[];
    };
    expect(pins()).toEqual([]);
    const s = k.session;
    const click = (p: [number, number], alt = false) => {
      expect(s.canvasPointer("down", p, { alt })).toBe(true);
      s.canvasPointer("up", p);
    };
    click([0.5, 0.5]);
    click([3.5, 1.5]);
    expect(pins()).toHaveLength(8);
    // Without a GPU the rest point is the click itself.
    expect(pins().slice(0, 4)).toEqual([0.125, 0.25, 0.125, 0.25]);
    expect(s.canvasPointer("down", [3.5, 1.5])).toBe(true);
    s.canvasPointer("move", [3, 1]);
    s.canvasPointer("up", [3, 1]);
    expect(pins()[6]).toBeCloseTo(0.75);
    expect(pins()[7]).toBeCloseTo(0.5);
    expect(pins()[4]).toBeCloseTo(0.875, 5);
    click([3, 1], true);
    expect(pins()).toHaveLength(4);
    expect(await k.session.cancelFilterDialog()).toBe(true);
    k.dispose();
  });

  it("Liquify… records each drag as a stroke of the chosen tool @level:gesture", async () => {
    covers("command:media.paged.image.command.filterLiquify");
    const k = await ingested();
    await k.run(`${C}.filterLiquify`);
    k.session.setFilterValues({ tool: 5, size: 2 });
    const sess = k.session;
    expect(sess.canvasPointer("down", [1, 1])).toBe(true);
    sess.canvasPointer("move", [2, 1]);
    sess.canvasPointer("move", [3, 1]);
    sess.canvasPointer("up", [3, 1]);
    const d = k.session.state().dialog;
    if (d?.kind !== "filter") throw new Error("no dialog");
    const s = d.filter.values.strokes as number[];
    // One pucker stroke, its size a fraction of the longer side.
    expect(s[0]).toBe(5);
    expect(s[1]).toBeCloseTo(0.5);
    expect(s[5]).toBeGreaterThanOrEqual(2);
    expect(s.length).toBe(6 + 2 * s[5]!);
    expect(s[6]).toBeCloseTo(0.25);
    expect(await k.session.cancelFilterDialog()).toBe(true);
    k.dispose();
  });

  it("Content-aware scale… opens at 100 % and declines without a GPU @level:gesture", async () => {
    covers("command:media.paged.image.command.contentAwareScale");
    const k = await ingested();
    const before = imageShape(k.session);
    await k.run(`${C}.contentAwareScale`);
    const d = k.session.state().dialog;
    if (d?.kind !== "filter") throw new Error("no dialog");
    expect(d.filter.id).toBe("contentAwareScale");
    expect(d.filter.values.width).toBe(100);
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(await k.session.cancelFilterDialog()).toBe(true);
    expect(imageShape(k.session)).toEqual(before);
    k.dispose();
  });
});

describe("WP5.6 Perspective crop [image.editor.transform-warp]", () => {
  it("the tool draws a quad, a corner drags alone, Enter commits it upright @level:gesture", async () => {
    covers("tool:media.paged.image.tool.perspectiveCrop");
    const k = await ingested();
    const calls = spyOn(k.session, { commitPerspectiveCrop: true });
    const g = gestures(k.toolTarget).tool(`${T}.perspectiveCrop`).settle();
    await g.drag({ from: [0, 0], to: [200, 100] }).settle();
    // The NE corner pulled in: a keystone.
    await g.drag({ from: [200, 0], to: [150, 0] }).settle();
    await g.key("Enter").settle();
    expect(calls).toHaveLength(1);
    const [quad, w, h] = JSON.parse(
      `[${calls[0]!.slice("commitPerspectiveCrop(".length, -1)}]`,
    ) as [number[][], number, number];
    expect(quad).toEqual([
      [0, 0],
      [3, 0],
      [4, 2],
      [0, 2],
    ]);
    // The mean of the opposite sides: (3 + 4) / 2 wide, (2 + √5) / 2 high.
    expect(w).toBe(4);
    expect(h).toBe(2);
    k.dispose();
  });

  it("Image ▸ Apply perspective crop commits the tool's quad; with none it does nothing @level:gesture", async () => {
    covers("command:media.paged.image.command.commitPerspectiveCrop");
    const k = await ingested();
    const calls = spyOn(k.session, { commitPerspectiveCrop: true });
    await k.run(`${C}.commitPerspectiveCrop`);
    expect(calls).toEqual([]);
    await gestures(k.toolTarget)
      .tool(`${T}.perspectiveCrop`)
      .settle()
      .drag({ from: [50, 0], to: [150, 100] })
      .settle();
    await k.run(`${C}.commitPerspectiveCrop`);
    expect(calls).toHaveLength(1);
    k.dispose();
  });
});
