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

// K-3 / S-07 / I-02 — the paged.image DECODE POOL (the live consumer of
// host.workers) over a MOCK WorkerBackend whose workers run the REAL
// image-js decode in-process (Node, CPU lanes — the same decode the worker
// module performs, here without a Worker realm so it is unit-testable).
// Pins: the pool spawns the GRANTED cap of workers, a decode round-trips
// the codec output, a batch fans out across the pool, dispose terminates
// every worker, and the honest null when the host wires no workers.

import { describe, expect, it } from "bun:test";

import { createBundleHost, type WorkerBackend } from "@paged-media/plugin-sdk";
import type { PagedEditor, PluginManifest } from "@paged-media/plugin-api";

import manifestJson from "@paged-media/image-manifest/manifest.json";

import { createDecodePool, DECODE_WORKER_MODULE } from "../src/decode-pool";
import {
  decodeReply,
  type DecodeReply,
  type DecodeRequest,
} from "../src/decode-worker";
import { bootEngine, displayTreatmentOf } from "../src/engine";
import {
  makeFakeEditor,
  mapBacking,
  psdBytes,
  silentConsole,
  PSD_RGBA,
} from "./helpers";
import { png16 } from "./fixtures/png16";

// A mock WorkerBackend whose every "worker" decodes via the REAL engine
// wasm in-process (the worker module's logic, run on the main thread for
// the test). Records spawns + terminations so the cap + teardown can be
// asserted. The injected module path is checked against DECODE_WORKER_MODULE
// (the declared-only contract).
function makeDecodingBackend() {
  const spawned: Array<{ module: string; alive: boolean }> = [];
  const enginePromise = bootEngine();
  const backend: WorkerBackend = {
    async spawn(_pluginId, module) {
      expect(module).toBe(DECODE_WORKER_MODULE);
      const record = { module, alive: true };
      spawned.push(record);
      const handlers = new Set<(m: unknown) => void>();
      return {
        post(message) {
          const req = message as DecodeRequest;
          void (async () => {
            const engine = await enginePromise;
            let reply: DecodeReply;
            try {
              // The worker decodes to an engine handle, then windows the
              // whole image out as RGBA8 (the decode-worker's contract).
              const info = engine.decode(req.bytes);
              const rgba = engine.tile(
                info.handle,
                0,
                0,
                info.width,
                info.height,
              );
              // A 16-bit source also hands over its samples (ADR 479).
              const samples16 =
                engine.imageBits(info.handle) === 16
                  ? Uint16Array.from(engine.imageSamples16(info.handle))
                  : undefined;
              engine.freeImage(info.handle);
              const out = new Uint8Array(rgba.length);
              out.set(rgba);
              reply = {
                id: req.id,
                ok: true,
                width: info.width,
                height: info.height,
                rgba: out.buffer,
                ...(samples16 ? { samples16: samples16.buffer } : {}),
              };
            } catch (err) {
              reply = {
                id: req.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
            for (const h of handlers) h(reply);
          })();
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
    },
  };
  return { backend, spawned };
}

function makeHost(withWorkers: boolean) {
  const fake = makeFakeEditor();
  const mock = makeDecodingBackend();
  const handle = createBundleHost(
    () => fake.editor as unknown as PagedEditor,
    manifestJson as PluginManifest,
    {
      console: silentConsole,
      storage: mapBacking(),
      ...(withWorkers ? { workers: mock.backend } : {}),
    },
  );
  return { ...handle, mock };
}

describe("the paged.image decode pool (K-3 consumer)", () => {
  it("spawns the granted cap of workers and decodes off-thread", async () => {
    const { host, mock } = makeHost(true);
    const pool = await createDecodePool(host);
    expect(pool).not.toBeNull();
    // The manifest declares max 4; the grant is min(4, hwConcurrency, 8) ≥ 1.
    const grant = host.workers.concurrency();
    expect(pool!.size()).toBe(grant);
    expect(mock.spawned.length).toBe(grant);
    expect(mock.spawned.every((s) => s.module === DECODE_WORKER_MODULE)).toBe(
      true,
    );

    // A real decode round-trips the codec output.
    const decoded = await pool!.decode(psdBytes());
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    expect(Array.from(decoded.rgba)).toEqual(PSD_RGBA);

    pool!.dispose();
  });

  it("hands a 16-bit source over at 16 bits (image ADR 479) [image.io.depth-color-modes]", async () => {
    const { host } = makeHost(true);
    const pool = await createDecodePool(host);
    const decoded = await pool!.decode(
      png16(3, 2, [0x1234, 0x8001, 0xfffe, 0xffff]),
    );
    expect(decoded.samples16).toBeDefined();
    expect(decoded.samples16!.length).toBe(3 * 2 * 4);
    expect(Array.from(decoded.samples16!.slice(0, 4))).toEqual([
      0x1234, 0x8001, 0xfffe, 0xffff,
    ]);
    // The 8-bit view rides along (the high byte).
    expect(Array.from(decoded.rgba.slice(0, 4))).toEqual([
      0x12, 0x80, 0xff, 0xff,
    ]);
    // An 8-bit source carries none.
    expect((await pool!.decode(psdBytes())).samples16).toBeUndefined();
    pool!.dispose();
  });

  it("decodes a batch in parallel across the pool", async () => {
    const { host } = makeHost(true);
    const pool = await createDecodePool(host);
    expect(pool).not.toBeNull();
    const batch = [psdBytes(), psdBytes(), psdBytes()];
    const results = await pool!.decodeBatch(batch);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.width).toBe(2);
      expect(Array.from(r.rgba)).toEqual(PSD_RGBA);
    }
    pool!.dispose();
  });

  it("dispose terminates every worker", async () => {
    const { host, mock } = makeHost(true);
    const pool = await createDecodePool(host);
    expect(mock.spawned.some((s) => s.alive)).toBe(true);
    pool!.dispose();
    expect(mock.spawned.every((s) => !s.alive)).toBe(true);
  });

  it("bundle dispose ALSO terminates the pool's workers (host teardown)", async () => {
    const { host, dispose, mock } = makeHost(true);
    await createDecodePool(host);
    expect(mock.spawned.some((s) => s.alive)).toBe(true);
    // The host facade tracks every spawned worker; tearing the bundle down
    // terminates them even without an explicit pool.dispose().
    dispose();
    expect(mock.spawned.every((s) => !s.alive)).toBe(true);
  });

  it("the worker's reply carries the display treatment and the 16-bit samples [image.io.depth-color-modes]", () => {
    // Code 3: a CMYK source converted through its profile on the worker.
    const samples16 = new Uint16Array(4);
    const { reply, transfer } = decodeReply(7, {
      width: 1,
      height: 1,
      rgba: new Uint8Array(4),
      display: 3,
      samples16,
    });
    expect(reply).toMatchObject({ id: 7, ok: true, display: 3 });
    expect(reply.ok && reply.samples16).toBe(samples16.buffer);
    expect(transfer.length).toBe(2);
    // Code 0 (managed) is a value, not an absence.
    const managed = decodeReply(8, {
      width: 1,
      height: 1,
      rgba: new Uint8Array(4),
      display: 0,
    }).reply;
    expect(managed.ok && managed.display).toBe(0);
    // An engine build without the field says nothing.
    const old = decodeReply(9, {
      width: 1,
      height: 1,
      rgba: new Uint8Array(4),
    }).reply;
    expect("display" in old).toBe(false);
  });

  it("the pool hands the worker's display treatment to the session [image.io.depth-color-modes]", async () => {
    // A worker that answers every request with a fixed treatment code.
    const replying = (display: number | undefined): WorkerBackend => ({
      async spawn() {
        const handlers = new Set<(m: unknown) => void>();
        return {
          post(message) {
            const { id } = message as DecodeRequest;
            const { reply } = decodeReply(id, {
              width: 1,
              height: 1,
              rgba: new Uint8Array(4),
              ...(display !== undefined ? { display } : {}),
            });
            queueMicrotask(() => {
              for (const h of handlers) h(reply);
            });
          },
          onMessage(handler) {
            handlers.add(handler);
            return { dispose: () => handlers.delete(handler) };
          },
          terminate() {
            handlers.clear();
          },
        };
      },
    });
    const poolOver = async (display: number | undefined) => {
      const fake = makeFakeEditor();
      const { host } = createBundleHost(
        () => fake.editor as unknown as PagedEditor,
        manifestJson as PluginManifest,
        {
          console: silentConsole,
          storage: mapBacking(),
          workers: replying(display),
        },
      );
      return (await createDecodePool(host))!;
    };
    for (const [code, name] of [
      [0, "managed"],
      [3, "cmyk-converted"],
      [undefined, "assumed-srgb"],
    ] as const) {
      const pool = await poolOver(code);
      const decoded = await pool.decode(new Uint8Array(1));
      expect(decoded.display).toBe(code);
      expect(displayTreatmentOf(decoded.display)).toBe(name);
      pool.dispose();
    }
  });

  it("returns null when the host wires no workers (honest main-thread fallback)", async () => {
    const { host } = makeHost(false);
    expect(host.supports("workers@1")).toBe(false);
    const pool = await createDecodePool(host);
    expect(pool).toBeNull();
  });
});
