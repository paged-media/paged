// paged.image's TOOLS through the gesture DSL: each tool is mounted from
// its REGISTERED contribution (`g.tool(<id>)`, the tool's own `gesture()`),
// driven with pointer samples in document points, and asserted on the
// real session it edits (the image-js wasm in Node, through the fake
// editor). The frame is 200×100 pt holding the 4×2 two-colour image, so
// one pixel is 50 pt and the image's origin is the page's (0, 0).
//
// What a tool owes, and what is asserted:
//   · the gesture maps the page point to the right IMAGE pixel and does
//     the tool's one edit (a selection, a crop rectangle, a stroke, a
//     patch, a type run) — or declines, saying why, without a frame;
//   · its preview (marching ants, the crop frame, the brush ring);
//   · nothing reaches the document (the image is the plugin's until
//     Commit, commands.spec.ts);
//   · INV-2 (apps/editor/docs/reference/gestures.md): Escape mid-gesture
//     commits nothing. The editor delivers Escape — and a lost pointer
//     capture — to `onKey`; only the polygonal lasso handles it. The
//     others are finding IMG-2, one expected failure per tool.
//
// The stroke tools paint through WGSL, so in Node `brushBegin` declines
// for the GPU and nothing is painted; the tests assert that refusal, and
// follow the stroke's own sequence (begin once, extend per sample, commit
// once on release) with `brushBegin` answered by a recorder (`spyOn`).
// The Move, Gradient, Bucket and Red-eye tools are in gestures.spec.ts.

import { describe, expect, it } from "bun:test";

import { covers } from "@paged-media/test-kit";

import { at, bundleOnFake, C, RED, sourcePixels, spyOn } from "./command-kit";

const T = "media.paged.image.tool";

async function ingested() {
  const k = await bundleOnFake();
  await k.ingest();
  return k;
}
type K = Awaited<ReturnType<typeof ingested>>;

const sel = (k: K) => {
  const s = k.session.state().selection;
  return s && [s.x, s.y, s.w, s.h];
};

/** The last non-null overlay preview the tool published. */
const lastPreview = (k: K) =>
  k.fake.overlayShapes.filter((x) => x !== null).at(-1) as
    | {
        pageId: string;
        dashed?: boolean;
        close?: boolean;
        points?: number[][];
        anchors?: Array<{ anchor: number[] }>;
      }
    | undefined;

describe("selection tools", () => {
  it("marquee (rectangle): a drag selects the pixels under it, Shift adds, the ants preview", async () => {
    covers("tool:media.paged.image.tool.marqueeRect");
    const k = await ingested();
    const g = k.tools();
    await g
      .tool(`${T}.marqueeRect`)
      .settle()
      .drag({ from: [0, 0], to: [100, 100] })
      .settle();
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(lastPreview(k)).toMatchObject({ dashed: true, close: true });
    await g.drag({ from: [100, 0], to: [200, 100], mods: ["shift"] }).settle();
    expect(sel(k)).toEqual([0, 0, 4, 2]);
    expect(k.session.state().selection?.coverage).toBeCloseTo(1, 5);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("marquee (ellipse): a drag selects an anti-aliased ellipse", async () => {
    covers("tool:media.paged.image.tool.marqueeEllipse");
    const k = await ingested();
    await k
      .tools()
      .tool(`${T}.marqueeEllipse`)
      .settle()
      .drag({ from: [0, 0], to: [200, 100] })
      .settle();
    const cov = k.session.state().selection!.coverage;
    expect(cov).toBeGreaterThan(0);
    expect(cov).toBeLessThan(1);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("lasso: the drag's trail closes on release and selects its polygon", async () => {
    covers("tool:media.paged.image.tool.lasso");
    const k = await ingested();
    await k
      .tools()
      .tool(`${T}.lasso`)
      .settle()
      .drag({
        from: [0, 0],
        via: [
          [100, 0],
          [100, 100],
        ],
        to: [0, 100],
      })
      .settle();
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.session.state().selection!.coverage).toBeCloseTo(0.5, 2);
    k.dispose();
  });

  it("polygonal lasso: clicks place vertices, Backspace drops one, Enter closes; Escape abandons", async () => {
    covers("tool:media.paged.image.tool.polygonal-lasso");
    const k = await ingested();
    const g = k.tools().tool(`${T}.polygonal-lasso`).settle();
    // Abandoned: three vertices, then Escape — no selection.
    await g
      .click([0, 0])
      .click([100, 0])
      .click([100, 100])
      .key("Escape")
      .settle();
    expect(k.session.state().selection).toBeNull();
    // A stray vertex, dropped with Backspace; then the left half, closed.
    await g
      .click([0, 0])
      .click([100, 0])
      .click([180, 90])
      .key("Backspace")
      .click([100, 100])
      .click([0, 100])
      .key("Enter")
      .settle();
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.session.state().selection!.coverage).toBeCloseTo(0.5, 2);
    k.dispose();
  });

  it("magic wand: a click selects the contiguous colour under it, Shift adds the other", async () => {
    covers("tool:media.paged.image.tool.magicWand");
    const k = await ingested();
    const g = k.tools().tool(`${T}.magicWand`).settle();
    await g.click([50, 50]).settle();
    expect(sel(k)).toEqual([0, 0, 2, 2]);
    expect(k.session.state().selection!.coverage).toBeCloseTo(0.5, 2);
    await g.click([150, 50], { mods: ["shift"] }).settle();
    expect(k.session.state().selection!.coverage).toBeCloseTo(1, 2);
    k.dispose();
  });

  it("quick selection: painting over the image commits the grown region as the selection", async () => {
    covers("tool:media.paged.image.tool.quickSelect");
    const k = await ingested();
    const g = k.tools().tool(`${T}.quickSelect`).settle();
    // The quick-select brush (tens of pixels wide) covers this whole
    // 4×2 image from inside the red half; the edge-stopping growth is
    // pinned on a larger image in selection.spec.ts.
    await g.drag({ from: [25, 25], to: [75, 75] }).settle();
    const s = k.session.state().selection!;
    expect([s.x, s.y]).toEqual([0, 0]);
    expect(s.coverage).toBeGreaterThanOrEqual(0.5);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

describe("crop", () => {
  it("crop: dragging the top-left handle moves the crop rectangle in image pixels and previews it", async () => {
    covers("tool:media.paged.image.tool.crop");
    const k = await ingested();
    await k
      .tools()
      .tool(`${T}.crop`)
      .settle()
      .drag({ from: [0, 0], to: [100, 50] })
      .settle();
    expect(k.session.cropMachine()!.state().rect).toEqual({
      x: 2,
      y: 1,
      w: 2,
      h: 1,
    });
    const frame = lastPreview(k)!;
    expect(frame.close).toBe(true);
    expect(frame.points).toContainEqual([100, 50]);
    expect(frame.points).toContainEqual([200, 100]);
    // The rectangle is a draft: the image changes on Apply crop.
    expect(k.session.state().source?.width).toBe(4);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

/** Drive a stroke with `brushBegin` answered, so its sequence shows. */
async function strokeSequence(k: K, tool: string) {
  const calls = spyOn(k.session, {
    brushBegin: true,
    brushExtend: true,
    brushCommit: true,
  });
  await k
    .tools()
    .tool(tool)
    .settle()
    .drag({ from: [25, 25], to: [175, 75], steps: 3 })
    .settle();
  return calls;
}

/** The real session in Node: the stroke declines for the GPU and paints
 *  nothing; the tip ring was previewed. */
async function declinesForGpu(k: K, tool: string) {
  const before = await sourcePixels(k.session);
  await k
    .tools()
    .tool(tool)
    .settle()
    .drag({ from: [25, 25], to: [175, 75] })
    .settle();
  expect(k.session.state().status).toMatch(/GPU-only/);
  expect(await sourcePixels(k.session)).toEqual(before);
  expect(k.session.state().history?.depth).toBe(0);
  expect(k.session.state().strokeActive).toBe(false);
  expect(lastPreview(k)?.close).toBe(true);
  expect(k.docOps()).toEqual([]);
}

describe("paint tools", () => {
  it("brush: one stroke is begin → extend per sample → one commit; in Node the stroke declines for the GPU; Alt-click picks the colour", async () => {
    covers("tool:media.paged.image.tool.brush");
    const k = await ingested();
    await declinesForGpu(k, `${T}.brush`);
    // Alt-click is the eyedropper: the 3×3 mean under pixel (0, 0),
    // clipped to the image, is pure red.
    await k
      .tools()
      .tool(`${T}.brush`)
      .settle()
      .click([25, 25], { mods: ["alt"] })
      .settle();
    expect(k.session.state().colors.fg.slice(0, 3)).toEqual(
      [...RED].slice(0, 3).map((c) => c / 255),
    );
    expect(k.session.state().history?.depth).toBe(0);
    const calls = await strokeSequence(k, `${T}.brush`);
    expect(calls[0]).toBe('brushBegin("brush")');
    expect(
      calls.filter((c) => c.startsWith("brushExtend")).length,
    ).toBeGreaterThan(0);
    expect(calls.filter((c) => c.startsWith("brushCommit"))).toHaveLength(1);
    expect(calls.at(-1)).toBe("brushCommit()");
    k.dispose();
  });

  it("pencil: the same stroke under the pencil's name; declines for the GPU in Node", async () => {
    covers("tool:media.paged.image.tool.pencil");
    const k = await ingested();
    await declinesForGpu(k, `${T}.pencil`);
    const calls = await strokeSequence(k, `${T}.pencil`);
    expect(calls[0]).toBe('brushBegin("pencil")');
    expect(calls.at(-1)).toBe("brushCommit()");
    k.dispose();
  });

  it("eraser: the same stroke under the eraser's name; declines for the GPU in Node", async () => {
    covers("tool:media.paged.image.tool.eraser");
    const k = await ingested();
    await declinesForGpu(k, `${T}.eraser`);
    const calls = await strokeSequence(k, `${T}.eraser`);
    expect(calls[0]).toBe('brushBegin("eraser")');
    expect(calls.at(-1)).toBe("brushCommit()");
    k.dispose();
  });
});

describe("retouching tools", () => {
  it("clone stamp: Alt-click sets the source in image pixels and paints nothing; a stroke then declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.clone");
    const k = await ingested();
    await k
      .tools()
      .tool(`${T}.clone`)
      .settle()
      .click([75, 25], { mods: ["alt"] })
      .settle();
    expect(k.session.state().cloneSource).toMatchObject({ x: 1.5, y: 0.5 });
    expect(k.session.state().history?.depth).toBe(0);
    await declinesForGpu(k, `${T}.clone`);
    const calls = await strokeSequence(k, `${T}.clone`);
    expect(calls[0]).toBe('brushBegin("clone")');
    k.dispose();
  });

  it("healing brush: Alt-click sets the source; a stroke declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.heal");
    const k = await ingested();
    await k
      .tools()
      .tool(`${T}.heal`)
      .settle()
      .click([25, 75], { mods: ["alt"] })
      .settle();
    expect(k.session.state().cloneSource).toMatchObject({ x: 0.5, y: 1.5 });
    await declinesForGpu(k, `${T}.heal`);
    const calls = await strokeSequence(k, `${T}.heal`);
    expect(calls[0]).toBe('brushBegin("heal")');
    k.dispose();
  });

  it("dodge: a filter stroke under its name; declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.dodge");
    const k = await ingested();
    await declinesForGpu(k, `${T}.dodge`);
    expect((await strokeSequence(k, `${T}.dodge`))[0]).toBe(
      'brushBegin("dodge")',
    );
    k.dispose();
  });

  it("burn: a filter stroke under its name; declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.burn");
    const k = await ingested();
    await declinesForGpu(k, `${T}.burn`);
    expect((await strokeSequence(k, `${T}.burn`))[0]).toBe(
      'brushBegin("burn")',
    );
    k.dispose();
  });

  it("sponge: a filter stroke under its name; declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.sponge");
    const k = await ingested();
    await declinesForGpu(k, `${T}.sponge`);
    expect((await strokeSequence(k, `${T}.sponge`))[0]).toBe(
      'brushBegin("sponge")',
    );
    k.dispose();
  });

  it("blur (brush): a filter stroke under its name; declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.blur");
    const k = await ingested();
    await declinesForGpu(k, `${T}.blur`);
    expect((await strokeSequence(k, `${T}.blur`))[0]).toBe(
      'brushBegin("blur")',
    );
    k.dispose();
  });

  it("sharpen (brush): a filter stroke under its name; declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.sharpen");
    const k = await ingested();
    await declinesForGpu(k, `${T}.sharpen`);
    expect((await strokeSequence(k, `${T}.sharpen`))[0]).toBe(
      'brushBegin("sharpen")',
    );
    k.dispose();
  });

  it("spot healing brush: no source is asked for; the stroke declines for the GPU", async () => {
    covers("tool:media.paged.image.tool.spotHeal");
    const k = await ingested();
    await declinesForGpu(k, `${T}.spotHeal`);
    expect(k.session.state().status).not.toMatch(/source/);
    expect((await strokeSequence(k, `${T}.spotHeal`))[0]).toBe(
      'brushBegin("spot-heal")',
    );
    k.dispose();
  });

  it("patch: needs a selection; a drag names the source offset in image pixels; a click patches nothing", async () => {
    covers("tool:media.paged.image.tool.patch");
    const k = await ingested();
    const g = k.tools().tool(`${T}.patch`).settle();
    await g.drag({ from: [25, 25], to: [125, 25] }).settle();
    expect(k.session.state().status).toMatch(/needs a selection/);
    await k.run(`${C}.selectAll`);
    await g.drag({ from: [25, 25], to: [125, 25] }).settle();
    expect(k.session.state().status).toMatch(/GPU-only/);
    expect(at(await sourcePixels(k.session), 0, 0)).toEqual([...RED]);
    const calls = spyOn(k.session, { patchSelection: true });
    await g
      .drag({ from: [25, 25], to: [125, 75] })
      .click([50, 50])
      .settle();
    expect(calls).toEqual(["patchSelection(2,1)"]);
    k.dispose();
  });
});

describe("raster type", () => {
  it("type: a click sets a run at the clicked baseline with the session's text, family and size", async () => {
    covers("tool:media.paged.image.tool.type");
    const k = await ingested();
    const calls = spyOn(k.session, { paintText: true });
    const g = k.tools().tool(`${T}.type`).settle();
    // No text yet: the click sets nothing.
    await g.click([50, 50]).settle();
    expect(calls).toEqual([]);
    k.session.setType({ text: "Hi", family: "Test", sizePx: 20 });
    await g.click([50, 50]).settle();
    expect(calls).toEqual(['paintText([1,1],"Hi","Test",20)']);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });
});

// ── FINDING IMG-2: Escape mid-gesture commits ───────────────────────
//
// The editor routes Escape (and a lost pointer capture) to the active
// tool's `onKey` as THE zero-mutation cancel (useGestureSpine, INV-2 /
// INV-8). The image tools other than the polygonal lasso have no Escape
// handling, so the gesture runs on and commits on release.

async function escapeThenRelease(k: K, tool: string) {
  await k
    .tools()
    .tool(tool)
    .settle()
    .down([0, 0])
    .move([100, 100])
    .cancel()
    .up([100, 100])
    .settle();
}

describe("IMG-2 — Escape cancels the gesture (INV-2)", () => {
  it.failing(
    "IMG-2 — marquee (rectangle): Escape mid-drag selects nothing",
    async () => {
      const k = await ingested();
      await escapeThenRelease(k, `${T}.marqueeRect`);
      expect(k.session.state().selection).toBeNull();
      k.dispose();
    },
  );

  it.failing(
    "IMG-2 — marquee (ellipse): Escape mid-drag selects nothing",
    async () => {
      const k = await ingested();
      await escapeThenRelease(k, `${T}.marqueeEllipse`);
      expect(k.session.state().selection).toBeNull();
      k.dispose();
    },
  );

  it.failing("IMG-2 — lasso: Escape mid-drag selects nothing", async () => {
    const k = await ingested();
    await k
      .tools()
      .tool(`${T}.lasso`)
      .settle()
      .down([0, 0])
      .move([100, 0])
      .move([100, 100])
      .cancel()
      .up([0, 100])
      .settle();
    expect(k.session.state().selection).toBeNull();
    k.dispose();
  });

  it.failing(
    "IMG-2 — quick selection: Escape mid-drag selects nothing",
    async () => {
      const k = await ingested();
      await escapeThenRelease(k, `${T}.quickSelect`);
      expect(k.session.state().selection).toBeNull();
      k.dispose();
    },
  );

  it.failing("IMG-2 — patch: Escape mid-drag patches nothing", async () => {
    const k = await ingested();
    await k.run(`${C}.selectAll`);
    const calls = spyOn(k.session, { patchSelection: true });
    await escapeThenRelease(k, `${T}.patch`);
    expect(calls).toEqual([]);
    k.dispose();
  });

  it.failing("IMG-2 — brush: Escape mid-stroke commits no stroke", async () => {
    const k = await ingested();
    const calls = spyOn(k.session, {
      brushBegin: true,
      brushExtend: true,
      brushCommit: true,
    });
    await escapeThenRelease(k, `${T}.brush`);
    expect(calls.filter((c) => c.startsWith("brushCommit"))).toEqual([]);
    k.dispose();
  });

  it.failing("IMG-2 — move pixels: Escape mid-drag moves nothing", async () => {
    const k = await ingested();
    const calls = spyOn(k.session, { offsetLayer: true, moveSelection: true });
    await escapeThenRelease(k, `${T}.move`);
    expect(calls).toEqual([]);
    k.dispose();
  });

  it.failing("IMG-2 — gradient: Escape mid-drag fills nothing", async () => {
    const k = await ingested();
    const calls = spyOn(k.session, { fillGradientLine: true });
    await escapeThenRelease(k, `${T}.gradient`);
    expect(calls).toEqual([]);
    k.dispose();
  });

  it.failing("IMG-2 — red eye: Escape mid-drag corrects nothing", async () => {
    const k = await ingested();
    const calls = spyOn(k.session, { applyRedEye: true });
    await escapeThenRelease(k, `${T}.redEye`);
    expect(calls).toEqual([]);
    k.dispose();
  });
});
