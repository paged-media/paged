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

// The slide transition shader library (slide ADR 721): every PowerPoint
// transition as a WGSL fragment shader over two slide textures.
//
// - `_prelude.wgsl` declares the bindings, the Uniforms block and shared
//   helpers; `_fullscreen.wgsl` the vertex stage. A transition file starts
//   with `// #include "_prelude.wgsl"` (and may include another `_*.wgsl`
//   library); `assembleShader` splices them in.
// - `manifest.json` maps each PowerPoint transition id (`p:push`,
//   `p14:vortex`, `p15:prstTrans` presets, …) to a shader, its passes and the
//   XML attributes that set its parameters.
// - `createTransitionRenderer` compiles pipelines lazily on the caller's
//   device and draws one frame per `render` call. Multi-pass shaders
//   ping-pong through two textures: pass k > 0 reads pass k-1 as `from`.
//
// The WGSL comes from sources.generated.ts (`bun run gen:shaders`), so no
// bundler affordance is needed.

import manifestJson from "./manifest.json" with { type: "json" };
import { SHADER_SOURCES } from "./sources.generated.ts";

/** One frame of a transition (the show runtime's `TransitionRenderer`
 *  contract, `show/transition-renderer.ts`). */
export interface TransitionRenderOptions {
  /** A PowerPoint kind (`push`, `p14:vortex`), or a resolved key from
   *  `resolveTransition` (`prstTrans:curtains`). */
  kind: string;
  from: GPUTexture;
  to: GPUTexture;
  /** 0 → 1. */
  progress: number;
  /** Named shader parameters (manifest `params`), plus `direction` (a
   *  manifest `directions` code), `time` (seconds) and, for `random`,
   *  `seed`. Missing ones take the transition's defaults. */
  params?: Record<string, number>;
  target: GPUTextureView;
  /** GPU timing (tests, profiling): written around all passes. */
  timestampWrites?: GPURenderPassTimestampWrites;
}

export interface TransitionRenderer {
  supports(kind: string): boolean;
  render(opts: TransitionRenderOptions): void;
}

export interface CompileReport {
  shader: string;
  errors: string[];
  warnings: string[];
}

/** The renderer plus the extras tests and warm-up use. */
export interface TransitionShaderRenderer extends TransitionRenderer {
  /** Compiles every pipeline (or the named shaders') and reports WGSL
   *  diagnostics and pipeline validation errors. */
  prepare(shaders?: string[]): Promise<CompileReport[]>;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// The manifest

export interface ParamSpec {
  slot: number;
  default: number;
}

export interface ShaderSpec {
  passes: string[];
  params: Record<string, ParamSpec>;
  approximation?: string;
}

export interface AttributeSpec {
  param: string;
  type: "bool" | "enum" | "number";
  values?: Record<string, number>;
  default?: string;
}

export interface TransitionSpec {
  kind: string;
  shader: string | null;
  dir?: { values: string[]; default: string };
  attributes?: Record<string, AttributeSpec>;
  preset?: {
    attribute: string;
    default: string;
    values: Record<string, string>;
  };
  random?: string[];
  instant?: boolean;
  approximation?: string;
  note?: string;
}

export interface TransitionManifest {
  version: number;
  directions: Record<string, number>;
  shaders: Record<string, ShaderSpec>;
  transitions: Record<string, TransitionSpec>;
}

export const TRANSITION_MANIFEST =
  manifestJson as unknown as TransitionManifest;
export { SHADER_SOURCES };

const BY_KIND = new Map<string, TransitionSpec>(
  Object.values(TRANSITION_MANIFEST.transitions).map((t) => [t.kind, t]),
);

const INCLUDE = /^\/\/ #include "([^"]+)\.wgsl"\s*$/gm;

/** A transition file with its includes spliced in and the vertex stage
 *  appended: what goes to `createShaderModule`. */
export function assembleShader(name: string, sources = SHADER_SOURCES): string {
  const body = sources[name];
  if (body === undefined) throw new Error(`no shader ${name}.wgsl`);
  const seen = new Set<string>();
  const libs: string[] = [];
  const own = body.replace(INCLUDE, (_m, lib: string) => {
    if (!seen.has(lib)) {
      seen.add(lib);
      const src = sources[lib];
      if (src === undefined)
        throw new Error(`${name}.wgsl includes missing ${lib}.wgsl`);
      libs.push(src);
    }
    return "";
  });
  if (!seen.has("_prelude"))
    throw new Error(`${name}.wgsl does not include _prelude.wgsl`);
  return [...libs, sources._fullscreen ?? "", own].join("\n");
}

interface Target {
  shader: ShaderSpec;
  spec: TransitionSpec;
  /** The concrete key (a random pick resolved). */
  key: string;
}

function bareKind(kind: string): string {
  const i = kind.indexOf(":");
  // `p14:vortex` → `vortex`; `prstTrans:curtains` stays (a resolved preset).
  if (i > 0 && /^p\d*$/.test(kind.slice(0, i))) return kind.slice(i + 1);
  return kind;
}

function lookup(kind: string, seed = 0): Target | null {
  const k = bareKind(kind);
  const [base, preset] = k.split(":", 2) as [string, string | undefined];
  const spec = BY_KIND.get(base);
  if (!spec) return null;
  if (spec.random) {
    const pool = spec.random;
    const pick = pool[Math.abs(Math.floor(seed)) % pool.length] ?? "fade";
    return seed ? lookup(pick) : lookup("fade");
  }
  let shaderName = spec.shader;
  if (spec.preset) {
    shaderName = spec.preset.values[preset ?? spec.preset.default] ?? null;
  }
  if (!shaderName) return null;
  const shader = TRANSITION_MANIFEST.shaders[shaderName];
  return shader ? { shader, spec, key: k } : null;
}

/** The resolved form of a deck transition: the key and parameters to pass
 *  to `render`. */
export interface ResolvedTransition {
  kind: string;
  params: Record<string, number>;
  /** Set when the shader is an approximation of PowerPoint's effect. */
  approximation?: string;
}

/** The attributes on the effect element `<p:kind …>` / `<p14:kind …>`. */
export function effectAttributes(
  xml: string,
  kind: string,
): Record<string, string> {
  const el = new RegExp(`<(?:[A-Za-z0-9]+:)?${kind}\\b([^>]*)>`).exec(xml);
  const out: Record<string, string> = {};
  if (!el) return out;
  for (const m of (el[1] ?? "").matchAll(
    /(?:[A-Za-z0-9]+:)?([A-Za-z0-9]+)="([^"]*)"/g,
  )) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

function attrValue(a: AttributeSpec, raw: string): number | null {
  switch (a.type) {
    case "bool":
      return raw === "1" || raw === "true" ? 1 : 0;
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "enum":
      return a.values?.[raw] ?? null;
  }
}

/**
 * A deck transition (pptx-core `Transition`: its kind, `dir` and the element
 * XML that carries the other attributes) as a render key and parameters.
 * `null` for no transition or a kind with no shader.
 */
export function resolveTransition(t: {
  kind: string | null | undefined;
  dir?: string | null;
  xml?: string | null;
}): ResolvedTransition | null {
  if (!t.kind) return null;
  const spec = BY_KIND.get(bareKind(t.kind));
  if (!spec) return null;
  const attrs = t.xml ? effectAttributes(t.xml, spec.kind) : {};
  let key = spec.kind;
  if (spec.preset) {
    const p = attrs[spec.preset.attribute] ?? spec.preset.default;
    key = `${spec.kind}:${spec.preset.values[p] ? p : spec.preset.default}`;
  }
  const target = lookup(key);
  if (!target) return null;
  const params: Record<string, number> = {};
  const dir = t.dir ?? attrs.dir;
  if (spec.dir) {
    const d = dir && spec.dir.values.includes(dir) ? dir : spec.dir.default;
    params.direction = TRANSITION_MANIFEST.directions[d] ?? 0;
  }
  for (const [name, a] of Object.entries(spec.attributes ?? {})) {
    const raw = attrs[name] ?? a.default;
    if (raw === undefined) continue;
    const v = attrValue(a, raw);
    if (v !== null) params[a.param] = v;
  }
  const approximation = spec.approximation ?? target.shader.approximation;
  return approximation
    ? { kind: key, params, approximation }
    : { kind: key, params };
}

/** Every key `render` accepts for a concrete shader: plain kinds and
 *  `prstTrans:<preset>` (tests iterate these). */
export function renderKinds(): string[] {
  const out: string[] = [];
  for (const spec of Object.values(TRANSITION_MANIFEST.transitions)) {
    if (spec.preset) {
      for (const p of Object.keys(spec.preset.values))
        out.push(`${spec.kind}:${p}`);
    } else if (spec.shader) {
      out.push(spec.kind);
    }
  }
  return out;
}

/** Default parameters of a render key (its dir default and attribute
 *  defaults), as `resolveTransition` would give them without XML. */
const DEFAULTS = new Map<string, Record<string, number>>();

export function defaultParams(kind: string): Record<string, number> {
  let d = DEFAULTS.get(kind);
  if (!d) {
    d = computeDefaults(kind);
    DEFAULTS.set(kind, d);
  }
  return d;
}

function computeDefaults(kind: string): Record<string, number> {
  const [base, preset] = bareKind(kind).split(":", 2) as [
    string,
    string | undefined,
  ];
  const spec = BY_KIND.get(base);
  if (!spec) return {};
  const xml =
    preset && spec.preset
      ? `<p15:${base} ${spec.preset.attribute}="${preset}"/>`
      : null;
  return resolveTransition({ kind: base, xml })?.params ?? {};
}

// ---------------------------------------------------------------------------
// The renderer

const UNIFORM_BYTES = 64;

/** WebGPU's flag values (fixed by the specification). TypeScript's DOM lib
 *  declares the GPU interfaces but not these namespace objects, and the
 *  bundle must not depend on them existing at module load either. */
export const GPU_FLAGS = {
  shaderFragment: 0x2,
  bufferMapRead: 0x1,
  bufferCopySrc: 0x4,
  bufferCopyDst: 0x8,
  bufferUniform: 0x40,
  bufferQueryResolve: 0x200,
  textureCopySrc: 0x1,
  textureCopyDst: 0x2,
  textureBinding: 0x4,
  textureRenderAttachment: 0x10,
  mapRead: 0x1,
} as const;

export function createTransitionRenderer(
  device: GPUDevice,
  format: GPUTextureFormat,
): TransitionShaderRenderer {
  const bindGroupLayout = device.createBindGroupLayout({
    label: "slide-transition",
    entries: [
      {
        binding: 0,
        visibility: GPU_FLAGS.shaderFragment,
        sampler: { type: "filtering" },
      },
      {
        binding: 1,
        visibility: GPU_FLAGS.shaderFragment,
        texture: { sampleType: "float" },
      },
      {
        binding: 2,
        visibility: GPU_FLAGS.shaderFragment,
        texture: { sampleType: "float" },
      },
      {
        binding: 3,
        visibility: GPU_FLAGS.shaderFragment,
        buffer: { type: "uniform" },
      },
    ],
  });
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const uniforms = device.createBuffer({
    label: "slide-transition uniforms",
    size: UNIFORM_BYTES,
    usage: GPU_FLAGS.bufferUniform | GPU_FLAGS.bufferCopyDst,
  });
  const staging = new ArrayBuffer(UNIFORM_BYTES);
  const f32 = new Float32Array(staging);
  const u32 = new Uint32Array(staging);
  const pipelines = new Map<string, GPURenderPipeline>();
  const modules = new Map<string, GPUShaderModule>();
  let ping: GPUTexture[] = [];

  const moduleFor = (pass: string): GPUShaderModule => {
    let m = modules.get(pass);
    if (!m) {
      m = device.createShaderModule({
        label: `slide-transition ${pass}`,
        code: assembleShader(pass),
      });
      modules.set(pass, m);
    }
    return m;
  };

  const descriptor = (pass: string): GPURenderPipelineDescriptor => {
    const module = moduleFor(pass);
    return {
      label: `slide-transition ${pass}`,
      layout,
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    };
  };

  const pipelineFor = (pass: string): GPURenderPipeline => {
    let p = pipelines.get(pass);
    if (!p) {
      p = device.createRenderPipeline(descriptor(pass));
      pipelines.set(pass, p);
    }
    return p;
  };

  const pingPong = (w: number, h: number): GPUTexture[] => {
    if (ping.length && ping[0]!.width === w && ping[0]!.height === h)
      return ping;
    for (const t of ping) t.destroy();
    ping = [0, 1].map((i) =>
      device.createTexture({
        label: `slide-transition ping ${i}`,
        size: [w, h],
        format,
        usage: GPU_FLAGS.textureRenderAttachment | GPU_FLAGS.textureBinding,
      }),
    );
    return ping;
  };

  return {
    supports(kind) {
      return lookup(kind) !== null;
    },

    render(opts) {
      const params = opts.params ?? {};
      const target = lookup(opts.kind, params.seed ?? 0);
      if (!target) throw new Error(`no transition shader for ${opts.kind}`);
      const defaults = defaultParams(target.key);
      f32.fill(0);
      f32[0] = Math.min(1, Math.max(0, opts.progress));
      f32[1] = params.time ?? performance.now() / 1000;
      f32[2] = opts.from.width;
      f32[3] = opts.from.height;
      u32[4] = params.direction ?? defaults.direction ?? 0;
      for (const [name, spec] of Object.entries(target.shader.params)) {
        f32[8 + spec.slot] = params[name] ?? defaults[name] ?? spec.default;
      }
      device.queue.writeBuffer(uniforms, 0, staging);

      const passes = target.shader.passes;
      const pp =
        passes.length > 1 ? pingPong(opts.from.width, opts.from.height) : [];
      const toView = opts.to.createView();
      let input = opts.from.createView();
      const encoder = device.createCommandEncoder({
        label: `slide-transition ${opts.kind}`,
      });
      passes.forEach((pass, i) => {
        const last = i === passes.length - 1;
        const out = last ? opts.target : pp[i % 2]!.createView();
        const bindGroup = device.createBindGroup({
          layout: bindGroupLayout,
          entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: input },
            { binding: 2, resource: toView },
            { binding: 3, resource: { buffer: uniforms } },
          ],
        });
        const tw = opts.timestampWrites;
        const timestampWrites: GPURenderPassTimestampWrites | undefined = tw
          ? {
              querySet: tw.querySet,
              ...(i === 0 && tw.beginningOfPassWriteIndex !== undefined
                ? { beginningOfPassWriteIndex: tw.beginningOfPassWriteIndex }
                : {}),
              ...(last && tw.endOfPassWriteIndex !== undefined
                ? { endOfPassWriteIndex: tw.endOfPassWriteIndex }
                : {}),
            }
          : undefined;
        const rp = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: out,
              loadOp: "clear",
              storeOp: "store",
              clearValue: [0, 0, 0, 1],
            },
          ],
          ...(timestampWrites &&
          (timestampWrites.beginningOfPassWriteIndex !== undefined ||
            timestampWrites.endOfPassWriteIndex !== undefined)
            ? { timestampWrites }
            : {}),
        });
        rp.setPipeline(pipelineFor(pass));
        rp.setBindGroup(0, bindGroup);
        rp.draw(3);
        rp.end();
        if (!last) input = pp[i % 2]!.createView();
      });
      device.queue.submit([encoder.finish()]);
    },

    async prepare(shaders) {
      const names = shaders ?? Object.keys(TRANSITION_MANIFEST.shaders);
      const passes = [
        ...new Set(
          names.flatMap((n) => TRANSITION_MANIFEST.shaders[n]?.passes ?? [n]),
        ),
      ];
      const reports: CompileReport[] = [];
      for (const pass of passes) {
        const report: CompileReport = {
          shader: pass,
          errors: [],
          warnings: [],
        };
        device.pushErrorScope("validation");
        const module = moduleFor(pass);
        const info = await module.getCompilationInfo();
        for (const m of info.messages) {
          const line = `${pass}.wgsl (assembled) ${m.lineNum}:${m.linePos} ${m.message}`;
          if (m.type === "error") report.errors.push(line);
          else if (m.type === "warning") report.warnings.push(line);
        }
        try {
          const p = await device.createRenderPipelineAsync(descriptor(pass));
          pipelines.set(pass, p);
        } catch (e) {
          report.errors.push(`${pass}: ${(e as Error).message}`);
        }
        const err = await device.popErrorScope();
        if (err) report.errors.push(`${pass}: ${err.message}`);
        reports.push(report);
      }
      return reports;
    },

    destroy() {
      for (const t of ping) t.destroy();
      ping = [];
      uniforms.destroy();
      pipelines.clear();
      modules.clear();
    },
  };
}
