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

// Draws the show (slide ADR 716): the slide up, letterboxed on black, the
// blank screens, and the transition from one slide to the next. A
// transition runs on WebGPU through the registered TransitionRenderer
// (transition-renderer.ts, ADR 721) when there is one and the device has
// WebGPU: a GPU canvas over the slide's box shows it while it runs.
// Otherwise the 2D canvas cross-fades fade-like kinds and cuts the rest,
// so a show runs everywhere (a device without WebGPU gets a plain cut).

import type { Frame } from "./frames.js";
import {
  FADE_LIKE,
  transitionDurationMs,
  transitionKind,
  transitionParams,
  transitionRendererFactory,
  type TransitionRenderer,
} from "./transition-renderer.js";
import type { ShowSlide } from "./show-model.js";

export interface SlideBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a slide of `aspect` (width / height) sits in a `w × h` box. */
export function letterbox(aspect: number, w: number, h: number): SlideBox {
  if (!(aspect > 0) || !(w > 0) || !(h > 0))
    return { x: 0, y: 0, width: w, height: h };
  const width = Math.min(w, h * aspect);
  const height = width / aspect;
  return { x: (w - width) / 2, y: (h - height) / 2, width, height };
}

export interface Compositor {
  /** Show `frame` (a slide of `aspect`), through `transition` when one is
   *  given and a frame was up before. */
  show(
    frame: Frame | null,
    aspect: number,
    transition?: ShowSlide["transition"],
  ): void;
  /** Cover the slide with black or white, or uncover it. */
  blank(color: "black" | "white" | null): void;
  /** The slide's box in CSS px within the container. */
  box(): SlideBox;
  /** The container changed size. */
  resize(): void;
  dispose(): void;
}

interface Gpu {
  device: GPUDevice;
  format: GPUTextureFormat;
  renderer: TransitionRenderer;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
}

export function createCompositor(
  container: HTMLElement,
  win: Window,
): Compositor {
  const doc = container.ownerDocument;
  const canvas = doc.createElement("canvas");
  canvas.setAttribute("data-show-canvas", "");
  Object.assign(canvas.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
  });
  container.appendChild(canvas);
  const g = canvas.getContext("2d");

  let current: Frame | null = null;
  let aspect = 16 / 9;
  let blankColor: "black" | "white" | null = null;
  let anim = 0;
  let gpu: Gpu | null = null;
  let gpuPending: Promise<Gpu | null> | null = null;

  const size = () => {
    const dpr = win.devicePixelRatio || 1;
    const w = container.clientWidth || win.innerWidth || 0;
    const h = container.clientHeight || win.innerHeight || 0;
    return { w, h, dpr };
  };

  const box = (): SlideBox => {
    const { w, h } = size();
    return letterbox(aspect, w, h);
  };

  const paint = (from: Frame | null, to: Frame | null, p: number) => {
    if (!g) return;
    const { w, h, dpr } = size();
    if (canvas.width !== Math.round(w * dpr))
      canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr))
      canvas.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = "#000";
    g.fillRect(0, 0, w, h);
    const b = letterbox(aspect, w, h);
    if (blankColor) {
      g.fillStyle = blankColor === "white" ? "#fff" : "#000";
      g.fillRect(0, 0, w, h);
      return;
    }
    if (from && p < 1) g.drawImage(from, b.x, b.y, b.width, b.height);
    if (to) {
      g.globalAlpha = from ? p : 1;
      g.drawImage(to, b.x, b.y, b.width, b.height);
      g.globalAlpha = 1;
    }
  };

  const initGpu = (): Promise<Gpu | null> => {
    if (gpuPending) return gpuPending;
    const factory = transitionRendererFactory();
    const nav = win.navigator as Navigator & { gpu?: GPU };
    if (!factory || !nav.gpu) return (gpuPending = Promise.resolve(null));
    gpuPending = (async () => {
      try {
        const adapter = await nav.gpu!.requestAdapter();
        if (!adapter) return null;
        const device = await adapter.requestDevice();
        const format = nav.gpu!.getPreferredCanvasFormat();
        const surface = doc.createElement("canvas");
        surface.setAttribute("data-show-gpu", "");
        Object.assign(surface.style, {
          position: "absolute",
          display: "none",
        });
        container.appendChild(surface);
        const context = surface.getContext(
          "webgpu",
        ) as unknown as GPUCanvasContext | null;
        if (!context) return null;
        context.configure({ device, format, alphaMode: "opaque" });
        gpu = {
          device,
          format,
          renderer: factory(device, format),
          canvas: surface,
          context,
        };
        return gpu;
      } catch {
        return null;
      }
    })();
    return gpuPending;
  };
  // Start the device early: the first transition should not wait for it.
  void initGpu();

  const texture = (device: GPUDevice, frame: Frame): GPUTexture => {
    const tex = device.createTexture({
      size: [frame.width, frame.height],
      format: "rgba8unorm",
      // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT (the GPUTextureUsage
      // flags; the DOM lib does not declare the namespace).
      usage: 0x04 | 0x02 | 0x10,
    });
    device.queue.copyExternalImageToTexture(
      { source: frame },
      { texture: tex },
      [frame.width, frame.height],
    );
    return tex;
  };

  /** Run the transition on the GPU; false when it cannot. */
  const gpuTransition = (
    from: Frame,
    to: Frame,
    kind: string,
    durationMs: number,
    params: Record<string, number>,
    done: () => void,
  ): boolean => {
    if (!gpu || !gpu.renderer.supports(kind)) return false;
    const { device, renderer, canvas: surface, context } = gpu;
    const { dpr } = size();
    const b = box();
    Object.assign(surface.style, {
      display: "block",
      left: `${b.x}px`,
      top: `${b.y}px`,
      width: `${b.width}px`,
      height: `${b.height}px`,
    });
    surface.width = Math.max(1, Math.round(b.width * dpr));
    surface.height = Math.max(1, Math.round(b.height * dpr));
    const a = texture(device, from);
    const z = texture(device, to);
    const start = win.performance.now();
    const step = () => {
      const p = Math.min(1, (win.performance.now() - start) / durationMs);
      renderer.render({
        kind,
        from: a,
        to: z,
        progress: p,
        params,
        target: context.getCurrentTexture().createView(),
      });
      if (p < 1) {
        anim = win.requestAnimationFrame(step);
      } else {
        surface.style.display = "none";
        a.destroy();
        z.destroy();
        done();
      }
    };
    anim = win.requestAnimationFrame(step);
    return true;
  };

  return {
    show(frame, a, transition) {
      if (anim) win.cancelAnimationFrame(anim);
      anim = 0;
      if (gpu) gpu.canvas.style.display = "none";
      const from = current;
      current = frame;
      aspect = a > 0 ? a : aspect;
      const kind = transitionKind(transition?.kind);
      const durationMs = transition ? transitionDurationMs(transition) : 0;
      if (!from || !frame || !kind || durationMs <= 0 || blankColor) {
        paint(null, frame, 1);
        return;
      }
      // The outgoing slide stays on the 2D canvas under the GPU's.
      const finish = () => paint(null, frame, 1);
      if (
        gpuTransition(
          from,
          frame,
          kind,
          durationMs,
          transitionParams(transition?.dir),
          finish,
        )
      ) {
        paint(null, from, 1);
        return;
      }
      if (!FADE_LIKE.has(kind)) {
        paint(null, frame, 1);
        return;
      }
      const start = win.performance.now();
      const step = () => {
        const p = Math.min(1, (win.performance.now() - start) / durationMs);
        paint(from, frame, p);
        anim = p < 1 ? win.requestAnimationFrame(step) : 0;
      };
      step();
    },
    blank(color) {
      blankColor = color;
      if (anim) win.cancelAnimationFrame(anim);
      anim = 0;
      paint(null, current, 1);
    },
    box,
    resize() {
      paint(null, current, 1);
    },
    dispose() {
      if (anim) win.cancelAnimationFrame(anim);
      canvas.remove();
      gpu?.canvas.remove();
      gpu?.device.destroy();
      gpu = null;
    },
  };
}
