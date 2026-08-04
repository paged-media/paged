/* tslint:disable */
/* eslint-disable */

/**
 * Install the panic hook. Idempotent; called by the bundle right after
 * instantiation.
 */
export function traceInit(): void;

/**
 * The kernel's HARD CAPS, as JSON — read by the bundle so the decoder's
 * downsample target and the tracer's refusal threshold can never drift
 * apart (there is one source of truth, and it is the Rust constant).
 */
export function traceLimits(): string;

/**
 * Trace an RGBA8 raster. `options_json` is a camelCase
 * [`TraceOptions`] object (`"{}"` = every documented default).
 *
 * Returns the [`draw_trace::TraceResult`] as JSON, or an error string
 * that is safe to show a user (it names the size that was refused).
 *
 * **Synchronous and CPU-bound.** The bundle calls this on the thread it
 * runs on — in the editor, the MAIN thread — so a trace at the cap
 * stalls the UI for its duration. See `draw_trace`'s module docs.
 */
export function traceRgba(pixels: Uint8Array, width: number, height: number, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly traceLimits: (a: number) => void;
    readonly traceRgba: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly traceInit: () => void;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
