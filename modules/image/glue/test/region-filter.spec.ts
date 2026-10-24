// @feat: image.editor.region-filter
//
// A filter on a region (plan G4; ADR 465), headless: the typed
// `filterRegion` on the REAL plugin in the SDK's headless host, where no
// GPU exists, so the engine runs the shipped CPU twins of the adjustment
// chain's kernels. The pixels inside the region change, the ones outside
// do not, the write is one undo step, and what the object model bakes is
// what the engine's own `filterRegion` computes. A mask given as data
// (polygons with a feather, an alpha coverage as raw bytes or as an image)
// narrows the region headless; `selection: true` reads the editor
// session's selection and is refused where there is none.
//
// REQUIRE_REAL_WASM=1 turns a missing artifact into a failure (the
// wasm-exec convention).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  createHeadlessHost,
  defineBundle,
  type HeadlessHost,
  silentConsole as silent,
} from "@paged-media/plugin-sdk";
import type { BundleHost, PluginManifest } from "@paged-media/plugin-api";
import manifestJson from "@paged-media/image-manifest/manifest.json";
import { covers } from "@paged-media/test-kit";

import { imageBundle } from "../src/index";
import { bootEngine, type ImageEngine } from "../src/engine";
import { defaultAdjust, writeAdjust } from "../src/object-model/adjust";
import {
  contributeImageObjectModel,
  engineCodec,
} from "../src/object-model/contribute";
import type {
  SelectionFollow,
  SelectionSource,
} from "../src/object-model/image-objects";
import { minimalIdml } from "./fixtures/minimal-idml";

const ENGINE_ANCHOR = fileURLToPath(new URL(".", import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));
const built = existsSync(join(HERE, "..", "wasm", "image_js_bg.wasm"));
if (process.env.REQUIRE_REAL_WASM === "1" && !built) {
  throw new Error(
    "REQUIRE_REAL_WASM=1 but glue/wasm/image_js_bg.wasm is missing",
  );
}
const lane = built ? describe : describe.skip;

const P = "plugin:media.paged.image";
const FRAME = "urect";
const L = `${P}/layer/${FRAME}/1`;
const FILTER = "media.paged.image.command.filterRegion";
const W = 16;
const H = 12;

let engine: ImageEngine;
beforeAll(async () => {
  if (built) engine = await bootEngine();
});

let live: HeadlessHost | null = null;
afterEach(() => {
  live?.dispose();
  live = null;
});

/** Vertical stripes two pixels wide, so a blur changes every column. */
const stripes = () => {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      px.set(
        x % 4 < 2 ? [200, 60, 20, 255] : [30, 90, 220, 255],
        (y * W + x) * 4,
      );
  return px;
};

const decode = (bytes: Uint8Array) => {
  const d = engine.decode(bytes);
  try {
    return engine.tile(d.handle, 0, 0, d.width, d.height);
  } finally {
    engine.freeImage(d.handle);
  }
};

async function imageDoc(bundle = imageBundle) {
  const h = (live = await createHeadlessHost({
    resolveFrom: ENGINE_ANCHOR,
    console: silent,
  }));
  await h.load(minimalIdml());
  h.loadBundle(bundle);
  const out = await h.host.document.mutate({
    op: "replaceImageBytes",
    args: {
      elementId: FRAME,
      bytes: Array.from(engine.encode(stripes(), W, H, "png")),
    },
  } as never);
  expect(out.applied).toBe(true);
  return h;
}

const shown = async (h: HeadlessHost) =>
  decode((await h.host.assets.getPlacedImage(FRAME))!.bytes);

/** Whether pixel (x, y) differs between two RGBA8 buffers. */
const differs = (a: Uint8Array, b: Uint8Array, x: number, y: number) => {
  const o = (y * W + x) * 4;
  return [0, 1, 2, 3].some((c) => a[o + c] !== b[o + c]);
};

lane("filterRegion, headless (the CPU twins)", () => {
  it("runs without a GPU: inside the region only, one undo step, the frame baked", async () => {
    covers("command:media.paged.image.command.filterRegion");
    const h = await imageDoc();
    expect(engine.gpuReady()).toBe(false);
    const before = await shown(h);
    // [top, left, bottom, right]: rows 2–7, columns 3–12.
    const region = [2, 3, 8, 13];
    const r = await h.objects.invoke(FILTER, {
      layer: L,
      params: { "gaussianBlur.sigma": 1.5, "unsharp.amount": 0.5 },
      region,
    });
    expect(r).toMatchObject({ applied: true, undoSteps: 1 });
    expect(await h.objects.get(`${P}/image/${FRAME}`, "pending")).toEqual({
      kind: "value",
      value: false,
    });
    const after = await shown(h);
    let inside = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const isInside = y >= 2 && y < 8 && x >= 3 && x < 13;
        if (!isInside)
          expect(differs(before, after, x, y), `(${x}, ${y})`).toBe(false);
        else if (differs(before, after, x, y)) inside++;
      }
    expect(inside).toBeGreaterThan(40);

    // The object model baked what the engine computes for the same chain.
    const wire = defaultAdjust();
    writeAdjust(wire, "gaussianBlur.sigma", 1.5);
    writeAdjust(wire, "unsharp.amount", 0.5);
    const direct = await engine.filterRegion(stripes(), W, H, wire, {
      x: 3,
      y: 2,
      w: 10,
      h: 6,
    });
    expect(Buffer.from(after).equals(Buffer.from(direct))).toBe(true);

    await h.host.document.undo();
    expect(Buffer.from(await shown(h)).equals(Buffer.from(before))).toBe(true);
  });

  it("takes the adjustment kernels, and the whole canvas without a region", async () => {
    const h = await imageDoc();
    const r = await h.objects.invoke(FILTER, {
      layer: L,
      params: { "invert.enabled": true },
    });
    expect(r).toMatchObject({ applied: true });
    const px = await shown(h);
    expect(Array.from(px.subarray(0, 4))).toEqual([55, 195, 235, 255]);
    expect(Array.from(px.subarray(8, 12))).toEqual([225, 165, 35, 255]);
  });

  it("refuses with a reason: outside the canvas, no change, an adjustment layer", async () => {
    const h = await imageDoc();
    await expect(
      h.objects.invoke(FILTER, {
        layer: L,
        params: { "invert.enabled": true },
        region: [0, 0, 20, 4],
      }),
    ).rejects.toThrow(/the region must lie inside the 16×12 canvas/);
    await expect(
      h.objects.invoke(FILTER, { layer: L, params: {} }),
    ).rejects.toThrow(/changes nothing/);
    await h.objects.invoke("media.paged.image.command.applyAdjustment", {
      image: `${P}/image/${FRAME}`,
      params: { "exposure.ev": 0.5 },
    });
    await expect(
      h.objects.invoke(FILTER, {
        layer: `${P}/layer/${FRAME}/2`,
        params: { "invert.enabled": true },
      }),
    ).rejects.toThrow(/adjustment layer has no pixels/);
    await expect(
      h.objects.invoke(FILTER, {
        layer: L,
        params: { "noSuch.path": 1 },
      }),
    ).rejects.toThrow(/no adjustment parameter "noSuch.path"/);
  });
});

/** The object model alone with `selection` standing in for the editor
 *  session's live selection. */
function withSelection(
  selection: SelectionSource,
  selectionFollow?: SelectionFollow,
) {
  return defineBundle({
    manifest: manifestJson as PluginManifest,
    activate(host: BundleHost) {
      const om = contributeImageObjectModel(
        host,
        [],
        engineCodec(),
        undefined,
        selection,
        selectionFollow,
      );
      return {
        dispose: () => (om?.objects.dispose(), om?.handle.dispose()),
      } as never;
    },
  });
}

/** Every pixel's (x, y) where `pred` holds. */
const where = (pred: (x: number, y: number) => boolean) => {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (pred(x, y)) out.push([x, y]);
  return out;
};

const INVERT = { "invert.enabled": true };
const invertWire = () => {
  const wire = defaultAdjust();
  writeAdjust(wire, "invert.enabled", true);
  return wire;
};

lane("filterRegion with a mask, headless", () => {
  it("a polygon: only its pixels change, as the engine computes; a feather reaches further", async () => {
    covers("command:media.paged.image.command.filterRegion");
    const h = await imageDoc();
    const before = await shown(h);
    // A right triangle over the left half: (0,0)–(8,0)–(0,12).
    const polygons = [
      [
        [0, 0],
        [8, 0],
        [0, 12],
      ],
    ];
    const r = await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      mask: { polygons },
    });
    expect(r).toMatchObject({ applied: true, undoSteps: 1 });
    const after = await shown(h);
    // Well outside the triangle (x + 2y/3 > 9): untouched.
    for (const [x, y] of where((x, y) => x + (2 * y) / 3 > 9))
      expect(differs(before, after, x, y), `(${x}, ${y})`).toBe(false);
    // Well inside: inverted exactly.
    expect(Array.from(after.subarray(0, 4))).toEqual([55, 195, 235, 255]);
    const direct = await engine.filterRegion(
      stripes(),
      W,
      H,
      invertWire(),
      { x: 0, y: 0, w: W, h: H },
      {
        polygons: [
          [
            [0, 0],
            [8, 0],
            [0, 12],
          ],
        ],
      },
    );
    expect(Buffer.from(after).equals(Buffer.from(direct))).toBe(true);

    // The same triangle feathered changes pixels the hard one left.
    await h.host.document.undo();
    await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      mask: { polygons, feather: 2 },
      region: [0, 0, 12, 12],
    });
    const soft = await shown(h);
    const reach = (img: Uint8Array) =>
      where((x, y) => differs(before, img, x, y)).length;
    expect(reach(soft)).toBeGreaterThan(reach(after));
    // The region still clips hard: nothing at x ≥ 12.
    for (const [x, y] of where((x) => x >= 12))
      expect(differs(before, soft, x, y), `(${x}, ${y})`).toBe(false);
  });

  it("an alpha mask, raw bytes or an image: 0 untouched, 255 filtered, 128 half way", async () => {
    const h = await imageDoc();
    const before = await shown(h);
    // Columns 0–3 full, 4 half, the rest none.
    const alpha = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < 5; x++) alpha[y * W + x] = x < 4 ? 255 : 128;
    await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      mask: { alpha },
    });
    const after = await shown(h);
    for (const [x, y] of where((x) => x > 4))
      expect(differs(before, after, x, y), `(${x}, ${y})`).toBe(false);
    // Column 0 is (200, 60, 20) → inverted; column 4 is the same stripe
    // colour half inverted: mix(200, 55, ½) ≈ 127.
    expect(Array.from(after.subarray(0, 4))).toEqual([55, 195, 235, 255]);
    const half = after.subarray(16, 20);
    expect(Math.abs(half[0]! - 127)).toBeLessThanOrEqual(1);
    expect(Math.abs(half[1]! - 127)).toBeLessThanOrEqual(1);
    expect(half[3]).toBe(255);

    // The same coverage as a grey PNG of the canvas size.
    await h.host.document.undo();
    const grey = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++)
      grey.set([alpha[i]!, alpha[i]!, alpha[i]!, 255], i * 4);
    await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      mask: { alpha: engine.encode(grey, W, H, "png") },
    });
    expect(Buffer.from(await shown(h)).equals(Buffer.from(after))).toBe(true);
  });

  it("refuses with a reason: a short polygon, a mis-sized alpha, a mask over nothing, no selection headless", async () => {
    const h = await imageDoc();
    await expect(
      h.objects.invoke(FILTER, {
        layer: L,
        params: INVERT,
        mask: {
          polygons: [
            [
              [0, 0],
              [4, 4],
            ],
          ],
        },
      }),
    ).rejects.toThrow(/at least 3/);
    await expect(
      h.objects.invoke(FILTER, {
        layer: L,
        params: INVERT,
        mask: { alpha: new Uint8Array(7) },
      }),
    ).rejects.toThrow(/16×12 = 192 coverage bytes/);
    await expect(
      h.objects.invoke(FILTER, {
        layer: L,
        params: INVERT,
        mask: { alpha: new Uint8Array(W * H) },
      }),
    ).rejects.toThrow(/covers no pixel/);
    await expect(
      h.objects.invoke(FILTER, {
        layer: L,
        params: INVERT,
        mask: { feather: 3 },
      }),
    ).rejects.toThrow(/needs polygons or an alpha/);
    // The bundle's session has no image open headless.
    await expect(
      h.objects.invoke(FILTER, { layer: L, params: INVERT, selection: true }),
    ).rejects.toThrow(/no image is open in the editor/);
  });

  it("selection: true filters within the session's selection (intersected with a mask)", async () => {
    // The session's coverage: the top half.
    const top = new Uint8Array(W * H).fill(255, 0, W * (H / 2));
    const asked: string[] = [];
    const h = await imageDoc(
      withSelection((frameId) => {
        asked.push(frameId);
        return { width: W, height: H, coverage: top };
      }),
    );
    const before = await shown(h);
    await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      selection: true,
      mask: {
        polygons: [
          [
            [0, 0],
            [8, 0],
            [8, 12],
            [0, 12],
          ],
        ],
      },
    });
    expect(asked).toEqual([FRAME]);
    const after = await shown(h);
    for (const [x, y] of where(() => true))
      expect(differs(before, after, x, y), `(${x}, ${y})`).toBe(
        x < 8 && y < H / 2,
      );
    h.dispose();
    live = null;

    const elsewhere = await imageDoc(
      withSelection(() => ({ refused: "nothing is selected in the editor" })),
    );
    await expect(
      elsewhere.objects.invoke(FILTER, {
        layer: L,
        params: INVERT,
        selection: true,
      }),
    ).rejects.toThrow(/nothing is selected in the editor/);
  });

  it("a canvas operation committed on the frame is handed to the session, which answers for the revision it made", async () => {
    // The kept selection is asked for the revision the frame shows; the
    // session is told which revision a flip made from which.
    const follows: Array<[string, string | null, string, unknown]> = [];
    const asked: Array<string | null> = [];
    const h = await imageDoc(
      withSelection(
        (_frameId, record) => {
          asked.push(record);
          return {
            width: W,
            height: H,
            coverage: new Uint8Array(W * H).fill(255),
          };
        },
        (frameId, from, to, ops) => follows.push([frameId, from, to, ops]),
      ),
    );
    const flipped = await h.objects.batch([
      {
        op: "set",
        address: `${P}/image/${FRAME}`,
        path: "transform",
        value: "flipHorizontal",
      } as never,
    ]);
    expect(flipped.reason ?? "").toBe("");
    expect(follows).toHaveLength(1);
    const [frameId, from, to, ops] = follows[0]!;
    expect(frameId).toBe(FRAME);
    expect(to).not.toBe(from);
    expect(ops).toEqual([{ kind: "flipHorizontal" }]);
    await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      selection: true,
    });
    expect(asked).toEqual([to]);
    h.dispose();
    live = null;
  });

  it("selection: true maps a selection made on the same image at another size, and refuses another crop", async () => {
    // The session's selection on the image at twice the size: the left
    // half selected.
    const big = new Uint8Array(W * 2 * H * 2);
    for (let y = 0; y < H * 2; y++) big.fill(255, y * W * 2, y * W * 2 + W);
    const h = await imageDoc(
      withSelection(() => ({ width: W * 2, height: H * 2, coverage: big })),
    );
    const before = await shown(h);
    await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      selection: true,
    });
    const after = await shown(h);
    for (const [x, y] of where(() => true))
      expect(differs(before, after, x, y), `(${x}, ${y})`).toBe(x < W / 2);
    h.dispose();
    live = null;

    const cropped = await imageDoc(
      withSelection(() => ({
        width: W,
        height: W,
        coverage: new Uint8Array(W * W).fill(255),
      })),
    );
    await expect(
      cropped.objects.invoke(FILTER, {
        layer: L,
        params: INVERT,
        selection: true,
      }),
    ).rejects.toThrow(/16×16 image, the canvas is 16×12: another crop/);
  });
});

lane("filterRegion's polygons: a fill rule and ops", () => {
  // An outer square (1,1)–(15,11) and an inner one (5,3)–(11,9).
  const outer = [
    [1, 1],
    [15, 1],
    [15, 11],
    [1, 11],
  ];
  const inner = [
    [5, 3],
    [11, 3],
    [11, 9],
    [5, 9],
  ];
  const innerReversed = [...inner].reverse();
  const inOuter = (x: number, y: number) =>
    x >= 1 && x < 15 && y >= 1 && y < 11;
  const inInner = (x: number, y: number) => x >= 5 && x < 11 && y >= 3 && y < 9;

  async function filtered(mask: Record<string, unknown>) {
    const h = await imageDoc();
    const before = await shown(h);
    const r = await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      mask,
    });
    expect(r).toMatchObject({ applied: true, undoSteps: 1 });
    const after = await shown(h);
    h.dispose();
    live = null;
    return (x: number, y: number) => differs(before, after, x, y);
  }

  it("evenodd cuts a hole with an inner polygon; without a rule the polygons union", async () => {
    covers("command:media.paged.image.command.filterRegion");
    const ring = await filtered({
      polygons: [outer, inner],
      fillRule: "evenodd",
    });
    for (const [x, y] of where(() => true))
      expect(ring(x, y), `(${x}, ${y})`).toBe(inOuter(x, y) && !inInner(x, y));
    const union = await filtered({ polygons: [outer, inner] });
    for (const [x, y] of where(() => true))
      expect(union(x, y), `(${x}, ${y})`).toBe(inOuter(x, y));
  });

  it("nonzero cuts a hole where the inner polygon winds the other way", async () => {
    const same = await filtered({
      polygons: [outer, inner],
      fillRule: "nonzero",
    });
    expect(same(7, 5)).toBe(true);
    const opposite = await filtered({
      polygons: [outer, innerReversed],
      fillRule: "nonzero",
    });
    for (const [x, y] of where(() => true))
      expect(opposite(x, y), `(${x}, ${y})`).toBe(
        inOuter(x, y) && !inInner(x, y),
      );
  });

  it("ops: subtract cuts, intersect keeps the overlap, and the engine computes the same", async () => {
    const cut = await filtered({
      polygons: [outer, inner],
      ops: ["add", "subtract"],
    });
    for (const [x, y] of where(() => true))
      expect(cut(x, y), `(${x}, ${y})`).toBe(inOuter(x, y) && !inInner(x, y));
    const kept = await filtered({
      polygons: [outer, inner],
      ops: ["add", "intersect"],
    });
    for (const [x, y] of where(() => true))
      expect(kept(x, y), `(${x}, ${y})`).toBe(inInner(x, y));
    // Subtract alone starts from the whole canvas.
    const allBut = await filtered({ polygons: [inner], ops: ["subtract"] });
    for (const [x, y] of where(() => true))
      expect(allBut(x, y), `(${x}, ${y})`).toBe(!inInner(x, y));

    const h = await imageDoc();
    await h.objects.invoke(FILTER, {
      layer: L,
      params: INVERT,
      mask: { polygons: [outer, inner], fillRule: "evenodd" },
    });
    const direct = await engine.filterRegion(
      stripes(),
      W,
      H,
      invertWire(),
      { x: 0, y: 0, w: W, h: H },
      {
        polygons: [outer, inner] as Array<Array<[number, number]>>,
        fillRule: "evenodd",
      },
    );
    expect(Buffer.from(await shown(h)).equals(Buffer.from(direct))).toBe(true);
  });

  it("refuses with a reason: ops of the wrong length or word, a fill rule without polygons or of another name", async () => {
    const h = await imageDoc();
    const refuse = (mask: unknown) =>
      h.objects.invoke(FILTER, { layer: L, params: INVERT, mask });
    await expect(
      refuse({ polygons: [outer, inner], ops: ["add"] }),
    ).rejects.toThrow(/one op per polygon \(2\)/);
    await expect(refuse({ polygons: [outer], ops: ["xor"] })).rejects.toThrow(
      /add|subtract|intersect/,
    );
    await expect(
      refuse({ polygons: [outer], fillRule: "winding" }),
    ).rejects.toThrow(/nonzero|evenodd/);
    await expect(
      refuse({ alpha: new Uint8Array(W * H).fill(255), fillRule: "evenodd" }),
    ).rejects.toThrow(/fillRule needs polygons/);
  });
});
