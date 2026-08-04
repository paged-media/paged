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

// The IMAGE TRACE engine facade — a typed shape over the `trace-js`
// wasm-bindgen surface (crates/trace-js), which wraps `draw-trace`, which
// wraps `visioncortex`. The rest of the bundle codes against THIS, so the
// wasm boundary has exactly one call site and the conformance spec can
// boot the real artifact in Node.
//
// WHY THERE IS RUST IN A TS-ONLY REPO AT ALL. Everything else here is
// pure TS on purpose. Image Trace's kernel is not path algebra but
// computer vision — hierarchical colour clustering, boundary walking,
// curve fitting — and `visioncortex` (MIT/Apache-2.0; the library under
// vtracer) is a mature implementation of exactly that. The plugin
// contract already carries `capabilities.wasm[]`, and paged.image /
// paged.sheet / paged.data all ship wasm, so this is the established
// shape rather than a new one. See crates/draw-trace's module docs for
// the scope and the caps.
//
// BOOT (the paged.image / paged.sheet pattern, BREAKAGE I-07). The
// artifact is the wasm-bindgen `--target web` glue that
// scripts/build-wasm.sh writes into `packages/draw-bundle/wasm/` — the
// SAME directory the manifest declares under `capabilities.wasm[]`
// (`wasm/trace_js_bg.wasm`, manifest-relative) and the same one this file
// imports. One copy: paged.image ships two and they drifted. We do NOT
// use the host's `loadBundleWasm` (a raw module with no wbindgen
// imports); the glue loads in the BUNDLE REALM.
//
// THIS MODULE MUST STAY AT `src/` DEPTH 1. tsup emits a FLAT `dist/`, so
// `../wasm/…` is the only relative path that resolves both from
// `src/trace-engine.ts` and from `dist/index.js`.
//
// BLOCKING — MEASURED, not estimated, because the first estimate here was
// wrong by two orders of magnitude. `trace()` is synchronous and
// CPU-bound and runs on the thread that calls it: in the editor, the MAIN
// (UI) thread. Nothing is interruptible once it starts. Timings on an
// M-series laptop, release wasm, default options:
//
//   flat / smooth artwork      2048×2048   0.3 – 0.8 s
//   line art (1 025 clusters)  2048×2048   0.6 s
//   photo-ish, light noise     2048×2048   0.8 s
//   photo-ish, HEAVY noise     1024×1024   6.3 s
//   photo-ish, HEAVY noise     2048×2048  41   s   ← the worst case seen
//
// The cost is the hierarchical CLUSTERING pass, so it scales with how
// many colour clusters the image has, not with how much geometry comes
// out: `filterSpeckle` cuts the region count 6× and the time by 2 %.
// A noisy photograph is therefore the pathological input, and 41 s of
// frozen UI is not acceptable — which is why the DEFAULT trace budget
// (`maxTracePixels`, below) is 1 MP rather than the kernel's 4 MP
// refusal cap, and why the command warns before a long one. Moving the
// call behind `host.workers` is the real fix and is a named v1 step, not
// a claim about today.

/** Trace parameters. Every field is optional; omitted ones take the
 *  documented v0 default (see `TRACE_DEFAULTS`, mirrored from the Rust
 *  `TraceOptions::default`). */
export interface TraceOptions {
  /** `"color"` = hierarchical colour clustering (default);
   *  `"bw"` = one luminance threshold. */
  mode?: "color" | "bw";
  /** `"spline"` = curve-fitted cubics (default); `"polygon"` = corners. */
  pathMode?: "spline" | "polygon";
  /** Bits of colour kept when deciding "same colour", 1–8. Default 6. */
  colorPrecision?: number;
  /** Clusters smaller than this many PIXELS are dropped. Default 4. */
  filterSpeckle?: number;
  /** Colour distance that splits a new layer (|ΔR|+|ΔG|+|ΔB|). Default 16. */
  layerDifference?: number;
  /** B&W luminance split, 0–255. Default 128. */
  bwThreshold?: number;
  /** Drop the paper. Default true. See the Rust docs — in colour mode it
   *  is a heuristic (every channel ≥ 250). */
  ignoreWhite?: boolean;
  /** Degrees above which a turn stays a corner. Default 60. */
  cornerThresholdDeg?: number;
  /** Shortest subdivided segment, px. Default 4. */
  segmentLength?: number;
  /** Degrees above which the fitter splices a new curve. Default 45. */
  spliceThresholdDeg?: number;
  /** Smoothing iteration ceiling. Default 10. */
  maxIterations?: number;
  /** Hard ceiling on emitted regions; the surplus is dropped and
   *  reported. Default 512. */
  maxRegions?: number;
  /** Stacked regions instead of cut-out ones. Default false. */
  stacked?: boolean;
  /**
   * DECODER-side pixel budget — **not a kernel knob**; `trace()` strips
   * it before crossing into the wasm, which has never heard of it.
   *
   * The placed image is downsampled to at most this many pixels BEFORE
   * tracing. Default [`DEFAULT_TRACE_PIXELS`] = 1 MP, which keeps the
   * measured worst case (a noisy photograph) around 6 s rather than the
   * 41 s a 4 MP one costs — see the module header's table. The kernel's
   * own `maxPixels` is a REFUSAL four times higher; this is the practical
   * default under it, and it is clamped to it.
   *
   * Raise it deliberately, on artwork you know is flat.
   */
  maxTracePixels?: number;
}

/** The default DECODE budget: 1 MP. Not the kernel's cap (4 MP, a hard
 *  refusal) — the resolution a trace actually runs at unless the caller
 *  asks for more. Chosen from the measured timings in the module header. */
export const DEFAULT_TRACE_PIXELS = 1_048_576;

/** The v0 defaults, mirrored from `draw_trace::TraceOptions::default` —
 *  the Rust side is the source of truth and applies them itself; this is
 *  what the UI/logs quote. Pinned against the real engine in the
 *  conformance spec. */
export const TRACE_DEFAULTS: Required<TraceOptions> = {
  mode: "color",
  pathMode: "spline",
  colorPrecision: 6,
  filterSpeckle: 4,
  layerDifference: 16,
  bwThreshold: 128,
  ignoreWhite: true,
  cornerThresholdDeg: 60,
  segmentLength: 4,
  spliceThresholdDeg: 45,
  maxIterations: 10,
  maxRegions: 512,
  stacked: false,
  maxTracePixels: DEFAULT_TRACE_PIXELS,
};

/** One cubic path point, pixel space — the engine's wire shape. */
export interface TraceAnchor {
  anchor: [number, number];
  left: [number, number];
  right: [number, number];
}

/** One closed contour. `area`'s SIGN is the walked winding; the
 *  authoritative hole orientation is applied by draw-geometry's
 *  `orientForNonZeroHoles` on the way to the document. */
export interface TraceContour {
  anchors: TraceAnchor[];
  area: number;
}

/** One traced region: `contours[0]` is the outer boundary, the rest are
 *  holes. */
export interface TraceRegion {
  /** Straight sRGB 0–255. No alpha — a document swatch has none. */
  color: [number, number, number];
  /** Cluster area in pixels. */
  pixels: number;
  contours: TraceContour[];
}

/** A completed trace, in PIXEL space (origin top-left, +y down). */
export interface TraceResult {
  width: number;
  height: number;
  /** Largest first. */
  regions: TraceRegion[];
  /** Clusters found before the speckle filter and the region cap. */
  clusters: number;
  /** Regions dropped by `maxRegions` — non-zero means INCOMPLETE. */
  truncated: number;
  /** Regions dropped by `filterSpeckle`. */
  speckles: number;
}

/** The kernel's hard caps. Read FROM the wasm so the decoder's
 *  downsample target and the tracer's refusal threshold cannot drift. */
export interface TraceLimits {
  maxDimension: number;
  maxPixels: number;
}

/** The EFFECTIVE decode budget: the caller's `maxTracePixels` clamped to
 *  the kernel's hard cap (which it may never exceed). Pure, so the
 *  conformance spec pins the clamp rather than trusting it. */
export function traceBudget(
  limits: TraceLimits,
  maxTracePixels?: number,
): TraceLimits {
  const wanted =
    typeof maxTracePixels === "number" && Number.isFinite(maxTracePixels)
      ? Math.max(1, Math.floor(maxTracePixels))
      : DEFAULT_TRACE_PIXELS;
  return {
    maxDimension: limits.maxDimension,
    maxPixels: Math.min(limits.maxPixels, wanted),
  };
}

/** The typed facade the bundle codes against. */
export interface TraceEngine {
  limits(): TraceLimits;
  /** Synchronous and CPU-bound — see the module header on blocking.
   *  Throws with the kernel's own message on a refusal (over-cap raster,
   *  short buffer). */
  trace(
    pixels: Uint8Array,
    width: number,
    height: number,
    options?: TraceOptions,
  ): TraceResult;
}

/** Thrown (as the message) when the wasm artifact has not been built.
 *  `scripts/build-wasm.sh` is the fix; the artifact is committed, so this
 *  should only be seen mid-rebuild. */
export const TRACE_ENGINE_NOT_BUILT =
  "paged.draw trace engine wasm not built — run scripts/build-wasm.sh";

interface TraceWasmModule {
  default: (init?: unknown) => Promise<unknown>;
  initSync: (init: unknown) => unknown;
  traceInit: () => void;
  traceLimits: () => string;
  traceRgba: (
    pixels: Uint8Array,
    width: number,
    height: number,
    optionsJson: string,
  ) => string;
}

const isNode = (): boolean =>
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

let cached: Promise<TraceEngine> | null = null;

/** Load + instantiate the trace wasm, browser vs Node (the paged.image
 *  `loadModule` shape). Rejects with `TRACE_ENGINE_NOT_BUILT` when the
 *  artifact is absent. */
async function loadModule(): Promise<TraceWasmModule> {
  let mod: TraceWasmModule;
  try {
    // @ts-ignore — the artifact is generated by scripts/build-wasm.sh;
    // typed by TraceWasmModule above rather than by its own .d.ts, so a
    // fresh checkout typechecks before it builds.
    mod = (await import("../wasm/trace_js.js")) as TraceWasmModule;
  } catch (cause) {
    throw new Error(TRACE_ENGINE_NOT_BUILT, { cause });
  }
  if (isNode()) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve("../wasm/trace_js_bg.wasm");
    const bytes = await readFile(
      wasmPath.startsWith("file:") ? fileURLToPath(wasmPath) : wasmPath,
    );
    mod.initSync({
      module: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    });
  } else {
    // Browser: resolve the artifact through the bundler's explicit `?url`
    // import (the editor's wasm convention — a bare relative URL resolves
    // against the served module path and gets the dev server's HTML
    // fallback, the "expected magic word" trap).
    // @ts-ignore — `?url` is a bundler affordance, untyped.
    const wasmUrl = (await import(
      // @ts-ignore — see above.
      "../wasm/trace_js_bg.wasm?url"
    )) as { default: string };
    await mod.default({ module_or_path: wasmUrl.default });
  }
  mod.traceInit();
  return mod;
}

/** Wrap a loaded module in the typed facade. Exported for the
 *  conformance spec, which asserts the JSON boundary shape directly. */
export function wrapTraceEngine(mod: TraceWasmModule): TraceEngine {
  return {
    limits() {
      return JSON.parse(mod.traceLimits()) as TraceLimits;
    },
    trace(pixels, width, height, options) {
      // `maxTracePixels` is a DECODER knob; the kernel has never heard of
      // it, so it is stripped here rather than smuggled across as an
      // ignored field.
      let payload = "{}";
      if (options) {
        const { maxTracePixels: _decodeOnly, ...kernel } = options;
        payload = JSON.stringify(kernel);
      }
      const json = mod.traceRgba(pixels, width, height, payload);
      return JSON.parse(json) as TraceResult;
    },
  };
}

/** Boot (once) and return the trace engine. The instance is cached for
 *  the lifetime of the bundle — instantiating the module per trace would
 *  dominate the cost of a small one. */
export function bootTraceEngine(): Promise<TraceEngine> {
  cached ??= loadModule()
    .then(wrapTraceEngine)
    .catch((err) => {
      cached = null;
      throw err;
    });
  return cached;
}
