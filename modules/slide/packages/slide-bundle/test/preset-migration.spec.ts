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

// The lift of the earlier live-preset labels (slide ADR 717, amendment of
// 2026-11-11): which labels are old, and the batch a plan becomes.

import { describe, expect, it } from "bun:test";

import { LABEL_KEY } from "../src/object-model";
import { isOldLabel, liftMutation } from "../src/preset-migration";

const label = (data: object) => JSON.stringify({ v: 1, data });

describe("[plugin-slide.live-presets] the earlier preset labels", () => {
  it("are the ones with a preset, a connector, a part or a shape box", () => {
    expect(isOldLabel(label({ shape: "s#2", preset: { prst: "rect" } }))).toBe(
      true,
    );
    expect(isOldLabel(label({ shape: "s#2", box: [10, 20] }))).toBe(true);
    expect(isOldLabel(label({ shape: "s#9", connector: { st: null } }))).toBe(
      true,
    );
    expect(isOldLabel(label({ shape: "new:1", part: "detail" }))).toBe(true);
    // A chart frame's box is the chart's.
    expect(isOldLabel(label({ chart: "c1", box: [0, 0, 10, 10] }))).toBe(false);
    expect(isOldLabel(label({ shape: "s#2" }))).toBe(false);
    expect(isOldLabel("not json")).toBe(false);
  });

  it("become one batch: the engine's preset on a path, the key on its text frame, the labels", () => {
    const preset = { name: "roundRect", frame: [0, 0, 180, 108], key: "s#2" };
    const m = liftMutation([
      { kind: "polygon", id: "u1p", preset, label: label({ shape: "s#2" }) },
      { kind: "textFrame", id: "u1t", presetText: "s#2", label: null },
    ]) as unknown as { op: string; args: { ops: { op: string; args: any }[] } };
    expect(m.op).toBe("batch");
    expect(m.args.ops.map((o) => o.op)).toEqual([
      "setElementProperty",
      "setPluginMetadata",
      "setElementProperty",
      "setPluginMetadata",
    ]);
    const [set, poly, key, text] = m.args.ops;
    expect(key!.args).toEqual({
      elementId: { kind: "textFrame", id: "u1t" },
      path: "frameShapePresetText",
      value: { type: "text", value: "s#2" },
    });
    expect(set!.args.path).toBe("frameShapePreset");
    expect(set!.args.elementId).toEqual({ kind: "polygon", id: "u1p" });
    expect(JSON.parse(set!.args.value.value)).toEqual(preset);
    expect(poly!.args).toEqual({
      elementId: { kind: "polygon", id: "u1p" },
      key: LABEL_KEY,
      value: label({ shape: "s#2" }),
    });
    // A label with nothing left is removed.
    expect(text!.args.value).toBeNull();
    expect(liftMutation([])).toBeNull();
  });
});
