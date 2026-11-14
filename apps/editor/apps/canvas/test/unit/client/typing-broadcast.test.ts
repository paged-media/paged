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

// Editor ADR 1232 amendment (F-56): a typed insert's change reaches the
// client's subscribers — the panels that re-read the document on every
// change — once per burst, not once per key. The caller's own promise
// settles at once; another change of the document lets the held one out
// first, so subscribers still see the changes in the order they were made.

import { describe, expect, test } from "bun:test";

import {
  CanvasClient,
  PROTOCOL_VERSION,
  TYPING_SETTLE_MS,
} from "@paged-media/client";
import type { WorkerToMain } from "@paged-media/client";

type Listener = (event: { data: unknown }) => void;

/** A worker that answers every mutate with `mutationApplied` on page
 *  `p<n>` and every read with an empty `documentMetaReply`. */
function answeringWorker(): Worker {
  const listeners = new Set<Listener>();
  let n = 0;
  const post = (data: unknown) =>
    queueMicrotask(() => {
      for (const l of listeners) l({ data });
    });
  return {
    postMessage(m: { kind: string; msg?: { seq: number; kind: string } }) {
      if (m.kind !== "channel" || !m.msg) return;
      const { seq, kind } = m.msg;
      if (kind === "mutate" || kind === "undo") {
        n += 1;
        post({
          seq,
          protocol: PROTOCOL_VERSION,
          kind: kind === "mutate" ? "mutationApplied" : "undoApplied",
          payload: {
            clientSeq: seq,
            appliedSeq: n,
            undoneSeq: n,
            pageIds: [`p${n}`],
            cacheStats: {
              hits: 0,
              misses: 0,
              len: 0,
              capacity: 0,
              rebuildMs: 1,
            },
          },
        });
      } else {
        post({
          seq,
          protocol: PROTOCOL_VERSION,
          kind: "documentMetaReply",
          payload: { meta: {} },
        });
      }
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

const insert = (offset: number) =>
  ({
    op: "insertText",
    args: { storyId: "s1", offset, text: "x" },
  }) as never;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("typed changes reach subscribers once per burst", () => {
  test("three typed inserts: three settled calls, one merged change after the keys stop", async () => {
    const client = new CanvasClient({ workerFactory: answeringWorker });
    const seen: WorkerToMain[] = [];
    client.subscribe((m) => {
      if (m.kind === "mutationApplied") seen.push(m);
    });
    for (let i = 0; i < 3; i++) {
      const reply = await client.mutate(insert(i), { typing: true });
      expect(reply.kind).toBe("mutationApplied");
      // A read in between neither waits nor lets the change out.
      await client.send({ kind: "requestDocumentMeta" });
    }
    expect(seen).toHaveLength(0);
    await wait(TYPING_SETTLE_MS + 60);
    expect(seen).toHaveLength(1);
    const merged = seen[0]!;
    if (merged.kind !== "mutationApplied") throw new Error("kind");
    expect([...merged.payload.pageIds].sort()).toEqual(["p1", "p2", "p3"]);
    expect(merged.payload.appliedSeq).toBe(3);
  });

  test("another change lets the held one out first, in order; an untyped write is not held", async () => {
    const client = new CanvasClient({ workerFactory: answeringWorker });
    const seen: string[] = [];
    client.subscribe((m) => {
      if (m.kind === "mutationApplied" || m.kind === "undoApplied") {
        seen.push(`${m.kind} ${m.payload.pageIds.join(",")}`);
      }
    });
    await client.mutate(insert(0), { typing: true });
    await client.send({ kind: "undo" } as never);
    expect(seen).toEqual(["mutationApplied p1", "undoApplied p2"]);
    await client.mutate(insert(0));
    expect(seen).toEqual([
      "mutationApplied p1",
      "undoApplied p2",
      "mutationApplied p3",
    ]);
  });
});
