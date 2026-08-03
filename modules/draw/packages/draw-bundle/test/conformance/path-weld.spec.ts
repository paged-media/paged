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

// TRUE JOIN conformance — the protocol-v56 topology ops (`joinPaths` /
// `closePath`) through the REAL engine wasm the harness boots. Pins:
//   (1) the ENGINE-OP PROBE: the booted build's mutation vocabulary
//       actually carries closePath + joinPaths. This test is the gate —
//       if it fails, the wasm behind the harness predates v56 and every
//       assertion below would be silently testing the COINCIDE fallback
//       instead of the real weld;
//   (2) WELD: two open paths + `Path: Join` → one element (leaf count
//       drops by 1, the other element's anchors are merged into the
//       survivor); ONE undo brings both back;
//   (3) CLOSE: an open path + `Path: Close path` → `subpathOpen` false;
//       ONE undo reopens it;
//   (4) the FALLBACK lane, driven against a host whose engine answers
//       "unknown variant" for the weld ops (the pre-v56 shape): Join
//       degrades to the pathPointSet coincide plan — both elements
//       survive, endpoints merely coincide.

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type {
  BundleHost,
  CommandContribution,
  ElementId,
  Mutation,
  MutationOutcome,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  applyJoin,
  closePathMutationFor,
  joinPathsMutationFor,
  parseOpVocabulary,
  engineOpVocabulary,
  supportsPathWeld,
  JOIN_COMMAND_ID,
  CLOSE_PATH_COMMAND_ID,
} from "../../src";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

async function leafIds(h: HeadlessHost): Promise<string[]> {
  const roots = await h.host.document.tree();
  const out: string[] = [];
  const walk = (nodes: { id?: { id?: unknown } | null; children?: unknown[] }[]) => {
    for (const node of nodes) {
      const raw = node.id?.id;
      if (typeof raw === "string" && (!node.children || node.children.length === 0)) {
        out.push(raw);
      }
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return out;
}

const asPolygon = (id: string): ElementId =>
  ({ kind: "polygon", id }) as ElementId;

describe("draw conformance — true join (protocol v56 closePath / joinPaths)", () => {
  describe("the vocabulary parser (pure)", () => {
    it("reads the op list out of an unknown-variant rejection", () => {
      const vocab = parseOpVocabulary({
        error: {
          kind: "notImplemented",
          details: {
            what:
              "malformed message: unknown variant `nope`, expected one of " +
              "`insertPath`, `closePath`, `joinPaths` at line 1 column 79",
          },
        },
      });
      expect(vocab).not.toBeNull();
      expect(vocab!.has("closePath")).toBe(true);
      expect(vocab!.has("joinPaths")).toBe(true);
      expect(vocab!.has("nope")).toBe(false);
    });

    it("answers null for a foreign error shape (callers stay optimistic)", () => {
      expect(parseOpVocabulary(null)).toBeNull();
      expect(parseOpVocabulary({ error: { kind: "noDocument" } })).toBeNull();
    });
  });

  it("the wire builders emit the exact v56 shapes", () => {
    const a = asPolygon("uA");
    const b = asPolygon("uB");
    expect(closePathMutationFor(a)).toEqual({
      op: "closePath",
      args: { elementId: a },
    });
    expect(closePathMutationFor(a, 1)).toEqual({
      op: "closePath",
      args: { elementId: a, subpath: 1 },
    });
    expect(joinPathsMutationFor(a, b)).toEqual({
      op: "joinPaths",
      args: { elementId: a, otherId: b },
    });
  });

  describe("against the real engine", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    const insertOpenPath = async (
      points: ReadonlyArray<[number, number]>,
    ): Promise<ElementId> => {
      const outcome = await h.host.document.mutate({
        op: "insertPath",
        args: {
          pageId: F1_MULTI_SHAPE.pageId,
          anchors: points.map((p) => ({ anchor: p, left: p, right: p })),
          open: true,
        },
      } as Mutation);
      expect(outcome.applied).toBe(true);
      const created = (outcome as Extract<MutationOutcome, { applied: true }>)
        .createdId;
      expect(created).not.toBeNull();
      return created!;
    };

    it("THE GATE — the booted engine carries closePath + joinPaths", async () => {
      // Observed at the checkout this landed on: engineVersion
      // "0.0.0-local", protocol 56. A LOWER protocol here means the
      // harness booted an older canvas-wasm and the weld assertions
      // below cannot be exercised — read this number, do not silence it.
      expect(
        h.protocolVersion,
        `booted engine ${h.engineVersion} speaks protocol ${h.protocolVersion} — ` +
          "closePath/joinPaths landed in v56",
      ).toBeGreaterThanOrEqual(56);
      const vocab = await engineOpVocabulary(h.host);
      expect(
        vocab,
        "the engine did not answer its op vocabulary — the probe shape changed",
      ).not.toBeNull();
      // If either of these fails, the wasm behind the harness predates
      // protocol v56 and the weld assertions below are meaningless.
      expect(vocab!.has("closePath")).toBe(true);
      expect(vocab!.has("joinPaths")).toBe(true);
      expect(await supportsPathWeld(h.host)).toBe(true);
      // The probe itself must not touch the document (an unknown variant
      // fails deserialization — nothing applies, nothing undoes).
      expect(vocab!.has("mediaPagedDrawOpProbe")).toBe(false);
    });

    it("WELD — two open paths join into ONE element; one undo restores both", async () => {
      const a = await insertOpenPath([
        [100, 100],
        [200, 100],
      ]);
      const b = await insertOpenPath([
        [260, 100],
        [340, 100],
      ]);
      const before = await leafIds(h);
      expect(before).toContain(a.id);
      expect(before).toContain(b.id);

      await h.host.selection.set([a, b]);
      await commandFor(h, JOIN_COMMAND_ID).handler(undefined);

      const after = await leafIds(h);
      // Leaf count drops by one and the OTHER element is the one gone.
      expect(after.length).toBe(before.length - 1);
      expect(after).toContain(a.id);
      expect(after).not.toContain(b.id);

      // The survivor carries both contours' anchors on ONE open path
      // (the endpoints are apart → an implicit straight edge, no merge).
      const welded = await h.host.document.pathAnchors(a);
      expect(welded).not.toBeNull();
      expect(welded!.anchors).toHaveLength(4);
      expect(welded!.subpathStarts).toEqual([0]);
      expect(welded!.subpathOpen?.[0]).toBe(true);
      const xs = welded!.anchors.map((p) => p.anchor[0]).sort((l, r) => l - r);
      expect(xs).toEqual([100, 200, 260, 340]);

      // ONE undo is the faithful inverse: both elements, both tables.
      await h.host.document.undo();
      const restored = await leafIds(h);
      expect(restored.length).toBe(before.length);
      expect(restored).toContain(b.id);
      expect((await h.host.document.pathAnchors(a))!.anchors).toHaveLength(2);
      expect((await h.host.document.pathAnchors(b))!.anchors).toHaveLength(2);
    });

    it("CLOSE — an open path closes; one undo reopens it", async () => {
      const c = await insertOpenPath([
        [400, 400],
        [500, 400],
        [500, 500],
      ]);
      expect((await h.host.document.pathAnchors(c))!.subpathOpen?.[0]).toBe(true);

      await h.host.selection.set([c]);
      await commandFor(h, CLOSE_PATH_COMMAND_ID).handler(undefined);

      const closed = await h.host.document.pathAnchors(c);
      expect(closed!.subpathOpen?.[0]).toBe(false);
      // Closing an apart-endpoint contour adds the implicit straight
      // edge — the anchor count is unchanged.
      expect(closed!.anchors).toHaveLength(3);

      await h.host.document.undo();
      expect((await h.host.document.pathAnchors(c))!.subpathOpen?.[0]).toBe(true);
    });

    it("a 1-element Join CLOSES the path too (the same v56 op)", async () => {
      const d = await insertOpenPath([
        [300, 600],
        [400, 600],
        [400, 700],
      ]);
      await h.host.selection.set([d]);
      await commandFor(h, JOIN_COMMAND_ID).handler(undefined);
      expect((await h.host.document.pathAnchors(d))!.subpathOpen?.[0]).toBe(false);
      await h.host.document.undo();
      expect((await h.host.document.pathAnchors(d))!.subpathOpen?.[0]).toBe(true);
    });

    it("an honest engine REFUSAL is a no-op, never a silent coincide fallback", async () => {
      // A rectangle is bounds-based (no anchor table) — closePath has
      // nothing to close. The command must leave the document alone
      // rather than fall through to the endpoint-moving fallback.
      const rect = {
        kind: "rectangle",
        id: F1_MULTI_SHAPE.ids.rectangle!,
      } as ElementId;
      const before = await leafIds(h);
      await h.host.selection.set([rect]);
      await expect(
        commandFor(h, CLOSE_PATH_COMMAND_ID).handler(undefined),
      ).resolves.toBeUndefined();
      expect((await leafIds(h)).length).toBe(before.length);
    });

    it("FALLBACK — a pre-v56 engine degrades Join to the coincide subset", async () => {
      const a = await insertOpenPath([
        [100, 700],
        [200, 700],
      ]);
      const b = await insertOpenPath([
        [260, 700],
        [340, 700],
      ]);
      const before = await leafIds(h);

      // A host whose engine does not know the weld ops — the exact
      // rejection an older canvas-wasm answers (serde's unknown-variant
      // message). Everything else delegates to the REAL engine, so the
      // fallback's pathPointSet batch genuinely applies.
      const legacyHost = {
        ...h.host,
        document: {
          ...h.host.document,
          mutate: async (m: Mutation): Promise<MutationOutcome> => {
            const op = (m as { op: string }).op;
            if (op !== "batch" && op !== "pathPointSet") {
              return {
                applied: false,
                error: {
                  error: {
                    kind: "notImplemented",
                    details: {
                      what:
                        `malformed message: unknown variant \`${op}\`, ` +
                        "expected one of `pathPointSet`, `batch` at line 1 column 9",
                    },
                  },
                },
              };
            }
            return h.host.document.mutate(m);
          },
        },
      } as unknown as BundleHost;

      expect(await supportsPathWeld(legacyHost)).toBe(false);
      await h.host.selection.set([a, b]);
      await applyJoin(legacyHost);

      // Topology untouched — BOTH elements survive, the nearest
      // endpoints merely coincide (the documented fallback).
      const after = await leafIds(h);
      expect(after.length).toBe(before.length);
      expect(after).toContain(b.id);
      const tableB = await h.host.document.pathAnchors(b);
      expect(tableB!.anchors[0].anchor).toEqual([200, 700]);
      expect(tableB!.subpathOpen?.[0]).toBe(true);
      await h.host.document.undo();
    });
  });
});
