/*
 * This file is part of paged (https://paged.media).
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

// Extensions ADR 1101 — the COMMENTS door (`host.comments`, comments@1) and
// `contribute.commentAnchor`.
//
// Coverage:
//   1. the rows group into threads (anchors, replies, text comments,
//      orphaned) and `list` filters them;
//   2. the writes become the engine's comment mutations through the document
//      door (a person first, a reply on the root, a thread id or a comment id
//      both name a thread) and a refused write is an answer, not a throw;
//   3. `onDidChange` fires only when a committed change altered the comments;
//   4. the gate: no write capability answers `{ ok: false }`;
//   5. the anchor registry: first resolver that knows the address answers,
//      without a backend the contribution is a no-op and the flag is false.

import { describe, expect, it } from "bun:test";

import type {
  CommentSummary,
  CommentThread,
  PluginManifest,
} from "@paged-media/plugin-api";

import {
  createBundleHost,
  createCommentAnchorRegistry,
  threadsOf,
} from "../src";
import { makeFakeEditor } from "./fake-editor";

import { silentConsole as silent } from "../src/testing";

const manifest = (
  document: PluginManifest["capabilities"] = {
    document: { read: "broad", write: "broad" },
  },
): PluginManifest => ({
  id: "media.paged.sheet",
  name: "sheet",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: document,
});

const row = (r: Partial<CommentSummary> & { id: string }): CommentSummary => ({
  storyId: "",
  anchorText: "",
  text: "",
  resolved: false,
  ...r,
});

const ROWS: CommentSummary[] = [
  row({
    id: "c1",
    threadId: "c1",
    text: "check B7",
    author: "Ada",
    person: "ada",
    resolved: false,
    anchor: { kind: "cell", item: "u12", address: "B7" },
    page: "p1",
    at: [10, 20],
  }),
  row({
    id: "c2",
    threadId: "c1",
    parentId: "c1",
    text: "done",
    author: "Bo",
  }),
  row({
    id: "c3",
    threadId: "c3",
    text: "move",
    resolved: true,
    orphaned: true,
    anchor: { kind: "page", page: "p2", at: [1, 2] },
    page: "p2",
    at: [1, 2],
  }),
  row({
    id: "c4",
    storyId: "s1",
    start: 3,
    end: 9,
    anchorText: "words",
    text: "a text comment",
  }),
];

/** A fake editor whose `comments` collection is `rows`, and which records
 *  the mutations. The reply to a mutation is the applied outcome unless
 *  `refuse` is set. */
function setup(
  caps?: PluginManifest["capabilities"],
  options: {
    commentAnchors?: ReturnType<typeof createCommentAnchorRegistry>;
  } = {},
) {
  const fake = makeFakeEditor();
  let rows: CommentSummary[] = ROWS;
  const client = fake.editor.client as unknown as {
    collection: (name: string) => Promise<unknown[]>;
  };
  client.collection = async (name) => (name === "comments" ? rows : []);
  const { host } = createBundleHost(() => fake.editor, manifest(caps), {
    console: silent,
    capabilityMode: "enforce",
    ...options,
  });
  return {
    fake,
    host,
    setRows(r: CommentSummary[]) {
      rows = r;
    },
    ops: () =>
      fake.mutations.map((m) => {
        const mutation =
          (m as { payload?: { mutation?: unknown } }).payload?.mutation ?? m;
        return mutation as { op: string; args: Record<string, unknown> };
      }),
  };
}

const flat = (m: { op: string; args: Record<string, unknown> }) =>
  m.op === "batch" ? (m.args.ops as { op: string }[]) : [m];

describe("host.comments — the comments door (extensions ADR 1101)", () => {
  it("groups the rows into threads: anchors, replies, orphaned, text", () => {
    const threads = threadsOf(ROWS);
    expect(threads.map((t) => t.id)).toEqual(["c1", "c3", "c4"]);
    expect(threads[0]).toMatchObject({
      kind: "comment",
      anchor: { kind: "cell", item: "u12", address: "B7" },
      page: "p1",
      at: [10, 20],
      resolved: false,
      orphaned: false,
    });
    expect(threads[0]!.comments.map((c) => [c.id, c.parentId])).toEqual([
      ["c1", null],
      ["c2", "c1"],
    ]);
    expect(threads[1]).toMatchObject({ resolved: true, orphaned: true });
    expect(threads[2]!.anchor).toEqual({
      kind: "text",
      story: "s1",
      start: 3,
      end: 9,
    });
  });

  it("lists with a filter and gets one thread", async () => {
    const { host } = setup();
    expect(host.supports("comments@1")).toBe(true);
    expect((await host.comments.list()).length).toBe(3);
    const ids = async (f: Parameters<typeof host.comments.list>[0]) =>
      (await host.comments.list(f)).map((t: CommentThread) => t.id);
    expect(await ids({ item: "u12" })).toEqual(["c1"]);
    expect(await ids({ anchorKind: "page" })).toEqual(["c3"]);
    expect(await ids({ resolved: true })).toEqual(["c3"]);
    expect(await ids({ orphaned: false, page: "p1" })).toEqual(["c1"]);
    expect((await host.comments.get("c1"))?.comments.length).toBe(2);
    expect(await host.comments.get("nope")).toBeNull();
  });

  it("starts a thread with its author entered first", async () => {
    const { host, ops } = setup();
    const anchor = { kind: "cell", item: "u12", address: "C3" } as const;
    const r = await host.comments.startThread(anchor, "hello", {
      id: "ada",
      name: "Ada",
      initials: "A",
    });
    expect(r.ok).toBe(true);
    const [person, thread] = flat(ops()[0]!);
    expect(person).toMatchObject({
      op: "setPerson",
      args: { person: { id: "ada", name: "Ada", initials: "A" } },
    });
    expect(thread).toMatchObject({
      op: "insertCommentThread",
      args: { anchor, comment: { text: "hello", person: "ada" } },
    });
    expect((await host.comments.startThread(anchor, "  ")).ok).toBe(false);
    expect(ops().length).toBe(1);
  });

  it("replies, edits, resolves and removes by thread or comment id", async () => {
    const { host, ops } = setup();
    expect((await host.comments.reply("c1", "ok")).ok).toBe(true);
    expect((await host.comments.reply("c2", "ok too")).ok).toBe(true);
    expect(ops().map((m) => [m.op, m.args.parentId])).toEqual([
      ["replyComment", "c1"],
      ["replyComment", "c1"],
    ]);
    const missing = await host.comments.reply("zzz", "x");
    expect(missing).toEqual({
      ok: false,
      reason: 'no comment or thread "zzz"',
    });

    await host.comments.edit("c2", "changed");
    await host.comments.resolve("c1", true);
    await host.comments.resolve("c2", false);
    await host.comments.remove("c3");
    expect(
      ops()
        .slice(2)
        .map((m) => [m.op, m.args.commentId]),
    ).toEqual([
      ["editComment", "c2"],
      ["resolveComment", "c1"],
      ["resolveComment", "c2"],
      ["deleteComment", "c3"],
    ]);
    expect((await host.comments.edit("c2", "")).ok).toBe(false);
  });

  it("answers a refused write instead of throwing", async () => {
    const { host, fake } = setup();
    fake.setNextMutateReply({
      kind: "mutationFailed",
      payload: { error: { kind: "noSuchComment" } },
    });
    const r = await host.comments.remove("c1");
    expect(r.ok).toBe(false);
  });

  it("answers { ok: false } without the write capability", async () => {
    const { host, ops } = setup({ document: { read: "broad" } });
    const r = await host.comments.resolve("c1", true);
    expect(r.ok).toBe(false);
    expect(ops()).toEqual([]);
    expect((await host.comments.list()).length).toBe(3);
  });

  it("onDidChange fires only when the comments changed", async () => {
    const { host, fake, setRows } = setup();
    let n = 0;
    host.comments.onDidChange(() => n++);
    await new Promise((r) => setTimeout(r, 0));
    const commit = async () => {
      fake.emit({ kind: "mutationApplied", payload: { pageIds: ["p1"] } });
      await new Promise((r) => setTimeout(r, 0));
    };
    await commit();
    expect(n).toBe(0);
    setRows([...ROWS, row({ id: "c9", threadId: "c9", text: "new" })]);
    await commit();
    expect(n).toBe(1);
    await commit();
    expect(n).toBe(1);
  });
});

describe("contribute.commentAnchor — the anchor registry (extensions ADR 1101)", () => {
  const sheetResolver = {
    id: "media.paged.sheet.cells",
    kind: "cell" as const,
    resolve: (address: string, item: string) =>
      item === "u12" && /^[A-Z]+\d+$/.test(address)
        ? {
            rect: [0, 0, 50, 10] as [number, number, number, number],
            label: address,
          }
        : null,
  };

  it("the first resolver that knows the address answers; disposing removes it", () => {
    const anchors = createCommentAnchorRegistry();
    const { host } = setup(undefined, { commentAnchors: anchors });
    expect(host.supports("contribute.commentAnchor@1")).toBe(true);
    let changes = 0;
    anchors.onDidChange(() => changes++);
    expect(anchors.resolve("u12", "B7")).toBeNull();
    const d = host.contribute.commentAnchor(sheetResolver);
    expect(anchors.resolve("u12", "B7")).toEqual({
      rect: [0, 0, 50, 10],
      label: "B7",
    });
    expect(anchors.resolve("u99", "B7")).toBeNull();
    d.dispose();
    expect(anchors.resolve("u12", "B7")).toBeNull();
    expect(changes).toBe(2);
  });

  it("is a no-op without a backend, and ids must be namespaced", () => {
    const { host } = setup();
    expect(host.supports("contribute.commentAnchor@1")).toBe(false);
    expect(() =>
      host.contribute.commentAnchor(sheetResolver).dispose(),
    ).not.toThrow();
    expect(() =>
      host.contribute.commentAnchor({ ...sheetResolver, id: "other.cells" }),
    ).toThrow(/namespaced/);
  });
});
