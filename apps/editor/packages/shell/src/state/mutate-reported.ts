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

// A write nobody waits for, with its refusal said.
//
// `client.mutate` RESOLVES on a refused mutation (`mutationFailed`: a
// locked layer, a role that may not, an address that is gone) and rejects
// only when the worker cannot answer. A call site that fires a write and
// moves on (`void client.mutate(…)`) therefore drops the refusal: the
// control snaps back, or does not, and nothing says why. `mutateReported`
// is that same fire-and-move-on write with the refusal reported through
// this editor's operation feedback (one toast per kind of write, a count
// when it repeats; the engine's own words behind Details).
//
// The feedback is found by the client, so the non-React call sites (a
// binding's commit, a planner) need nothing but the client they already
// hold: the shell names the sink once (`setMutationReportSink`).

import type { CanvasClient, Mutation, WorkerToMain } from "@paged-media/client";
import { refusalText } from "@paged-media/panel-kit";
import { defineMessages, t } from "@paged-media/strings";

import type { OperationReport } from "./operation-feedback";

const M = defineMessages("shell.mutation", {
  action: "apply the change",
});

type Sink = (report: OperationReport) => void;
const SINKS = new WeakMap<object, Sink>();

/** Where `client`'s refused writes are reported (the shell: this editor's
 *  operation feedback). Null takes it away. */
export function setMutationReportSink(
  client: Pick<CanvasClient, "mutate">,
  sink: Sink | null,
): void {
  if (sink) SINKS.set(client, sink);
  else SINKS.delete(client);
}

type MutateOptions = NonNullable<Parameters<CanvasClient["mutate"]>[1]> & {
  /** The attempted action, a lowercase verb phrase in the editor's
   *  language ("unlink the frames"); default "apply the change". */
  action?: string;
};

/** The report of a write that did not apply. `error` is the engine's
 *  refusal (`mutationFailed`'s) or what the call threw. */
export function refusedMutationReport(
  mutation: Mutation,
  error: unknown,
  refused: boolean,
  action: string = t(M.action),
): OperationReport {
  let detail: string;
  try {
    detail =
      error instanceof Error ? error.message : (JSON.stringify(error) ?? "");
  } catch {
    detail = String(error);
  }
  return {
    action,
    // A refusal is the engine's answer; anything else is a failure.
    outcome: refused ? "blocked" : "recoverable-failure",
    reason: refusalText(error, action),
    document: "unchanged",
    detail: `${mutation.op}: ${detail}`,
    source: "paged.mutation",
    key: `paged.mutation|${mutation.op}`,
  };
}

/**
 * `client.mutate`, for a caller that does not wait for the answer: the
 * reply when the engine answered (applied or refused), null when the call
 * failed. Never rejects. A refusal or a failure is reported; a write lost
 * to a stopped engine is not (the engine-failure notice says that).
 */
export async function mutateReported(
  client: Pick<CanvasClient, "mutate"> & Partial<Pick<CanvasClient, "failure">>,
  mutation: Mutation,
  options: MutateOptions = {},
): Promise<WorkerToMain | null> {
  const { action, ...mutateOptions } = options;
  const report = (error: unknown, refused: boolean) => {
    const r = refusedMutationReport(mutation, error, refused, action);
    const sink = SINKS.get(client);
    if (sink) sink(r);
    else console.warn(`[mutation] ${r.detail}`);
  };
  try {
    const reply = await client.mutate(mutation, mutateOptions);
    if (reply.kind === "mutationFailed") report(reply.payload.error, true);
    return reply;
  } catch (err) {
    if (!client.failure) report(err, false);
    return null;
  }
}
