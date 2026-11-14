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

// Engine ADR 1314 — the client half of a progressive load. A small
// document's last composition step can reach the client before the shell
// has set the handle the load answered (the step is the worker's next
// task); `composedHandle` turns that handle final whenever it is asked,
// with the final build's page list, and `whenComposed` no longer waits.

import { describe, expect, test } from "bun:test";

import { CanvasClient, PROTOCOL_VERSION } from "@paged-media/client";
import type { DocumentHandle } from "@paged-media/client";

type Listener = (event: { data: unknown }) => void;

const handle = {
  docId: "d1",
  pageCount: 2,
  pageIds: ["p1", "p2"],
  pageSizesPt: [
    [612, 792],
    [612, 792],
  ],
  pageOriginsPt: [
    [0, 0],
    [0, 812],
  ],
  provisional: true,
  composedPages: ["p1"],
};

/** A worker that answers a binary load with a provisional document and,
 *  as its next task, the composition's last step: a growing story added
 *  page 3 (`last: false` sends one step that composes page 2 instead). */
function composingWorker(last = true): Worker {
  const listeners = new Set<Listener>();
  const post = (data: unknown) =>
    setTimeout(() => {
      for (const l of listeners) l({ data });
    }, 0);
  return {
    postMessage(m: { kind: string; seq?: number }) {
      if (m.kind !== "loadDocumentBinary") return;
      post({
        kind: "loadDocumentBinaryReply",
        seq: m.seq,
        replyJson: JSON.stringify({
          seq: m.seq,
          protocol: PROTOCOL_VERSION,
          kind: "documentLoaded",
          payload: handle,
        }),
      });
      post({
        seq: null,
        protocol: PROTOCOL_VERSION,
        kind: "compositionProgress",
        payload: last
          ? {
              pageIds: ["p1", "p2", "p3"],
              composed: 3,
              pageCount: 3,
              done: true,
              pageStructureChanged: true,
              pageSizesPt: [
                [612, 792],
                [612, 792],
                [612, 792],
              ],
              pageOriginsPt: [
                [0, 0],
                [0, 812],
                [0, 1624],
              ],
            }
          : {
              pageIds: ["p2"],
              composed: 2,
              pageCount: 2,
              done: false,
              pageStructureChanged: false,
            },
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

/** Let the scripted worker's queued messages arrive. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("engine ADR 1314: the handle of a progressive load", () => {
  test("the last step turns the handle the load answered final, with the final build's pages", async () => {
    const client = new CanvasClient({ workerFactory: () => composingWorker() });
    const loaded = await client.loadDocument(
      new Uint8Array([1]),
      new Uint8Array([2]),
      undefined,
      { firstPages: [0] },
    );
    await settle();
    expect(loaded.provisional).toBe(true);
    expect(client.isProvisional()).toBe(false);
    await client.whenComposed();
    const final: DocumentHandle = client.composedHandle(loaded);
    expect(final.provisional).toBe(false);
    expect(final.pageIds).toEqual(["p1", "p2", "p3"]);
    expect(final.pageCount).toBe(3);
    expect(final.pageOriginsPt?.[2]).toEqual([0, 1624]);
  });

  test("while the composition goes on, the handle stays as it is", async () => {
    const client = new CanvasClient({
      workerFactory: () => composingWorker(false),
    });
    const loaded = await client.loadDocument(
      new Uint8Array([1]),
      new Uint8Array([2]),
      undefined,
      { firstPages: [0] },
    );
    await settle();
    expect(client.isProvisional()).toBe(true);
    expect(client.composedHandle(loaded)).toBe(loaded);
  });

  test("a handle that is not provisional comes back as it is", async () => {
    const client = new CanvasClient({ workerFactory: () => composingWorker() });
    const whole = { ...handle, provisional: undefined, composedPages: [] };
    expect(client.composedHandle(whole as unknown as DocumentHandle)).toBe(
      whole as unknown as DocumentHandle,
    );
  });
});
