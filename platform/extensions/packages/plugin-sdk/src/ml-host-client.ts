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

// The client of the local generative host (`apps/ml-host`, Tier B of the ML
// doors, extensions ADR 1100). The editor reaches the host through its
// same-origin proxy (`/api/ml/*`, editor ADR 290); paged-node talks to it
// directly on the loopback. One implementation for both, over `fetch`.
//
// The wire is the host's HTTP API v1 (apps/ml-host/README.md): JSON jobs,
// progress as server-sent events, the result as PNG. Images cross as PNG
// bytes; turning an `MlImage` into PNG and back is the caller's (the
// browser has a canvas, Node a decoder), passed in as `MlPngCodec`.

import type {
  MlCallOptions,
  MlCapability,
  MlImage,
  MlMask,
  MlProgress,
  MlRequests,
} from "@paged-media/plugin-api";

import { toBase64 } from "./bytes.js";
import type { MlProvider, MlProviderAnswer } from "./doors-ml.js";

export { toBase64 };

/** `GET /api/ml/health`. */
export interface MlHostHealth {
  ok: boolean;
  version: string;
  api: number;
  runtime: { binary: string | null; found: boolean };
  model: {
    id: string | null;
    configured: boolean;
    licenceAcknowledged: boolean;
  };
  ready: boolean;
  capabilities: Array<"generate" | "edit">;
  queue: { running: number; queued: number };
}

/** `GET`/`PUT /api/ml/config`: the paths the user gave. */
export interface MlHostConfig {
  sdBinary: string | null;
  model: null | {
    id: string;
    licenceId: string;
    licenceAcknowledged: boolean;
    diffusionModel: string;
    textEncoder: string;
    vae: string;
    textEncoderFlag?: string;
  };
  extraArgs?: string[];
}

export type MlHostJobState =
  "queued" | "running" | "done" | "failed" | "cancelled";

/** `GET /api/ml/jobs/{id}`. */
export interface MlHostJob {
  id: string;
  kind: "generate" | "edit";
  state: MlHostJobState;
  progress: { step: number; total: number };
  error?: string;
}

/** `POST /api/ml/jobs`: images as base64 PNG. */
export type MlHostJobRequest =
  | {
      kind: "generate";
      prompt: string;
      negativePrompt?: string;
      width: number;
      height: number;
      steps?: number;
      seed?: number;
      cfgScale?: number;
    }
  | {
      kind: "edit";
      prompt: string;
      image: string;
      mask?: string;
      references?: string[];
      steps?: number;
      seed?: number;
      strength?: number;
    };

/** An answer the host refused: its `error` code and message. */
export class MlHostError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MlHostError";
  }
}

export interface MlHostClient {
  readonly baseUrl: string;
  health(): Promise<MlHostHealth>;
  config(): Promise<MlHostConfig>;
  configure(config: MlHostConfig): Promise<MlHostConfig>;
  submit(job: MlHostJobRequest): Promise<string>;
  job(id: string): Promise<MlHostJob>;
  /** Follow a job's events until it ends; answers the final job. */
  follow(
    id: string,
    onProgress?: (p: MlProgress) => void,
    signal?: AbortSignal,
  ): Promise<MlHostJob>;
  result(id: string): Promise<Uint8Array>;
  cancel(id: string): Promise<MlHostJob>;
  /** Submit, follow and fetch: the PNG bytes. Aborting cancels the job. */
  run(
    job: MlHostJobRequest,
    options?: { signal?: AbortSignal; onProgress?: (p: MlProgress) => void },
  ): Promise<Uint8Array>;
}

export interface MlHostClientOptions {
  /** Where `/api/ml` lives: `""` for the same origin (the editor's proxy),
   *  `http://127.0.0.1:7861` for the host itself. */
  baseUrl: string;
  fetch?: typeof fetch;
}

/** The host's default loopback address. */
export const ML_HOST_DEFAULT_URL = "http://127.0.0.1:7861";

const TERMINAL = new Set<MlHostJobState>(["done", "failed", "cancelled"]);

export function createMlHostClient(options: MlHostClientOptions): MlHostClient {
  const base = options.baseUrl.replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const url = (path: string) => `${base}/api/ml${path}`;
  const refuse = async (res: Response): Promise<never> => {
    let code = "http_" + res.status;
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      // not JSON: the status says it
    }
    throw new MlHostError(res.status, code, message);
  };
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let res: Response;
    try {
      res = await doFetch(url(path), init);
    } catch (err) {
      throw new MlHostError(
        0,
        "unreachable",
        `local image model not running: the ML host at ${base || "/api/ml"} does not answer (${(err as Error).message})`,
      );
    }
    if (!res.ok) await refuse(res);
    return (await res.json()) as T;
  };
  const body = (value: unknown): RequestInit => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

  const client: MlHostClient = {
    baseUrl: base,
    health: () => json<MlHostHealth>("/health"),
    config: () => json<MlHostConfig>("/config"),
    configure: (config) =>
      json<MlHostConfig>("/config", { method: "PUT", ...body(config) }),
    async submit(job) {
      const r = await json<{ id: string }>("/jobs", {
        method: "POST",
        ...body(job),
      });
      return r.id;
    },
    job: (id) => json<MlHostJob>(`/jobs/${encodeURIComponent(id)}`),
    async follow(id, onProgress, signal) {
      const res = await doFetch(url(`/jobs/${encodeURIComponent(id)}/events`), {
        headers: { accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) await refuse(res);
      if (!res.body) return client.job(id);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let final: MlHostJob | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (event === "progress")
            onProgress?.({
              step: Number(parsed["step"]),
              total: Number(parsed["total"]),
            });
          else if (TERMINAL.has(event as MlHostJobState))
            final = parsed as unknown as MlHostJob;
        }
        if (final || done) break;
      }
      void reader.cancel().catch(() => undefined);
      return final ?? client.job(id);
    },
    async result(id) {
      const res = await doFetch(url(`/jobs/${encodeURIComponent(id)}/result`));
      if (!res.ok) await refuse(res);
      return new Uint8Array(await res.arrayBuffer());
    },
    cancel: (id) =>
      json<MlHostJob>(`/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    async run(job, opts = {}) {
      const { signal, onProgress } = opts;
      signal?.throwIfAborted();
      const id = await client.submit(job);
      let final: MlHostJob;
      try {
        final = await client.follow(id, onProgress, signal);
      } catch (err) {
        // Aborting ends the event stream; the job is cancelled on the host
        // before the caller hears of it, so its process stops too.
        if (signal?.aborted) await client.cancel(id).catch(() => undefined);
        throw err;
      }
      {
        if (final.state === "cancelled")
          throw new MlHostError(0, "cancelled", "the job was cancelled");
        if (final.state !== "done")
          throw new MlHostError(
            0,
            "failed",
            `the local image model failed: ${final.error ?? final.state}`,
          );
        return await client.result(id);
      }
    },
  };
  return client;
}

/** PNG in and out, the host's side of the image bridge. */
export interface MlPngCodec {
  decode(png: Uint8Array): Promise<MlImage>;
  encode(image: MlImage): Promise<Uint8Array>;
}

/** A mask as an opaque greyscale image (white = the region to change, as
 *  stable-diffusion.cpp reads it). */
export function maskToImage(mask: MlMask): MlImage {
  const data = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i]!;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: mask.width, height: mask.height, data };
}

export interface MlHostProviderOptions {
  client: MlHostClient;
  codec: MlPngCodec;
  id?: string;
  title?: string;
  /** Called when the health the provider holds moved (pass the registry
   *  handle's `changed`). */
  onStatus?: () => void;
}

/** A Tier-B provider over the host: `generate` and `edit`, healthy while
 *  the last health check said ready. Call `refresh()` to check again (the
 *  editor polls; paged-node checks once). */
export interface MlHostProvider extends MlProvider {
  refresh(): Promise<MlHostHealth | null>;
  readonly lastHealth: MlHostHealth | null;
}

export function mlHostProvider(options: MlHostProviderOptions): MlHostProvider {
  const { client, codec } = options;
  let health: MlHostHealth | null = null;
  let detail = "not checked yet";
  const png = async (image: MlImage) => toBase64(await codec.encode(image));
  const provider: MlHostProvider = {
    id: options.id ?? "paged.ml-host",
    title: options.title ?? "Local image model",
    tier: "B",
    capabilities: ["generate", "edit"],
    get lastHealth() {
      return health;
    },
    status() {
      if (health?.ready)
        return {
          healthy: true,
          ...(health.model.id ? { model: health.model.id } : {}),
          detail: `paged-ml-host ${health.version}`,
        };
      return { healthy: false, detail };
    },
    async refresh() {
      const before = JSON.stringify(provider.status());
      try {
        health = await client.health();
        detail = health.ready
          ? "ready"
          : !health.runtime.found
            ? "the stable-diffusion.cpp binary is not configured or not found"
            : !health.model.configured
              ? "no model configured"
              : "the model licence is not acknowledged";
      } catch (err) {
        health = null;
        detail = `local image model not running (${(err as Error).message})`;
      }
      if (JSON.stringify(provider.status()) !== before) options.onStatus?.();
      return health;
    },
    async run<C extends MlCapability>(
      capability: C,
      request: MlRequests[C],
      opts: MlCallOptions,
    ): Promise<MlProviderAnswer<C>> {
      const run = { signal: opts.signal, onProgress: opts.onProgress };
      let job: MlHostJobRequest;
      if (capability === "generate") {
        const r = request as MlRequests["generate"];
        job = {
          kind: "generate",
          prompt: r.prompt,
          width: r.width,
          height: r.height,
          ...(r.negativePrompt ? { negativePrompt: r.negativePrompt } : {}),
          ...(r.seed !== undefined ? { seed: r.seed } : {}),
          ...(r.steps !== undefined ? { steps: r.steps } : {}),
        };
      } else if (capability === "edit") {
        const r = request as MlRequests["edit"];
        job = {
          kind: "edit",
          prompt: r.prompt,
          image: await png(r.image),
          ...(r.mask ? { mask: await png(maskToImage(r.mask)) } : {}),
          ...(r.references?.length
            ? { references: await Promise.all(r.references.map(png)) }
            : {}),
          ...(r.seed !== undefined ? { seed: r.seed } : {}),
          ...(r.steps !== undefined ? { steps: r.steps } : {}),
          ...(r.strength !== undefined ? { strength: r.strength } : {}),
        };
      } else {
        throw new Error(
          `ml.${capability}@1: the local image model does not answer it`,
        );
      }
      const bytes = await client.run(job, {
        ...(run.signal ? { signal: run.signal } : {}),
        ...(run.onProgress ? { onProgress: run.onProgress } : {}),
      });
      const image = await codec.decode(bytes);
      return { image } as unknown as MlProviderAnswer<C>;
    },
  };
  return provider;
}
