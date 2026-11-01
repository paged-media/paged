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

// `paged.appearance.*`: the five stack operations through their runner over
// a recording client that serves each item's `frameAppearance` and paint.
// Whole list written back per item, all items in ONE batch; the panel's list
// functions decide the result; draw's payload addressing is kept.

import { describe, expect, test } from "bun:test";

import type { ElementId } from "@paged-media/client";
import { covers } from "@paged-media/test-kit";

import {
  APPEARANCE_MENU_ITEMS,
  buildAppearanceCommands,
  editAppearance,
  type AppearanceDeps,
} from "../../../src/appearance-commands";
import {
  addFill,
  clear,
  move,
  remove,
} from "../../../src/panels/appearance-layers";

const RECT = { kind: "rectangle", id: "r" } as unknown as ElementId;
const POLY = { kind: "polygon", id: "p" } as unknown as ElementId;
const LINE = { kind: "graphicLine", id: "l" } as unknown as ElementId;

type Layers = { kind: string; color?: string }[];

function fake(
  selection: ElementId[],
  stored: Record<string, Layers> = {},
  reply: unknown = { kind: "mutationApplied", payload: {} },
) {
  const sent: {
    args: {
      ops: {
        args: { elementId: ElementId; value: { value: { layers: Layers } } };
      }[];
    };
  }[] = [];
  const deps: AppearanceDeps = {
    client: {
      elementProperties: (async (id: ElementId) => ({
        entries: [
          {
            path: "frameFillColor",
            value: { type: "colorRef", value: "Color/Red" },
          },
          {
            path: "frameStrokeColor",
            value: { type: "colorRef", value: "Color/Black" },
          },
          { path: "frameStrokeWeight", value: { type: "length", value: 3 } },
          {
            path: "frameAppearance",
            value: {
              type: "appearance",
              value: { layers: stored[String(id.id)] ?? [] },
            },
          },
        ],
      })) as never,
      mutate: (async (m: unknown) => {
        sent.push(m as never);
        return reply;
      }) as never,
    },
    getSelection: () => selection,
  };
  return { deps, sent };
}

const written = (sent: ReturnType<typeof fake>["sent"]) =>
  sent[0]!.args.ops.map((o) => o.args.value.value.layers);

describe("appearance stack edits", () => {
  test("Add fill seeds from the frame's fill and writes every item in one batch", async () => {
    covers("command:paged.appearance.addFill");
    const { deps, sent } = fake([RECT, POLY]);
    expect(
      await editAppearance(deps, (l, seed) => addFill(l, seed)),
    ).toBeNull();
    expect(sent).toHaveLength(1);
    const lists = written(sent);
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect(list.map((l) => l.kind)).toEqual([
        "frameFill",
        "fill",
        "frameStroke",
      ]);
      expect(list[1]!.color).toBe("Color/Red");
    }
  });

  test("Clear writes the empty list; Remove and Move edit the list as drawn", async () => {
    covers(
      "command:paged.appearance.addStroke",
      "command:paged.appearance.clear",
      "command:paged.appearance.removeLayer",
      "command:paged.appearance.moveLayer",
    );
    const stored = {
      r: [
        { kind: "frameFill" },
        { kind: "fill", color: "Color/A" },
        { kind: "fill", color: "Color/B" },
        { kind: "frameStroke" },
      ],
    };
    const a = fake([RECT], stored);
    await editAppearance(a.deps, () => clear());
    expect(written(a.sent)).toEqual([[]]);
    const b = fake([RECT], stored);
    await editAppearance(b.deps, (l) => remove(l, 1));
    expect(written(b.sent)[0]!.map((l) => l.color)).toEqual([
      undefined,
      "Color/B",
      undefined,
    ]);
    const c = fake([RECT], stored);
    await editAppearance(c.deps, (l) => move(l, 1, 1));
    expect(written(c.sent)[0]!.map((l) => l.color)).toEqual([
      undefined,
      "Color/B",
      "Color/A",
      undefined,
    ]);
  });

  test("an item the properties door does not answer for is skipped; nothing to write sends nothing", async () => {
    const { deps, sent } = fake([LINE]);
    deps.client.elementProperties = (async () => null) as never;
    expect(await editAppearance(deps, (l) => l)).toBeNull();
    expect(sent).toEqual([]);
  });

  test("the engine's refusal comes back in words", async () => {
    const { deps } = fake(
      [RECT],
      {},
      { kind: "mutationFailed", payload: { error: "nope" } },
    );
    expect(await editAppearance(deps, (l) => l)).toContain("ope");
  });
});

describe("the command projection", () => {
  test("five commands; payloads address layers as draw's did", async () => {
    const stored = {
      r: [
        { kind: "frameFill" },
        { kind: "fill", color: "Color/A" },
        { kind: "fill", color: "Color/B" },
        { kind: "frameStroke" },
      ],
    };
    const { deps, sent } = fake([RECT], stored);
    const commands = buildAppearanceCommands(
      deps,
      () => {},
      () => {},
    );
    expect(commands.map((c) => c.id)).toEqual(
      ["addFill", "addStroke", "clear", "removeLayer", "moveLayer"].map(
        (v) => `paged.appearance.${v}`,
      ),
    );
    // { kind, index } addresses the extra layers of one kind, bottom to top.
    await commands[3]!.handler(undefined as never, { kind: "fill", index: 0 });
    expect(written(sent)[0]!.map((l) => l.color)).toEqual([
      undefined,
      "Color/B",
      undefined,
    ]);
    // { layer } addresses the list as drawn; { direction: "down" } moves back.
    sent.length = 0;
    await commands[4]!.handler(undefined as never, {
      layer: 2,
      direction: "down",
    });
    expect(written(sent)[0]!.map((l) => l.color)).toEqual([
      undefined,
      "Color/B",
      "Color/A",
      undefined,
    ]);
    expect(APPEARANCE_MENU_ITEMS.map((m) => m.path)).toEqual([
      "Object/Appearance/Add fill",
      "Object/Appearance/Add stroke",
      "Object/Appearance/Clear",
    ]);
  });
});
