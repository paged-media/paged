/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file is part of paged (https://paged.media) and is additionally
 * available under the Paged Media Enterprise License (PMEL). Full
 * copyright and license information is available in LICENSE.md which is
 * distributed with this source code.
 *
 *  @copyright  Copyright (c) And The Next GmbH
 *  @license    MPL-2.0 OR Paged Media Enterprise License (PMEL)
 */

// The HOST half of the Boa script bridge (ADR 323, engine protocol 71).
//
// A `paged.*` script runs in core's worker. When it names a `plugin:`
// address (`paged.get/set/batch/query/schema`), the worker cannot answer:
// the script suspends and the `executeScript` reply is
// `requestHostObjects { session, calls }`. The host answers every call
// through `host.objects` and sends `hostObjectsResult { session, answers }`,
// whose reply is the `scriptResult` or the next `requestHostObjects`.
//
// `runScriptWithObjects` is that loop; the editor's client, the headless
// host and the Node CLI all drive it with their own `send` and the ONE
// shared registry. The message shapes are declared here (not taken from
// the vendored wire) so this file works against any engine: a pre-71
// engine ignores `hostObjects` and simply never suspends.

import type { ObjectOp, ObjectsSurface } from "@paged-media/plugin-api";

/** One call a suspended script makes (core `HostObjectCall`). */
export type HostObjectCall =
  | { op: "get"; address: string; path: string }
  | { op: "batch"; ops: unknown[] }
  | { op: "query"; selector: string }
  | { op: "schema"; target: string }
  /** A typed command (`paged.invoke`): `core.<op>` or a plugin's. */
  | { op: "invoke"; id: string; args?: unknown }
  /** The typed commands on offer (`paged.commands`), optionally one owner's. */
  | { op: "commands"; owner?: string };

/** The answer to one call (core `HostObjectAnswer`). */
export interface HostObjectAnswer {
  value?: unknown;
  error?: { code: string; reason: string; index?: number } | null;
}

export interface ScriptRunResult {
  output: string[];
  error: string | null;
  budgetKind?: string | null;
  /** Host round trips the script took (0 = it never touched a plugin). */
  hostRounds: number;
}

/** A request/reply door onto the engine (`client.send`). */
export type ScriptSend = (message: { kind: string; payload: unknown }) => Promise<{ kind: string; payload?: any }>;

/** Answer a suspended script's calls through the object registry, one
 *  answer per call, in order. Never throws: a failure is the answer's
 *  `error` (the script sees an exception carrying its `code`). */
export async function answerHostObjects(
  objects: ObjectsSurface,
  calls: readonly HostObjectCall[],
): Promise<HostObjectAnswer[]> {
  return (await answerHostObjectsRound(objects, calls)).answers;
}

/** {@link answerHostObjects}, plus `committed`: the engine `appliedSeq` of
 *  every write made ANSWERING these calls (a batch that committed). The
 *  host sends it as `HostObjectsResult.committed` — protocol 71 folds only
 *  a script session's own undo records, so without it a script's plugin
 *  write would be a separate undo step; a write made by anyone else
 *  while the script waits is never listed and stays its own step. */
export async function answerHostObjectsRound(
  objects: ObjectsSurface,
  calls: readonly HostObjectCall[],
): Promise<{ answers: HostObjectAnswer[]; committed: number[] }> {
  const out: HostObjectAnswer[] = [];
  const committed: number[] = [];
  const commit = (seq: number): void => {
    if (!committed.includes(seq)) committed.push(seq);
  };
  // The SDK registry's tracked view reports the commits made THROUGH it —
  // a batch, a core command, and the writes a plugin command's handler
  // makes — and nothing written elsewhere meanwhile (a UI edit while the
  // script waits stays its own undo step).
  const tracker = (objects as Partial<{ tracked(note: (seq: number) => void): ObjectsSurface }>).tracked;
  const via = typeof tracker === "function" ? tracker.call(objects, commit) : objects;
  for (const call of calls) {
    try {
      switch (call.op) {
        case "get": {
          const v = await via.get(call.address, call.path);
          out.push(
            v.kind === "refused"
              ? { error: { code: v.code, reason: v.reason } }
              : { value: v },
          );
          break;
        }
        case "batch": {
          const r = await via.batch((call.ops as unknown[]).map(sdkOp));
          const seq = r.applied && r.outcome?.applied ? r.outcome.appliedSeq : undefined;
          if (typeof seq === "number") commit(seq);
          out.push(
            r.applied
              ? { value: r }
              : {
                  value: r,
                  error: {
                    code: r.code ?? "failed",
                    reason: r.reason ?? "the batch was not applied",
                    ...(r.index !== undefined ? { index: r.index } : {}),
                  },
                },
          );
          break;
        }
        case "query":
          out.push({ value: await via.query(call.selector) });
          break;
        case "schema":
          out.push({ value: await via.schema(call.target) });
          break;
        case "invoke": {
          if (typeof call.id !== "string" || call.id === "") {
            out.push({ error: { code: "invalidValue", reason: "invoke: the command id must be a non-empty string" } });
            break;
          }
          if (call.id.startsWith("core.")) {
            // A core command is ONE batch: its seq comes from the outcome
            // even when the registry cannot report commits.
            const r = await via.batch([{ op: "invoke", command: call.id, args: call.args ?? {} }]);
            const seq = r.applied && r.outcome?.applied ? r.outcome.appliedSeq : undefined;
            if (typeof seq === "number") commit(seq);
            out.push(
              r.applied
                ? { value: { created: r.commands?.[0]?.created ?? [], undoSteps: r.undoSteps } }
                : { error: { code: r.code ?? "failed", reason: r.reason ?? "the command was not applied" } },
            );
            break;
          }
          out.push({ value: (await via.invoke(call.id, call.args ?? {})) ?? null });
          break;
        }
        case "commands": {
          const all = await via.commands();
          out.push({ value: call.owner === undefined || call.owner === null ? all : all.filter((c) => c.owner === call.owner) });
          break;
        }
        default:
          out.push({ error: { code: "unmapped", reason: `unknown host call ${JSON.stringify(call)}` } });
      }
    } catch (err) {
      out.push({ error: refusalOf(err) });
    }
  }
  return { answers: out, committed };
}

/** A thrown `host.objects` refusal (`"<code>: <reason>"`, the shape
 *  `invoke` rejects with) as the answer's coded error. */
function refusalOf(err: unknown): { code: string; reason: string } {
  const text = err instanceof Error ? err.message : String(err);
  const m = /^([A-Za-z]+): ([\s\S]*)$/.exec(text);
  return m ? { code: m[1]!, reason: m[2]! } : { code: "failed", reason: text };
}

/** A script's batch op → the SDK op. Core's `{ op: "invoke", id, args,
 *  handle? }` becomes `{ op: "invoke", command, args }` (a core command
 *  takes its handle as an argument); every other op passes through. */
function sdkOp(op: unknown): ObjectOp {
  const o = op as { op?: unknown; id?: unknown; command?: unknown; args?: unknown; handle?: unknown };
  if (o?.op !== "invoke" || typeof o.command === "string") return op as ObjectOp;
  const args = (typeof o.args === "object" && o.args !== null ? { ...(o.args as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (typeof o.handle === "string") args["handle"] = o.handle;
  return { op: "invoke", command: String(o.id ?? ""), args };
}

/** Run a script whose `plugin:` calls are answered by `objects`. */
export async function runScriptWithObjects(
  send: ScriptSend,
  objects: ObjectsSurface | null,
  source: string,
  options: { budget?: unknown } = {},
): Promise<ScriptRunResult> {
  let reply = await send({
    kind: "executeScript",
    payload: {
      source,
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
      ...(objects ? { hostObjects: true } : {}),
    },
  });
  let hostRounds = 0;
  while (reply.kind === "requestHostObjects" && objects) {
    hostRounds++;
    const { session, calls } = reply.payload as { session: number; calls: HostObjectCall[] };
    const { answers, committed } = await answerHostObjectsRound(objects, calls);
    reply = await send({
      kind: "hostObjectsResult",
      payload: { session, answers, ...(committed.length > 0 ? { committed } : {}) },
    });
  }
  if (reply.kind !== "scriptResult") throw new Error(`unexpected reply: ${reply.kind}`);
  const p = reply.payload as { output: string[]; error?: string | null; budgetKind?: string | null };
  return { output: p.output, error: p.error ?? null, budgetKind: p.budgetKind ?? null, hostRounds };
}
