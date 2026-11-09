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

import {
  SYMBOLISM_DEFAULTS,
  SymbolismMachine,
  type SymbolismToolKind,
} from "../src";

const target = (id: string, x: number, y: number) => ({
  id,
  item: {
    matrix: [1, 0, 0, 1, x, y] as const,
    box: [-10, -10, 10, 10] as const,
    tint: null,
    opacity: 100,
  },
});

const machine = (kind: SymbolismToolKind, extra = {}) =>
  new SymbolismMachine({
    options: {
      ...SYMBOLISM_DEFAULTS,
      kind,
      diameter: 100,
      intensity: 10,
      ...extra,
    },
    targets: [target("a", 0, 0), target("b", 400, 400)],
    sprayBox: [-10, -10, 10, 10],
  });

describe("SymbolismMachine — one drag, one commit [plugin-draw.symbols]", () => {
  it("a Shifter drag commits only the instance it reached, with its new matrix", () => {
    const m = machine("shifter");
    m.handle({ type: "down", point: [0, 0] });
    const live = m.handle({ type: "move", point: [10, 0] });
    expect(live.active).toBe(true);
    expect(live.quads).toHaveLength(1);
    const done = m.handle({ type: "up", point: [10, 0] });
    expect(done.commit?.updates).toHaveLength(1);
    expect(done.commit?.updates[0]!.id).toBe("a");
    // The brush has moved 10 pt on: the weight there is 1 − (10/50)² = 0.96.
    expect(done.commit?.updates[0]!.matrix?.[4]).toBeCloseTo(9.6, 9);
    expect(done.commit?.updates[0]!.tint).toBeUndefined();
    expect(done.commit?.placements).toEqual([]);
  });

  it("a press that reaches nothing commits nothing", () => {
    const m = machine("sizer");
    m.handle({ type: "down", point: [200, 200] });
    expect(m.handle({ type: "up", point: [200, 200] }).commit).toBeNull();
  });

  it("the dwell tick keeps the Sizer growing; the Shifter ignores it", () => {
    const m = machine("sizer");
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "tick" });
    m.handle({ type: "tick" });
    const s = m.handle({ type: "up", point: [0, 0] }).commit!.updates[0]!
      .matrix!;
    expect(s[0]).toBeCloseTo(1.05 ** 3, 9);
    const shift = machine("shifter");
    shift.handle({ type: "down", point: [0, 0] });
    shift.handle({ type: "tick" });
    expect(shift.handle({ type: "up", point: [0, 0] }).commit).toBeNull();
  });

  it("Stainer and Screener commit only the override they change", () => {
    const st = machine("stainer", { color: [0, 1, 0] });
    st.handle({ type: "down", point: [0, 0] });
    const u = st.handle({ type: "up", point: [0, 0] }).commit!.updates[0]!;
    expect(u.tint).toEqual([0, 1, 0, 0.1]);
    expect(u.matrix).toBeUndefined();
    expect(u.opacity).toBeUndefined();
    const sc = machine("screener");
    sc.handle({ type: "down", point: [0, 0] });
    expect(
      sc.handle({ type: "up", point: [0, 0] }).commit!.updates[0]!.opacity,
    ).toBe(90);
  });

  it("the Sprayer places along the drag; Alt marks what it sweeps for removal", () => {
    const m = machine("sprayer", { density: 5, intensity: 5, seed: 3 });
    m.handle({ type: "down", point: [0, 200] });
    m.handle({ type: "move", point: [100, 200] });
    const c = m.handle({ type: "up", point: [100, 200] }).commit!;
    expect(c.placements).toHaveLength(6);
    expect(c.updates).toEqual([]);
    const alt = machine("sprayer");
    alt.handle({ type: "down", point: [0, 0], alt: true });
    const sweep = alt.handle({ type: "move", point: [5, 0], alt: true });
    expect(sweep.removing).toHaveLength(1);
    const r = alt.handle({ type: "up", point: [5, 0] }).commit!;
    expect(r.removals).toEqual(["a"]);
    expect(r.placements).toEqual([]);
  });

  it("Escape cancels: nothing is committed", () => {
    const m = machine("scruncher");
    m.handle({ type: "down", point: [0, 0] });
    m.handle({ type: "move", point: [5, 5] });
    expect(m.handle({ type: "key", key: "Escape" }).commit).toBeNull();
    expect(m.handle({ type: "up", point: [5, 5] }).commit).toBeNull();
  });
});
