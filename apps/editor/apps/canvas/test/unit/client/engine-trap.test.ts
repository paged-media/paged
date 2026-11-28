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

// A WebAssembly trap in the worker is fatal. The worker stops calling the
// engine and reports `engineTrapped` (worker/trap.ts); the client rejects
// every caller, refuses later requests and notifies `onFatal`, which is
// what the engine-failure notice shows on.

import { describe, expect, test } from "bun:test";

import { CanvasClient, PROTOCOL_VERSION } from "@paged-media/client";

import { ENGINE_TRAPPED, isEngineTrap } from "../../../src/worker/trap";

type Listener = (event: { data: unknown }) => void;

/** A worker whose engine traps on the first request it dispatches, the
 *  way worker.ts answers one: `engineTrapped` with the request's seq. */
function trappingWorker(): Worker {
  const listeners = new Set<Listener>();
  return {
    postMessage(m: { kind: string; msg?: { seq: number } }) {
      if (m.kind !== "channel" || !m.msg) return;
      const { seq } = m.msg;
      queueMicrotask(() => {
        for (const l of listeners)
          l({
            data: {
              seq,
              protocol: PROTOCOL_VERSION,
              kind: "warning",
              payload: {
                kind: ENGINE_TRAPPED,
                details: "RuntimeError: unreachable",
              },
            },
          });
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

describe("a trap in the engine", () => {
  test("is a WebAssembly.RuntimeError, not any error the glue throws", () => {
    expect(isEngineTrap(new WebAssembly.RuntimeError("unreachable"))).toBe(
      true,
    );
    expect(isEngineTrap({ name: "RuntimeError", message: "x" })).toBe(true);
    expect(isEngineTrap(new Error("recursive use of an object"))).toBe(false);
    expect(isEngineTrap(new TypeError("bad argument"))).toBe(false);
    expect(isEngineTrap("RuntimeError")).toBe(false);
    expect(isEngineTrap(null)).toBe(false);
  });

  test("fails the client: every caller rejected, later requests refused, onFatal notified once", async () => {
    const client = new CanvasClient({ workerFactory: trappingWorker });
    const fatal: string[] = [];
    client.onFatal((e) => void fatal.push(e.message));
    expect(client.failure).toBeNull();

    const first = client.send({ kind: "requestDocumentMeta" });
    const second = client.send({ kind: "requestDocumentMeta" });
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    expect(String((outcomes[0] as PromiseRejectedResult).reason)).toContain(
      "canvas engine stopped: RuntimeError: unreachable",
    );
    expect(client.failure?.message).toContain("canvas engine stopped");
    expect(fatal).toHaveLength(1);

    // Nothing is sent to a poisoned engine again.
    await expect(client.send({ kind: "requestDocumentMeta" })).rejects.toThrow(
      "canvas engine stopped",
    );
    expect(fatal).toHaveLength(1);
  });
});
