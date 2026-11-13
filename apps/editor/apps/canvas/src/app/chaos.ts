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

// The slow worker of the interaction contract's fixture H (spec §23.1): a
// reply gate on the editor's engine client that delays or reorders the
// replies its callers await, so a spec can prove a late hit test cannot
// select the wrong thing. Published as `__chaos` by the page entry, and
// only on a page opened with `?debug=chaos` (dev-handles.ts); nothing
// else imports it.

import type {
  CanvasClient,
  ReplyGate,
  WorkerToMain,
} from "@paged-media/client";

/** A delay in ms, or one per reply (`nth` counts that kind's replies from 0). */
export type ChaosDelay =
  number | ((nth: number, reply: WorkerToMain) => number);

export interface ReplyChaos {
  /** Settle every caller of a `kind` request (`"hitTest"`) `ms` late. */
  delayReply(kind: string, ms: ChaosDelay): void;
  /** Hold the next replies to these request kinds, one per entry in that
   *  order, until all have arrived; then settle them last first. */
  reorder(kinds: readonly string[]): void;
  /** Replies held right now. */
  held(): number;
  /** Settle everything held, in arrival order, and drop every rule. */
  clear(): void;
}

interface Held {
  reply: WorkerToMain;
  settle: (reply: WorkerToMain) => void;
}

/** The chaos of the editor whose client `client()` returns (read at each
 *  call: the gate goes on whichever client is current). */
export function createReplyChaos(
  client: () => Pick<CanvasClient, "setReplyGate"> | undefined,
): ReplyChaos {
  const delays = new Map<string, { ms: ChaosDelay; nth: number }>();
  const waiting = new Map<Held, ReturnType<typeof setTimeout>>();
  let order: { kinds: readonly string[]; held: Held[] } | null = null;

  const gate: ReplyGate = (kind, reply) =>
    new Promise<WorkerToMain>((settle) => {
      if (order && order.kinds[order.held.length] === kind) {
        order.held.push({ reply, settle });
        if (order.held.length === order.kinds.length) {
          const held = order.held;
          order = null;
          for (const h of held.reverse()) h.settle(h.reply);
        }
        return;
      }
      const rule = delays.get(kind);
      let ms = 0;
      if (rule) {
        ms = typeof rule.ms === "function" ? rule.ms(rule.nth, reply) : rule.ms;
        rule.nth += 1;
      }
      if (ms <= 0) {
        settle(reply);
        return;
      }
      const held: Held = { reply, settle };
      waiting.set(
        held,
        setTimeout(() => {
          waiting.delete(held);
          settle(reply);
        }, ms),
      );
    });

  const install = () => client()?.setReplyGate(gate);

  return {
    delayReply(kind, ms) {
      delays.set(kind, { ms, nth: 0 });
      install();
    },
    reorder(kinds) {
      order = { kinds: [...kinds], held: [] };
      install();
    },
    held: () => waiting.size + (order?.held.length ?? 0),
    clear() {
      client()?.setReplyGate(null);
      delays.clear();
      const held = [...(order?.held ?? []), ...waiting.keys()];
      for (const timer of waiting.values()) clearTimeout(timer);
      waiting.clear();
      order = null;
      for (const h of held) h.settle(h.reply);
    },
  };
}
