/*
 * This file is part of paged (https://paged.media).
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

// The page side of the slide transition lane: bundled with the shader
// library (Bun.build) and served on a blank page. It owns the WebGPU device,
// the two test slides, frame read-back, PNG encoding and GPU timing; the
// test (slide-transitions.gpu.test.ts) drives it through
// `window.slideTransitions` and does the comparing.

import {
  GPU_FLAGS as F,
  createTransitionRenderer,
  type CompileReport,
  type TransitionShaderRenderer,
} from "../../../modules/slide/packages/slide-bundle/src/show/shaders/index.ts";

const FORMAT: GPUTextureFormat = "rgba8unorm";

export interface InitResult {
  ok: boolean;
  reason?: string;
  adapter?: string;
  timestamps: boolean;
}

export interface Harness {
  init(): Promise<InitResult>;
  compileAll(): Promise<CompileReport[]>;
  /** The two test slides at w × h, RGBA, base64. */
  slides(w: number, h: number): { from: string; to: string };
  /** One frame per progress value, RGBA, base64. */
  render(
    kind: string,
    params: Record<string, number>,
    progress: number[],
    w: number,
    h: number,
  ): Promise<string[]>;
  png(rgba: string, w: number, h: number): Promise<string>;
  unpng(png: string): Promise<{ rgba: string; w: number; h: number }>;
  /** GPU milliseconds of `frames` renders at w × h (timestamp queries). */
  time(
    kind: string,
    params: Record<string, number>,
    w: number,
    h: number,
    frames: number,
  ): Promise<number[]>;
}

declare global {
  interface Window {
    slideTransitions: Harness;
  }
}

let device: GPUDevice | null = null;
let renderer: TransitionShaderRenderer | null = null;
let timestamps = false;
const slideCache = new Map<
  string,
  {
    from: GPUTexture;
    to: GPUTexture;
    bytes: { from: Uint8Array; to: Uint8Array };
  }
>();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The outgoing slide: a red → blue gradient across, with a light diagonal
 *  band; the incoming one: a green → amber gradient down, with a checker. */
function slideBytes(
  w: number,
  h: number,
): { from: Uint8Array; to: Uint8Array } {
  const from = new Uint8Array(w * h * 4);
  const to = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const fx = x / Math.max(1, w - 1);
      const fy = y / Math.max(1, h - 1);
      const band = Math.abs(x / w - y / h) < 0.08;
      from[i] = band ? 235 : Math.round(230 * (1 - fx) + 20);
      from[i + 1] = band ? 235 : 30;
      from[i + 2] = band ? 235 : Math.round(230 * fx + 20);
      from[i + 3] = 255;
      const check =
        (Math.floor((x * 8) / w) + Math.floor((y * 6) / h)) % 2 === 0
          ? 1
          : 0.65;
      to[i] = Math.round((40 + 200 * fy) * check);
      to[i + 1] = Math.round(190 * check);
      to[i + 2] = Math.round(50 * check);
      to[i + 3] = 255;
    }
  }
  return { from, to };
}

function slides(w: number, h: number) {
  const key = `${w}x${h}`;
  let s = slideCache.get(key);
  if (!s) {
    const bytes = slideBytes(w, h);
    const tex = (data: Uint8Array) => {
      const t = device!.createTexture({
        size: [w, h],
        format: FORMAT,
        usage: F.textureBinding | F.textureCopyDst,
      });
      device!.queue.writeTexture({ texture: t }, data, { bytesPerRow: w * 4 }, [
        w,
        h,
      ]);
      return t;
    };
    s = { from: tex(bytes.from), to: tex(bytes.to), bytes };
    slideCache.set(key, s);
  }
  return s;
}

async function readTexture(
  t: GPUTexture,
  w: number,
  h: number,
): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  const buf = device!.createBuffer({
    size: bytesPerRow * h,
    usage: F.bufferCopyDst | F.bufferMapRead,
  });
  const enc = device!.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: t }, { buffer: buf, bytesPerRow }, [w, h]);
  device!.queue.submit([enc.finish()]);
  await buf.mapAsync(F.mapRead);
  const src = new Uint8Array(buf.getMappedRange());
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    out.set(src.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
  buf.unmap();
  buf.destroy();
  return out;
}

window.slideTransitions = {
  async init() {
    if (!("gpu" in navigator))
      return {
        ok: false,
        reason: "navigator.gpu is missing",
        timestamps: false,
      };
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter)
      return { ok: false, reason: "no WebGPU adapter", timestamps: false };
    timestamps = adapter.features.has("timestamp-query");
    device = await adapter.requestDevice({
      requiredFeatures: timestamps ? ["timestamp-query"] : [],
    });
    renderer = createTransitionRenderer(device, FORMAT);
    const info = adapter.info;
    return {
      ok: true,
      adapter: `${info.vendor} ${info.architecture} ${info.description}`.trim(),
      timestamps,
    };
  },

  compileAll() {
    return renderer!.prepare();
  },

  slides(w, h) {
    const s = slides(w, h);
    return { from: b64(s.bytes.from), to: b64(s.bytes.to) };
  },

  async render(kind, params, progress, w, h) {
    const s = slides(w, h);
    const target = device!.createTexture({
      size: [w, h],
      format: FORMAT,
      usage: F.textureRenderAttachment | F.textureCopySrc,
    });
    const out: string[] = [];
    for (const p of progress) {
      renderer!.render({
        kind,
        from: s.from,
        to: s.to,
        progress: p,
        params: { time: 0, ...params },
        target: target.createView(),
      });
      out.push(b64(await readTexture(target, w, h)));
    }
    target.destroy();
    return out;
  },

  async png(rgba, w, h) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(unb64(rgba)), w, h),
      0,
      0,
    );
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return b64(new Uint8Array(await blob.arrayBuffer()));
  },

  async unpng(png) {
    const bmp = await createImageBitmap(
      new Blob([unb64(png)], { type: "image/png" }),
      {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      },
    );
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return {
      rgba: b64(new Uint8Array(data.buffer)),
      w: bmp.width,
      h: bmp.height,
    };
  },

  async time(kind, params, w, h, frames) {
    if (!timestamps) return [];
    const s = slides(w, h);
    const target = device!.createTexture({
      size: [w, h],
      format: FORMAT,
      usage: F.textureRenderAttachment,
    });
    const querySet = device!.createQuerySet({
      type: "timestamp",
      count: frames * 2,
    });
    const resolve = device!.createBuffer({
      size: frames * 16,
      usage: F.bufferQueryResolve | F.bufferCopySrc,
    });
    const read = device!.createBuffer({
      size: frames * 16,
      usage: F.bufferCopyDst | F.bufferMapRead,
    });
    const view = target.createView();
    // Warm up: the first frame compiles the pipeline, and a sustained burst
    // lets the GPU leave its idle clocks before anything is timed (Apple
    // GPUs ramp their clock with load; a cold measurement reads 5-15x slow).
    for (let i = 0; i < 200; i++) {
      renderer!.render({
        kind,
        from: s.from,
        to: s.to,
        progress: (i + 0.5) / 200,
        params: { time: 0, ...params },
        target: view,
      });
    }
    for (let i = 0; i < frames; i++) {
      renderer!.render({
        kind,
        from: s.from,
        to: s.to,
        progress: (i + 0.5) / frames,
        params: { time: 0, ...params },
        target: view,
        timestampWrites: {
          querySet,
          beginningOfPassWriteIndex: i * 2,
          endOfPassWriteIndex: i * 2 + 1,
        },
      });
    }
    const enc = device!.createCommandEncoder();
    enc.resolveQuerySet(querySet, 0, frames * 2, resolve, 0);
    enc.copyBufferToBuffer(resolve, 0, read, 0, frames * 16);
    device!.queue.submit([enc.finish()]);
    await read.mapAsync(F.mapRead);
    const t = new BigUint64Array(read.getMappedRange());
    const ms: number[] = [];
    for (let i = 0; i < frames; i++)
      ms.push(Number(t[i * 2 + 1]! - t[i * 2]!) / 1e6);
    read.unmap();
    for (const b of [resolve, read]) b.destroy();
    querySet.destroy();
    target.destroy();
    return ms;
  },
};
