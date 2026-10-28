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

// The animation layer compositor on WebGPU (slide ADR 714): `layer.wgsl`
// draws each layer of an animated slide as a quad, moved, faded, recoloured
// and cut by PowerPoint's animation filters, on the show's device (the same
// one the transitions run on, ADR 721). The WGSL comes from
// sources.generated.ts (`bun run gen:shaders`).

import type { RenderRect } from "@paged-media/plugin-api";

import type { Box } from "../../anim/model.js";
import type { DrawState, MaskState } from "../scene.js";
import { EFFECT_SOURCES } from "./sources.generated.ts";

export { EFFECT_SOURCES };

/** `layer.wgsl`'s filter kinds. */
export const FILTER_CODES: Readonly<Record<string, number>> = {
  fade: 1,
  wipe: 2,
  barn: 3,
  blinds: 4,
  box: 5,
  checkerboard: 6,
  circle: 7,
  diamond: 8,
  dissolve: 9,
  plus: 10,
  randombar: 11,
  slide: 12,
  strips: 13,
  wedge: 14,
  wheel: 15,
};

/** Each filter's options (the parenthesised part of `wipe(down)`) as the
 *  shader's `sub` code. */
const SUB_CODES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  wipe: { left: 1, right: 2, up: 3, down: 4 },
  barn: { inVertical: 1, inHorizontal: 2, outVertical: 3, outHorizontal: 4 },
  blinds: { horizontal: 1, vertical: 2 },
  randombar: { horizontal: 1, vertical: 2 },
  checkerboard: { across: 1, down: 2 },
  box: { in: 1, out: 2 },
  circle: { in: 1, out: 2 },
  diamond: { in: 1, out: 2 },
  plus: { in: 1, out: 2 },
  slide: { fromTop: 1, fromBottom: 2, fromLeft: 3, fromRight: 4 },
  strips: { downLeft: 1, upLeft: 2, downRight: 3, upRight: 4 },
};

/** A filter as the shader's (kind, sub): unknown filters fade (a filter
 *  this library does not draw still brings its target in and out). */
export function filterCode(
  filter: string,
  sub: string | null,
): { kind: number; sub: number } {
  const name = filter.toLowerCase();
  const kind = FILTER_CODES[name] ?? FILTER_CODES.fade;
  if (name === "wheel") return { kind, sub: Math.max(1, Number(sub) || 1) };
  const table = SUB_CODES[name];
  if (!table) return { kind, sub: 0 };
  return { kind, sub: (sub && table[sub]) || Object.values(table)[0] };
}

/** Bytes of one layer's uniforms (ten vec4f), and the stride its slot takes
 *  in the shared buffer (WebGPU's minimum uniform offset alignment). */
export const LAYER_UNIFORM_BYTES = 160;
export const LAYER_UNIFORM_STRIDE = 256;

const rgb = (hex: string | null): [number, number, number] | null => {
  const m = hex ? /^#?([0-9a-f]{6})$/i.exec(hex) : null;
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

const maskVec = (m: MaskState | undefined): [number[], number[]] => {
  if (!m)
    return [
      [0, 0, 0, 0],
      [0, 0, 1, 1],
    ];
  const c = filterCode(m.filter, m.sub);
  return [
    [c.kind, c.sub, m.progress, m.out ? 1 : 0],
    [m.box.x, m.box.y, Math.max(m.box.w, 1e-3), Math.max(m.box.h, 1e-3)],
  ];
};

/** One layer's uniforms (`layer.wgsl`'s `Layer`). */
export function layerUniforms(
  region: RenderRect,
  state: DrawState,
  slide: [number, number],
  seed = 0,
): Float32Array {
  const [a, b, c, d, e, f] = state.matrix;
  const tint = rgb(state.tint);
  const [f0, b0] = maskVec(state.masks[0]);
  const [f1, b1] = maskVec(state.masks[1]);
  return new Float32Array([
    a,
    b,
    c,
    d,
    e,
    f,
    0,
    0,
    region.x,
    region.y,
    region.width,
    region.height,
    slide[0],
    slide[1],
    0,
    0,
    state.visible ? state.opacity : 0,
    tint ? 1 : 0,
    0,
    seed,
    ...(tint ?? [0, 0, 0]),
    1,
    ...f0,
    ...b0,
    ...f1,
    ...b1,
  ]);
}

/** A layer to draw: its texture, the page region it covers and how. */
export interface LayerDraw {
  texture: GPUTexture;
  region: RenderRect;
  state: DrawState;
}

export interface LayerRenderer {
  /** Draw `layers` (bottom first) over `clear` into `target`, the slide
   *  (`slide` pt) filling it. */
  render(
    target: GPUTextureView,
    slide: [number, number],
    layers: readonly LayerDraw[],
    clear?: [number, number, number, number],
  ): void;
  destroy(): void;
}

/** The compositor on `device`, drawing into textures of `format`. */
export function createLayerRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
): LayerRenderer {
  const module = device.createShaderModule({
    label: "slide layer compositor",
    code: EFFECT_SOURCES.layer,
  });
  const layout = device.createBindGroupLayout({
    entries: [
      // FRAGMENT = 2, VERTEX = 1 (GPUShaderStage, which the DOM lib does
      // not declare as a value).
      { binding: 0, visibility: 2, sampler: {} },
      { binding: 1, visibility: 2, texture: {} },
      {
        binding: 2,
        visibility: 3,
        buffer: { type: "uniform", hasDynamicOffset: true },
      },
    ],
  });
  const pipeline = device.createRenderPipeline({
    label: "slide layer compositor",
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: "vs_layer" },
    fragment: {
      module,
      entryPoint: "fs_layer",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });
  let buffer: GPUBuffer | null = null;
  let slots = 0;
  const cache = new Map<GPUTexture, GPUBindGroup>();
  let groupBuffer: GPUBuffer | null = null;

  const ensure = (n: number) => {
    if (buffer && slots >= n) return;
    buffer?.destroy();
    slots = Math.max(16, n * 2);
    // UNIFORM | COPY_DST.
    buffer = device.createBuffer({
      size: slots * LAYER_UNIFORM_STRIDE,
      usage: 0x40 | 0x08,
    });
  };

  const groupOf = (texture: GPUTexture): GPUBindGroup => {
    if (groupBuffer !== buffer) {
      // A new buffer: every cached bind group names the old one.
      groupBuffer = buffer;
      cache.clear();
    }
    let g = cache.get(texture);
    if (!g) {
      g = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: texture.createView() },
          {
            binding: 2,
            resource: { buffer: buffer!, size: LAYER_UNIFORM_BYTES },
          },
        ],
      });
      cache.set(texture, g);
    }
    return g;
  };

  return {
    render(target, slide, layers, clear = [0, 0, 0, 1]) {
      ensure(layers.length);
      const data = new Float32Array((layers.length * LAYER_UNIFORM_STRIDE) / 4);
      layers.forEach((l, i) => {
        data.set(
          layerUniforms(l.region, l.state, slide, i + 1),
          (i * LAYER_UNIFORM_STRIDE) / 4,
        );
      });
      if (layers.length) device.queue.writeBuffer(buffer!, 0, data);
      const enc = device.createCommandEncoder({ label: "slide layers" });
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: target,
            clearValue: { r: clear[0], g: clear[1], b: clear[2], a: clear[3] },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      layers.forEach((l, i) => {
        if (!l.state.visible || l.state.opacity <= 0) return;
        pass.setBindGroup(0, groupOf(l.texture), [i * LAYER_UNIFORM_STRIDE]);
        pass.draw(6);
      });
      pass.end();
      device.queue.submit([enc.finish()]);
      // Bind groups name textures the caller may destroy: keep the cache
      // to one frame's.
      for (const t of [...cache.keys()])
        if (!layers.some((l) => l.texture === t)) cache.delete(t);
    },
    destroy() {
      buffer?.destroy();
      buffer = null;
      cache.clear();
    },
  };
}

/** A box as a RenderRect. */
export const rectOf = (b: Box): RenderRect => ({
  x: b.x,
  y: b.y,
  width: b.w,
  height: b.h,
});
