// THE FILTER DIALOG's flow (WP5.2): preview on the canvas, a change of
// values re-previews, OK keeps ONE undo step, Cancel restores, the
// before/after toggle, the proxy while values move, and the selection.
//
// Node has no WebGPU, so the filters' kernels cannot run here. The engine
// is the REAL image-js wasm with two stand-ins (installed only by this
// file): `initGpu` answers true, and the kernel doors the dialog calls
// (`applyEmboss`, `applyMotionBlur`) record their arguments and land a
// real, journaled change in the active layer — a horizontal flip, the
// exact CPU canvas op — so the undo, redo and recomposite paths the
// dialog drives are the engine's own. `resize` (the proxy) returns a
// CPU-made image of the asked size. What the kernels compute is proved in
// Rust; this file proves what the dialog asks of the engine and when.

import { describe, expect, it, mock } from "bun:test";
import { covers, importActual } from "@paged-media/test-kit";

import type { DecodedInfo, ImageEngine } from "../src/engine";
import {
  at,
  BLUE,
  bundleOnFake,
  quiesce,
  RED,
  sourcePixels,
} from "./command-kit";

interface Call {
  fn: string;
  bound: boolean;
  args: unknown[];
}
const stand = { calls: [] as Call[], resized: 0, proxy: [1, 1] };

const actualEngine = await importActual(() => import("../src/engine"));
mock.module("../src/engine", () => ({
  ...actualEngine,
  bootEngine: async (): Promise<ImageEngine> => {
    const e = await actualEngine.bootEngine();
    const kernel =
      (fn: string) =>
      async (handle: number, ...args: unknown[]): Promise<DecodedInfo> => {
        const bound = handle === e.layersBound();
        stand.calls.push({ fn, bound, args });
        if (bound) {
          const wh = await e.layersCanvasOp("flip-h");
          return {
            handle,
            width: wh.width,
            height: wh.height,
            display: "assumed-srgb",
            depthReduced: false,
          };
        }
        // The proxy: a new, flat image, as the engine's own doors return.
        const [w, h] = stand.proxy as [number, number];
        return e.ingestRgba8(w, h, e.tile(handle, 0, 0, w, h));
      };
    const overrides: Record<string, unknown> = {
      initGpu: async () => true,
      gpuReady: () => true,
      applyEmboss: kernel("applyEmboss"),
      applyMotionBlur: kernel("applyMotionBlur"),
      resize: async (_h: number, w: number, h: number) => {
        stand.resized += 1;
        stand.proxy = [w, h];
        return e.ingestRgba8(w, h, new Uint8Array(w * h * 4).fill(9));
      },
    };
    return new Proxy(e, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop in overrides)
          return overrides[prop];
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The bundle with the two-colour image (red | blue, 4×2) ingested. A
 *  `tinyFrame` lays it out at 1×1 pt, so the preview proxy is smaller
 *  than the image and the drag preview takes the proxy path. */
async function open(tinyFrame = false) {
  stand.calls = [];
  stand.resized = 0;
  const k = await bundleOnFake();
  if (tinyFrame)
    k.fake.geometry.set("u1", {
      id: { kind: "rectangle", id: "u1" } as never,
      pageId: "pg1",
      bounds: [0, 0, 1, 1],
    } as never);
  await k.ingest();
  expect(k.session.state().gpu).toBe(true);
  return k;
}

type K = Awaited<ReturnType<typeof open>>;
const depth = (k: K) => k.session.state().history?.depth ?? 0;
const flipped = async (k: K) => at(await sourcePixels(k.session), 0, 0);

describe("the Filter dialog", () => {
  it("previews on open, re-previews a change, and OK keeps ONE undo step", async () => {
    covers("command:media.paged.image.command.filterEmboss");
    const k = await open();
    expect(depth(k)).toBe(0);
    expect(await k.session.openFilterDialog("emboss")).toBe(true);
    // The preview IS the filter in the active layer, at the defaults.
    expect(stand.calls).toEqual([
      { fn: "applyEmboss", bound: true, args: [135, 1] },
    ]);
    expect(await flipped(k)).toEqual([...BLUE]);
    expect(depth(k)).toBe(1);
    // A change: the old preview step is taken back and the new one
    // applied — still one step.
    k.session.setFilterValues({ height: 3, angle: 45 });
    for (let i = 0; i < 100 && stand.calls.length < 2; i++) await sleep(5);
    await quiesce(k.session);
    expect(stand.calls[1]).toEqual({
      fn: "applyEmboss",
      bound: true,
      args: [45, 3],
    });
    expect(depth(k)).toBe(1);
    expect(await flipped(k)).toEqual([...BLUE]);
    // OK at the values already previewed runs nothing new.
    expect(await k.session.commitFilterDialog()).toBe(true);
    expect(stand.calls).toHaveLength(2);
    expect(k.session.state().dialog).toBeNull();
    expect(k.session.state().history?.undoSteps).toEqual(["Flip horizontal"]);
    expect(k.session.state().status).toMatch(/Emboss applied/);
    // The one step undoes to the image before the dialog.
    await k.session.undo();
    expect(await flipped(k)).toEqual([...RED]);
    expect(depth(k)).toBe(0);
    // Reopening starts from the values it was closed with.
    await k.session.openFilterDialog("emboss");
    const d = k.session.state().dialog;
    expect(d?.kind === "filter" && d.filter.values).toEqual({
      angle: 45,
      height: 3,
    });
    await k.session.cancelFilterDialog();
    k.dispose();
  });

  it("Cancel puts the image back as it was", async () => {
    const k = await open();
    await k.session.openFilterDialog("emboss");
    expect(await flipped(k)).toEqual([...BLUE]);
    expect(await k.session.cancelFilterDialog()).toBe(true);
    expect(k.session.state().dialog).toBeNull();
    expect(await flipped(k)).toEqual([...RED]);
    expect(depth(k)).toBe(0);
    expect(k.session.state().status).toMatch(/Emboss cancelled/);
    expect(k.docOps()).toEqual([]);
    k.dispose();
  });

  it("the before/after toggle and Preview take the filter off the canvas, and OK still applies", async () => {
    const k = await open();
    await k.session.openFilterDialog("emboss");
    await k.session.setFilterBefore(true);
    expect(await flipped(k)).toEqual([...RED]);
    expect(depth(k)).toBe(0);
    await k.session.setFilterBefore(false);
    expect(await flipped(k)).toEqual([...BLUE]);
    expect(depth(k)).toBe(1);
    await k.session.setFilterPreview(false);
    expect(await flipped(k)).toEqual([...RED]);
    expect(depth(k)).toBe(0);
    // OK applies what the dialog says, preview or not.
    expect(await k.session.commitFilterDialog()).toBe(true);
    expect(await flipped(k)).toEqual([...BLUE]);
    expect(depth(k)).toBe(1);
    k.dispose();
  });

  it("while values move the frame shows a proxy (px lengths scaled); full resolution follows at rest", async () => {
    covers("command:media.paged.image.command.filterMotionBlur");
    const k = await open(true);
    await k.session.openFilterDialog("motionBlur");
    expect(stand.resized).toBe(1);
    expect(stand.calls).toEqual([
      { fn: "applyMotionBlur", bound: true, args: [0, 24] },
    ]);
    const submits = k.fake.sceneLayers.submit.mock.calls.length;
    k.session.setFilterValues({ length: 40 });
    for (let i = 0; i < 100 && stand.calls.length < 2; i++) await sleep(5);
    // The proxy is half the image's width: 40 px becomes 20.
    expect(stand.calls[1]).toEqual({
      fn: "applyMotionBlur",
      bound: false,
      args: [0, 20],
    });
    // …and it went to the frame without touching the image.
    for (
      let i = 0;
      i < 100 && k.fake.sceneLayers.submit.mock.calls.length === submits;
      i++
    )
      await sleep(5);
    expect(k.fake.sceneLayers.submit.mock.calls.length).toBeGreaterThan(
      submits,
    );
    expect(depth(k)).toBe(1);
    // At rest: the full-resolution pass at the real value.
    for (let i = 0; i < 200 && stand.calls.length < 3; i++) await sleep(5);
    await quiesce(k.session);
    expect(stand.calls[2]).toEqual({
      fn: "applyMotionBlur",
      bound: true,
      args: [0, 40],
    });
    expect(depth(k)).toBe(1);
    expect(await k.session.commitFilterDialog()).toBe(true);
    expect(stand.calls).toHaveLength(3);
    k.dispose();
  });

  it("with a selection there is no proxy: the preview runs where the selection is bound, and the selection stays", async () => {
    const k = await open(true);
    expect(k.session.selectAll()).toBe(true);
    const sel = k.session.state().selection;
    expect(sel).not.toBeNull();
    await k.session.openFilterDialog("motionBlur");
    expect(stand.resized).toBe(0);
    k.session.setFilterValues({ length: 10 });
    for (let i = 0; i < 100 && stand.calls.length < 2; i++) await sleep(5);
    await quiesce(k.session);
    expect(stand.calls.every((c) => c.bound)).toBe(true);
    expect(stand.calls[1]!.args).toEqual([0, 10]);
    expect(await k.session.commitFilterDialog()).toBe(true);
    expect(k.session.state().selection).toEqual(sel);
    // Two steps: Select All (a selection change is a step, ADR 470) and
    // the filter.
    expect(depth(k)).toBe(2);
    k.dispose();
  });

  it("opening another dialog cancels the open filter first", async () => {
    const k = await open();
    await k.session.openFilterDialog("emboss");
    expect(depth(k)).toBe(1);
    await k.session.openFilterDialog("motionBlur");
    const d = k.session.state().dialog;
    expect(d?.kind === "filter" && d.filter.id).toBe("motionBlur");
    // Emboss's step went; motion blur's preview is the one step.
    expect(depth(k)).toBe(1);
    expect(stand.calls.map((c) => c.fn)).toEqual([
      "applyEmboss",
      "applyMotionBlur",
    ]);
    k.session.openDialog("trim");
    await quiesce(k.session);
    expect(k.session.state().dialog).toEqual({ kind: "trim" });
    expect(depth(k)).toBe(0);
    k.dispose();
  });
});
