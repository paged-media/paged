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

// The Format Painter's mode (slide ADR 723): armed for the next click,
// locked by a double invoke, off by Esc or the painter again.

import { describe, expect, it } from "bun:test";
import { covers } from "@paged-media/test-kit";

import { PAINTER_DOUBLE_MS, PainterMode } from "../src/format-painter";

const FMT = {
  shape: [{ path: "frameFill", value: "Color/red" }],
  text: [],
} as never;

describe("Format Painter", () => {
  it("paints the next shape clicked, then is off", () => {
    covers("command:media.paged.slide.command.formatPainter");
    const m = new PainterMode();
    expect(m.invoke(FMT, "a", 0)).toBe("armed");
    // The source itself, or an empty selection on the way: nothing.
    expect(m.take(["a"])).toBeNull();
    expect(m.take([])).toBeNull();
    expect(m.take(["b"])?.targets).toEqual(["b"]);
    expect(m.armed).toBe(false);
    expect(m.take(["c"])).toBeNull();
  });

  it("twice quickly keeps painting until put down", () => {
    const m = new PainterMode();
    m.invoke(FMT, "a", 1000);
    expect(m.invoke(null, null, 1000 + PAINTER_DOUBLE_MS - 1)).toBe("locked");
    expect(m.take(["b"])?.targets).toEqual(["b"]);
    expect(m.take(["c", "a"])?.targets).toEqual(["c"]);
    expect(m.armed).toBe(true);
    m.off();
    expect(m.armed).toBe(false);
  });

  it("again later puts it down; nothing copied does not arm it", () => {
    const m = new PainterMode();
    m.invoke(FMT, "a", 0);
    expect(m.invoke(null, null, PAINTER_DOUBLE_MS + 1)).toBe("off");
    expect(m.invoke(null, null, 0)).toBe("off");
    expect(m.armed).toBe(false);
  });
});

describe("Copy formatting", () => {
  it("takes an effect that is off as off, without its settings", async () => {
    const { withoutOffEffects } = await import("../src/format-painter");
    const b = (v: boolean) => ({ type: "bool", value: v }) as never;
    const n = (v: number) => ({ type: "length", value: v }) as never;
    const kept = withoutOffEffects([
      { path: "frameBevelEnabled", value: b(false) },
      { path: "frameBevelSize", value: n(5) },
      { path: "frameDropShadow", value: b(true) },
      { path: "frameDropShadowSize", value: n(4) },
      { path: "frameFeatherEnabled", value: b(false) },
      { path: "frameFeatherWidth", value: n(5) },
      { path: "frameFillColor", value: b(true) },
    ] as never).map((e) => e.path);
    expect(kept).toEqual([
      "frameBevelEnabled",
      "frameDropShadow",
      "frameDropShadowSize",
      "frameFeatherEnabled",
      "frameFillColor",
    ]);
  });
});
