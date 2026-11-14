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

// Typing that outruns the engine folds into one insert per round trip
// (ui/typing-coalescer.ts; UX audit F-56): what is sent, in which order,
// and what each caller's promise answers.

import { describe, expect, test } from "bun:test";

import type { CanvasClient, Mutation } from "@paged-media/client";

import {
  continues,
  createTypingCoalescer,
  rawClient,
} from "../../src/ui/typing-coalescer";

/** A client whose replies the test releases one at a time. */
function fakeClient() {
  const sent: Array<{ method: string; arg?: unknown }> = [];
  const waiting: Array<() => void> = [];
  const client = {
    mutate(m: Mutation) {
      sent.push({ method: "mutate", arg: m });
      return new Promise((resolve) =>
        waiting.push(() =>
          resolve({ kind: "mutationApplied", payload: { op: m } }),
        ),
      );
    },
    caretNav(arg: unknown) {
      sent.push({ method: "caretNav", arg });
      return Promise.resolve(null);
    },
    undo() {
      sent.push({ method: "undo" });
      return Promise.resolve(null);
    },
  } as unknown as CanvasClient;
  const release = async () => {
    waiting.shift()?.();
    // Let the reply's continuations (the next send) run.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { client, sent, release };
}

const ins = (offset: number, text: string, storyId = "s1"): Mutation =>
  ({ op: "insertText", args: { storyId, offset, text } }) as Mutation;

const texts = (sent: Array<{ method: string; arg?: unknown }>) =>
  sent.map((s) =>
    s.method === "mutate"
      ? `${(s.arg as { op: string }).op}:${String((s.arg as { args: { text?: string } }).args.text ?? "")}`
      : s.method,
  );

describe("the typing coalescer", () => {
  test("a key with nothing in flight goes at once, as before", async () => {
    const { client, sent } = fakeClient();
    const t = createTypingCoalescer(client);
    void t.client.mutate(ins(0, "a"));
    expect(texts(sent)).toEqual(["insertText:a"]);
    expect(t.folded()).toBe(0);
  });

  test("keys typed while one is in flight fold into ONE insert, sent when the reply comes", async () => {
    const { client, sent, release } = fakeClient();
    const t = createTypingCoalescer(client);
    const replies = [
      t.client.mutate(ins(0, "a")),
      t.client.mutate(ins(1, "b")),
      t.client.mutate(ins(2, "c")),
      // A multi-byte character: offsets are UTF-8 bytes.
      t.client.mutate(ins(3, "é")),
      t.client.mutate(ins(5, "d")),
    ];
    expect(texts(sent)).toEqual(["insertText:a"]);
    await release();
    expect(texts(sent)).toEqual(["insertText:a", "insertText:bcéd"]);
    expect((sent[1]!.arg as { args: { offset: number } }).args.offset).toBe(1);
    expect(t.folded()).toBe(3);
    await release();
    // Every caller hears the reply of the insert that carried its key.
    for (const r of await Promise.all(replies))
      expect((r as { kind: string }).kind).toBe("mutationApplied");
  });

  test("anything else the editor sends goes after what is pending: order is kept", async () => {
    const { client, sent, release } = fakeClient();
    const t = createTypingCoalescer(client);
    void t.client.mutate(ins(0, "a"));
    void t.client.mutate(ins(1, "b"));
    void t.client.mutate(ins(2, "c"));
    // Backspace (a delete), a caret move and an undo, while "bc" waits.
    void t.client.mutate({
      op: "deleteRange",
      args: { storyId: "s1", start: 2, end: 3 },
    } as Mutation);
    void (t.client.caretNav as (...a: unknown[]) => unknown)({});
    void t.client.undo();
    expect(texts(sent)).toEqual([
      "insertText:a",
      "insertText:bc",
      "deleteRange:",
      "caretNav",
      "undo",
    ]);
    await release();
    await release();
  });

  test("a key somewhere else (another story, a jump) does not fold into the pending text", async () => {
    const { client, sent, release } = fakeClient();
    const t = createTypingCoalescer(client);
    void t.client.mutate(ins(0, "a"));
    void t.client.mutate(ins(1, "b"));
    void t.client.mutate(ins(0, "x", "s2"));
    void t.client.mutate(ins(1, "y", "s2"));
    // "b" went when "x" came (it could not fold); "x" and "y" fold.
    expect(texts(sent)).toEqual(["insertText:a", "insertText:b"]);
    await release();
    expect(texts(sent)).toEqual([
      "insertText:a",
      "insertText:b",
      "insertText:xy",
    ]);
    expect(continues(ins(0, "ab") as never, ins(2, "c", "s1") as never)).toBe(
      true,
    );
    expect(continues(ins(0, "ab") as never, ins(3, "c") as never)).toBe(false);
  });

  test("flush sends what waits; the raw client is reachable for per-client registries", async () => {
    const { client, sent } = fakeClient();
    const t = createTypingCoalescer(client);
    void t.client.mutate(ins(0, "a"));
    void t.client.mutate(ins(1, "b"));
    t.flush();
    expect(texts(sent)).toEqual(["insertText:a", "insertText:b"]);
    expect(rawClient(t.client)).toBe(client);
    expect(rawClient(client)).toBe(client);
  });
});
