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

// A GPU page readback crosses the worker boundary as bytes. The worker
// answers `renderPageVelloPng` with the glue's `Uint8Array` and lists its
// buffer for transfer (worker/bytes-reply.ts); the client hands that array
// to the caller. No `number[]` on the way, and no copy of a buffer the
// reply owns.

import { describe, expect, test } from "bun:test";

import { CanvasClient } from "@paged-media/client";

import { ownedBytes, velloPngReply } from "../../../src/worker/bytes-reply";

type Listener = (event: { data: unknown }) => void;

/** A worker that answers `renderPageVelloPng` with `answer`'s reply, posted
 *  the way a real worker posts: structured clone, honouring the transfer
 *  list. `seen` keeps what arrived on the main thread. */
function pngWorker(
  answer: (seq: number) => { message: unknown; transfer: Transferable[] },
  seen: unknown[],
): Worker {
  const listeners = new Set<Listener>();
  return {
    postMessage(m: { kind: string; seq?: number }) {
      if (m.kind !== "renderPageVelloPng" || m.seq === undefined) return;
      const { message, transfer } = answer(m.seq);
      const data = structuredClone(message, { transfer });
      seen.push(data);
      queueMicrotask(() => {
        for (const l of listeners) l({ data });
      });
    },
    addEventListener(type: string, l: Listener) {
      if (type === "message") listeners.add(l);
    },
    removeEventListener(type: string, l: Listener) {
      if (type === "message") listeners.delete(l);
    },
    terminate() {},
  } as unknown as Worker;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

describe("the vello PNG reply", () => {
  test("carries a Uint8Array and lists its buffer for transfer", () => {
    const png = Uint8Array.from(PNG);
    const { message, transfer } = velloPngReply(7, png);
    expect(message.pngBytes).toBe(png);
    expect(Array.isArray(message.pngBytes)).toBe(false);
    expect(transfer).toEqual([png.buffer]);
    expect(velloPngReply(8, undefined)).toEqual({
      message: { kind: "velloPngReply", seq: 8, pngBytes: null },
      transfer: [],
    });
  });

  test("a view onto a larger buffer (wasm memory) is copied, never transferred", () => {
    const memory = new Uint8Array(64);
    memory.set(PNG, 16);
    const view = memory.subarray(16, 16 + PNG.length);
    const { message, transfer } = velloPngReply(1, view);
    expect(message.pngBytes).not.toBe(view);
    expect([...message.pngBytes!]).toEqual(PNG);
    expect(transfer).toEqual([message.pngBytes!.buffer]);
    structuredClone(message, { transfer });
    // The memory the view was on is whole.
    expect(memory.byteLength).toBe(64);
    expect([...view]).toEqual(PNG);

    const shared = new Uint8Array(new SharedArrayBuffer(PNG.length));
    shared.set(PNG);
    const owned = ownedBytes(shared);
    expect(owned.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...owned]).toEqual(PNG);
  });

  test("the client resolves the transferred bytes as a Uint8Array", async () => {
    const png = Uint8Array.from(PNG);
    const seen: unknown[] = [];
    const client = new CanvasClient({
      workerFactory: () => pngWorker((seq) => velloPngReply(seq, png), seen),
    });
    const bytes = await client.requestVelloPng("page-1", 150);
    // What crossed the boundary is the typed array, not a number[].
    const crossed = (seen[0] as { pngBytes: unknown }).pngBytes;
    expect(crossed).toBeInstanceOf(Uint8Array);
    expect(bytes).toBe(crossed as Uint8Array);
    expect([...bytes!]).toEqual(PNG);
    // The buffer moved: the worker's array is detached, nothing was copied.
    expect(png.byteLength).toBe(0);
  });

  test("the client still reads a number[] reply, and null", async () => {
    const legacy = new CanvasClient({
      workerFactory: () =>
        pngWorker(
          (seq) => ({
            message: { kind: "velloPngReply", seq, pngBytes: [...PNG] },
            transfer: [],
          }),
          [],
        ),
    });
    const bytes = await legacy.requestVelloPng("page-1", 150);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes!]).toEqual(PNG);

    const none = new CanvasClient({
      workerFactory: () => pngWorker((seq) => velloPngReply(seq, null), []),
    });
    expect(await none.requestVelloPng("page-1", 150)).toBeNull();
  });
});
