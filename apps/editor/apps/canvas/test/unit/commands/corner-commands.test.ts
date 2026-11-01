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

// `paged.corners.*`: the five presets through their runner over a recording
// client. Eight writes per corner-bearing item, all in ONE batch; items whose
// corners nothing renders are skipped; nothing eligible sends nothing; the
// engine's refusal is reported in words.

import { describe, expect, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import {
  applyCornerPreset,
  buildCornerCommands,
  CORNER_MENU_ITEMS,
  type CornerDeps,
} from "../../../src/corner-commands";

const RECT = { kind: "rectangle", id: "r" } as unknown as ElementId;
const POLY = { kind: "polygon", id: "p" } as unknown as ElementId;
const OVAL = { kind: "oval", id: "o" } as unknown as ElementId;

function fake(
  selection: ElementId[],
  reply: unknown = { kind: "mutationApplied", payload: {} },
) {
  const sent: {
    op: string;
    args: {
      ops: { args: { elementId: unknown; path: string; value: unknown } }[];
    };
  }[] = [];
  const deps: CornerDeps = {
    client: {
      mutate: async (m: unknown) => {
        sent.push(m as never);
        return reply as never;
      },
    },
    getSelection: () => selection,
  };
  return { deps, sent };
}

describe("corner presets", () => {
  test("eight writes per rectangle and polygon, in one batch; an oval is skipped", async () => {
    covers(
      "command:paged.corners.rounded",
      "command:paged.corners.inverseRounded",
      "command:paged.corners.bevel",
      "command:paged.corners.fancy",
      "command:paged.corners.none",
    );
    const { deps, sent } = fake([RECT, OVAL, POLY]);
    expect(await applyCornerPreset(deps, "RoundedCorner", 12)).toBeNull();
    expect(sent).toHaveLength(1);
    const ops = sent[0]!.args.ops;
    expect(ops).toHaveLength(16);
    expect(
      ops
        .map((o) => o.args.path)
        .slice(0, 8)
        .sort(),
    ).toEqual(
      [
        "frameCornerOptionBottomLeft",
        "frameCornerOptionBottomRight",
        "frameCornerOptionTopLeft",
        "frameCornerOptionTopRight",
        "frameCornerRadiusBottomLeft",
        "frameCornerRadiusBottomRight",
        "frameCornerRadiusTopLeft",
        "frameCornerRadiusTopRight",
      ].sort(),
    );
    expect(
      new Set(ops.map((o) => String((o.args.elementId as { id: string }).id))),
    ).toEqual(new Set(["r", "p"]));
    expect(ops[0]!.args.value).toEqual({
      type: "text",
      value: "RoundedCorner",
    });
    expect(ops[4]!.args.value).toEqual({ type: "length", value: 12 });
  });

  test("None writes empty option text and a zero radius", async () => {
    const { deps, sent } = fake([RECT]);
    await applyCornerPreset(deps, "None", 0);
    const ops = sent[0]!.args.ops;
    expect(ops[0]!.args.value).toEqual({ type: "text", value: "" });
    expect(ops[4]!.args.value).toEqual({ type: "length", value: 0 });
  });

  test("nothing with renderable corners selected sends nothing", async () => {
    const { deps, sent } = fake([OVAL]);
    expect(await applyCornerPreset(deps, "RoundedCorner", 12)).toBeNull();
    expect(sent).toEqual([]);
  });

  test("the engine's refusal comes back in words", async () => {
    const { deps } = fake([RECT], {
      kind: "mutationFailed",
      payload: { error: "nope" },
    });
    expect(await applyCornerPreset(deps, "RoundedCorner", 12)).toContain("ope");
  });
});

describe("the command and menu projection", () => {
  test("five commands run their preset and report a refusal; five Object > Corners entries", async () => {
    const { deps, sent } = fake([RECT], {
      kind: "mutationFailed",
      payload: { error: "nope" },
    });
    const reported: string[] = [];
    let cleared = 0;
    const commands = buildCornerCommands(
      deps,
      (m) => reported.push(m),
      () => cleared++,
    );
    expect(commands.map((c) => c.id)).toEqual(
      ["rounded", "inverseRounded", "bevel", "fancy", "none"].map(
        (v) => `paged.corners.${v}`,
      ),
    );
    await commands[2]!.handler(undefined as never);
    expect(sent[0]!.args.ops[0]!.args.value).toEqual({
      type: "text",
      value: "BeveledCorner",
    });
    expect(cleared).toBe(1);
    expect(reported).toHaveLength(1);
    expect(CORNER_MENU_ITEMS.map((m) => m.command)).toEqual(
      commands.map((c) => c.id),
    );
    expect(
      CORNER_MENU_ITEMS.every((m) => m.path.startsWith("Object/Corners/")),
    ).toBe(true);
  });
});
