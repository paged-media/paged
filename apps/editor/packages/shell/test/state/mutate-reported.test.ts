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

// A write nobody waits for (state/mutate-reported.ts): its refusal is
// reported through the editor's operation feedback instead of dropped.

import { describe, expect, test } from "bun:test";

import type { Mutation, WorkerToMain } from "@paged-media/client";

import {
  mutateReported,
  setMutationReportSink,
} from "../../src/state/mutate-reported";
import { createOperationFeedback } from "../../src/state/operation-feedback";

const unlink = { op: "unlinkFrames", args: { frame: "u1" } } as Mutation;

const applied = {
  kind: "mutationApplied",
  payload: { pageIds: [] },
} as unknown as WorkerToMain;
const refused = {
  kind: "mutationFailed",
  payload: {
    error: { kind: "locked", details: { node: "Layer 1", action: "edit" } },
  },
} as unknown as WorkerToMain;

function editor(
  answer: () => Promise<WorkerToMain>,
  failure: Error | null = null,
) {
  const feedback = createOperationFeedback();
  const calls: unknown[][] = [];
  const client = {
    failure,
    mutate: (...args: unknown[]) => {
      calls.push(args);
      return answer();
    },
  };
  setMutationReportSink(client as never, (r) => feedback.report(r));
  return { feedback, client: client as never, calls };
}

describe("mutateReported", () => {
  test("an applied write reports nothing and passes its options on", async () => {
    const { feedback, client, calls } = editor(async () => applied);
    const reply = await mutateReported(client, unlink, { coalesce: "k" });
    expect(reply?.kind).toBe("mutationApplied");
    expect(calls).toEqual([[unlink, { coalesce: "k" }]]);
    expect(feedback.snapshot().log).toHaveLength(0);
  });

  test("a refusal is a toast with the engine's words behind Details, once per kind of write", async () => {
    const { feedback, client } = editor(async () => refused);
    expect((await mutateReported(client, unlink))?.kind).toBe("mutationFailed");
    await mutateReported(client, unlink);
    const { toasts, problems } = feedback.snapshot();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.count).toBe(2);
    expect(toasts[0]!.report.outcome).toBe("blocked");
    expect(
      toasts[0]!.text.headline.startsWith("Could not apply the change"),
    ).toBe(true);
    expect(toasts[0]!.text.change).toBe("Nothing changed.");
    expect(toasts[0]!.report.detail).toContain("unlinkFrames");
    expect(toasts[0]!.report.detail).toContain("locked");
    expect(problems).toHaveLength(0);
  });

  test("the caller's own action names the refusal", async () => {
    const { feedback, client } = editor(async () => refused);
    await mutateReported(client, unlink, { action: "unlink the frames" });
    expect(
      feedback
        .snapshot()
        .toasts[0]!.text.headline.startsWith("Could not unlink the frames"),
    ).toBe(true);
  });

  test("a call that throws is reported and never rejects", async () => {
    const { feedback, client } = editor(async () => {
      throw new Error("malformed reply");
    });
    expect(await mutateReported(client, unlink)).toBeNull();
    const toast = feedback.snapshot().toasts[0]!;
    expect(toast.report.outcome).toBe("recoverable-failure");
    expect(toast.report.detail).toBe("unlinkFrames: malformed reply");
  });

  test("a write lost to a stopped engine is left to the engine-failure notice", async () => {
    const stopped = new Error("canvas engine stopped");
    const { feedback, client } = editor(async () => {
      throw stopped;
    }, stopped);
    expect(await mutateReported(client, unlink)).toBeNull();
    expect(feedback.snapshot().log).toHaveLength(0);
  });
});
