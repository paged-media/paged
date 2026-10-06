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

// COUNT BUDGET — a 10-op `host.objects.batch` over paged.draw's kinds and
// core paths (ADR 323 method rule: "count budgets for host calls and undo
// steps on the new paths").
//
// Counted at the ENGINE CLIENT — the one door every lane ends at: the
// registry's core seam, draw's kinds (through the bundle host's
// facades) and the parts door all call it. So the number is what the
// batch costs the engine, whoever asked.
//
// The batch: 6 core paths on 3 elements, 1 appearance stack, 2 path
// writes, 1 graphic-style create (the label-hash lane).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ObjectOp } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle } from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "../conformance/host";

const D = "media.paged.draw";
const A = (kind: string, id: string) => `plugin:${D}/${kind}/${id}`;

type Client = Record<string, unknown>;

/** Count every call to the engine client, by method (and `send` kind). */
function countClient(client: Client): { counts: Record<string, number>; reset(): void } {
  const counts: Record<string, number> = {};
  for (const [name, fn] of Object.entries(client)) {
    if (typeof fn !== "function") continue;
    client[name] = (...args: unknown[]) => {
      const key = name === "send" ? `send:${(args[0] as { kind?: string })?.kind}` : name;
      counts[key] = (counts[key] ?? 0) + 1;
      return (fn as (...a: unknown[]) => unknown).apply(client, args);
    };
  }
  return {
    counts,
    reset() {
      for (const k of Object.keys(counts)) delete counts[k];
    },
  };
}

describe("perf budget — a 10-op object-model batch", () => {
  let h: HeadlessHost;
  let counter: ReturnType<typeof countClient>;

  beforeAll(async () => {
    h = await openHost();
    await h.load(F1_MULTI_SHAPE.bytes());
    h.loadBundle(drawBundle);
    counter = countClient((h.host as unknown as { editor: { client: Client } }).editor.client);
  });
  afterAll(() => h?.dispose());

  it("ONE engine mutation, ONE undo step, and a pinned read count", async () => {
    const weightBefore = await h.objects.get("rectangle:urect", "frameStrokeWeight");
    const points = (await h.objects.get(A("path", "polygon:upoly"), "points")) as { value: unknown[] };
    const ops: ObjectOp[] = [
      { op: "set", address: "rectangle:urect", path: "frameStrokeWeight", value: 2 },
      { op: "set", address: "rectangle:urect", path: "frameOpacity", value: 80 },
      { op: "set", address: "polygon:upoly", path: "frameStrokeWeight", value: 3 },
      { op: "set", address: "polygon:upoly", path: "frameOpacity", value: 70 },
      { op: "set", address: "graphicLine:uline", path: "frameStrokeWeight", value: 4 },
      { op: "set", address: "rectangle:urect", path: "frameFillTint", value: 50 },
      {
        op: "set",
        address: A("appearance", "rectangle:urect"),
        path: "fills",
        value: [{ color: "Color/Black", tint: 40, opacity: 100, blendMode: "Normal" }],
      },
      { op: "set", address: A("path", "polygon:upoly"), path: "points", value: points.value },
      { op: "set", address: A("path", "polygon:upoly"), path: "subpathStarts", value: [] },
      { op: "create", kind: `plugin:${D}/graphicStyle`, props: { name: "Budget" } },
    ];
    counter.reset();
    const out = await h.objects.batch(ops);
    const counts = { ...counter.counts };
    expect(out, out.reason).toMatchObject({ applied: true, undoSteps: 1 });

    // ONE mutation reaches the engine — the whole batch.
    expect(counts.mutate).toBe(1);
    // READS, pinned per door (measured 2026-10-06, engine 0.70.0,
    // plugin-sdk 0.2.43-canary.0, plugin-level batch). Whose they are:
    //   · the SDK's core seam — NOTHING: the six core paths validate and
    //     plan off its cached containment snapshot (warm here: the read
    //     above built it; cold, it is 11 `collection` + 1 scene tree, once
    //     per document revision, not per op);
    //   · the planning mark is gone (the plugin-level batch plans every
    //     library of a batch at once), and with it the `subscribe`;
    //   · draw `appearance` — 2 `requestElementProperties` (the envelope
    //     and the element's vocabulary, which filters the bake);
    //   · draw `path` — 1 `pathAnchors`: both path writes fold onto ONE
    //     table and ONE framePath;
    //   · draw `graphicStyle` (the label-hash lane) — 3 `documentMeta`
    //     (the label: library read, origin read, plan), 2 `readPagedPart`
    //     (the fixed-name part, twice), 3 `writePagedPart` (origin, the
    //     content-addressed state, the stamped fixed-name part — written
    //     by the REGISTRY from the `state` write's parts);
    //   · the registry — 1 `documentMeta`: it reads the document label to
    //     merge the `x-paged:media.paged.draw.recipes` sub-key into it.
    //     The appearance stack shares the write with a library, so it is
    //     a full-envelope stamp (no second label read).
    // None of it grows with the op count except per touched element.
    expect(counts).toEqual({
      "send:requestElementProperties": 2,
      pathAnchors: 1,
      "send:readPagedPart": 2,
      documentMeta: 4,
      "send:writePagedPart": 3,
      mutate: 1,
    });

    // ONE undo restores all ten.
    await h.host.document.undo();
    expect(await h.objects.get("rectangle:urect", "frameStrokeWeight")).toEqual(weightBefore);
    expect(await h.objects.query(`plugin:${D}/graphicStyle`)).toEqual([]);
  });
});

