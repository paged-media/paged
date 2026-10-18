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
// element removed and undo restoring it, and (3) the recorded command
// handlers drive the live selection (first selected = kept,
// re-selected on success).

import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";

import type {
  CommandContribution,
  ElementId,
  Mutation,
} from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  PATHFINDER_PRESETS,
  pathfinderMutationFor,
} from "../../src";
import { F4_OVERLAP } from "../fixtures/corpus";
import { openHost } from "./host";

const KEPT = { kind: "polygon", id: F4_OVERLAP.ids.polygon! } as ElementId;
const OTHER = { kind: "polygon", id: F4_OVERLAP.secondId } as ElementId;

function commandFor(h: HeadlessHost, id: string): CommandContribution {
  const rec = h.contributions.find((c) => c.kind === "command" && c.id === id);
  if (!rec) throw new Error(`no command recorded for ${id}`);
  return rec.value as CommandContribution;
}

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
    for (const preset of PATHFINDER_PRESETS) {
      const m = pathfinderMutationFor(KEPT, [OTHER], preset.kind) as Extract<
        Mutation,
        { op: "pathfinderBoolean" }
      >;
      expect(m).toEqual({
        op: "pathfinderBoolean",
        args: { kept: KEPT, others: [OTHER], kind: preset.kind },
      });
    }
    expect(PATHFINDER_PRESETS.map((p) => p.kind)).toEqual([
      "union",
      "subtract",
      "intersect",
      "exclude",
    ]);
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

    for (const preset of PATHFINDER_PRESETS) {
      it(`${preset.kind} consumes the other element; undo restores it`, async () => {
        const before = await leafCount(h);
        const outcome = await h.host.document.mutate(
          pathfinderMutationFor(KEPT, [OTHER], preset.kind),
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

    it("the recorded Unite handler drives the selection (kept = first selected, re-selected)", async () => {
      const before = await leafCount(h);
      await h.host.selection.set([KEPT, OTHER]);
      await commandFor(
        h,
        "media.paged.draw.command.pathfinderUnite",
      ).handler(undefined);
      expect(await leafCount(h)).toBe(before - 1);
      // The result (kept) element is the selection.
      const sel = h.host.selection.get();
      expect(sel).toHaveLength(1);
      expect(sel[0].id).toBe(F4_OVERLAP.ids.polygon);
      await h.host.document.undo();
      expect(await leafCount(h)).toBe(before);
    });

    it("with fewer than two selected the command is a no-op (no throw)", async () => {
      await h.host.selection.set([KEPT]);
      const before = await leafCount(h);
      await expect(
        commandFor(
          h,
          "media.paged.draw.command.pathfinderSubtract",
        ).handler(undefined),
      ).resolves.toBeUndefined();
      expect(await leafCount(h)).toBe(before);
    });
  });
});
