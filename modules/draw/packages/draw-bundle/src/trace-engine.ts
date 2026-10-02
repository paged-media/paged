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
// wrong by two orders of magnitude. `TraceEngine.trace()` is synchronous
// and CPU-bound and runs on the thread that calls it. Nothing is
// interruptible once it starts. Timings on an M-series laptop, release
// wasm, default options:
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
// refusal cap, and why the command warns before a long one.
//
// OFF THE CALLING THREAD — `openTraceSession`, at the foot of this file.
// The bundle no longer calls `trace()` itself: it opens a SESSION, and a
// session runs the kernel in a `host.workers` worker whenever the host
// can spawn one, and on the calling thread only when it cannot. What
// "cannot" means is spelled out there, because in a host that injects a
// worker backend but has not been told about THIS bundle's worker module
// the answer is still "cannot" — and that is the state of the editor
// until it registers `TRACE_WORKER_MODULE`.

import type { BundleHost, BundleWorker } from "@paged-media/plugin-api";

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
  /** `trace`, answered as the kernel's own JSON text. What the worker
   *  posts back: a string crosses a worker boundary as one copy, where
   *  the parsed result would be re-walked node by node on both sides. */
  traceJson(
    pixels: Uint8Array,
    width: number,
    height: number,
    options?: TraceOptions,
  ): string;
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
  const traceJson: TraceEngine["traceJson"] = (pixels, width, height, options) => {
    // `maxTracePixels` is a DECODER knob; the kernel has never heard of
    // it, so it is stripped here rather than smuggled across as an
    // ignored field.
    let payload = "{}";
    if (options) {
      const { maxTracePixels: _decodeOnly, ...kernel } = options;
      payload = JSON.stringify(kernel);
    }
    return mod.traceRgba(pixels, width, height, payload);
  };
  return {
    limits() {
      return JSON.parse(mod.traceLimits()) as TraceLimits;
    },
    trace(pixels, width, height, options) {
      return JSON.parse(traceJson(pixels, width, height, options)) as TraceResult;
    },
    traceJson,
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

// =====================================================================
// THE WORKER LANE — the trace, off the calling thread.
//
// `trace()` above freezes whatever thread calls it; in the editor that is
// the UI thread, for anything from a third of a second to most of a
// minute. `host.workers` (K-3) is the door that moves it: the bundle
// spawns a module worker it ships, the worker boots ITS OWN copy of the
// trace wasm (`trace-worker.ts`), and the two talk over `postMessage`.
//
// THE PROTOCOL is two requests, each answered once, matched by `id`:
//
//   limits → the kernel's caps. Also the HANDSHAKE: the first answer is
//            the proof that the worker module loaded and its wasm booted.
//   trace  → the pixels, TRANSFERRED (the buffer changes owner — no copy
//            of up to 16 MB of RGBA), answered with the kernel's JSON.
//
// WHEN THE SESSION IS *NOT* A WORKER — four cases, each of which lands on
// the calling thread with the reason logged, because a trace that blocks
// is still better than a command that does nothing:
//
//   1. `supports("workers@1")` is false — the host injects no backend
//      (the headless harness; any host without `Worker`).
//   2. `spawn` rejects. The door is DECLARED-ONLY: the host resolves
//      `TRACE_WORKER_MODULE` through a resolver it registers per bundle,
//      and a host that has not registered this bundle's module refuses
//      the spawn by name. So does the count cap.
//   3. The worker never answers the handshake within
//      `TRACE_WORKER_BOOT_MS` — its module failed to load. The door has
//      NO error channel (`BundleWorker` is post / onMessage / terminate),
//      so a worker that dies on import is simply silent; a deadline on
//      the FIRST answer is the only way to notice.
//   4. The handshake answers with an error — the worker is up but its
//      wasm did not boot.
//
// WHAT IS NOT COVERED, said plainly: a worker that dies AFTER a good
// handshake, mid-trace, is silent for the same reason, and there is no
// honest deadline for a trace (41 s is a real one). `close()` is the way
// out — it ends the worker and fails whatever was pending.
//
// ONE WORKER PER SESSION, ended on `close()`. Wasm linear memory only
// ever grows, so a worker kept "warm" would hold whatever its largest
// trace needed for the rest of the editing session; ending it gives the
// memory back. Spawning is cheap against the call it wraps — measured in
// Chromium, the worker module and its wasm were up and answering in
// 18–40 ms. The manifest asks for at most TWO workers
// (`capabilities.workers.max`): a second trace started while one is
// running gets its own, a third is refused by the host's count cap and
// falls back (case 2).
//
// MEASURED, in Chromium, the built `dist/trace-worker.js` served the way
// the editor serves a bundle's worker (Vite `?worker&url`, dev server and
// production build): a noisy 1024×1024 raster — the size of the 6.3 s row
// in the table above — traced in 7.6 s in the worker, while a 4 ms ticker
// on the page's own thread fired 1 896 times and never waited longer than
// 21 ms.

/** The bundle-relative worker module the session asks `host.workers` to
 *  spawn. A NAME the host resolves, not a URL: the host maps it to the
 *  built `trace-worker` entry this package exports (`./trace-worker`). */
export const TRACE_WORKER_MODULE = "workers/trace.js";

/** How long the worker has to answer its FIRST request before the session
 *  gives it up and traces on the calling thread. Generous on purpose: it
 *  covers fetching and compiling the worker module and a ~170 KB wasm,
 *  measured at 18–40 ms. It is a deadline on the boot, never on a trace. */
export const TRACE_WORKER_BOOT_MS = 15_000;

/** What the bundle posts to the worker. */
export type TraceWorkerRequest =
  | { id: number; kind: "limits" }
  | {
      id: number;
      kind: "trace";
      /** The RGBA8 raster's buffer — transferred when it is transferable. */
      pixels: ArrayBufferLike;
      byteOffset: number;
      byteLength: number;
      width: number;
      height: number;
      options?: TraceOptions;
    };

/** What the worker posts back — exactly one per request. */
export type TraceWorkerReply =
  | { id: number; ok: true; kind: "limits"; limits: TraceLimits }
  | { id: number; ok: true; kind: "trace"; json: string }
  | { id: number; ok: false; error: string };

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Answer one request against a booted engine — the worker's whole job,
 *  kept here (not in the worker entry) so it runs under test against the
 *  real wasm. A kernel refusal is an ANSWER, with the kernel's own
 *  message; it never escapes as a throw the other side cannot see. */
export function answerTraceRequest(
  engine: TraceEngine,
  request: TraceWorkerRequest,
): TraceWorkerReply {
  try {
    if (request.kind === "limits") {
      return { id: request.id, ok: true, kind: "limits", limits: engine.limits() };
    }
    const pixels = new Uint8Array(
      request.pixels,
      request.byteOffset,
      request.byteLength,
    );
    return {
      id: request.id,
      ok: true,
      kind: "trace",
      json: engine.traceJson(pixels, request.width, request.height, request.options),
    };
  } catch (err) {
    return { id: request.id, ok: false, error: messageOf(err) };
  }
}

/** One trace's worth of tracer: the caps, the call, and where it runs. */
export interface TraceSession {
  /** Where `trace` runs: a `host.workers` worker, or the thread that
   *  called — the one `trace` then BLOCKS. */
  readonly thread: "worker" | "calling";
  /** The kernel's hard caps. */
  limits(): Promise<TraceLimits>;
  /**
   * Trace an RGBA8 raster. Rejects with the kernel's own message on a
   * refusal, on either thread.
   *
   * ON A WORKER SESSION `pixels`' BUFFER IS TRANSFERRED: when this
   * returns, the caller's view is detached (length 0). Read what you need
   * from the raster first.
   */
  trace(
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    options?: TraceOptions,
  ): Promise<TraceResult>;
  /** End the session: the worker is terminated and anything still
   *  pending is failed. Idempotent. */
  close(): void;
}

function callingThreadSession(engine: TraceEngine): TraceSession {
  return {
    thread: "calling",
    limits: async () => engine.limits(),
    trace: async (pixels, width, height, options) => {
      try {
        return engine.trace(
          new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
          width,
          height,
          options,
        );
      } catch (err) {
        // The wasm throws its refusal as a bare STRING. Both lanes reject
        // with an Error carrying the kernel's message.
        throw err instanceof Error ? err : new Error(messageOf(err), { cause: err });
      }
    },
    close() {},
  };
}

/** A worker session, or `null` with the reason logged (the four cases in
 *  the section header). */
async function workerSession(
  host: BundleHost,
  bootMs: number,
): Promise<TraceSession | null> {
  const why = (reason: string): null => {
    host.log.info(
      `image trace: no worker — ${reason} — tracing on the calling thread`,
    );
    return null;
  };
  if (!host.supports("workers@1")) {
    return why(`the host has no worker backend (supports("workers@1") is false)`);
  }
  let worker: BundleWorker;
  try {
    worker = await host.workers.spawn({
      module: TRACE_WORKER_MODULE,
      name: "paged.draw image trace",
    });
  } catch (err) {
    return why(messageOf(err));
  }

  let seq = 0;
  let closed = false;
  const pending = new Map<number, (reply: TraceWorkerReply) => void>();
  const subscription = worker.onMessage((message) => {
    const reply = message as TraceWorkerReply | null;
    const settle = reply ? pending.get(reply.id) : undefined;
    if (!reply || !settle) return;
    pending.delete(reply.id);
    settle(reply);
  });
  type Ask =
    | { kind: "limits" }
    | Omit<Extract<TraceWorkerRequest, { kind: "trace" }>, "id">;
  const ask = (
    request: Ask,
    transfer?: Transferable[],
  ): Promise<TraceWorkerReply> =>
    new Promise((resolve) => {
      const id = ++seq;
      if (closed) {
        resolve({ id, ok: false, error: "the trace session is closed" });
        return;
      }
      pending.set(id, resolve);
      worker.post({ ...request, id } satisfies TraceWorkerRequest, transfer);
    });
  const close = (): void => {
    if (closed) return;
    closed = true;
    subscription.dispose();
    worker.terminate();
    for (const [id, settle] of pending) {
      settle({ id, ok: false, error: "the trace session was closed" });
    }
    pending.clear();
  };

  // THE HANDSHAKE — the caps, and the only evidence the worker is alive.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    ask({ kind: "limits" }),
    new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), bootMs);
    }),
  ]);
  clearTimeout(deadline);
  if (first === null) {
    close();
    return why(
      `the worker module "${TRACE_WORKER_MODULE}" did not answer within ` +
        `${bootMs} ms (it failed to load, and the worker door has no error ` +
        `channel to say so)`,
    );
  }
  if (!first.ok || first.kind !== "limits") {
    close();
    return why(
      `the worker could not boot the tracer — ${
        first.ok ? "unexpected answer" : first.error
      }`,
    );
  }
  const limits = first.limits;

  return {
    thread: "worker",
    limits: async () => limits,
    async trace(pixels, width, height, options) {
      const buffer = pixels.buffer;
      // A SharedArrayBuffer cannot be transferred — and need not be: it
      // is shared, not copied.
      const transfer = buffer instanceof ArrayBuffer ? [buffer] : [];
      const reply = await ask(
        {
          kind: "trace",
          pixels: buffer,
          byteOffset: pixels.byteOffset,
          byteLength: pixels.byteLength,
          width,
          height,
          options,
        },
        transfer,
      );
      if (!reply.ok) throw new Error(reply.error);
      if (reply.kind !== "trace") throw new Error("unexpected answer from the trace worker");
      return JSON.parse(reply.json) as TraceResult;
    },
    close,
  };
}

/**
 * Open a trace session: in a worker when the host can spawn one, on the
 * calling thread otherwise (the section header lists when, and each case
 * is logged). Rejects only when the trace wasm itself cannot be loaded on
 * the calling thread either (`TRACE_ENGINE_NOT_BUILT`).
 *
 * `close()` it when the trace is done.
 */
export async function openTraceSession(
  host: BundleHost,
  options: { bootMs?: number } = {},
): Promise<TraceSession> {
  const session = await workerSession(
    host,
    options.bootMs ?? TRACE_WORKER_BOOT_MS,
  );
  return session ?? callingThreadSession(await bootTraceEngine());
}
