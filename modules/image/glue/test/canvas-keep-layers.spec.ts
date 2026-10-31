// Image ▸ Crop and Image Size keep the layer stack (WP5.1): the commit
// runs over the whole stack on the SAME engine handle, as one undo step
// on top of the history that was there, and a crop deselects. Over the
// real engine wasm in Node, where an exact crop of a stack whose
// composite is trivial needs no device; the resampling verbs decline
// honestly here and leave the stack as it was (their pixels are pinned
// by the Rust GPU tests of `LayerStack::transform_canvas_gpu`).

import { describe, expect, it } from "bun:test";

import { createBundleHost } from "@paged-media/plugin-sdk";
import type { PluginManifest } from "@paged-media/plugin-api";
import manifestJson from "@paged-media/image-manifest/manifest.json";

import { createImageSession } from "../src/session";
import {
  makeFakeEditor,
  mapBacking,
  psdBytes,
  shellStub,
  silentConsole,
} from "./helpers";

async function layered() {
  const fake = makeFakeEditor();
  const handle = createBundleHost(
    () => fake.editor,
    manifestJson as PluginManifest,
    {
      console: silentConsole,
      storage: mapBacking(),
      shell: shellStub(),
    },
  );
  const session = createImageSession(handle.host);
  // psdBytes(): a 2×1 image, left (10,30,50), right (20,40,60).
  expect(await session.importBytes("k.psd", psdBytes())).toBe(true);
  // An empty layer on top: two layers, and a composite that is still
  // the background alone (so no device is needed to recomposite).
  expect(await session.addLayer("top")).toBe(true);
  expect(session.state().layers.layers).toHaveLength(2);
  return {
    session,
    dispose() {
      session.dispose();
      handle.dispose();
    },
  };
}

const steps = (s: ReturnType<typeof createImageSession>) => [
  ...(s.state().history?.undoSteps ?? []),
];

describe("Canvas ops keep the layers: Crop and Image Size", () => {
  it("a crop keeps every layer, is one undo step and deselects", async () => {
    const k = await layered();
    const { session } = k;
    const handleBefore = session.state().source!.handle;
    const before = steps(session);
    expect(session.selectAll()).toBe(true);
    expect(session.state().selection).not.toBeNull();

    // Drag the right edge in: crop to the left pixel.
    const machine = session.cropMachine()!;
    machine.pointerDown([2, 0.5]);
    machine.pointerMove([1, 0.5]);
    machine.pointerUp();
    expect(await session.commitCrop()).toBe(true);

    const src = session.state().source!;
    expect(src).toMatchObject({ width: 1, height: 1 });
    expect(src.handle).toBe(handleBefore); // in place, no handle swap
    expect(session.state().layers.layers).toHaveLength(2);
    // The Select All before it is a step of its own (ADR 470).
    expect(steps(session)).toEqual([...before, "Select All", "Crop"]);
    expect(session.state().selection).toBeNull(); // a crop deselects
    expect(
      session.sampleColor([0, 0])!.map((v) => Math.round(v * 255)),
    ).toEqual([10, 30, 50, 255]);

    // Undo restores the extent; the layers were never lost.
    expect(await session.undo()).toBe(true);
    expect(session.state().source).toMatchObject({ width: 2, height: 1 });
    expect(session.state().layers.layers).toHaveLength(2);
    expect(steps(session)).toEqual([...before, "Select All"]);
    // …and the selection the crop dropped comes back with it.
    expect(session.state().selection).not.toBeNull();
    k.dispose();
  });

  it("a refused Image Size leaves the stack and its history alone", async () => {
    const k = await layered();
    const { session } = k;
    const before = steps(session);
    expect(session.state().gpu).toBe(false);
    expect(await session.resizeTo(4, 2, "lanczos3")).toBe(false);
    expect(session.state().status).toMatch(/GPU-only|init_gpu/);
    expect(session.state().source).toMatchObject({ width: 2, height: 1 });
    expect(session.state().layers.layers).toHaveLength(2);
    expect(steps(session)).toEqual(before);
    k.dispose();
  });

  it("a straighten is refused without a device and changes nothing", async () => {
    const k = await layered();
    const { session } = k;
    const before = steps(session);
    session.cropMachine()!.setAngle(5);
    expect(await session.commitCrop()).toBe(false);
    expect(session.state().status).toMatch(/GPU-only|init_gpu/);
    expect(session.state().layers.layers).toHaveLength(2);
    expect(steps(session)).toEqual(before);
    k.dispose();
  });
});
