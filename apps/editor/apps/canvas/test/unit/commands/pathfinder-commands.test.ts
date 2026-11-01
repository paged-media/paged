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

// `paged.pathfinder.*`: the ten verbs through their runners over a recording
// client. Shape modes: the FIRST selected object is the kept target. Region
// verbs: `elementIds` top-to-bottom by the scene tree's paint order, not by
// click order. Fewer than two: nothing sent. A refusal comes back in words.

import { describe, expect, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import {
  buildPathfinderCommands,
  PATHFINDER_MENU_ITEMS,
  runRegionVerb,
  runShapeMode,
  topToBottom,
  type PathfinderDeps,
} from "../../../src/pathfinder-commands";

const A = { kind: "rectangle", id: "a" } as unknown as ElementId;
const B = { kind: "rectangle", id: "b" } as unknown as ElementId;
const C = { kind: "oval", id: "c" } as unknown as ElementId;

function fake(
  selection: ElementId[],
  reply: unknown = { kind: "mutationApplied", payload: {} },
) {
  const sent: unknown[] = [];
  const selected: ElementId[][] = [];
  const deps: PathfinderDeps = {
    client: {
      mutate: async (m: unknown) => {
        sent.push(m);
        return reply as never;
      },
      // Paint order, back to front: c, a, b.
      sceneTree: async () => [{ id: C }, { id: A }, { id: B }] as never,
    },
    getSelection: () => selection,
    setSelection: async (ids) => {
      selected.push(ids);
    },
  };
  return { deps, sent, selected };
}

describe("shape modes", () => {
  test("Unite / Subtract / Intersect / Exclude keep the first selected and consume the rest, in one mutation", async () => {
    covers(
      "command:paged.pathfinder.unite",
      "command:paged.pathfinder.subtract",
      "command:paged.pathfinder.intersect",
      "command:paged.pathfinder.exclude",
    );
    for (const kind of ["union", "subtract", "intersect", "exclude"] as const) {
      const { deps, sent, selected } = fake([B, A, C]);
      expect(await runShapeMode(deps, kind, kind)).toBeNull();
      expect(selected).toEqual([[B]]);
      expect(sent).toEqual([
        { op: "pathfinderBoolean", args: { kept: B, others: [A, C], kind } },
      ]);
    }
  });

  test("fewer than two selected sends nothing", async () => {
    const { deps, sent } = fake([A]);
    expect(await runShapeMode(deps, "union", "Unite")).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("region verbs", () => {
  test("elementIds go top-to-bottom by paint order, whatever the click order", async () => {
    covers(
      "command:paged.pathfinder.divide",
      "command:paged.pathfinder.trim",
      "command:paged.pathfinder.merge",
      "command:paged.pathfinder.crop",
      "command:paged.pathfinder.outline",
      "command:paged.pathfinder.minusBack",
    );
    for (const verb of [
      "pathfinderDivide",
      "pathfinderTrim",
      "pathfinderMerge",
      "pathfinderCrop",
      "pathfinderOutline",
      "pathfinderMinusBack",
    ] as const) {
      const { deps, sent, selected } = fake([C, A, B]);
      expect(await runRegionVerb(deps, verb, verb)).toBeNull();
      expect(selected).toEqual([[]]);
      expect(sent).toEqual([{ op: verb, args: { elementIds: [B, A, C] } }]);
    }
  });

  test("ids the tree does not carry keep their selection order at the back", () => {
    expect(topToBottom([A, B, C], ["rectangle:b"])).toEqual([B, A, C]);
  });

  test("an unreadable tree leaves click order; fewer than two sends nothing", async () => {
    const { deps, sent } = fake([A, B]);
    deps.client.sceneTree = async () => {
      throw new Error("gone");
    };
    await runRegionVerb(deps, "pathfinderCrop", "Crop");
    expect(sent).toEqual([
      { op: "pathfinderCrop", args: { elementIds: [A, B] } },
    ]);
    const one = fake([A]);
    await runRegionVerb(one.deps, "pathfinderCrop", "Crop");
    expect(one.sent).toEqual([]);
  });

  test("the engine's refusal comes back in words", async () => {
    const { deps, selected } = fake([A, B], {
      kind: "mutationFailed",
      payload: { error: "planar arrangement takes at most 1000 input paths" },
    });
    const text = await runRegionVerb(deps, "pathfinderDivide", "Divide");
    expect(text).toContain("1000");
    expect(selected).toEqual([]);
  });
});

describe("the command and menu projection", () => {
  test("ten commands, each runs its verb and reports a refusal; ten menu entries under Object > Pathfinder", async () => {
    const { deps, sent } = fake([A, B], {
      kind: "mutationFailed",
      payload: { error: "nope" },
    });
    const reported: string[] = [];
    let cleared = 0;
    const commands = buildPathfinderCommands(
      deps,
      (m) => reported.push(m),
      () => cleared++,
    );
    expect(commands.map((c) => c.id)).toEqual(
      [
        "unite",
        "subtract",
        "intersect",
        "exclude",
        "divide",
        "trim",
        "merge",
        "crop",
        "outline",
        "minusBack",
      ].map((v) => `paged.pathfinder.${v}`),
    );
    await commands[0]!.handler(undefined as never);
    expect(sent).toHaveLength(1);
    expect(cleared).toBe(1);
    expect(reported).toHaveLength(1);
    expect(PATHFINDER_MENU_ITEMS.map((m) => m.command)).toEqual(
      commands.map((c) => c.id),
    );
    expect(
      PATHFINDER_MENU_ITEMS.every((m) =>
        m.path.startsWith("Object/Pathfinder/"),
      ),
    ).toBe(true);
  });
});
