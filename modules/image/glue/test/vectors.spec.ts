// VECTORS INSIDE THE IMAGE (WP5.11, image ADR 476) through the gesture
// DSL: the Pen, the Freeform Pen, Path Selection, Direct Selection and
// the five shape tools, each mounted from its REGISTERED contribution
// and driven in document points over the 4×2 image (200×100 pt, 50 pt
// per pixel) — so every assertion in image px also proves the frame fit.
// Plus the tools' options, set the way the options bar sets them.
//
// Node has no WebGPU: the Shape and Pixels modes (a fill renders on the
// GPU) decline honestly here and change nothing; paths and vector masks
// are mask preparation on the CPU and run in full.

import { describe, expect, it } from "bun:test";

import type { ToolContribution } from "@paged-media/plugin-api";
import { inMemoryToolSettings } from "@paged-media/plugin-sdk";
import { covers, gestures } from "@paged-media/test-kit";

import { bundleOnFake, imageShape } from "./command-kit";
import type { Geometry } from "../src/vector-engine";

const T = "media.paged.image.tool";

async function ingested(toolSettings = inMemoryToolSettings()) {
  const k = await bundleOnFake({ toolSettings });
  await k.ingest();
  return { k, settings: toolSettings };
}
type K = Awaited<ReturnType<typeof ingested>>["k"];

const paths = (k: K) => k.session.masking().state().info.paths;
const lastStep = (k: K) => k.session.state().history?.undoSteps.at(-1);
const work = (k: K): Geometry => {
  const p = paths(k).find((q) => q.work);
  if (!p) throw new Error("no work path");
  return k.session.masking().engine()!.pathGeometry(p.id).geometry;
};
/** The anchor points of one subpath, rounded to 1/100 px. */
const points = (g: Geometry, i = 0) => {
  const a = g.subpaths[i].anchors;
  const out: [number, number][] = [];
  for (let k = 0; k < a.length; k += 6)
    out.push([Math.round(a[k] * 100) / 100, Math.round(a[k + 1] * 100) / 100]);
  return out;
};

describe("[image.paths.vectors] the Pen", () => {
  it("clicks a closed triangle into a new work path, then a second subpath joins it; Enter keeps an open one", async () => {
    covers("tool:media.paged.image.tool.pen");
    const { k } = await ingested();
    const g = gestures(k.toolTarget).tool(`${T}.pen`).settle();
    await g
      .click([10, 10])
      .click([190, 10])
      .click([190, 90])
      .click([10, 10])
      .settle();
    expect(paths(k)).toHaveLength(1);
    expect(paths(k)[0]).toMatchObject({ name: "Work Path", work: true });
    const w = work(k);
    expect(w.subpaths[0].closed).toBe(true);
    expect(points(w)).toEqual([
      [0.2, 0.2],
      [3.8, 0.2],
      [3.8, 1.8],
    ]);
    expect(lastStep(k)).toBe("Work path");
    // The work path is now the target: an open run joins it.
    await g.click([20, 80]).click([60, 80]).key("Enter").settle();
    const w2 = work(k);
    expect(w2.subpaths).toHaveLength(2);
    expect(w2.subpaths[1]).toMatchObject({ closed: false, op: 1, rule: 1 });
    expect(points(w2, 1)).toEqual([
      [0.4, 1.6],
      [1.2, 1.6],
    ]);
    expect(lastStep(k)).toBe("Edit path");
    // Paths are image state: nothing reached the document.
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("a click on the target path's segment adds an anchor there", async () => {
    const { k } = await ingested();
    const g = gestures(k.toolTarget).tool(`${T}.pen`).settle();
    await g
      .click([10, 10])
      .click([190, 10])
      .click([190, 90])
      .click([10, 10])
      .settle();
    await g.click([100, 10]).settle();
    expect(points(work(k))).toHaveLength(4);
    expect(points(work(k))).toContainEqual([2, 0.2]);
    k.dispose();
  });

  it("Shape mode declines without WebGPU and changes nothing", async () => {
    const { k, settings } = await ingested();
    settings.set(`${T}.pen`, "mode", "shape");
    const before = imageShape(k.session);
    const g = gestures(k.toolTarget).tool(`${T}.pen`).settle();
    await g
      .click([10, 10])
      .click([190, 10])
      .click([190, 90])
      .click([10, 10])
      .settle();
    expect(k.session.state().status).toContain("WebGPU");
    expect(imageShape(k.session)).toEqual(before);
    expect(paths(k)).toHaveLength(0);
    k.dispose();
  });
});

describe("[image.paths.vectors] the Freeform Pen", () => {
  it("a drag becomes a smooth open work path", async () => {
    covers("tool:media.paged.image.tool.freeformPen");
    const { k } = await ingested();
    await gestures(k.toolTarget)
      .tool(`${T}.freeformPen`)
      .drag({ from: [10, 50], via: [[100, 10]], to: [190, 50], steps: 12 })
      .settle();
    const w = work(k);
    expect(w.subpaths).toHaveLength(1);
    expect(w.subpaths[0].closed).toBe(false);
    const p = points(w);
    expect(p.length).toBeGreaterThanOrEqual(2);
    expect(p[0]).toEqual([0.2, 1]);
    expect(p.at(-1)).toEqual([3.8, 1]);
    k.dispose();
  });
});

/** A 4-anchor rectangle work path over px (1,0)–(3,2), via the
 *  Rectangle tool in Path mode. */
async function rectanglePath(k: K) {
  await gestures(k.toolTarget)
    .tool(`${T}.rectangleShape`)
    .drag({ from: [50, 0], to: [150, 100] })
    .settle();
}

describe("[image.paths.vectors] Direct Selection", () => {
  it("drags one anchor of the target path; one undo step", async () => {
    covers("tool:media.paged.image.tool.directSelect");
    const { k } = await ingested();
    await rectanglePath(k);
    expect(points(work(k))).toEqual([
      [1, 0],
      [3, 0],
      [3, 2],
      [1, 2],
    ]);
    const depth = k.session.state().history!.depth;
    await gestures(k.toolTarget)
      .tool(`${T}.directSelect`)
      .drag({ from: [150, 100], to: [175, 75] })
      .settle();
    expect(points(work(k))).toEqual([
      [1, 0],
      [3, 0],
      [3.5, 1.5],
      [1, 2],
    ]);
    expect(k.session.state().history!.depth).toBe(depth + 1);
    expect(lastStep(k)).toBe("Edit path");
    k.dispose();
  });
});

describe("[image.paths.vectors] Path Selection", () => {
  it("drags a whole subpath, Alt-drags a copy, Delete removes it", async () => {
    covers("tool:media.paged.image.tool.pathSelect");
    const { k } = await ingested();
    await rectanglePath(k);
    const g = gestures(k.toolTarget).tool(`${T}.pathSelect`).settle();
    // Inside the rectangle: the whole subpath moves by (−0.5, 0) px.
    await g.drag({ from: [100, 50], to: [75, 50] }).settle();
    expect(points(work(k))).toEqual([
      [0.5, 0],
      [2.5, 0],
      [2.5, 2],
      [0.5, 2],
    ]);
    // Alt: a copy, the original stays.
    await g.drag({ from: [75, 50], to: [125, 50], mods: ["alt"] }).settle();
    expect(work(k).subpaths).toHaveLength(2);
    expect(points(work(k), 1)[0]).toEqual([1.5, 0]);
    // The copy is picked: Delete removes it.
    await g.key("Delete").settle();
    expect(work(k).subpaths).toHaveLength(1);
    expect(points(work(k))[0]).toEqual([0.5, 0]);
    k.dispose();
  });
});

describe("[image.paths.vectors] the shape tools", () => {
  it("Rectangle, Ellipse, Polygon, Line and Custom Shape draw paths in Path mode", async () => {
    covers("tool:media.paged.image.tool.rectangleShape");
    covers("tool:media.paged.image.tool.ellipseShape");
    covers("tool:media.paged.image.tool.polygonShape");
    covers("tool:media.paged.image.tool.lineShape");
    covers("tool:media.paged.image.tool.customShape");
    const { k } = await ingested();
    const drag = (tool: string) =>
      gestures(k.toolTarget)
        .tool(`${T}.${tool}`)
        .drag({ from: [0, 0], to: [200, 100] })
        .settle();
    await drag("rectangleShape");
    expect(points(work(k))).toEqual([
      [0, 0],
      [4, 0],
      [4, 2],
      [0, 2],
    ]);
    // The work path is the target now: each shape adds a subpath.
    await drag("ellipseShape");
    await drag("polygonShape");
    await drag("lineShape");
    await drag("customShape");
    const w = work(k);
    expect(w.subpaths.map((s) => s.anchors.length / 6)).toEqual([
      4, 4, 5, 4, 7,
    ]);
    // Each new shape is a component that combines.
    expect(w.subpaths.map((s) => s.op)).toEqual([1, 1, 1, 1, 1]);
    // The ellipse is curved: its anchors carry handles.
    const e = w.subpaths[1].anchors;
    expect(e[1]).not.toBe(e[3]);
    k.dispose();
  });

  it("Pixels and Shape modes need WebGPU and say so", async () => {
    const { k, settings } = await ingested();
    const before = imageShape(k.session);
    for (const mode of ["pixels", "shape"]) {
      settings.set(`${T}.ellipseShape`, "mode", mode);
      await gestures(k.toolTarget)
        .tool(`${T}.ellipseShape`)
        .drag({ from: [0, 0], to: [200, 100] })
        .settle();
      expect(k.session.state().status).toContain("WebGPU");
    }
    expect(imageShape(k.session)).toEqual(before);
    k.dispose();
  });
});

describe("[image.paths.vectors] the vector tools' options", () => {
  it("mode and path operation reach the session from every drawing tool", async () => {
    const tools = [
      "pen",
      "freeformPen",
      "rectangleShape",
      "ellipseShape",
      "polygonShape",
      "lineShape",
      "customShape",
    ];
    covers("setting:media.paged.image.tool.pen.mode");
    covers("setting:media.paged.image.tool.pen.operation");
    covers("setting:media.paged.image.tool.freeformPen.mode");
    covers("setting:media.paged.image.tool.freeformPen.operation");
    covers("setting:media.paged.image.tool.rectangleShape.mode");
    covers("setting:media.paged.image.tool.rectangleShape.operation");
    covers("setting:media.paged.image.tool.ellipseShape.mode");
    covers("setting:media.paged.image.tool.ellipseShape.operation");
    covers("setting:media.paged.image.tool.polygonShape.mode");
    covers("setting:media.paged.image.tool.polygonShape.operation");
    covers("setting:media.paged.image.tool.lineShape.mode");
    covers("setting:media.paged.image.tool.lineShape.operation");
    covers("setting:media.paged.image.tool.customShape.mode");
    covers("setting:media.paged.image.tool.customShape.operation");
    const { k, settings } = await ingested();
    const v = () => k.session.vectors().state();
    for (const tool of tools) {
      const fields = (
        k.fake.tools.get(`${T}.${tool}`) as unknown as ToolContribution
      ).options!.fields;
      expect(fields.map((f) => f.key).slice(0, 2)).toEqual([
        "mode",
        "operation",
      ]);
      settings.set(`${T}.${tool}`, "mode", "shape");
      expect(v().mode).toBe("shape");
      settings.set(`${T}.${tool}`, "mode", "path");
      expect(v().mode).toBe("path");
      settings.set(`${T}.${tool}`, "operation", "subtract");
      expect(v().op).toBe(2);
      settings.set(`${T}.${tool}`, "operation", "exclude");
      expect(v().op).toBe(0);
      settings.set(`${T}.${tool}`, "operation", "combine");
      expect(v().op).toBe(1);
    }
    // The Pen offers no Pixels mode (Photoshop's).
    const penMode = (
      k.fake.tools.get(`${T}.pen`) as unknown as ToolContribution
    ).options!.fields[0];
    expect(
      penMode.kind === "select" && penMode.options.map((o) => o.value),
    ).toEqual(["shape", "path"]);
    // A value of the wrong kind is ignored.
    settings.set(`${T}.pen`, "mode", "stencil");
    expect(v().mode).toBe("path");
    k.dispose();
  });

  it("the shapes' own options: radius, sides, indent, weight, custom shape", async () => {
    covers("setting:media.paged.image.tool.rectangleShape.radius");
    covers("setting:media.paged.image.tool.polygonShape.sides");
    covers("setting:media.paged.image.tool.polygonShape.starIndent");
    covers("setting:media.paged.image.tool.lineShape.weight");
    covers("setting:media.paged.image.tool.customShape.shape");
    const { k, settings } = await ingested();
    const shape = () => k.session.vectors().state().shape;
    settings.set(`${T}.rectangleShape`, "radius", 1);
    settings.set(`${T}.polygonShape`, "sides", 6);
    settings.set(`${T}.polygonShape`, "starIndent", 50);
    settings.set(`${T}.lineShape`, "weight", 2);
    settings.set(`${T}.customShape`, "shape", "heart");
    expect(shape()).toEqual({
      radius: 1,
      sides: 6,
      starIndent: 50,
      weight: 2,
      custom: "heart",
    });
    settings.set(`${T}.customShape`, "shape", "no-such-shape");
    expect(shape().custom).toBe("heart");
    // They shape what is drawn: a six-pointed star has 12 corners, a
    // rounded rectangle 8 anchors.
    const drag = (tool: string) =>
      gestures(k.toolTarget)
        .tool(`${T}.${tool}`)
        .drag({ from: [0, 0], to: [200, 100] })
        .settle();
    await drag("polygonShape");
    await drag("rectangleShape");
    expect(work(k).subpaths.map((s) => s.anchors.length / 6)).toEqual([12, 8]);
    k.dispose();
  });
});
