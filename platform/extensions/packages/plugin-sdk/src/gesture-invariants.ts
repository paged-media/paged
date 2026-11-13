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

// The universal gesture invariants (gestures.md §5), as runner-agnostic
// checks that THROW an `InvariantError` (any runner reports a throw):
//
//   INV-1 one gesture is exactly one commit — one applied mutation or
//         one committed worker gesture, never two, never a partial;
//   INV-2 cancel (Escape mid-gesture) commits nothing, and a begun
//         worker gesture is cancelled, not left open;
//   INV-4 undo restores the model exactly and redo re-applies it;
//   INV-7 no document write from another channel (a script, a panel, an
//         undo) applies while a gesture is open;
//   INV-8 liveness: pointercancel, blur, capture loss, a tool switch and
//         a document close each END an open gesture, without a mutation.
//
// Two levels. Against a FAKE editor the log is the evidence
// (`expectOneCommit`, `expectNoCommit`, `expectOneUndoStep`). Against a
// real ENGINE the model is: `checkUndoRedo` / `checkCancel` /
// `checkLiveness` compare model dumps through a `ModelChannel`, and
// `engineModelChannel` builds one over any `client.send` (the headless
// host's, or the editor's). `checkNoInterleave` reads the order of the
// replies either level records.

import type {
  ElementId,
  MainToWorkerKind,
  WorkerToMain,
} from "@paged-media/plugin-api";

import type { FakeEditor, FakeEditorEvent } from "./fake-editor.js";

export type InvariantId = "INV-1" | "INV-2" | "INV-4" | "INV-7" | "INV-8";

export class InvariantError extends Error {
  constructor(
    readonly invariant: InvariantId,
    message: string,
    readonly details?: unknown,
  ) {
    super(`${invariant}: ${message}`);
    this.name = "InvariantError";
  }
}

/** What committed in a slice of a fake editor's log. */
export interface CommitSummary {
  /** Mutations the fake applied. */
  applied: Array<Extract<FakeEditorEvent, { channel: "mutation" }>>;
  /** Mutations it refused (`mutationFailed`). */
  refused: Array<Extract<FakeEditorEvent, { channel: "mutation" }>>;
  /** Worker gestures committed. */
  committed: Array<Extract<FakeEditorEvent, { channel: "gesture" }>>;
  /** Worker gestures begun, and cancelled. */
  begun: number;
  cancelled: number;
}

export function commitsSince(fake: FakeEditor, mark = 0): CommitSummary {
  const slice = fake.since(mark);
  const mutations = slice.filter(
    (e): e is Extract<FakeEditorEvent, { channel: "mutation" }> =>
      e.channel === "mutation",
  );
  const gestures = slice.filter(
    (e): e is Extract<FakeEditorEvent, { channel: "gesture" }> =>
      e.channel === "gesture",
  );
  return {
    applied: mutations.filter((m) => m.reply.kind === "mutationApplied"),
    refused: mutations.filter((m) => m.reply.kind !== "mutationApplied"),
    committed: gestures.filter(
      (g) =>
        g.message === "commitGesture" && g.reply.kind === "gestureCommitted",
    ),
    begun: gestures.filter(
      (g) => g.message === "beginGesture" && g.reply.kind === "gestureBegun",
    ).length,
    cancelled: gestures.filter((g) => g.message === "cancelGesture").length,
  };
}

/** INV-1 on a fake editor: since `mark`, exactly one commit. Returns it. */
export function expectOneCommit(
  fake: FakeEditor,
  mark = 0,
  label = "gesture",
): Extract<FakeEditorEvent, { channel: "mutation" | "gesture" }> {
  const s = commitsSince(fake, mark);
  const total = s.applied.length + s.committed.length;
  if (total !== 1) {
    throw new InvariantError(
      "INV-1",
      `${label}: expected exactly one commit, saw ${s.applied.length} applied mutation(s) and ${s.committed.length} committed gesture(s)` +
        (s.refused.length ? ` (${s.refused.length} refused)` : ""),
      s,
    );
  }
  return s.applied[0] ?? s.committed[0];
}

/** INV-2 on a fake editor: since `mark`, nothing committed and every
 *  begun worker gesture was cancelled. */
export function expectNoCommit(
  fake: FakeEditor,
  mark = 0,
  label = "gesture",
): void {
  const s = commitsSince(fake, mark);
  if (s.applied.length + s.committed.length !== 0) {
    throw new InvariantError(
      "INV-2",
      `${label}: expected no commit, saw ${s.applied.length} mutation(s) and ${s.committed.length} committed gesture(s)`,
      s,
    );
  }
  if (s.cancelled < s.begun) {
    throw new InvariantError(
      "INV-2",
      `${label}: ${s.begun} worker gesture(s) begun but only ${s.cancelled} cancelled`,
      s,
    );
  }
}

/** INV-1 on the fake's undo stack: `run` adds exactly one undo step. */
export async function expectOneUndoStep(
  fake: FakeEditor,
  run: () => unknown | Promise<unknown>,
  label = "gesture",
): Promise<void> {
  const before = fake.undoDepth();
  await run();
  await fake.settle();
  const after = fake.undoDepth();
  if (after !== before + 1) {
    throw new InvariantError(
      "INV-1",
      `${label}: expected one undo step, the stack moved by ${after - before}`,
    );
  }
}

// ------------------------------------------------------------ model level

/** A real document, as the invariants see it. */
export interface ModelChannel {
  /** A stable serialisation of the model (equal string = equal model). */
  dump(): Promise<string>;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/** Stable JSON: object keys sorted, recursively. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** The first difference between two dumps, for a readable failure. */
export function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 60);
  return `at ${i}: …${a.slice(from, i + 60)}… vs …${b.slice(from, i + 60)}…`;
}

export interface UndoRedoReport {
  before: string;
  after: string;
  /** False when the gesture changed nothing (a no-op is reported, not
   *  failed: whether it should have changed something is the caller's
   *  domain assertion). */
  changed: boolean;
}

/**
 * INV-1 + INV-4 against a real model: `run` the gesture; ONE undo must
 * restore the dump exactly (one gesture = one undo step), and ONE redo
 * must re-apply it exactly. Leaves the document as `run` left it.
 */
export async function checkUndoRedo(
  channel: ModelChannel,
  run: () => unknown | Promise<unknown>,
  label = "gesture",
): Promise<UndoRedoReport> {
  const before = await channel.dump();
  await run();
  const after = await channel.dump();
  if (after === before) return { before, after, changed: false };
  await channel.undo();
  const undone = await channel.dump();
  if (undone !== before) {
    throw new InvariantError(
      "INV-4",
      `${label}: one undo did not restore the model (more than one undo step, or a lossy undo) ${firstDifference(before, undone)}`,
    );
  }
  await channel.redo();
  const redone = await channel.dump();
  if (redone !== after) {
    throw new InvariantError(
      "INV-4",
      `${label}: redo did not re-apply the gesture exactly ${firstDifference(after, redone)}`,
    );
  }
  return { before, after, changed: true };
}

/** INV-2 against a real model: after `run` (a gesture cancelled
 *  mid-way) the dump is byte-identical to before. */
export async function checkCancel(
  channel: ModelChannel,
  run: () => unknown | Promise<unknown>,
  label = "cancelled gesture",
): Promise<void> {
  const before = await channel.dump();
  await run();
  const after = await channel.dump();
  if (after !== before) {
    throw new InvariantError(
      "INV-2",
      `${label}: the model changed ${firstDifference(before, after)}`,
    );
  }
}

/** What ends an open gesture without committing it (INV-8). */
export type LivenessInterrupt =
  "pointercancel" | "blur" | "captureLoss" | "toolSwitch" | "documentClose";

export interface LivenessOptions {
  /** What `run` does to the open gesture, named in a failure. */
  interrupt: LivenessInterrupt;
  /** True once no gesture is open: the host is out of its dragging state
   *  (a fake editor: every begun worker gesture cancelled; an engine: a
   *  new begin is not refused as already active). */
  idle: () => boolean | Promise<boolean>;
  label?: string;
}

/**
 * INV-8 against a real model: `run` begins a gesture and interrupts it
 * the way `options.interrupt` says; afterwards nothing is open
 * (`options.idle`) and the dump is byte-identical to before. A document
 * close replaces the model, so after one only the first half is checked.
 */
export async function checkLiveness(
  channel: ModelChannel,
  run: () => unknown | Promise<unknown>,
  options: LivenessOptions,
): Promise<void> {
  const label = options.label ?? `gesture ended by ${options.interrupt}`;
  const compare = options.interrupt !== "documentClose";
  const before = compare ? await channel.dump() : "";
  await run();
  if (!(await options.idle())) {
    throw new InvariantError(
      "INV-8",
      `${label}: the gesture is still open after ${options.interrupt}`,
    );
  }
  if (!compare) return;
  const after = await channel.dump();
  if (after !== before) {
    throw new InvariantError(
      "INV-8",
      `${label}: ${options.interrupt} committed instead of aborting ${firstDifference(before, after)}`,
    );
  }
}

/** One reply of a channel log, in arrival order: its `kind` is a
 *  `WorkerToMain` kind (`gestureBegun`, `mutationApplied`, …). */
export interface ChannelLogEntry {
  kind: string;
}

/** What opens a gesture, what ends one, and what writes the document. */
const GESTURE_OPENS = new Set(["gestureBegun"]);
const GESTURE_ENDS = new Set([
  "gestureCommitted",
  "gestureCancelled",
  "gestureFailed",
]);
const DOCUMENT_WRITES = new Set([
  "mutationApplied",
  "undoApplied",
  "redoApplied",
]);

export interface NoInterleaveOptions {
  /** Reply kinds that write the document besides the defaults
   *  (`mutationApplied`, `undoApplied`, `redoApplied`): a script run's
   *  reply when the recorder keeps only the ones that wrote. */
  writes?: readonly string[];
  label?: string;
}

/** The replies a fake editor recorded since `mark`, as a channel log. */
export function channelLog(fake: FakeEditor, mark = 0): ChannelLogEntry[] {
  const out: ChannelLogEntry[] = [];
  for (const e of fake.since(mark)) {
    if (
      e.channel === "mutation" ||
      e.channel === "gesture" ||
      e.channel === "history" ||
      e.channel === "send"
    ) {
      out.push({ kind: e.reply.kind });
    }
  }
  return out;
}

/**
 * INV-7: in `log` (a fake editor's, or the replies a browser recorded),
 * no document write lands between a gesture's begin and its commit,
 * cancel or failure — another channel's write is serialised around the
 * gesture or refused, never interleaved.
 */
export function checkNoInterleave(
  log: FakeEditor | readonly ChannelLogEntry[],
  options: NoInterleaveOptions = {},
): void {
  const label = options.label ?? "gesture";
  const entries = Array.isArray(log)
    ? (log as readonly ChannelLogEntry[])
    : channelLog(log as FakeEditor);
  const writes = new Set([...DOCUMENT_WRITES, ...(options.writes ?? [])]);
  let openAt = -1;
  entries.forEach((e, i) => {
    if (GESTURE_OPENS.has(e.kind)) openAt = i;
    else if (GESTURE_ENDS.has(e.kind)) openAt = -1;
    else if (openAt >= 0 && writes.has(e.kind)) {
      throw new InvariantError(
        "INV-7",
        `${label}: ${e.kind} at #${i} landed inside the gesture begun at #${openAt}`,
        entries,
      );
    }
  });
}

type Send = (message: MainToWorkerKind) => Promise<WorkerToMain>;

interface TreeNode {
  id?: ElementId | null;
  kind: string;
  children?: TreeNode[];
}

export interface EngineModelChannelOptions {
  /** Document-meta fields left out of the dump (default: `dirty`, which
   *  an undo back to the saved state flips, and `activePage`). */
  ignoreMeta?: readonly string[];
  /** Collections included in the dump (default pages, spreads, swatches, layers). */
  collections?: readonly string[];
}

/**
 * A `ModelChannel` over an engine's message channel: the scene tree,
 * every element's properties, the document meta and a few collections.
 * Works over the headless host (`createHeadlessHost(...).host.editor
 * .client.send`) and over the editor's client alike.
 */
export function engineModelChannel(
  send: Send,
  options: EngineModelChannelOptions = {},
): ModelChannel {
  const ignore = new Set(options.ignoreMeta ?? ["dirty", "activePage"]);
  const collections = options.collections ?? [
    "pages",
    "spreads",
    "swatches",
    "layers",
  ];
  const expect = async (message: MainToWorkerKind, kind: string) => {
    const reply = await send(message);
    if (reply.kind !== kind) {
      throw new Error(
        `model dump: ${message.kind} answered ${reply.kind}: ${JSON.stringify(reply.payload ?? null).slice(0, 200)}`,
      );
    }
    return reply.payload as Record<string, unknown>;
  };
  return {
    async dump() {
      const tree = (await expect({ kind: "requestSceneTree" }, "sceneTree"))
        .roots as TreeNode[];
      const ids: ElementId[] = [];
      const walk = (n: TreeNode) => {
        if (n.id) ids.push(n.id);
        for (const c of n.children ?? []) walk(c);
      };
      tree.forEach(walk);
      const elements: unknown[] = [];
      for (const id of ids) {
        const p = await expect(
          { kind: "requestElementProperties", payload: { id } },
          "elementProperties",
        );
        elements.push(p.result ?? null);
      }
      const meta = {
        ...((await expect({ kind: "requestDocumentMeta" }, "documentMetaReply"))
          .meta as Record<string, unknown>),
      };
      for (const k of ignore) delete meta[k];
      const cols: Record<string, unknown> = {};
      for (const name of collections) {
        const reply = await send({
          kind: "requestCollection",
          payload: { name },
        } as MainToWorkerKind);
        cols[name] =
          reply.kind === "collectionReply"
            ? (reply.payload as { items: unknown }).items
            : null;
      }
      return stableJson({ tree, elements, meta, collections: cols });
    },
    async undo() {
      await expect({ kind: "undo" }, "undoApplied");
    },
    async redo() {
      await expect({ kind: "redo" }, "redoApplied");
    },
  };
}
