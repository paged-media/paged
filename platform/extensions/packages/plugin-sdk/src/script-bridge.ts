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
  | { op: "schema"; target: string };

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
  const out: HostObjectAnswer[] = [];
  for (const call of calls) {
    try {
      switch (call.op) {
        case "get": {
          const v = await objects.get(call.address, call.path);
          out.push(
            v.kind === "refused"
              ? { error: { code: v.code, reason: v.reason } }
              : { value: v },
          );
          break;
        }
        case "batch": {
          const r = await objects.batch(call.ops as ObjectOp[]);
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
          out.push({ value: await objects.query(call.selector) });
          break;
        case "schema":
          out.push({ value: await objects.schema(call.target) });
          break;
        default:
          out.push({ error: { code: "unmapped", reason: `unknown host call ${JSON.stringify(call)}` } });
      }
    } catch (err) {
      out.push({ error: { code: "failed", reason: String(err) } });
    }
  }
  return out;
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
    const answers = await answerHostObjects(objects, calls);
    reply = await send({ kind: "hostObjectsResult", payload: { session, answers } });
  }
  if (reply.kind !== "scriptResult") throw new Error(`unexpected reply: ${reply.kind}`);
  const p = reply.payload as { output: string[]; error?: string | null; budgetKind?: string | null };
  return { output: p.output, error: p.error ?? null, budgetKind: p.budgetKind ?? null, hostRounds };
}
