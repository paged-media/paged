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

import { describe, expect, it } from "bun:test";

import { applySampledStyle, sampledStyleFrom } from "../src/index.ts";

const entry = (path: string, type: string, value: unknown) => ({
  path,
  value: { type, value },
});

describe("sampledStyleFrom", () => {
  it("reads fill, tint, stroke, weight and opacity; nothing relevant is null", () => {
    expect(
      sampledStyleFrom({
        entries: [
          entry("frameFillColor", "colorRef", "Color/Red"),
          entry("frameFillTint", "length", 40),
          entry("frameStrokeColor", "colorRef", null),
          entry("frameStrokeWeight", "length", 3),
          entry("frameOpacity", "length", 50),
          entry("frameBlendMode", "text", "Multiply"),
        ],
      }),
    ).toEqual({
      fillColor: "Color/Red",
      fillTint: 40,
      strokeColor: null,
      strokeWeight: 3,
      opacity: 50,
    });
    expect(sampledStyleFrom({ entries: [entry("x", "text", "y")] })).toBeNull();
    expect(sampledStyleFrom(null)).toBeNull();
  });
});

describe("applySampledStyle", () => {
  const style = { fillColor: null, strokeWeight: 2, opacity: null };

  it("writes each target only what it exposes; null tint and opacity are skipped; null fill clears", () => {
    const out = applySampledStyle(
      [
        { id: "a", supports: new Set(["frameFillColor", "frameStrokeWeight"]) },
        { id: "b", supports: new Set(["frameStrokeWeight", "frameOpacity"]) },
      ],
      style,
    );
    expect(out?.args.ops.map((o) => [o.args.elementId, o.args.path])).toEqual([
      ["a", "frameFillColor"],
      ["a", "frameStrokeWeight"],
      ["b", "frameStrokeWeight"],
    ]);
    expect(out?.args.ops[0]!.args.value).toEqual({
      type: "colorRef",
      value: null,
    });
  });

  it("nothing to write is null", () => {
    expect(applySampledStyle([], style)).toBeNull();
    expect(
      applySampledStyle([{ id: "a", supports: new Set() }], style),
    ).toBeNull();
  });
});
