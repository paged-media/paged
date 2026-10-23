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

// `mutate(m, { amend })` (engine ADR 1004, extensions ADR 337): a write
// joins the undo step a change committed, so a rebuild an edit provokes is
// undone and redone with the edit. Covered on the fake editor (the flag,
// the wire message, the step count, the refusal) and on the real engine
// through the headless harness (a mutation and a gesture commit amended,
// one undo, one redo, a refusal after the history moved).

import { afterEach, describe, expect, it } from "bun:test";

import type {
  DocumentChangeEvent,
  ElementId,
  PluginManifest,
} from "@paged-media/plugin-api";

import { createBundleHost } from "../src";
import { createHeadlessHost, type HeadlessHost } from "../src/harness";
import { createFakeEditor } from "../src/fake-editor";
import { minimalIdml } from "./fixtures/minimal-idml";

import { silentConsole as silent } from "../src/testing";

const manifest = (): PluginManifest => ({
  id: "media.paged.test",
  name: "test",
  version: "1.0.0",
  apiVersion: "^0.2",
  capabilities: { document: { read: "broad", write: "broad" } },
});

const RECT = { kind: "rectangle", id: "urect" } as ElementId;

const opacity = (value: number) =>
  ({
    op: "setElementProperty",
    args: {
      elementId: RECT,
      path: "frameOpacity",
      value: { type: "length", value },
    },
  }) as never;

describe("mutate(…, { amend }) on the fake editor", () => {
  it("is a supported door, sends amendMutation, and adds no step", async () => {
    const fake = createFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
      capabilityMode: "enforce",
    });
    expect(host.supports("document.mutate.amend@1")).toBe(true);
    const seen: DocumentChangeEvent[] = [];
    host.document.onDidChange((e) => seen.push(e));
    const edit = await host.document.mutate(opacity(50));
    expect(edit.applied).toBe(true);
    expect(seen[0]?.appliedSeq).toBe(edit.applied ? edit.appliedSeq : -1);
    const depth = fake.undoDepth();
    const follow = await host.document.mutate(opacity(20), {
      amend: seen[0]!.appliedSeq,
    });
    expect(follow.applied).toBe(true);
    expect(fake.undoDepth()).toBe(depth);
    expect(fake.ofChannel("mutation").at(-1)).toMatchObject({
      amend: seen[0]!.appliedSeq,
    });
    await host.document.undo();
    const late = await host.document.mutate(opacity(10), {
      amend: seen[0]!.appliedSeq,
    });
    expect(late).toMatchObject({
      applied: false,
      error: { error: { kind: "notAmendable" } },
    });
  });

  it("refuses an amend that is not a step number, without sending it", async () => {
    const fake = createFakeEditor();
    const { host } = createBundleHost(() => fake.editor, manifest(), {
      console: silent,
      capabilityMode: "enforce",
    });
    const out = await host.document.mutate(opacity(50), { amend: 1.5 });
    expect(out.applied).toBe(false);
    expect(fake.mutations()).toEqual([]);
  });
});

describe("mutate(…, { amend }) on the real engine", () => {
  let h: HeadlessHost | null = null;
  afterEach(() => {
    h?.dispose();
    h = null;
  });

  const props = async (live: HeadlessHost) =>
    JSON.stringify(await live.host.document.elementProperties(RECT));

  it("joins a mutation's step: one undo reverts both, one redo replays both", async () => {
    h = await createHeadlessHost({ console: silent });
    await h.load(minimalIdml());
    const original = await props(h);
    const seen: DocumentChangeEvent[] = [];
    h.host.document.onDidChange((e) => seen.push(e));
    const edit = await h.host.document.mutate(opacity(50));
    expect(edit.applied).toBe(true);
    const seq = seen[0]!.appliedSeq!;
    const first = await h.host.document.mutate(opacity(30), { amend: seq });
    expect(first.applied).toBe(true);
    // The step is named by the last amend's number from then on.
    const next = first.applied ? first.appliedSeq! : -1;
    expect(seen.at(-1)?.appliedSeq).toBe(next);
    const second = await h.host.document.mutate(opacity(20), { amend: next });
    expect(second.applied).toBe(true);
    const both = await props(h);

    await h.host.document.undo();
    expect(await props(h)).toBe(original);
    await h.host.document.redo();
    expect(await props(h)).toBe(both);
    // A redo put the step back: it is not amendable any more.
    const late = await h.host.document.mutate(opacity(10), {
      amend: second.applied ? second.appliedSeq! : -1,
    });
    expect(late).toMatchObject({
      applied: false,
      error: { error: { kind: "notAmendable" } },
    });
    expect(await props(h)).toBe(both);
  });

  it("joins a gesture commit's step", async () => {
    h = await createHeadlessHost({ console: silent });
    await h.load(minimalIdml());
    const original = await props(h);
    const seen: DocumentChangeEvent[] = [];
    h.host.document.onDidChange((e) => seen.push(e));
    type Send = (m: {
      kind: string;
      payload?: unknown;
    }) => Promise<{ kind: string; payload?: any }>;
    const client = (h.host.editor as unknown as { client: { send: Send } })
      .client;
    const send = client.send.bind(client);
    const begun = await send({
      kind: "beginGesture",
      payload: {
        nodes: [RECT],
        gesture: { kind: "resize", handle: "south" },
        anchor: null,
      },
    });
    const handle = begun.payload.handle as number;
    await send({
      kind: "updateGesture",
      payload: {
        handle,
        delta: [0, 40],
        modifiers: { shift: false, alt: false, disableSnap: true },
      },
    });
    await send({ kind: "commitGesture", payload: { handle } });
    expect(seen[0]).toMatchObject({ kind: "gestureCommitted" });
    const follow = await h.host.document.mutate(opacity(40), {
      amend: seen[0]!.appliedSeq,
    });
    expect(follow.applied).toBe(true);
    await h.host.document.undo();
    expect(await props(h)).toBe(original);
  });
});
