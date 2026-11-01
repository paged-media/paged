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

// Phase 4c conformance — Pathfinder Unite / Subtract / Intersect /
// Exclude (the `pathfinderBoolean` wire consumers). Asserts (1) the
// EXACT wire shape per preset, (2) each kind applied at the REAL
// engine over two overlapping closed polygons (F4) with the consumed
// element removed and undo restoring it, and (the commands are the host's, `paged.pathfinder.*`).

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";

import type { ElementId, Mutation } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import { drawBundle, pathfinderMutationFor } from "../../src";
import { F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "./host";

/** The four shape modes, in Illustrator's order. */
const KINDS = ["union", "subtract", "intersect", "exclude"] as const;

const KEPT = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;
const OTHER = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId;

/** Count selectable leaves in the scene tree (the consumed-element
 *  probe — a pathfinder removes `others`). */
async function leafCount(h: HeadlessHost): Promise<number> {
  const roots = await h.host.document.tree();
  let n = 0;
  const walk = (nodes: { id?: unknown; children?: unknown[] }[]) => {
    for (const node of nodes) {
      if (node.id) n++;
      if (node.children) walk(node.children as never);
    }
  };
  walk(roots as never);
  return n;
}

describe("draw conformance — pathfinder booleans (Phase 4c)", () => {
  it("each preset emits the exact pathfinderBoolean wire shape", () => {
    for (const kind of KINDS) {
      const m = pathfinderMutationFor(KEPT, [OTHER], kind) as Extract<
        Mutation,
        { op: "pathfinderBoolean" }
      >;
      expect(m).toEqual({
        op: "pathfinderBoolean",
        args: { kept: KEPT, others: [OTHER], kind },
      });
    }
  });

  describe("against the real engine (two overlapping quads, undo round-trips)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F4_OVERLAP.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    beforeEach(async () => {
      await h.host.selection.set([]);
    });

    for (const kind of KINDS) {
      it(`${kind} consumes the other element; undo restores it`, async () => {
        const before = await leafCount(h);
        const outcome = await h.host.document.mutate(
          pathfinderMutationFor(KEPT, [OTHER], kind),
        );
        expect(outcome.applied).toBe(true);
        // The consumed element left the tree; the kept one remains.
        expect(await leafCount(h)).toBe(before - 1);
        const keptTable = await h.host.document.pathAnchors(KEPT);
        expect(keptTable).not.toBeNull();
        await h.host.document.undo();
        expect(await leafCount(h)).toBe(before);
        // Both operands are intact again.
        expect(await h.host.document.pathAnchors(OTHER)).not.toBeNull();
      });
    }
  });
});
