/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// K-3 / S-07 / I-02 — the WORKER door (host.workers.spawn /
// BundleWorker) over a MOCK WorkerBackend (an in-memory echo worker, no
// real Worker realm). Pins: the feature probe + capability gate, the
// concurrency cap, the post→onMessage round-trip, the allocateShared
// byte budget + the sharedMemory/cross-origin-isolation gates, and that
// bundle dispose terminates every spawned worker.

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PagedEditor,
  PluginManifest,
  WorkersCapability,
} from "@paged-media/plugin-api";

import {
  createBundleHost,
  type SpawnedWorker,
  type WorkerBackend,
} from "../src/host-impl";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const mapBacking = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => Array.from(m.keys()),
  };
};

const MANIFEST = (workers?: WorkersCapability): PluginManifest => ({
  id: "media.paged.k3",
  name: "k3",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: workers ? { workers } : {},
  contributes: {},
});

/** A mock WorkerBackend whose workers ECHO every posted message back to
 *  their onMessage subscribers (the round-trip a real decode worker
 *  performs: receive bytes → post a result). Records spawns/terminates so
 *  the teardown assertion can see them. The injected `module` path is
 *  recorded verbatim (the declared-only contract — the SDK never invents
 *  a URL). */
function makeMockWorkerBackend() {
  const spawned: Array<{ module: string; name?: string; alive: boolean }> = [];
  const backend: WorkerBackend = {
    async spawn(_pluginId, module, name) {
      const record = { module, name, alive: true };
      spawned.push(record);
      const handlers = new Set<(m: unknown) => void>();
      const worker: SpawnedWorker = {
        post(message) {
          // Echo asynchronously, mirroring a real worker's message turn.
          queueMicrotask(() => {
            for (const h of handlers) h({ echo: message });
          });
        },
        onMessage(handler) {
          handlers.add(handler);
          return { dispose: () => handlers.delete(handler) };
        },
        terminate() {
          record.alive = false;
          handlers.clear();
        },
      };
      return worker;
    },
  };
  return { backend, spawned };
}

function makeHost(workers: WorkersCapability | undefined, withBackend: boolean) {
  const mock = makeMockWorkerBackend();
  const handle = createBundleHost(
    () => ({}) as unknown as PagedEditor,
    MANIFEST(workers),
    {
      console: silent,
      storage: mapBacking(),
      capabilityMode: "enforce",
      ...(withBackend ? { workers: mock.backend } : {}),
    },
  );
  return { ...handle, mock };
}

// SharedArrayBuffer + crossOriginIsolated are not present in the default
// vitest (node) environment. Stub them so the SAB budget path is testable
// without a cross-origin-isolated browser.
let restoreGlobals: Array<() => void> = [];
function withCrossOriginIsolation(on: boolean) {
  const g = globalThis as Record<string, unknown>;
  const prevCoi = Object.getOwnPropertyDescriptor(g, "crossOriginIsolated");
  Object.defineProperty(g, "crossOriginIsolated", {
    value: on,
    configurable: true,
  });
  restoreGlobals.push(() => {
    if (prevCoi) Object.defineProperty(g, "crossOriginIsolated", prevCoi);
    else delete g.crossOriginIsolated;
  });
  // Node 20 has SharedArrayBuffer globally; nothing to stub there.
}

afterEach(() => {
  for (const r of restoreGlobals.splice(0)) r();
  vi.restoreAllMocks();
});

describe("host.workers (K-3, mock backend)", () => {
  it("probes workers@1 only when a backend is wired", () => {
    const wired = makeHost({ max: 4 }, true);
    expect(wired.host.supports("workers@1")).toBe(true);
    const unwired = makeHost({ max: 4 }, false);
    expect(unwired.host.supports("workers@1")).toBe(false);
  });

  it("clamps concurrency to min(declared, hardwareConcurrency, 8)", () => {
    // navigator.hardwareConcurrency may be undefined in node → treated as
    // 1 by the adapter; assert the grant never EXCEEDS the declared max
    // and is at least 1 when a backend is wired.
    const { host } = makeHost({ max: 6 }, true);
    const grant = host.workers.concurrency();
    expect(grant).toBeGreaterThanOrEqual(1);
    expect(grant).toBeLessThanOrEqual(6);
    // No backend → 0 (the door is dormant).
    const { host: noBackend } = makeHost({ max: 6 }, false);
    expect(noBackend.workers.concurrency()).toBe(0);
  });

  it("spawn → post → onMessage echoes a round-trip", async () => {
    const { host, mock } = makeHost({ max: 2 }, true);
    const worker = await host.workers.spawn({ module: "workers/decode.js" });
    // The declared module crossed verbatim (declared-only; no invented URL).
    expect(mock.spawned[0].module).toBe("workers/decode.js");

    const got: unknown[] = [];
    worker.onMessage((m) => got.push(m));
    worker.post({ decode: [1, 2, 3] });
    // Drain the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(got).toEqual([{ echo: { decode: [1, 2, 3] } }]);
  });

  it("gates on capabilities.workers (undeclared spawn rejects)", async () => {
    const { host } = makeHost(undefined, true);
    await expect(
      host.workers.spawn({ module: "workers/decode.js" }),
    ).rejects.toThrow(/capabilities\.workers/);
  });

  it("no backend wired → spawn rejects honestly", async () => {
    const { host } = makeHost({ max: 2 }, false);
    expect(host.supports("workers@1")).toBe(false);
    await expect(
      host.workers.spawn({ module: "workers/decode.js" }),
    ).rejects.toThrow(/no worker backend wired/);
  });

  it("enforces the worker-count cap", async () => {
    // Declared max 1 → exactly one live worker; the second spawn rejects
    // until one terminates.
    const { host } = makeHost({ max: 1 }, true);
    expect(host.workers.concurrency()).toBe(1);
    const w1 = await host.workers.spawn({ module: "workers/decode.js" });
    await expect(
      host.workers.spawn({ module: "workers/decode.js" }),
    ).rejects.toThrow(/count cap/);
    // Terminating frees the slot.
    w1.terminate();
    const w2 = await host.workers.spawn({ module: "workers/decode.js" });
    expect(w2).toBeTruthy();
  });

  it("allocateShared honors the byte budget (over-cap rejects, under-cap returns a real SAB)", async () => {
    withCrossOriginIsolation(true);
    const workers: WorkersCapability = {
      max: 1,
      sharedMemory: true,
      maxSharedBytes: 1024, // tighten the budget for the test
    };
    const { host } = makeHost(workers, true);
    const worker = await host.workers.spawn({ module: "workers/decode.js" });

    // Under-cap → a real SharedArrayBuffer.
    const sab = worker.allocateShared(512);
    expect(sab).toBeInstanceOf(SharedArrayBuffer);
    expect(sab?.byteLength).toBe(512);

    // The next 512 fits exactly (1024 total); a further byte is over-cap.
    const sab2 = worker.allocateShared(512);
    expect(sab2).toBeInstanceOf(SharedArrayBuffer);
    expect(worker.allocateShared(1)).toBeNull();
  });

  it("allocateShared returns null without the sharedMemory declaration", async () => {
    withCrossOriginIsolation(true);
    const { host } = makeHost({ max: 1 }, true); // sharedMemory absent
    const worker = await host.workers.spawn({ module: "workers/decode.js" });
    expect(worker.allocateShared(16)).toBeNull();
  });

  it("allocateShared returns null when not cross-origin isolated", async () => {
    withCrossOriginIsolation(false);
    const { host } = makeHost({ max: 1, sharedMemory: true }, true);
    const worker = await host.workers.spawn({ module: "workers/decode.js" });
    expect(worker.allocateShared(16)).toBeNull();
  });

  it("bundle dispose terminates every spawned worker", async () => {
    const { host, dispose, mock } = makeHost({ max: 4 }, true);
    await host.workers.spawn({ module: "workers/a.js" });
    await host.workers.spawn({ module: "workers/b.js" });
    expect(mock.spawned.filter((s) => s.alive).length).toBe(2);
    dispose();
    // Every spawned worker was terminated by the host facade.
    expect(mock.spawned.every((s) => !s.alive)).toBe(true);
  });

  it("a SAB budget is reclaimed when a worker terminates", async () => {
    withCrossOriginIsolation(true);
    const { host } = makeHost(
      { max: 2, sharedMemory: true, maxSharedBytes: 1024 },
      true,
    );
    const w1 = await host.workers.spawn({ module: "workers/a.js" });
    expect(w1.allocateShared(1024)).toBeInstanceOf(SharedArrayBuffer);
    // A second worker's allocation is over the shared per-bundle budget…
    const w2 = await host.workers.spawn({ module: "workers/b.js" });
    expect(w2.allocateShared(1)).toBeNull();
    // …until w1 terminates and returns its budget.
    w1.terminate();
    expect(w2.allocateShared(512)).toBeInstanceOf(SharedArrayBuffer);
  });
});
