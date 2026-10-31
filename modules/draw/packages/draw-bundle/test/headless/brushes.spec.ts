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

// BRUSHES AND WIDTH PROFILES (WP6.4, engine ADR 10XX, draw ADR 366)
// through the REAL engine: each command writes the selection's stroke
// style as ONE undo step that undoes and redoes exactly, the stroke is
// drawn as its artwork while the path keeps its anchors, and what has
// nothing to act on is refused with its reason.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { ElementId, MutationInput } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import {
  APPLY_BRUSH_COMMAND_ID,
  APPLY_WIDTH_PROFILE_COMMAND_ID,
  BRUSH_OPTIONS_COMMAND_ID,
  BRUSHES_COMMAND_ID,
  NEW_BRUSH_COMMAND_ID,
  REMOVE_BRUSH_COMMAND_ID,
  documentBrushes,
  readStroke,
} from "../../src/commands/brushes";
import { packageWithSpread } from "../fixtures/build-idml";
import { lineItem, squareItem } from "../panels/panel-document";
import { commandRig, expectApplies, type CommandRig } from "./command-kit";

const P = (id: string) => ({ kind: "polygon", id }) as ElementId;
const LINE = P("bl");
const SQUARE = P("bs");

const doc = () =>
  packageWithSpread(
    lineItem("bl", 40, 200, 340, 260) + squareItem("bs", 60, 40, 80),
  );

const stroke = (id: ElementId): MutationInput[] => [
  {
    op: "setElementProperty",
    args: {
      elementId: id,
      path: "frameStrokeColor",
      value: { type: "colorRef", value: "Color/Black" },
    },
  },
  {
    op: "setElementProperty",
    args: {
      elementId: id,
      path: "frameStrokeWeight",
      value: { type: "length", value: 6 },
    },
  },
];

let rig: CommandRig;
beforeAll(async () => {
  rig = await commandRig();
});
afterAll(() => rig?.dispose());

async function open(selection: ElementId[]): Promise<void> {
  await rig.open(doc(), []);
  await rig.h.host.document.mutate({
    op: "batch",
    args: { ops: [...stroke(LINE), ...stroke(SQUARE)] as never },
  });
  await rig.h.host.selection.set(selection);
}

const kinds = async (id: ElementId) =>
  (await readStroke(rig.h.host, id)).stack.map((e) => e.kind);

describe("brushes and width profiles through the engine [plugin-draw.brushes-width]", () => {
  it("applyBrush: one undo step; the path keeps its anchors; any built-in brush", async () => {
    covers("command:media.paged.draw.command.applyBrush");
    await open([LINE]);
    const anchors = (await rig.h.host.document.pathAnchors(LINE))!.anchors;
    await expectApplies(rig, APPLY_BRUSH_COMMAND_ID, { brush: "tapered" });
    expect(await kinds(LINE)).toEqual(["brush"]);
    expect((await rig.h.host.document.pathAnchors(LINE))!.anchors).toEqual(
      anchors,
    );
    for (const brush of [
      "dots",
      "diamonds",
      "roundBristle",
      "swash",
      "confetti",
    ]) {
      await rig.run(APPLY_BRUSH_COMMAND_ID, { brush });
      const entry = (await readStroke(rig.h.host, LINE)).stack[0]!;
      expect(entry.kind).toBe("brush");
    }
    await expect(
      rig.run(APPLY_BRUSH_COMMAND_ID, { brush: "nope" }),
    ).rejects.toThrow("failed: there is no brush `nope`");
  });

  it("applyWidthProfile: a library profile or points; uniform takes it off; the brush stays", async () => {
    covers("command:media.paged.draw.command.applyWidthProfile");
    await open([LINE, SQUARE]);
    await rig.run(APPLY_BRUSH_COMMAND_ID, { brush: "tapered" });
    await expectApplies(rig, APPLY_WIDTH_PROFILE_COMMAND_ID, {
      profile: "lens",
    });
    // The profile goes before the brush, which reads it.
    expect(await kinds(LINE)).toEqual(["widthProfile", "brush"]);
    await rig.run(APPLY_WIDTH_PROFILE_COMMAND_ID, {
      profile: "",
      points: [
        [0, 1],
        [1, 3],
      ],
    });
    const wp = (await readStroke(rig.h.host, SQUARE)).stack.find(
      (e) => e.kind === "widthProfile",
    )!;
    expect(wp.widthPoints).toEqual([
      [0, 1],
      [1, 3],
    ]);
    await rig.run(APPLY_WIDTH_PROFILE_COMMAND_ID, { profile: "uniform" });
    expect(await kinds(LINE)).toEqual(["brush"]);
    await expect(
      rig.run(APPLY_WIDTH_PROFILE_COMMAND_ID, { points: [[0, -1]] }),
    ).rejects.toThrow("never negative");
  });

  it("brushOptions: changes the brush the selection carries; bare it raises the panel", async () => {
    covers("command:media.paged.draw.command.brushOptions");
    await open([LINE]);
    await rig.run(APPLY_BRUSH_COMMAND_ID, { brush: "dots" });
    await expectApplies(rig, BRUSH_OPTIONS_COMMAND_ID, {
      spacingPct: 300,
      flipAcross: true,
    });
    const entry = (await readStroke(rig.h.host, LINE)).stack[0]!;
    expect(entry.spacingPct).toBe(300);
    expect(entry.flipAcross).toBe(true);
    await expect(
      rig.run(BRUSH_OPTIONS_COMMAND_ID, { scalePct: 0 }),
    ).rejects.toThrow("between 1 and 10000");
    await rig.h.host.selection.set([SQUARE]);
    await expect(
      rig.run(BRUSH_OPTIONS_COMMAND_ID, { scalePct: 50 }),
    ).rejects.toThrow("nothing selected has a brush");
  });

  it("removeBrush: the stroke is plain again, one undo step", async () => {
    covers("command:media.paged.draw.command.removeBrush");
    await open([LINE]);
    await rig.run(APPLY_BRUSH_COMMAND_ID, { brush: "diamonds" });
    await expectApplies(rig, REMOVE_BRUSH_COMMAND_ID);
    expect(await kinds(LINE)).toEqual([]);
    await expect(rig.run(REMOVE_BRUSH_COMMAND_ID, {})).rejects.toThrow(
      "nothing selected has a brush",
    );
    // Run bare (the menu row) it changes nothing and does not throw.
    expect(await rig.run(REMOVE_BRUSH_COMMAND_ID)).toBeUndefined();
  });

  it("newBrush: the selected artwork becomes a document brush the panel and the commands can apply", async () => {
    covers("command:media.paged.draw.command.newBrush");
    covers("command:media.paged.draw.command.brushes");
    await open([SQUARE]);
    const made = (await rig.run(NEW_BRUSH_COMMAND_ID, {
      type: "pattern",
      name: "Squares",
    })) as { brush: string };
    const library = await documentBrushes(rig.h.host);
    expect(library.map((b) => [b.name, b.type])).toEqual([
      ["Squares", "pattern"],
    ]);
    expect(library[0]!.art!.nodes.length).toBe(4);
    await rig.h.host.selection.set([LINE]);
    await expectApplies(rig, APPLY_BRUSH_COMMAND_ID, { brush: made.brush });
    expect((await readStroke(rig.h.host, LINE)).stack[0]!.artNodes).toEqual(
      library[0]!.art!.nodes,
    );
    // The Brushes row raises nothing on a host with no panel door, and
    // changes nothing.
    await rig.run(BRUSHES_COMMAND_ID);
    await expect(
      rig.run(NEW_BRUSH_COMMAND_ID, { type: "bristle" }),
    ).rejects.toThrow("no artwork");
  });

  it("Expand Appearance keeps a brushed stroke's artwork as the path", async () => {
    await open([LINE]);
    await rig.h.host.document.mutate({
      op: "setElementProperty",
      args: {
        elementId: LINE,
        path: "frameFillColor",
        value: { type: "colorRef", value: "Swatch/None" },
      },
    });
    await rig.run(APPLY_BRUSH_COMMAND_ID, { brush: "diamonds" });
    const out = await rig.h.host.document.mutate({
      op: "expandAppearance",
      args: { elementId: LINE },
    });
    expect(out.applied).toBe(true);
    const table = (await rig.h.host.document.pathAnchors(LINE))!;
    // 300 × 60 pt line, 6 pt diamonds: dozens of closed contours.
    expect(table.subpathStarts.length).toBeGreaterThan(20);
    expect(await kinds(LINE)).toEqual([]);
  });
});
