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

// The client's half of the SVG size limit (`paged_svg::limits`): a file
// over 32 MiB is answered by the client, with the engine's reply shape,
// and never posted (it would ride the JSON channel as a number array the
// worker cannot buffer). A file at the limit is posted as before, and the
// client goes on answering after a refusal.

import { describe, expect, test } from "bun:test";

import { CanvasClient } from "@paged-media/client";

const LIMIT = 32 * 1024 * 1024;

/** A worker that records what is posted and answers every channel
 *  message with an empty plan. */
function fakeWorker() {
  const posted: unknown[] = [];
  let listener: ((e: MessageEvent) => void) | null = null;
  const worker = {
    addEventListener(kind: string, l: (e: MessageEvent) => void) {
      if (kind === "message") listener = l;
    },
    removeEventListener() {},
    terminate() {},
    postMessage(data: { kind: string; msg?: { seq: number } }) {
      posted.push(data);
      if (data.kind !== "channel" || !data.msg) return;
      const seq = data.msg.seq;
      queueMicrotask(() =>
        listener?.({
          data: {
            seq,
            protocol: 0,
            kind: "svgImportPlanned",
            payload: {
              mutation: null,
              report: { items: 0, notes: [] },
              width: 0,
              height: 0,
              error: "the SVG draws nothing",
            },
          },
        } as MessageEvent),
      );
    },
  };
  return { worker, posted };
}

describe("svg import size limit", () => {
  test("a file over the limit is refused by the client, not posted", async () => {
    const { worker, posted } = fakeWorker();
    const client = new CanvasClient({
      workerFactory: () => worker as unknown as Worker,
    });
    const before = posted.length;
    const plan = await client.svgImportPlan("p1", new Uint8Array(LIMIT + 1));
    expect(plan.mutation).toBeNull();
    expect(plan.error).toContain("too large");
    expect(posted.length).toBe(before);

    // The client goes on: a small file is posted and its reply resolves.
    const small = new TextEncoder().encode("<svg/>");
    const next = await client.svgImportPlan("p1", small);
    expect(next.error).toBe("the SVG draws nothing");
    expect(posted.length).toBe(before + 1);
  });
});
