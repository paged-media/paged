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

// The client half of a binary load whose dispatch throws in the worker.
// A scripted worker answers each message the way the real one does when
// its dispatch throws: a `dispatchError` warning naming the request's seq.
// For a `send` the client rejects that caller; for a `loadDocument` it does
// not (WRK-2), so the load stays pending even once the worker names it
// (the worker does not name it yet: WRK-1, tests/worker-boot.spec.ts).

import { describe, expect, test } from "bun:test";

import { CanvasClient, PROTOCOL_VERSION } from "@paged-media/client";

type Listener = (event: { data: unknown }) => void;

/** A worker whose every dispatch throws. */
function throwingWorker(): Worker {
  const listeners = new Set<Listener>();
  const post = (data: unknown) =>
    queueMicrotask(() => {
      for (const l of listeners) l({ data });
    });
  return {
    postMessage(m: { kind: string; seq?: number; msg?: { seq: number } }) {
      const seq =
        m.kind === "loadDocumentBinary"
          ? m.seq
          : m.kind === "channel"
            ? m.msg?.seq
            : undefined;
      if (seq === undefined) return;
      post({
        seq,
        protocol: PROTOCOL_VERSION,
        kind: "warning",
        payload: { kind: "dispatchError", details: `${m.kind}: boom` },
      });
    },
    addEventListener(type: string, l: Listener) {
      if (type === "message") listeners.add(l);
    },
    removeEventListener(type: string, l: Listener) {
      if (type === "message") listeners.delete(l);
    },
    terminate() {},
    set onmessage(l: Listener | null) {
      if (l) listeners.add(l);
    },
  } as unknown as Worker;
}

/** How a promise ends within `ms`: resolved, rejected, or still pending. */
const outcome = (p: Promise<unknown>, ms = 300) =>
  Promise.race([
    p.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((r) => setTimeout(() => r("pending"), ms)),
  ]);

describe("a dispatch that throws, answered with the request's seq", () => {
  test("a send is rejected", async () => {
    const client = new CanvasClient({ workerFactory: throwingWorker });
    expect(await outcome(client.send({ kind: "requestDocumentMeta" }))).toBe(
      "rejected",
    );
  });

  // Finding WRK-2: `settleFromWarning` settles a `dispatchError` only for
  // `pending` and `bytesPending`, never for `loadDocPending`, so a load
  // whose dispatch threw stays pending for good (and every later
  // `registerDocumentFont` waits behind it).
  test.failing("WRK-2: a load is rejected", async () => {
    const client = new CanvasClient({ workerFactory: throwingWorker });
    expect(await outcome(client.loadDocument(new Uint8Array([1, 2, 3])))).toBe(
      "rejected",
    );
  });
});
