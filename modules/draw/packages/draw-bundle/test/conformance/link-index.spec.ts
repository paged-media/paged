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

// Conformance — the LINK INDEX (`src/link-index.ts`), against the booted
// engine: what it reads, when it reads it again, and what it must never
// answer from memory.
//
// Each case holds a count beside a behaviour, on a real document: 40
// plain leaves, two rectangles and two polygons (44 leaves). The counts
// are door calls through a counting host; everything the spec does to
// the document goes through the RAW host, the way another command — or
// another plugin, or the user — would.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BundleHost, ElementId, Mutation } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle, pasteIntoMutationFor } from "../../src";
import {
  announceRecipeChange,
  linkIndex,
  BIND_RECIPE_REVISION,
} from "../../src/link-index";
import { countingHost, type WorkLog } from "../perf/counting-host";
import {
  emptyDocument,
  leafIds,
  panelDocument,
  plainChange,
  plainId,
  poly,
  rectItem,
  seedRow,
} from "../panels/panel-document";
import { openHost } from "./host";

const RECT = { kind: "rectangle", id: "r0" } as ElementId;
const CHILD = poly("s0");
const LEAVES = 44;

const turn = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Replace one member of a facade (a spread would unbind `this`). */
function override<T extends object>(target: T, key: string, value: unknown): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      return prop === key ? value : (Reflect.get(obj, prop, receiver) as unknown);
    },
  });
}

describe("draw conformance — the link index", () => {
  let h: HeadlessHost;
  let host: BundleHost;
  let work: WorkLog;

  const stamp = async (id: ElementId, tag: string) => {
    const out = await h.host.document.setMetadata(id, { v: 1, data: { tag } });
    expect(out.applied).toBe(true);
  };

  beforeAll(async () => {
    h = await openHost();
    await h.load(
      panelDocument(
        rectItem("r0", 40, 40, 200) + rectItem("r1", 300, 40) + seedRow("s", 2, { x: 60, y: 60 }),
      ),
    );
    h.loadBundle(drawBundle);
    await stamp(plainId(0), "p0");
  });
  afterAll(() => h?.dispose());
  // A fresh view of the host per case: its own index, its own counts.
  beforeEach(() => {
    ({ host, work } = countingHost(h.host));
  });

  it("ONE walk per document revision: a tree and a read per leaf, then nothing", async () => {
    const index = linkIndex(host);
    const first = await index.snapshot();
    expect(first.leaves).toHaveLength(LEAVES);
    expect(first.leaves.map((l) => l.id.id)).toEqual(
      (await leafIds(h)).map((id) => id.id),
    );
    // What a feature iterates: the leaves that carry anything at all.
    expect(first.linked.map((l) => [l.id.id, l.envelope?.data.tag])).toEqual([
      ["p0", "p0"],
    ]);
    expect(work.count("document.tree")).toBe(1);
    expect(work.count("document.getMetadata")).toBe(LEAVES);

    work.reset();
    expect(await index.snapshot()).toBe(first);
    expect(await index.tree()).toBe(first.roots);
    expect(await index.envelopeOf(plainId(0))).toBe(first.linked[0]!.envelope);
    expect(work.reads()).toBe(0);
    // One index per host.
    expect(linkIndex(host)).toBe(index);
  });

  it("callers that ask while a walk is in flight share it", async () => {
    const index = linkIndex(host);
    const [a, b, c] = await Promise.all([
      index.snapshot(),
      index.snapshot(),
      index.envelopeOf(plainId(0)).then(() => index.snapshot()),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(work.count("document.tree")).toBe(1);
    expect(work.count("document.getMetadata")).toBe(LEAVES);
  });

  it("the envelopes it shares are FROZEN — a caller that mutates one is a bug, and a loud one", async () => {
    const { linked } = await linkIndex(host).snapshot();
    const envelope = linked[0]!.envelope!;
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.data)).toBe(true);
    expect(() => {
      (envelope.data as Record<string, unknown>).tag = "mine";
    }).toThrow(TypeError);
  });

  it("envelopeOf alone reads ONE element, and a later walk does not read it again", async () => {
    const index = linkIndex(host);
    expect((await index.envelopeOf(plainId(0)))?.data.tag).toBe("p0");
    expect(await index.envelopeOf(plainId(1))).toBeNull();
    // Asked twice, read once.
    await index.envelopeOf(plainId(0));
    expect(work.count("document.tree")).toBe(0);
    expect(work.count("document.getMetadata")).toBe(2);

    await index.snapshot();
    expect(work.count("document.getMetadata")).toBe(LEAVES);
  });

  it("A WRITE IS SEEN BY THE NEXT READ — a mutation, its undo and its redo each start a revision", async () => {
    const index = linkIndex(host);
    expect((await index.snapshot()).linked).toHaveLength(1);

    // Written through ANOTHER view of the host, read through this one.
    await stamp(plainId(1), "p1");
    work.reset();
    const after = await index.snapshot();
    expect(after.linked.map((l) => l.envelope?.data.tag)).toEqual(["p0", "p1"]);
    expect((await index.envelopeOf(plainId(1)))?.data.tag).toBe("p1");
    // The whole document again: one event says "something changed", not
    // what — and there is no door to ask.
    expect(work.count("document.getMetadata")).toBe(LEAVES);

    await h.host.document.undo();
    expect((await index.snapshot()).linked).toHaveLength(1);
    await h.host.document.redo();
    expect((await index.snapshot()).linked).toHaveLength(2);
    await h.host.document.undo();
    expect(await index.envelopeOf(plainId(1))).toBeNull();
  });

  it("a write and the read after it in ONE flow, with nothing awaited in between", async () => {
    const index = linkIndex(host);
    await index.snapshot();
    // The command shape: stamp, then discover — on the same host.
    const written = host.document.setMetadata(plainId(2), { v: 1, data: { tag: "p2" } });
    const tags = written.then(async () =>
      (await index.snapshot()).linked.map((l) => l.envelope?.data.tag),
    );
    expect(await tags).toEqual(["p0", "p2"]);
    await h.host.document.undo();
  });

  it("a tree read is one per revision too, and a change starts a new one", async () => {
    const index = linkIndex(host);
    const roots = await index.tree();
    expect(await index.tree()).toBe(roots);
    expect(work.count("document.tree")).toBe(1);
    await plainChange(h, 1);
    expect(await index.tree()).not.toBe(roots);
    expect(work.count("document.tree")).toBe(2);
  });

  it("cached(): once per revision per key; a rejection is not remembered", async () => {
    const index = linkIndex(host);
    let reads = 0;
    const read = () => {
      reads += 1;
      return Promise.resolve(reads);
    };
    expect(index.peek("k")).toBeUndefined();
    expect(await index.cached("k", read)).toBe(1);
    expect(await index.cached("k", read)).toBe(1);
    expect(await index.peek<number>("k")).toBe(1);
    await plainChange(h, 2);
    expect(index.peek("k")).toBeUndefined();
    expect(await index.cached("k", read)).toBe(2);

    let attempts = 0;
    const flaky = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("no")) : Promise.resolve("ok");
    };
    await expect(index.cached("flaky", flaky)).rejects.toThrow("no");
    expect(await index.cached("flaky", flaky)).toBe("ok");
  });

  it("WHAT A WALK CANNOT SEE: an element nested by pasteInto is read by id", async () => {
    await stamp(CHILD, "nested");
    const nest = await h.host.document.mutate(
      pasteIntoMutationFor(RECT, CHILD) as Mutation,
    );
    expect(nest.applied).toBe(true);

    const index = linkIndex(host);
    const snapshot = await index.snapshot();
    // B-18, measured: the container reports no children.
    expect(snapshot.leaves).toHaveLength(LEAVES - 1);
    expect(snapshot.leaves.some((l) => l.id.id === CHILD.id)).toBe(false);
    // …and the element still answers its own link BY ID.
    work.reset();
    expect((await index.envelopeOf(CHILD))?.data.tag).toBe("nested");
    expect(work.count("document.getMetadata")).toBe(1);
    // Once per revision, like everything else.
    await index.envelopeOf(CHILD);
    expect(work.count("document.getMetadata")).toBe(1);

    await h.host.document.undo(); // the nesting
    await h.host.document.undo(); // the stamp
    expect((await index.snapshot()).leaves).toHaveLength(LEAVES);
  });

  it("ONE walk in flight and ONE waiting, however many changes arrive meanwhile", async () => {
    // A host whose tree read takes a task — a walk that is still out
    // when the document changes under it, which is every walk in the
    // editor.
    const slow = override(
      host,
      "document",
      override(host.document, "tree", async () => {
        const roots = await host.document.tree();
        await turn();
        return roots;
      }),
    );
    const index = linkIndex(slow);
    const first = index.snapshot();
    await stamp(plainId(3), "p3");
    const second = index.snapshot();
    await stamp(plainId(4), "p4");
    const third = index.snapshot();
    // The two that asked while a walk was out wait for the SAME one.
    expect(third).toBe(second);

    const tags = async (p: typeof first) =>
      (await p).linked.map((l) => l.envelope?.data.tag);
    // The waiting walk reads the document as it is when its turn comes:
    // both writes are in it.
    expect(await tags(second)).toEqual(["p0", "p3", "p4"]);
    // The first one answered its caller with what it read — a walk that
    // straddles a change — and is not what the next caller gets.
    expect((await first).leaves).toHaveLength(LEAVES);
    expect(await index.snapshot()).toBe(await second);
    // Two walks for three requests and two changes.
    expect(work.count("document.tree")).toBe(2);

    await h.host.document.undo();
    await h.host.document.undo();
  });

  it("an unreadable tree answers EMPTY and is asked again — it is not a document with no leaves", async () => {
    let failing = true;
    const flaky = override(
      host,
      "document",
      override(host.document, "tree", () =>
        failing ? Promise.reject(new Error("worker gone")) : host.document.tree(),
      ),
    );
    const index = linkIndex(flaky);
    expect((await index.snapshot()).leaves).toEqual([]);
    failing = false;
    expect((await index.snapshot()).leaves).toHaveLength(LEAVES);
  });

  it("an unreadable ELEMENT reads as null for its caller and is asked again", async () => {
    let failing = true;
    const flaky = override(
      host,
      "document",
      override(host.document, "getMetadata", (id: ElementId) =>
        failing && id.id === "p0"
          ? Promise.reject(new Error("no"))
          : host.document.getMetadata(id),
      ),
    );
    const index = linkIndex(flaky);
    expect((await index.snapshot()).linked).toEqual([]);
    expect(await index.envelopeOf(plainId(0))).toBeNull();
    failing = false;
    expect((await index.envelopeOf(plainId(0)))?.data.tag).toBe("p0");
    expect((await index.snapshot()).linked).toHaveLength(1);
  });

  it("onDidChange: a document change (after the revision moved) and a recipe write", async () => {
    const index = linkIndex(host);
    await index.snapshot();
    const seen: number[] = [];
    const sub = index.onDidChange(() => {
      // Read INSIDE the listener: it must already be the new revision.
      void index.snapshot().then((s) => seen.push(s.linked.length));
    });

    await stamp(plainId(5), "p5");
    await turn();
    expect(seen).toEqual([2]);

    // A recipe write is not a document event; the announcement is. It is
    // made through ANOTHER view of the host and still arrives.
    const before = h.host.bindings.get(BIND_RECIPE_REVISION);
    announceRecipeChange(h.host);
    await turn();
    expect(seen).toEqual([2, 2]);
    expect(h.host.bindings.get(BIND_RECIPE_REVISION)).not.toBe(before);
    // …and it did not cost a walk: the links did not change.
    work.reset();
    await index.snapshot();
    expect(work.reads()).toBe(0);

    sub.dispose();
    await h.host.document.undo();
    await turn();
    expect(seen).toEqual([2, 2]);
  });

  it("the two changes the FACADE does not report are read off the raw client", async () => {
    // The headless client never sends either message, so they are sent
    // by hand through the door the index subscribed at.
    const wire: { send: (message: { kind: string }) => void } = {
      send: () => {
        throw new Error("the index did not subscribe to the raw client");
      },
    };
    const wired = override(host, "editor", {
      client: {
        subscribe(listener: (message: { kind: string }) => void) {
          wire.send = listener;
          return () => {};
        },
      },
    });
    const index = linkIndex(wired);
    let told = 0;
    index.onDidChange(() => {
      told += 1;
    });
    const first = await index.snapshot();

    // A reply to somebody's read is not a change.
    wire.send({ kind: "elementProperties" });
    wire.send({ kind: "stats" });
    expect(await index.snapshot()).toBe(first);
    expect(told).toBe(0);

    // A committed drag: its own undo step, no `mutationApplied`. The
    // links are read again — and no panel is reloaded for it.
    wire.send({ kind: "gestureCommitted" });
    work.reset();
    expect(await index.snapshot()).not.toBe(first);
    expect(work.count("document.getMetadata")).toBe(LEAVES);
    expect(told).toBe(0);

    // A new document under a host that outlives it.
    wire.send({ kind: "documentLoaded" });
    work.reset();
    await index.snapshot();
    expect(work.count("document.getMetadata")).toBe(LEAVES);
    expect(told).toBe(1);
  });

  it("a host that cannot report a change at all is given NO memory", async () => {
    const mute = override(
      host,
      "document",
      override(host.document, "onDidChange", () => {
        throw new Error("no event door");
      }),
    );
    const index = linkIndex(mute);
    await index.snapshot();
    await stamp(plainId(6), "p6");
    // Nothing told it — and it did not need telling.
    expect((await index.snapshot()).linked).toHaveLength(2);
    expect(work.count("document.tree")).toBe(2);
    await h.host.document.undo();
  });

  it("A NEW DOCUMENT loaded by the HEADLESS harness: silent, so the harness says it", async () => {
    const index = linkIndex(host);
    expect((await index.snapshot()).leaves).toHaveLength(LEAVES);
    // `openHost()`'s `load` calls `forgetAllLinks()` — the harness's
    // own `load` talks to the worker directly and broadcasts nothing.
    await h.load(emptyDocument());
    expect((await index.snapshot()).leaves).toEqual([]);
    expect(await index.envelopeOf(plainId(0))).toBeNull();
  });
});
