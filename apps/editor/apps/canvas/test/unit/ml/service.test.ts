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

// Editor ADR 290 — the ML service end to end, without a browser: the
// shipped fixture is installed with consent from public/, a bundle host on
// the same ML backend sees `ml.matting@1` turn true, its call runs the real
// onnxruntime-web on the fixture (sigmoid of the pixels) and names the
// provider and tier; removing turns it false. Choices persist; the Tier-B
// model is configured only after its licence is acknowledged, and turns
// `ml.generate@1` true once the host says it is ready.

import { describe, expect, test } from "bun:test";
import { covers } from "@paged-media/test-kit";

import type { MlImage, PluginManifest } from "@paged-media/plugin-api";
import {
  createBundleHost,
  createMlRegistry,
  type MlHostClient,
  type MlHostConfig,
  type MlHostHealth,
} from "@paged-media/plugin-sdk";

import {
  createMemoryModelFiles,
  ModelStore,
} from "../../../src/ml/model-store";
import { SHIPPED_REGISTRY } from "../../../src/ml/registry";
import {
  MlService,
  readMlSettings,
  type SettingsStorage,
} from "../../../src/ml/service";
import { ORIGIN, publicFetch, realWorker } from "./kit";

const MANIFEST: PluginManifest = {
  id: "com.example.ml",
  name: "ml",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { ml: ["matting", "generate"] },
};

function memorySettings(
  initial: string | null = null,
): SettingsStorage & { value: string | null } {
  const s = {
    value: initial,
    get: () => s.value,
    set: (v: string) => {
      s.value = v;
    },
  };
  return s;
}

function fakeHost(): MlHostClient & {
  ready: boolean;
  configured: MlHostConfig | null;
} {
  const health = (ready: boolean): MlHostHealth => ({
    ok: true,
    version: "0.1.0",
    api: 1,
    runtime: { binary: "/opt/sd", found: true },
    model: {
      id: ready ? "qwen-image-2.1" : null,
      configured: ready,
      licenceAcknowledged: ready,
    },
    ready,
    capabilities: ready ? ["generate", "edit"] : [],
    queue: { running: 0, queued: 0 },
  });
  const host = {
    baseUrl: "",
    ready: false,
    configured: null as MlHostConfig | null,
    health: async () => health(host.ready),
    config: async () => host.configured ?? { sdBinary: null, model: null },
    async configure(c: MlHostConfig) {
      host.configured = c;
      host.ready = true;
      return c;
    },
    submit: async () => "j1",
    job: async () => ({
      id: "j1",
      kind: "generate" as const,
      state: "done" as const,
      progress: { step: 1, total: 1 },
    }),
    follow: async () => ({
      id: "j1",
      kind: "generate" as const,
      state: "done" as const,
      progress: { step: 1, total: 1 },
    }),
    result: async () => new Uint8Array([1]),
    cancel: async () => ({
      id: "j1",
      kind: "generate" as const,
      state: "cancelled" as const,
      progress: { step: 0, total: 1 },
    }),
    run: async () => new Uint8Array([1]),
  };
  return host;
}

const codec = {
  decode: async (): Promise<MlImage> => ({
    width: 8,
    height: 8,
    data: new Uint8ClampedArray(256).fill(9),
  }),
  encode: async () => new Uint8Array([0]),
};

function setup(settings = memorySettings()) {
  const backend = createMlRegistry();
  const net = publicFetch();
  const host = fakeHost();
  const worker = realWorker();
  const service = new MlService({
    backend,
    registry: SHIPPED_REGISTRY,
    store: new ModelStore({
      files: createMemoryModelFiles(),
      origin: ORIGIN,
      fetch: net.fetch,
    }),
    worker: () => worker,
    host,
    codec,
    settings,
    detectGpu: async () => ({ webgpu: false, adapter: null, reason: "test" }),
    pollMs: 0,
  });
  const bundle = createBundleHost(() => ({}) as never, MANIFEST, {
    ml: backend,
    capabilityMode: "enforce",
  }).host;
  return { backend, service, bundle, host, settings, net };
}

const grey = (v: number): MlImage => ({
  width: 4,
  height: 4,
  data: new Uint8ClampedArray(64).fill(v),
});

describe("[plugin-platform.ml-service] the editor's ML service", () => {
  test("install with consent → ml.matting@1 answers from the fixture through the worker → remove", async () => {
    const { service, bundle } = setup();
    await service.start();
    expect(bundle.supports("ml.matting@1")).toBe(false);
    const before = service
      .snapshot()
      .models.find((m) => m.entry.id === "paged.fixture.matte")!;
    expect(before.installed).toBeNull();
    expect(before.healthy).toBe(false);

    await service.install("paged.fixture.matte", {
      consented: true,
      licenceAcknowledged: false,
    });
    const after = service
      .snapshot()
      .models.find((m) => m.entry.id === "paged.fixture.matte")!;
    expect(after.installed?.variant).toBe("fp32");
    expect(after.healthy).toBe(true);
    expect(service.snapshot().diskTotal).toBeGreaterThan(147);
    expect(bundle.supports("ml.matting@1")).toBe(true);

    const r = await bundle.ml.matting({ image: grey(0) });
    expect(r).toMatchObject({
      provider: "paged.ml.paged.fixture.matte",
      tier: "A",
      model: "paged.fixture.matte@fp32",
    });
    expect([...r.alpha.data]).toEqual(new Array(16).fill(128)); // sigmoid(0) = 0.5
    const bright = await bundle.ml.matting({ image: grey(255) });
    expect(bright.alpha.data[0]).toBe(Math.round(255 / (1 + Math.exp(-1)))); // sigmoid(1)
    expect(service.snapshot().models[0]!.detail).toBe("wasm");

    await service.remove("paged.fixture.matte");
    expect(bundle.supports("ml.matting@1")).toBe(false);
    expect(service.snapshot().diskTotal).toBe(0);
    await expect(bundle.ml.matting({ image: grey(0) })).rejects.toThrow(
      /no model installed/,
    );
    service.dispose();
  });

  test("the chosen quantisation is what installs, and it persists", async () => {
    covers("setting:paged.ml.settings");
    const settings = memorySettings();
    const { service, net } = setup(settings);
    await service.start();
    service.chooseVariant("paged.fixture.matte", "hard");
    await service.install("paged.fixture.matte", {
      consented: true,
      licenceAcknowledged: false,
    });
    expect(net.asked.at(-1)).toMatch(/matte-hard-sigmoid\.onnx$/);
    expect(readMlSettings(settings.value).variants).toEqual({
      "paged.fixture.matte": "hard",
    });
    expect(() => service.chooseVariant("paged.fixture.matte", "Q9")).toThrow(
      /no variant/,
    );
    service.dispose();
  });

  test("a refused install leaves nothing installed and says why", async () => {
    const { service, bundle } = setup();
    await service.start();
    await expect(
      service.install("paged.fixture.matte", {
        consented: false,
        licenceAcknowledged: false,
      }),
    ).rejects.toThrow(/consent/);
    const m = service.snapshot().models[0]!;
    expect(m.installed).toBeNull();
    expect(m.error).toMatch(/consent/);
    expect(bundle.supports("ml.matting@1")).toBe(false);
    service.dispose();
  });

  test("Tier B: the licence first, then the paths; generate turns true when the host is ready", async () => {
    const { service, bundle, host, settings } = setup();
    await service.start();
    expect(service.snapshot().host.health?.ready).toBe(false);
    expect(bundle.supports("ml.generate@1")).toBe(false);
    const paths = {
      sdBinary: "/opt/sd",
      diffusionModel: "/m/q.gguf",
      textEncoder: "/m/te.gguf",
      vae: "/m/vae.safetensors",
    };
    await expect(
      service.configureHost("qwen-image-2.1", paths),
    ).rejects.toThrow(/acknowledge the Qwen Research License first/);
    expect(host.configured).toBeNull();

    service.acknowledgeLicence("qwen-image-2.1", true);
    expect(readMlSettings(settings.value).acknowledged).toEqual({
      "qwen-image-2.1": "LicenseRef-Qwen-Research",
    });
    await service.configureHost("qwen-image-2.1", paths);
    expect(host.configured).toMatchObject({
      sdBinary: "/opt/sd",
      model: {
        id: "qwen-image-2.1",
        licenceId: "LicenseRef-Qwen-Research",
        licenceAcknowledged: true,
        vae: "/m/vae.safetensors",
      },
    });
    expect(service.snapshot().host.health?.ready).toBe(true);
    expect(bundle.supports("ml.generate@1")).toBe(true);
    const g = await bundle.ml.generate({
      prompt: "a lighthouse",
      width: 64,
      height: 64,
    });
    expect(g).toMatchObject({
      provider: "paged.ml-host",
      tier: "B",
      model: "qwen-image-2.1",
    });
    const tried = await service.tryModel("qwen-image-2.1");
    expect(tried.provider).toBe("paged.ml-host");
    service.dispose();
  });

  test("a changed licence id asks again; stored settings are shape-checked", () => {
    covers("setting:paged.ml.settings");
    expect(
      readMlSettings(
        '{"variants":{"a":"b"},"acknowledged":{"x":"old-licence"}}',
      ),
    ).toEqual({ variants: { a: "b" }, acknowledged: { x: "old-licence" } });
    expect(readMlSettings('{"variants":5,"acknowledged":["x"]}')).toEqual({
      variants: {},
      acknowledged: {},
    });
    expect(readMlSettings("not json")).toEqual({
      variants: {},
      acknowledged: {},
    });
    const { service } = setup(
      memorySettings('{"acknowledged":{"qwen-image-2.1":"Apache-2.0"}}'),
    );
    expect(
      service.snapshot().models.find((m) => m.entry.id === "qwen-image-2.1")!
        .acknowledged,
    ).toBe(false);
  });
});
