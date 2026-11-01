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

// `paged.stroke.dash*`: the four presets through their runner over a
// recording client. One dash-array write per selected page item, all in ONE
// batch; nothing selected sends nothing; the engine's refusal is reported
// in words.

import { describe, expect, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import {
  applyDashLengths,
  buildStrokeDashCommands,
  type StrokeDashDeps,
} from "../../../src/stroke-dash-commands";

const RECT = { kind: "rectangle", id: "r" } as unknown as ElementId;
const LINE = { kind: "graphicLine", id: "l" } as unknown as ElementId;

function fake(
  selection: ElementId[],
  reply: unknown = { kind: "mutationApplied", payload: {} },
) {
  const sent: {
    args: {
      ops: { args: { elementId: ElementId; path: string; value: unknown } }[];
    };
  }[] = [];
  const deps: StrokeDashDeps = {
    client: {
      mutate: (async (m: unknown) => {
        sent.push(m as never);
        return reply;
      }) as never,
    },
    getSelection: () => selection,
  };
  return { deps, sent };
}

describe("dash presets", () => {
  test("each preset writes its run to every selected item, in one batch", async () => {
    covers(
      "command:paged.stroke.dashSolid",
      "command:paged.stroke.dashDashed",
      "command:paged.stroke.dashDotted",
      "command:paged.stroke.dashDashDot",
    );
    const runs: Record<string, number[]> = {
      "paged.stroke.dashSolid": [],
      "paged.stroke.dashDashed": [6, 3],
      "paged.stroke.dashDotted": [1, 3],
      "paged.stroke.dashDashDot": [6, 3, 1, 3],
    };
    for (const [id, lengths] of Object.entries(runs)) {
      const { deps, sent } = fake([RECT, LINE]);
      const command = buildStrokeDashCommands(
        deps,
        () => {},
        () => {},
      ).find((c) => c.id === id)!;
      await command.handler(undefined as never);
      expect(sent).toHaveLength(1);
      const ops = sent[0]!.args.ops;
      expect(ops.map((o) => o.args.elementId)).toEqual([RECT, LINE]);
      for (const o of ops) {
        expect(o.args.path).toBe("frameStrokeDashArray");
        expect(o.args.value).toEqual({ type: "lengths", value: lengths });
      }
    }
  });

  test("nothing selected sends nothing; the engine's refusal comes back in words", async () => {
    const none = fake([]);
    expect(await applyDashLengths(none.deps, [6, 3])).toBeNull();
    expect(none.sent).toEqual([]);
    const refused = fake([RECT], {
      kind: "mutationFailed",
      payload: { error: "nope" },
    });
    expect(await applyDashLengths(refused.deps, [6, 3])).toContain("ope");
  });

  test("four palette commands, no menu entries", () => {
    const { deps } = fake([]);
    expect(
      buildStrokeDashCommands(
        deps,
        () => {},
        () => {},
      ).map((c) => c.id),
    ).toEqual([
      "paged.stroke.dashSolid",
      "paged.stroke.dashDashed",
      "paged.stroke.dashDotted",
      "paged.stroke.dashDashDot",
    ]);
  });
});
