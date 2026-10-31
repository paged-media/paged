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
// transition runs on WebGPU through the TransitionRenderer (the WGSL shader
// library, transition-renderer.ts, ADR 721): a GPU canvas over the slide's
// box shows it while it runs. A device without WebGPU gets a plain cut, and
// the show is told once (`onNoGpu`) so it can say so.

import type { SlideAnimation } from "./animation.js";
import { createLayerRenderer, type LayerRenderer } from "./effects/index.js";
import type { Frame } from "./frames.js";
import { drawScene2d } from "./scene-2d.js";
import type { SlideScene } from "./scene-source.js";
import {
  resolveShowTransition,
  transitionDurationMs,
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
  /** Show an animated slide (slide ADR 714): its layers composited each
   *  frame from `anim`, on WebGPU where the device has it, else Canvas2D.
   *  A transition into it runs to the slide's first state. */
  showAnimated(
    anim: SlideAnimation,
    aspect: number,
    transition?: ShowSlide["transition"],
  ): void;
  /** The animation changed (a click, a step): draw its frames again. */
  kick(): void;
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
  layers: LayerRenderer | null;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
}

export interface CompositorOptions {
  /** A transition was asked for and the device has no WebGPU (once). */
  onNoGpu?(): void;
}

export function createCompositor(
  container: HTMLElement,
  win: Window,
  opts: CompositorOptions = {},
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
  let gpuMissing = false;
  let toldNoGpu = false;

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
    if (!nav.gpu) {
      gpuMissing = true;
      return (gpuPending = Promise.resolve(null));
    }
    gpuPending = (async () => {
      try {
        const adapter = await nav.gpu!.requestAdapter();
        if (!adapter) {
          gpuMissing = true;
          return null;
        }
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
        const renderer = factory(device, format);
        let layers: LayerRenderer | null = null;
        try {
          layers = createLayerRenderer(device, format);
        } catch {
          // The 2D compositor draws animated slides instead.
        }
        // Compile every pipeline now, so the first transition does not
        // wait for its shader.
        void (renderer as { prepare?: () => Promise<unknown> })
          .prepare?.()
          .catch(() => {});
        gpu = { device, format, renderer, layers, canvas: surface, context };
        return gpu;
      } catch {
        gpuMissing = true;
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

  // ---- animated slides (slide ADR 714)
  let animated: SlideAnimation | null = null;
  let animFrame = 0;
  let sceneTextures: { scene: SlideScene; textures: GPUTexture[] } | null =
    null;

  const dropTextures = () => {
    for (const t of sceneTextures?.textures ?? []) t.destroy();
    sceneTextures = null;
  };

  const texturesOf = (device: GPUDevice, scene: SlideScene): GPUTexture[] => {
    if (sceneTextures?.scene === scene) return sceneTextures.textures;
    dropTextures();
    const textures = [
      scene.background,
      ...scene.layers.map((l) => l.image),
    ].map((img) => texture(device, img));
    sceneTextures = { scene, textures };
    return textures;
  };

  /** The animated slide's state now, as an image (a transition's ends). */
  const still = (a: SlideAnimation): Frame | null => {
    const OC = (win as unknown as { OffscreenCanvas?: typeof OffscreenCanvas })
      .OffscreenCanvas;
    const scene = a.scene;
    if (!OC) return scene.background;
    const [w, h] = scene.sizePt;
    const c = new OC(
      Math.max(1, Math.round(w * scene.scale)),
      Math.max(1, Math.round(h * scene.scale)),
    );
    const g = c.getContext("2d");
    if (!g) return scene.background;
    g.setTransform(scene.scale, 0, 0, scene.scale, 0, 0);
    drawScene2d(g, scene, a.draws().states);
    return c.transferToImageBitmap();
  };

  /** Draw the animated slide now; true while something moves. */
  const drawAnimated = (): boolean => {
    const a = animated;
    if (!a || blankColor) return false;
    const { states, running } = a.draws();
    const scene = a.scene;
    if (gpu?.layers) {
      const { dpr } = size();
      const b = box();
      Object.assign(gpu.canvas.style, {
        display: "block",
        left: `${b.x}px`,
        top: `${b.y}px`,
        width: `${b.width}px`,
        height: `${b.height}px`,
      });
      const pw = Math.max(1, Math.round(b.width * dpr));
      const ph = Math.max(1, Math.round(b.height * dpr));
      if (gpu.canvas.width !== pw) gpu.canvas.width = pw;
      if (gpu.canvas.height !== ph) gpu.canvas.height = ph;
      const textures = texturesOf(gpu.device, scene);
      const [w, h] = scene.sizePt;
      gpu.layers.render(
        gpu.context.getCurrentTexture().createView(),
        scene.sizePt,
        [
          {
            texture: textures[0],
            region: { x: 0, y: 0, width: w, height: h },
            state: {
              visible: true,
              opacity: 1,
              matrix: [1, 0, 0, 1, 0, 0],
              masks: [],
              tint: null,
            },
          },
          ...scene.layers.map((l, i) => ({
            texture: textures[i + 1],
            region: l.region,
            state: states[i],
          })),
        ],
      );
      container.dataset.animation = "gpu";
    } else if (g) {
      const { w, h, dpr } = size();
      if (canvas.width !== Math.round(w * dpr))
        canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr))
        canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = "#000";
      g.fillRect(0, 0, w, h);
      const b = letterbox(aspect, w, h);
      const k = b.width / scene.sizePt[0];
      g.setTransform(dpr * k, 0, 0, dpr * k, dpr * b.x, dpr * b.y);
      drawScene2d(g, scene, states);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      container.dataset.animation = "2d";
    }
    container.dataset.animationRunning = running ? "true" : "false";
    // What the frame shows of the animated layers (tests, diagnostics).
    container.dataset.visibleLayers = String(
      scene.layers.filter(
        (l, i) => l.target && states[i]?.visible && states[i].opacity > 0,
      ).length,
    );
    return running;
  };

  const loop = () => {
    animFrame = 0;
    if (drawAnimated()) animFrame = win.requestAnimationFrame(loop);
  };

  const stopAnimated = () => {
    if (animFrame) win.cancelAnimationFrame(animFrame);
    animFrame = 0;
    if (animated) {
      // What was up stays the outgoing frame of the next transition.
      current = still(animated);
    }
    animated = null;
    dropTextures();
    delete container.dataset.animation;
    delete container.dataset.animationRunning;
    delete container.dataset.visibleLayers;
  };

  return {
    showAnimated(next, a, transition) {
      if (anim) win.cancelAnimationFrame(anim);
      anim = 0;
      stopAnimated();
      if (gpu) gpu.canvas.style.display = "none";
      aspect = a > 0 ? a : aspect;
      const from = current;
      const to = still(next);
      current = to;
      const resolved = resolveShowTransition(transition);
      const durationMs = transition ? transitionDurationMs(transition) : 0;
      const start = () => {
        animated = next;
        loop();
      };
      if (from && to && resolved && durationMs > 0 && !blankColor) {
        if (
          gpuTransition(
            from,
            to,
            resolved.kind,
            durationMs,
            resolved.params,
            start,
          )
        ) {
          container.dataset.transition = `gpu:${resolved.kind}`;
          paint(null, from, 1);
          return;
        }
        if (gpuMissing && !toldNoGpu) {
          toldNoGpu = true;
          opts.onNoGpu?.();
        }
      }
      paint(null, to, 1);
      start();
    },
    kick() {
      if (animated && !animFrame) loop();
    },
    show(frame, a, transition) {
      if (anim) win.cancelAnimationFrame(anim);
      anim = 0;
      stopAnimated();
      if (gpu) gpu.canvas.style.display = "none";
      const from = current;
      current = frame;
      aspect = a > 0 ? a : aspect;
      const resolved = resolveShowTransition(transition);
      const durationMs = transition ? transitionDurationMs(transition) : 0;
      if (!from || !frame || !resolved || durationMs <= 0 || blankColor) {
        paint(null, frame, 1);
        return;
      }
      // What the last transition was drawn with (tests and diagnostics).
      container.dataset.transition = "cut";
      // The outgoing slide stays on the 2D canvas under the GPU's.
      const finish = () => paint(null, frame, 1);
      if (
        gpuTransition(
          from,
          frame,
          resolved.kind,
          durationMs,
          resolved.params,
          finish,
        )
      ) {
        container.dataset.transition = `gpu:${resolved.kind}`;
        paint(null, from, 1);
        return;
      }
      // No shader ran: a plain cut, and the show hears once why when the
      // device has no WebGPU.
      if (gpuMissing && !toldNoGpu) {
        toldNoGpu = true;
        opts.onNoGpu?.();
      }
      if (gpuMissing) container.dataset.transition = "cut:no-webgpu";
      paint(null, frame, 1);
    },
    blank(color) {
      blankColor = color;
      if (anim) win.cancelAnimationFrame(anim);
      anim = 0;
      if (gpu && color) gpu.canvas.style.display = "none";
      paint(null, current, 1);
      if (!color && animated) loop();
    },
    box,
    resize() {
      paint(null, current, 1);
      if (animated) drawAnimated();
    },
    dispose() {
      if (anim) win.cancelAnimationFrame(anim);
      if (animFrame) win.cancelAnimationFrame(animFrame);
      animated = null;
      dropTextures();
      gpu?.layers?.destroy();
      canvas.remove();
      gpu?.canvas.remove();
      gpu?.device.destroy();
      gpu = null;
    },
  };
}
