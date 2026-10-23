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

// The width profile and the linked-recipe update (plan G4), with no
// engine: what each sends, where a bare run (a menu row) goes, and that a
// call with nothing to do throws its reason. The real arrangement is the
// headless spec's (`test/headless/width-profile-recipes.spec.ts`).

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

describe("paged.draw commands, no engine — the width profile", () => {
  it("widthProfile: one outlineStrokeVariable per open path, the profile as given, one batch; a closed path is skipped", async () => {
    covers("command:media.paged.draw.command.widthProfile");
    const r = unitRig(doc(), { selection: [POLY, RECT] });
    await r.run(`${C}.widthProfile`, { widths: [0, 8, 0] });
    expect(r.steps()).toBe(1);
    const leaves = r.leaves();
    expect(leaves).toHaveLength(1);
    const args = leaves[0]!.args as {
      elementId: ElementId;
      path: string;
      value: { value: { widths: number[] } };
    };
    expect(leaves[0]!.op).toBe("setElementProperty");
    expect(args.path).toBe("outlineStrokeVariable");
    expect(args.elementId).toEqual(POLY);
    expect(args.value.value.widths).toEqual([0, 8, 0]);
  });

  it("widthProfile: refuses a selection with no open path, and a profile of no width", async () => {
    const closed = unitRig(doc(), { selection: [RECT] });
    await expect(
      closed.run(`${C}.widthProfile`, { widths: [4] }),
    ).rejects.toThrow(/^failed: a width profile needs a single-contour open/);
    const r = unitRig(doc(), { selection: [POLY] });
    await expect(r.run(`${C}.widthProfile`, { widths: [0] })).rejects.toThrow(
      /^failed: /,
    );
    expect(closed.sent()).toEqual([]);
    expect(r.sent()).toEqual([]);
  });

  it("widthProfile run bare raises Path Options at its section; with no panel door it applies the last profile", async () => {
    const raising = unitRig(doc(), { selection: [POLY], shell: true });
    await raising.run(`${C}.widthProfile`);
    expect(raising.opened).toEqual(["media.paged.draw.panel.pathOptions"]);
    expect(raising.sent()).toEqual([]);

    const plain = unitRig(doc(), { selection: [POLY] });
    await plain.run(`${C}.widthProfile`);
    const [m] = plain.leaves();
    expect(
      (m!.args as { value: { value: { widths: number[] } } }).value.value
        .widths,
    ).toEqual([1, 6, 1]);
  });
});

describe("paged.draw commands, no engine — updateLinkedRecipes", () => {
  it("names the recipes the selection is a source of; with a payload a selection that feeds none is refused", async () => {
    covers("command:media.paged.draw.command.updateLinkedRecipes");
    const r = unitRig(doc(), { selection: [RECT] });
    await expect(
      r.run(`${C}.updateLinkedRecipes`, { all: false }),
    ).rejects.toThrow("failed: nothing selected is the source of a recipe");
    await expect(
      r.run(`${C}.updateLinkedRecipes`, { all: true }),
    ).rejects.toThrow(/^failed: the document has no pattern/);
    expect(r.sent()).toEqual([]);
  });

  it("a selected source runs its recipe's own update, from the links the make wrote", async () => {
    const elements = doc();
    elements[0]!.meta = {
      v: 1,
      data: { repeatSource: { repeat: "rep-9", index: 0 } },
    } as never;
    const r = unitRig(elements, { selection: [RECT] });
    await r.run(`${C}.updateLinkedRecipes`, { all: false });
    // The repeat's update rebuilt its instances in one batch, and said so.
    expect(r.steps()).toBe(1);
    expect(
      r.logs.some((l) => l.includes("media.paged.draw.command.updateRepeat")),
    ).toBe(true);
  });

  it("run bare (the menu row) it changes nothing and does not throw", async () => {
    const r = unitRig(doc(), { selection: [RECT] });
    await r.run(`${C}.updateLinkedRecipes`);
    expect(r.sent()).toEqual([]);
    expect(r.logs.some((l) => l.includes("nothing selected"))).toBe(true);
  });
});
