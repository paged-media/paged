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

// The brush and width-profile commands (WP6.4, draw ADR 366) with no
// engine: what each sends — one `frameEffectStack` write per selected
// item, one batch — where a bare run goes, and that a call with nothing to
// do says why. The engine's half is `test/headless/brushes.spec.ts`.

import { describe, expect, it } from "bun:test";

import type { ElementId } from "@paged-media/plugin-api";
import { covers } from "@paged-media/test-kit";

import { openEl, rectEl, unitRig } from "./unit-kit";

const C = "media.paged.draw.command";
const POLY = { kind: "polygon", id: "upoly" } as ElementId;
const RECT = { kind: "rectangle", id: "urect" } as ElementId;

const doc = () => [
  rectEl("rectangle", "urect", [100, 100, 300, 300]),
  openEl("upoly", [
    [100, 400],
    [250, 600],
    [400, 400],
  ]),
];

type StackWrite = {
  op: string;
  args: {
    elementId: ElementId;
    path: string;
    value: { value: { entries: Record<string, unknown>[] } };
  };
};

const stacks = (leaves: unknown[]) =>
  (leaves as StackWrite[]).filter((m) => m.args?.path === "frameEffectStack");

describe("paged.draw commands, no engine — brushes and width profiles", () => {
  it("applyBrush: one stack write per selected item, one batch; an unknown brush is refused", async () => {
    covers("command:media.paged.draw.command.applyBrush");
    const r = unitRig(doc(), { selection: [POLY, RECT] });
    await r.run(`${C}.applyBrush`, { brush: "dots" });
    expect(r.steps()).toBe(1);
    const writes = stacks(r.leaves());
    expect(writes.map((w) => w.args.elementId)).toEqual([POLY, RECT]);
    expect(writes[0]!.args.value.value.entries[0]).toMatchObject({
      kind: "brush",
      brushType: "scatter",
      spacingPct: 150,
    });
    await expect(r.run(`${C}.applyBrush`, { brush: "nope" })).rejects.toThrow(
      "failed: there is no brush `nope`",
    );
  });

  it("applyWidthProfile: a library profile becomes a widthProfile entry; bad points are refused", async () => {
    covers("command:media.paged.draw.command.applyWidthProfile");
    const r = unitRig(doc(), { selection: [POLY] });
    await r.run(`${C}.applyWidthProfile`, { profile: "taperEnd" });
    expect(stacks(r.leaves())[0]!.args.value.value.entries).toEqual([
      {
        kind: "widthProfile",
        enabled: true,
        widthPoints: [
          [0, 1],
          [1, 0],
        ],
      },
    ]);
    await expect(
      r.run(`${C}.applyWidthProfile`, { points: [[0.5]] }),
    ).rejects.toThrow("`[t, width]` pairs");
    await expect(
      r.run(`${C}.applyWidthProfile`, { profile: "nope" }),
    ).rejects.toThrow("no width profile `nope`");
  });

  it("brushOptions: with options and no brush on the selection it is refused; bare it raises the Brushes panel", async () => {
    covers("command:media.paged.draw.command.brushOptions");
    const r = unitRig(doc(), { selection: [POLY] });
    await expect(r.run(`${C}.brushOptions`, { scalePct: 50 })).rejects.toThrow(
      "nothing selected has a brush",
    );
    await expect(r.run(`${C}.brushOptions`, { scalePct: -5 })).rejects.toThrow(
      "between 1 and 10000",
    );
    const raising = unitRig(doc(), { selection: [POLY], shell: true });
    await raising.run(`${C}.brushOptions`);
    expect(raising.opened).toEqual(["media.paged.draw.panel.brushes"]);
    expect(raising.sent()).toEqual([]);
  });

  it("brushes: raises the Brushes panel and sends nothing", async () => {
    covers("command:media.paged.draw.command.brushes");
    const r = unitRig(doc(), { selection: [], shell: true });
    await r.run(`${C}.brushes`);
    expect(r.opened).toEqual(["media.paged.draw.panel.brushes"]);
    expect(r.sent()).toEqual([]);
  });

  it("removeBrush: refused with a payload when nothing has a brush; bare it changes nothing", async () => {
    covers("command:media.paged.draw.command.removeBrush");
    const r = unitRig(doc(), { selection: [POLY] });
    await expect(r.run(`${C}.removeBrush`, {})).rejects.toThrow(
      "nothing selected has a brush",
    );
    await r.run(`${C}.removeBrush`);
    expect(r.sent()).toEqual([]);
  });

  it("newBrush: the selected outline becomes a document brush in the library part, no page write", async () => {
    covers("command:media.paged.draw.command.newBrush");
    const r = unitRig(doc(), { selection: [POLY] });
    await r.run(`${C}.newBrush`, { type: "art", name: "Chevron" });
    expect(r.sent()).toEqual([]);
    const lib = r.parts()["paged/media.paged.draw/brushes/library.json"] as {
      brushes: { id: string; name: string; art: { nodes: number[][] } }[];
    };
    expect(lib.brushes.map((b) => b.name)).toEqual(["Chevron"]);
    expect(lib.brushes[0]!.id).toMatch(/^doc-1-/);
    // x along the box, y up the page: the middle anchor (250, 600) is
    // the bottom middle of the box.
    expect(lib.brushes[0]!.art.nodes[1]!.slice(0, 2)).toEqual([0.5, -0.5]);
    await expect(r.run(`${C}.newBrush`, { type: "bristle" })).rejects.toThrow(
      "no artwork",
    );
  });
});
