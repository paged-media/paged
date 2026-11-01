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

// A Tier-A provider (editor ADR 290): one installed model, run in the ML
// worker. It is healthy while the model is installed; the first call loads
// the files from the cache (hash-checked) into a worker session, later
// calls reuse it. The adapter in the registry entry says how its tensors map
// to the door's images.

import type {
  MlCallOptions,
  MlCapability,
  MlRequests,
} from "@paged-media/plugin-api";
import type { MlProvider, MlProviderAnswer } from "@paged-media/plugin-sdk";

import {
  imageToTensor,
  maskToTensor,
  tensorToFace,
  tensorToImage,
  tensorToMask,
} from "./adapters";
import type { InstallRecord, ModelStore } from "./model-store";
import type { ModelEntry } from "./registry";
import type { ExecutionProvider, MlWorkerClient } from "./worker-protocol";

export interface TierAProvider extends MlProvider {
  /** The install record moved (installed, removed, another variant). */
  setInstalled(record: InstallRecord | null): void;
  /** Where its session runs, once loaded. */
  readonly executionProvider: ExecutionProvider | null;
  release(): Promise<void>;
}

export function tierAProvider(options: {
  entry: ModelEntry;
  store: ModelStore;
  worker: () => MlWorkerClient;
  record: InstallRecord | null;
  onStatus?: () => void;
}): TierAProvider {
  const { entry, store } = options;
  const adapter = entry.adapter!;
  let record = options.record;
  let loaded: Promise<string> | null = null;
  let ep: ExecutionProvider | null = null;
  const key = () => `${entry.id}@${record?.variant ?? "?"}`;

  const session = () =>
    (loaded ??= (async () => {
      const files = await store.load(entry);
      const bytes = [...files.entries()].find(([n]) =>
        n.endsWith(".onnx"),
      )?.[1];
      if (!bytes) throw new Error(`${entry.title}: no .onnx file installed`);
      const k = key();
      const r = await options.worker().load(k, bytes);
      ep = r.executionProvider;
      options.onStatus?.();
      return k;
    })().catch((err: unknown) => {
      loaded = null;
      throw err;
    }));

  const provider: TierAProvider = {
    id: `paged.ml.${entry.id}`,
    title: entry.title,
    tier: "A",
    capabilities: entry.capabilities,
    get executionProvider() {
      return ep;
    },
    status: () =>
      record
        ? {
            healthy: true,
            model: `${entry.id}@${record.variant}`,
            detail: ep ? (ep === "webgpu" ? "WebGPU" : "wasm") : "installed",
          }
        : { healthy: false, detail: "not installed" },
    setInstalled(next) {
      if (loaded) void provider.release();
      record = next;
      options.onStatus?.();
    },
    async release() {
      const was = loaded;
      loaded = null;
      ep = null;
      if (was) {
        const k = await was.catch(() => null);
        if (k)
          await options
            .worker()
            .unload(k)
            .catch(() => undefined);
      }
    },
    async run<C extends MlCapability>(
      capability: C,
      request: MlRequests[C],
      opts: MlCallOptions,
    ): Promise<MlProviderAnswer<C>> {
      if (!entry.capabilities.includes(capability))
        throw new Error(`${entry.title} does not answer ml.${capability}@1`);
      opts.signal?.throwIfAborted();
      const k = await session();
      opts.onProgress?.({ step: 0, total: 1 });
      const image = (request as { image: MlRequests["matting"]["image"] })
        .image;
      const feeds = { [adapter.input]: imageToTensor(image, adapter) };
      if (adapter.maskInput && capability === "inpaint")
        feeds[adapter.maskInput] = maskToTensor(
          (request as MlRequests["inpaint"]).mask,
          adapter,
        );
      const out = await options.worker().run(k, feeds);
      opts.signal?.throwIfAborted();
      const t = out[adapter.output];
      if (!t) throw new Error(`${entry.title}: no output "${adapter.output}"`);
      opts.onProgress?.({ step: 1, total: 1 });
      const answer = (v: unknown) => v as MlProviderAnswer<C>;
      switch (capability as MlCapability) {
        case "matting":
          return answer({ alpha: tensorToMask(t, image.width, image.height) });
        case "segment":
          return answer({ mask: tensorToMask(t, image.width, image.height) });
        case "inpaint":
          return answer({
            image: tensorToImage(t, {
              width: image.width,
              height: image.height,
            }),
          });
        case "superres": {
          const scale =
            (request as MlRequests["superres"]).scale ?? adapter.scale ?? 2;
          return answer({
            image: tensorToImage(t, {
              width: image.width * scale,
              height: image.height * scale,
            }),
          });
        }
        case "landmarks":
          return answer({
            faces: [tensorToFace(t, image.width, image.height)],
          });
        default:
          throw new Error(`ml.${capability}@1 is not a Tier-A capability`);
      }
    },
  };
  return provider;
}
