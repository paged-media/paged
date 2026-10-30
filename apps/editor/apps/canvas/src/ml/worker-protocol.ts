/*
 * This file is part of paged (https://paged.media), the commercial editor
 * for the paged IDML engine.
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

// The ML worker's protocol and its message handler (editor ADR 290). The
// handler is a plain function over an onnxruntime-like runtime, so the unit
// tests run it with the real onnxruntime-web on a generated model and no
// Worker; `ml-worker.ts` is the thin Worker entry around it. React-free and
// shell-free (a worker must not load the shell barrel).
//
// Execution providers: WebGPU when the browser offers an adapter, wasm
// otherwise, and wasm again when a model fails to build on WebGPU (an
// operator WebGPU lacks). The answer names the provider a session runs on.

/** The float tensors that cross the worker boundary. */
export interface WireTensor {
  dims: number[];
  data: Float32Array;
}

export type ExecutionProvider = "webgpu" | "wasm";

export type WorkerRequest =
  | { type: "probe"; id: number }
  | {
      type: "load";
      id: number;
      key: string;
      bytes: Uint8Array;
      providers?: ExecutionProvider[];
    }
  | {
      type: "run";
      id: number;
      key: string;
      feeds: Record<string, WireTensor>;
    }
  | { type: "unload"; id: number; key: string };

export interface ProbeResult {
  webgpu: boolean;
  runtime: string;
}
export interface LoadResult {
  executionProvider: ExecutionProvider;
  inputs: readonly string[];
  outputs: readonly string[];
}
export type RunResult = Record<string, WireTensor>;

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** The part of onnxruntime-web the worker uses. */
export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, { dims: readonly number[]; data: unknown }>>;
  release?(): Promise<void>;
}
export interface OrtLike {
  InferenceSession: {
    create(
      model: Uint8Array,
      options: { executionProviders: string[] },
    ): Promise<OrtSessionLike>;
  };
  Tensor: new (
    type: "float32",
    data: Float32Array,
    dims: readonly number[],
  ) => unknown;
  env: { versions?: Record<string, string> };
}

export function createMlWorkerHandler(
  loadRuntime: () => Promise<OrtLike>,
  hasWebGpu: () => Promise<boolean>,
): (request: WorkerRequest) => Promise<{
  response: WorkerResponse;
  transfer: Transferable[];
}> {
  let runtime: Promise<OrtLike> | null = null;
  let gpu: Promise<boolean> | null = null;
  const sessions = new Map<
    string,
    { session: OrtSessionLike; ep: ExecutionProvider }
  >();
  const ort = () => (runtime ??= loadRuntime());
  const webgpu = () => (gpu ??= hasWebGpu().catch(() => false));

  const handle = async (
    req: WorkerRequest,
  ): Promise<{ result: unknown; transfer: Transferable[] }> => {
    switch (req.type) {
      case "probe": {
        const rt = await ort();
        const result: ProbeResult = {
          webgpu: await webgpu(),
          runtime:
            `onnxruntime-web ${rt.env.versions?.["web"] ?? rt.env.versions?.["common"] ?? ""}`.trim(),
        };
        return { result, transfer: [] };
      }
      case "load": {
        const rt = await ort();
        const wanted = req.providers ?? ["webgpu", "wasm"];
        const order: ExecutionProvider[] = [];
        if (wanted.includes("webgpu") && (await webgpu())) order.push("webgpu");
        if (wanted.includes("wasm")) order.push("wasm");
        let last: unknown = null;
        for (const ep of order) {
          try {
            const session = await rt.InferenceSession.create(req.bytes, {
              executionProviders: [ep],
            });
            await sessions.get(req.key)?.session.release?.();
            sessions.set(req.key, { session, ep });
            const result: LoadResult = {
              executionProvider: ep,
              inputs: [...session.inputNames],
              outputs: [...session.outputNames],
            };
            return { result, transfer: [] };
          } catch (err) {
            last = err;
          }
        }
        throw new Error(
          `the model does not load (${order.join(", ") || "no execution provider"}): ${(last as Error)?.message ?? last}`,
        );
      }
      case "run": {
        const rt = await ort();
        const s = sessions.get(req.key);
        if (!s) throw new Error(`no model loaded as ${req.key}`);
        const feeds: Record<string, unknown> = {};
        for (const [name, t] of Object.entries(req.feeds))
          feeds[name] = new rt.Tensor("float32", t.data, t.dims);
        const out = await s.session.run(feeds);
        const result: RunResult = {};
        const transfer: Transferable[] = [];
        for (const [name, t] of Object.entries(out)) {
          const data =
            t.data instanceof Float32Array
              ? new Float32Array(t.data)
              : Float32Array.from(t.data as ArrayLike<number>);
          result[name] = { dims: [...t.dims], data };
          transfer.push(data.buffer);
        }
        return { result, transfer };
      }
      case "unload": {
        await sessions.get(req.key)?.session.release?.();
        sessions.delete(req.key);
        return { result: null, transfer: [] };
      }
    }
  };

  return async (req) => {
    try {
      const { result, transfer } = await handle(req);
      return { response: { id: req.id, ok: true, result }, transfer };
    } catch (err) {
      return {
        response: {
          id: req.id,
          ok: false,
          error: (err as Error)?.message ?? String(err),
        },
        transfer: [],
      };
    }
  };
}

/** The page's side: typed calls over a worker (or, in tests, the handler
 *  itself). */
export interface MlWorkerClient {
  probe(): Promise<ProbeResult>;
  load(
    key: string,
    bytes: Uint8Array,
    providers?: ExecutionProvider[],
  ): Promise<LoadResult>;
  run(key: string, feeds: Record<string, WireTensor>): Promise<RunResult>;
  unload(key: string): Promise<void>;
  terminate(): void;
}

type Sender = (req: WorkerRequest, transfer: Transferable[]) => void;

function clientOver(
  send: Sender,
  listen: (on: (r: WorkerResponse) => void) => void,
  terminate: () => void,
): MlWorkerClient {
  let next = 1;
  const pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void }
  >();
  listen((r) => {
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.result);
    else p.reject(new Error(r.error));
  });
  const call = <T>(req: WorkerRequest, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      pending.set(req.id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      send(req, transfer);
    });
  return {
    probe: () => call<ProbeResult>({ type: "probe", id: next++ }),
    load: (key, bytes, providers) =>
      call<LoadResult>({
        type: "load",
        id: next++,
        key,
        bytes,
        ...(providers ? { providers } : {}),
      }),
    run: (key, feeds) =>
      call<RunResult>(
        { type: "run", id: next++, key, feeds },
        Object.values(feeds).map((t) => t.data.buffer as ArrayBuffer),
      ),
    unload: (key) =>
      call<null>({ type: "unload", id: next++, key }).then(() => undefined),
    terminate() {
      for (const p of pending.values())
        p.reject(new Error("the ML worker stopped"));
      pending.clear();
      terminate();
    },
  };
}

/** A client over a real Worker running `ml-worker.ts`. */
export function workerClient(worker: Worker): MlWorkerClient {
  return clientOver(
    (req, transfer) => worker.postMessage(req, transfer),
    (on) => {
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => on(e.data);
    },
    () => worker.terminate(),
  );
}

/** A client that calls the handler in the same thread (tests). */
export function inlineClient(
  handler: ReturnType<typeof createMlWorkerHandler>,
): MlWorkerClient {
  let deliver: ((r: WorkerResponse) => void) | null = null;
  return clientOver(
    (req) => {
      void handler(req).then(({ response }) => deliver?.(response));
    },
    (on) => {
      deliver = on;
    },
    () => undefined,
  );
}
