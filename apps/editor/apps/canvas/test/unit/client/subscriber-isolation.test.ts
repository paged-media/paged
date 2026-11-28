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

// A subscriber that throws is its own failure: the subscribers after it
// still hear the message (the recovery journal, the dirty flag, the panels
// that re-read the document), and the failure is reported once per
// subscriber, not once per message.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { CanvasClient, PROTOCOL_VERSION } from "@paged-media/client";

type Listener = (event: { data: unknown }) => void;

/** A worker that answers every mutate with `mutationApplied`. */
function answeringWorker(): Worker {
  const listeners = new Set<Listener>();
  let n = 0;
  return {
    postMessage(m: { kind: string; msg?: { seq: number; kind: string } }) {
      if (m.kind !== "channel" || !m.msg) return;
      const { seq } = m.msg;
      n += 1;
      const applied = n;
      queueMicrotask(() => {
        for (const l of listeners)
          l({
            data: {
              seq,
              protocol: PROTOCOL_VERSION,
              kind: "mutationApplied",
              payload: {
                clientSeq: seq,
                appliedSeq: applied,
                pageIds: ["p1"],
                cacheStats: {
                  hits: 0,
                  misses: 0,
                  len: 0,
                  capacity: 0,
                  rebuildMs: 1,
                },
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
    set onmessage(l: Listener | null) {
      if (l) listeners.add(l);
    },
  } as unknown as Worker;
}

const edit = { op: "deletePage", args: { pageId: "p1" } } as never;

let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => errors.mockRestore());

describe("a subscriber that throws", () => {
  test("does not keep later subscribers from the message, and is reported once", async () => {
    const client = new CanvasClient({ workerFactory: answeringWorker });
    const before: string[] = [];
    const after: string[] = [];
    client.subscribe((m) => void before.push(m.kind));
    client.subscribe(() => {
      throw new Error("a panel read a row that is gone");
    });
    client.subscribe((m) => void after.push(m.kind));

    // The caller's own promise settles as well.
    expect((await client.mutate(edit)).kind).toBe("mutationApplied");
    expect((await client.mutate(edit)).kind).toBe("mutationApplied");
    expect(before).toEqual(["mutationApplied", "mutationApplied"]);
    expect(after).toEqual(["mutationApplied", "mutationApplied"]);
    // The edit count every later reader depends on moved with both.
    expect(client.editMark).toBe(2);
    // Reported once for the subscriber, not once per message.
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toContain("mutationApplied");
  });

  test("the saved notification is isolated the same way", () => {
    const client = new CanvasClient({ workerFactory: answeringWorker });
    let heard = 0;
    client.onSaved(() => {
      throw new Error("no");
    });
    client.onSaved(() => {
      heard += 1;
    });
    client.markSaved();
    client.markSaved();
    expect(heard).toBe(2);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});
