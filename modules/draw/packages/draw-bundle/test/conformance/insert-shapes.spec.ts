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

// Wave 2 conformance — the parametric insert-shape commands: (1) the
// exact batch wire shape the builders emit, (2) each recorded command
// handler inserting its v0 default geometry THROUGH THE REAL ENGINE
// (leaf counts + spot geometry read back via pathAnchors), (3) one
// undo returning the whole grid (the one-batch promise).

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import type { CommandContribution, Mutation } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  arcDefaultTable,
  spiralDefaultTable,
  rectGridDefaultTables,
  polarGridDefaultTables,
  insertTablesMutationFor,
  INSERT_ARC_COMMAND_ID,
  INSERT_SPIRAL_COMMAND_ID,
  INSERT_RECT_GRID_COMMAND_ID,
  INSERT_POLAR_GRID_COMMAND_ID,
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

describe("draw conformance — insert-shape commands (wave 2)", () => {
  it("insertTablesMutationFor emits ONE batch of insertPath ops", () => {
    const m = insertTablesMutationFor("usp", [
      {
        anchors: [
          { anchor: [0, 0], left: [0, 0], right: [0, 0] },
          { anchor: [10, 0], left: [10, 0], right: [10, 0] },
        ],
        subpathStarts: [0],
        subpathOpen: [true],
      },
    ]) as Extract<Mutation, { op: "batch" }>;
    expect(m).toEqual({
      op: "batch",
      args: {
        ops: [
          {
            op: "insertPath",
            args: {
              pageId: "usp",
              anchors: [
                { anchor: [0, 0], left: [0, 0], right: [0, 0] },
                { anchor: [10, 0], left: [10, 0], right: [10, 0] },
              ],
              open: true,
            },
          },
        ],
      },
    });
    expect(insertTablesMutationFor("usp", [])).toBeNull();
  });

  it("the default tables carry the documented v0 geometry", () => {
    // Arc: 270° → 3 quarter slices → 4 anchors, open.
    expect(arcDefaultTable().anchors).toHaveLength(4);
    expect(arcDefaultTable().subpathOpen).toEqual([true]);
    // Spiral: 3 turns × 8 seg/turn + 1 anchors, open.
    expect(spiralDefaultTable().anchors).toHaveLength(25);
    // Rect grid 4×4 → 5 + 5 lines; polar 3 rings + 6 radials.
    expect(rectGridDefaultTables()).toHaveLength(10);
    expect(polarGridDefaultTables()).toHaveLength(9);
  });

  describe("against the real engine (F1)", () => {
    let h: HeadlessHost;

    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    const runCommand = async (id: string) => {
      const command = commandFor(h, id);
      await command.handler(undefined, undefined);
    };

    it("insertArc lands one open path with the arc's anchors", async () => {
      const before = await leafIds(h);
      await runCommand(INSERT_ARC_COMMAND_ID);
      const after = await leafIds(h);
      expect(after.length).toBe(before.length + 1);
      const createdId = after.find((id) => !before.includes(id))!;
      const table = await h.host.document.pathAnchors({
        kind: "polygon",
        id: createdId,
      } as never);
      expect(table).not.toBeNull();
      expect(table!.anchors).toHaveLength(4);
      expect(table!.subpathOpen?.[0]).toBe(true);
      // The arc starts on the ellipse: (cx+rx, cy) = (300, 200).
      expect(table!.anchors[0].anchor[0]).toBeCloseTo(300);
      expect(table!.anchors[0].anchor[1]).toBeCloseTo(200);
    });

    it("insertSpiral lands one open 25-anchor path", async () => {
      const before = await leafIds(h);
      await runCommand(INSERT_SPIRAL_COMMAND_ID);
      const after = await leafIds(h);
      expect(after.length).toBe(before.length + 1);
      const createdId = after.find((id) => !before.includes(id))!;
      const table = await h.host.document.pathAnchors({
        kind: "polygon",
        id: createdId,
      } as never);
      expect(table!.anchors).toHaveLength(25);
      expect(table!.subpathOpen?.[0]).toBe(true);
    });

    it("insertRectGrid lands 10 line paths in ONE undo step", async () => {
      const before = await leafIds(h);
      await runCommand(INSERT_RECT_GRID_COMMAND_ID);
      const after = await leafIds(h);
      expect(after.length).toBe(before.length + 10);
      // One batch = one undo returns the WHOLE grid.
      await h.host.document.undo();
      expect((await leafIds(h)).length).toBe(before.length);
    });

    it("insertPolarGrid lands 3 closed rings + 6 open spokes", async () => {
      const before = await leafIds(h);
      await runCommand(INSERT_POLAR_GRID_COMMAND_ID);
      const after = await leafIds(h);
      expect(after.length).toBe(before.length + 9);
      const created = after.filter((id) => !before.includes(id));
      let closed = 0;
      let open = 0;
      for (const id of created) {
        const table = await h.host.document.pathAnchors({
          kind: "polygon",
          id,
        } as never);
        if (table?.subpathOpen?.[0]) open++;
        else closed++;
      }
      expect(closed).toBe(3);
      expect(open).toBe(6);
    });
  });
});
