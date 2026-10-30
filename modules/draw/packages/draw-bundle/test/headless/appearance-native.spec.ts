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

// Engine ADR 1043 — the migration of draw's metadata stack (draw ADR 354)
// to the engine's native appearance. Asserts the mapping (the lower fills,
// the frame's own fill in the top fill's place, the lower strokes, the
// frame's own stroke in the top stroke's place), the exact batch, and —
// against the real engine — that one batch moves a committed stack onto
// the frame's `frameAppearance`, empties the envelope's stack, and undoes
// in one step. [frames-paths.native-appearance]

import { describe, expect, it, beforeAll, afterAll } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import type { HeadlessHost } from "@paged-media/plugin-sdk";

import {
  drawBundle,
  appearanceOf,
  commitAppearance,
  nativeAppearanceOf,
  migrateAppearanceMutations,
  type AppearanceStack,
} from "../../src";
import { oneBatchFor } from "../../src/commands/batch-handles";
import { F1_MULTI_SHAPE } from "../fixtures/corpus";
import { openHost } from "./host";

const RECT = {
  kind: "rectangle",
  id: F1_MULTI_SHAPE.ids.rectangle!,
} as ElementId;

const STACK: AppearanceStack = {
  fills: [
    { color: "Color/Black", tint: 40, opacity: 50, blendMode: "Multiply" },
    { color: "Color/Paper", opacity: 80 },
  ],
  strokes: [
    { color: "Color/Black", weight: 8 },
    { color: "Color/Paper", weight: 2, blendMode: "Screen" },
  ],
};

describe("draw appearance → native appearance (engine ADR 1043) [frames-paths.native-appearance]", () => {
  it("maps the stack around the frame's own fill and stroke", () => {
    expect(nativeAppearanceOf(STACK)).toEqual([
      {
        kind: "fill",
        color: "Color/Black",
        tint: 40,
        opacityPct: 50,
        blendMode: "Multiply",
      },
      { kind: "frameFill" },
      { kind: "stroke", color: "Color/Black", weight: 8 },
      { kind: "frameStroke" },
    ]);
    expect(nativeAppearanceOf({ fills: [], strokes: [] })).toEqual([]);
    expect(
      nativeAppearanceOf({ fills: [{ color: "Color/Black" }], strokes: [] }),
    ).toEqual([{ kind: "frameFill" }, { kind: "frameStroke" }]);
  });

  it("writes the appearance, the top layers' transparency and the emptied envelope", () => {
    const prev = { v: 1, data: { appearance: STACK, tool: "x" } };
    const ops = migrateAppearanceMutations(RECT, prev) as Array<{
      op: string;
      args: { path?: string; value?: unknown };
    }>;
    expect(ops.map((o) => o.args.path ?? o.op)).toEqual([
      "frameAppearance",
      "frameFillOpacity",
      "frameStrokeBlendMode",
      "setPluginMetadata",
    ]);
    expect(ops[1]!.args.value).toEqual({ type: "length", value: 80 });
    expect(JSON.parse((ops[3]!.args as { value: string }).value).data).toEqual({
      tool: "x",
    });
    // A group-baked stack is released first; nothing to migrate here.
    expect(
      migrateAppearanceMutations(RECT, {
        v: 1,
        data: { appearance: STACK, appearanceBake: { v: 1 } },
      }),
    ).toEqual([]);
    expect(migrateAppearanceMutations(RECT, null)).toEqual([]);
  });

  describe("against the real engine", () => {
    let h: HeadlessHost;
    beforeAll(async () => {
      h = await openHost();
      await h.load(F1_MULTI_SHAPE.bytes());
      h.loadBundle(drawBundle);
    });
    afterAll(() => h?.dispose());

    it("one batch moves the stack onto frameAppearance and one undo brings it back", async () => {
      const prev0 = await h.host.document.getMetadata(RECT);
      expect((await commitAppearance(h.host, RECT, STACK, prev0)).applied).toBe(
        true,
      );
      const prev = await h.host.document.getMetadata(RECT);
      const out = await h.host.document.mutate(
        oneBatchFor(migrateAppearanceMutations(RECT, prev)),
      );
      expect(out.applied).toBe(true);
      const props = await h.host.document.elementProperties(RECT);
      const row = props?.entries.find((e) => e.path === "frameAppearance");
      const layers = (
        row?.value as { value: { layers: Array<{ kind: string }> } }
      ).value.layers;
      expect(layers.map((l) => l.kind)).toEqual([
        "fill",
        "frameFill",
        "stroke",
        "frameStroke",
      ]);
      expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual({
        fills: [],
        strokes: [],
      });
      await h.host.document.undo();
      expect(appearanceOf(await h.host.document.getMetadata(RECT))).toEqual(
        STACK,
      );
      await h.host.document.undo();
      await h.host.document.setMetadata(RECT, null);
    });
  });
});
