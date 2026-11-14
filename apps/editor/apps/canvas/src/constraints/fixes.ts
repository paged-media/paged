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

// A design constraint's suggested fix, applied (editor ADR 1233): the moves
// the evaluation planned, written through the one translation path the
// nudge and the Transform panel use (`translationPlan`), sent as ONE batch
// — one undo step. Only ever on the user's click: the evaluation plans,
// it never applies.

import type { Mutation } from "@paged-media/client";
import type { PagedEditor } from "@paged-media/shell";

import { translationPlan, type TranslationClient } from "../object-commands";
import type { FixPlan } from "./evaluate";

/** The ops of a move fix, or why there are none. */
export async function moveFixOps(
  client: TranslationClient,
  plan: Extract<FixPlan, { kind: "move" }>,
): Promise<{ ok: true; ops: Mutation[] } | { ok: false; reason: string }> {
  const ops: Mutation[] = [];
  for (const m of plan.moves) {
    if (m.dx === 0 && m.dy === 0) continue;
    const p = await translationPlan(client, [m.member], m.dx, m.dy);
    if (!p.ok) return p;
    ops.push(...p.ops);
  }
  return { ok: true, ops };
}

/** Apply a move fix as one undo step. True when the engine took it. */
export async function applyMoveFix(
  paged: PagedEditor,
  plan: Extract<FixPlan, { kind: "move" }>,
): Promise<boolean> {
  const planned = await moveFixOps(paged.client, plan);
  if (!planned.ok || planned.ops.length === 0) return false;
  const reply = await paged.client.mutate(
    planned.ops.length === 1
      ? planned.ops[0]!
      : { op: "batch", args: { ops: planned.ops } },
  );
  return reply.kind === "mutationApplied";
}
