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

// The show drawn offline, one frame at a time (slide ADR 720, editor ADR
// 308): the same slide frames (frames.ts) and the same WGSL transitions
// (transition-renderer.ts, ADR 721) as the live show, but at a size and a
// moment the caller names instead of the screen's and the clock's. The
// video export steps it at a fixed frame rate and hands each frame to the
// encoder.
//
// The seam for animations (wave 5): `slide` takes the slide's background
// frame today; per-item layers at a time `t` plug in here as an optional
// argument without changing the callers that draw whole slides.

import type { Frame } from "./frames.js";
import {
  transitionRendererFactory,
  type TransitionRenderer,
} from "./transition-renderer.js";

/** Where frames are drawn: a canvas the encoder can take a VideoFrame of. */
export type FrameCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface OfflineRenderer {
  /** The canvas each call draws into (width × height). */
  readonly canvas: FrameCanvas;
  /** Whether transitions run on the GPU (false: they cut). */
  readonly gpu: boolean;
  /** Draw a slide, filling the frame. */
  slide(frame: Frame | null): void;
  /** Draw `kind` from one slide to the next at `progress` (0…1). False
   *  when no shader ran (no WebGPU, an unknown kind): `to` was drawn. */
  transition(
    from: Frame,
    to: Frame,
    kind: string,
    progress: number,
    params?: Record<string, number>,
  ): Promise<boolean>;
  dispose(): void;
}

function makeCanvas(width: number, height: number): FrameCanvas {
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

interface Gpu {
  device: GPUDevice;
  renderer: TransitionRenderer;
  canvas: OffscreenCanvas;
  context: GPUCanvasContext;
  textures: Map<Frame, GPUTexture>;
}

async function makeGpu(width: number, height: number): Promise<Gpu | null> {
  const nav = (globalThis as { navigator?: Navigator & { gpu?: GPU } })
    .navigator;
  if (!nav?.gpu || typeof OffscreenCanvas === "undefined") return null;
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const format = nav.gpu.getPreferredCanvasFormat();
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext(
      "webgpu",
    ) as unknown as GPUCanvasContext | null;
    if (!context) return null;
    context.configure({ device, format, alphaMode: "opaque" });
    const renderer = transitionRendererFactory()(device, format);
    await (renderer as { prepare?: () => Promise<unknown> }).prepare?.();
    return { device, renderer, canvas, context, textures: new Map() };
  } catch {
    return null;
  }
}

/** An offline renderer of `width × height` pixels. */
export async function createOfflineRenderer(
  width: number,
  height: number,
  opts: { gpu?: boolean } = {},
): Promise<OfflineRenderer> {
  const canvas = makeCanvas(width, height);
  const g = canvas.getContext("2d") as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!g) throw new Error("no 2D canvas to draw the video's frames on");
  const gpu = opts.gpu === false ? null : await makeGpu(width, height);

  const fill = (frame: Frame | CanvasImageSource | null) => {
    g.globalAlpha = 1;
    g.fillStyle = "#000";
    g.fillRect(0, 0, width, height);
    if (frame) g.drawImage(frame as CanvasImageSource, 0, 0, width, height);
  };

  const texture = (frame: Frame): GPUTexture => {
    const hit = gpu!.textures.get(frame);
    if (hit) return hit;
    const tex = gpu!.device.createTexture({
      size: [frame.width, frame.height],
      format: "rgba8unorm",
      // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT.
      usage: 0x04 | 0x02 | 0x10,
    });
    gpu!.device.queue.copyExternalImageToTexture(
      { source: frame },
      { texture: tex },
      [frame.width, frame.height],
    );
    // Two slides are in play at a time; older textures go.
    if (gpu!.textures.size >= 2) {
      const [old, t] = gpu!.textures.entries().next().value as [
        Frame,
        GPUTexture,
      ];
      t.destroy();
      gpu!.textures.delete(old);
    }
    gpu!.textures.set(frame, tex);
    return tex;
  };

  return {
    canvas,
    gpu: gpu !== null,
    slide: fill,
    async transition(from, to, kind, progress, params = {}) {
      if (!gpu || !gpu.renderer.supports(kind)) {
        fill(to);
        return false;
      }
      gpu.renderer.render({
        kind,
        from: texture(from),
        to: texture(to),
        progress: Math.max(0, Math.min(1, progress)),
        params,
        target: gpu.context.getCurrentTexture().createView(),
      });
      const bitmap = gpu.canvas.transferToImageBitmap();
      fill(bitmap);
      bitmap.close();
      return true;
    },
    dispose() {
      if (!gpu) return;
      for (const t of gpu.textures.values()) t.destroy();
      gpu.textures.clear();
      gpu.device.destroy();
    },
  };
}
