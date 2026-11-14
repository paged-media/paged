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

// Typing that outruns the engine is folded, not queued (UX audit F-56;
// editor ADR "Performance budgets", UXI-PRF-001).
//
// Each typed character was one `insertText`, sent at once, and every one
// re-laid the story: a burst of 55 characters a second (a held key, a
// scripted or pasted run of keystrokes) queued in the worker, and a key
// reached the screen 235 ms after it was pressed. Now, while one insert is
// in flight, the characters typed behind it at the advancing caret wait in
// one pending insert, which goes as ONE mutation when the reply comes: the
// engine lays the story out once per round trip, however fast the keys
// come. At ordinary speeds (a key every 100 ms or more) nothing is ever
// pending and every character is its own insert, as before.
//
// ORDER IS KEPT: every other request the text editor makes — a delete, a
// caret move, a style, an undo, a read — sends what is pending first, so
// the worker sees the same sequence the user typed. Only a plain insert at
// a collapsed caret, contiguous with the pending one (same story, same
// cell, its offset where the pending text ends), is folded in.
//
// UNDO. An insert is one undo step, as it was; folded keys are one step
// together (a held key, a burst), as a nudge's folded presses are (ADR
// 251). Each step still reverses exactly what it inserted.

import type { CanvasClient, Mutation } from "@paged-media/client";

type InsertText = Extract<Mutation, { op: "insertText" }>;
type Reply = Awaited<ReturnType<CanvasClient["mutate"]>>;

const utf8 = new TextEncoder();
const bytes = (text: string): number => utf8.encode(text).length;

function isInsert(m: Mutation): m is InsertText {
  return (m as { op?: string }).op === "insertText";
}

/** Whether `next` continues `pending`: the same story and cell, at the
 *  byte offset where `pending`'s text ends. Pure, for the unit test. */
export function continues(pending: InsertText, next: InsertText): boolean {
  const a = pending.args as {
    storyId: string;
    offset: number;
    text: string;
    cell?: unknown;
  };
  const b = next.args as typeof a;
  return (
    a.storyId === b.storyId &&
    JSON.stringify(a.cell ?? null) === JSON.stringify(b.cell ?? null) &&
    b.offset === a.offset + bytes(a.text)
  );
}

const RAW = Symbol("typing-coalescer.raw");

/** The client a coalescing client wraps (itself for any other): what a
 *  per-client registry is keyed by (`heldTypingStyle`). */
export function rawClient<C extends object>(client: C): C {
  return ((client as Record<symbol, unknown>)[RAW] as C | undefined) ?? client;
}

export interface TypingCoalescer {
  /** The client the text editor talks through: `mutate` of a plain insert
   *  is folded while one is in flight; everything else sends what is
   *  pending first. */
  readonly client: CanvasClient;
  /** Send what is pending now. */
  flush(): void;
  /** Inserts folded into another so far (diagnostics, the perf probe). */
  folded(): number;
}

interface Pending {
  insert: InsertText;
  waiters: Array<(reply: Reply) => void>;
}

export function createTypingCoalescer(client: CanvasClient): TypingCoalescer {
  let inFlight = false;
  let pending: Pending | null = null;
  let folded = 0;

  const send = (p: Pending): void => {
    inFlight = true;
    const settle = (reply: Reply) => {
      for (const w of p.waiters) w(reply);
    };
    client
      .mutate(p.insert)
      .then(settle, (err: unknown) => {
        settle({
          kind: "mutationFailed",
          payload: { error: String(err) },
        } as unknown as Reply);
      })
      .finally(() => {
        inFlight = false;
        const next = pending;
        pending = null;
        if (next) send(next);
      });
  };

  const flush = (): void => {
    const p = pending;
    pending = null;
    if (p) send(p);
  };

  const mutateInsert = (m: InsertText): Promise<Reply> =>
    new Promise<Reply>((resolve) => {
      if (!inFlight && !pending) {
        send({ insert: m, waiters: [resolve] });
        return;
      }
      if (pending && continues(pending.insert, m)) {
        const a = pending.insert.args as { text: string };
        pending.insert = {
          ...pending.insert,
          args: { ...pending.insert.args, text: a.text + m.args.text },
        } as InsertText;
        pending.waiters.push(resolve);
        folded += 1;
        return;
      }
      // Not a continuation: what waits goes first, this one waits next.
      flush();
      pending = { insert: m, waiters: [resolve] };
      if (!inFlight) flush();
    });

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === RAW) return target;
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "mutate") {
        return (m: Mutation, ...rest: unknown[]) => {
          if (isInsert(m) && rest.length === 0) return mutateInsert(m);
          flush();
          return (value as (...a: unknown[]) => unknown).call(
            target,
            m,
            ...rest,
          );
        };
      }
      return (...args: unknown[]) => {
        flush();
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  return { client: proxy, flush, folded: () => folded };
}
