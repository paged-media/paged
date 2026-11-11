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

// The Width tool and the Envelope Mesh tool preview in TypeScript (a pointer
// move cannot wait for an engine round trip), so the width profile and the
// envelope map exist here as twins of the engine's: `paged-model`'s
// `WidthProfileParams` (`factor_at`, `normalized`) and `paged-vector-fx`'s
// `envelope_point`. The engine writes its numbers into one fixture
// (`paged-vector-fx/tests/it/ts_twins.rs`, which fails when the fixture is
// stale); this spec holds the twins to them. The engine computes in `f32`
// where its model stores `f32`, hence the tolerance.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  envelopePoint,
  normalizeWidthPoints,
  widthFactorAt,
  type WidthPoint,
} from "../src/index.ts";

interface Fixture {
  width: {
    id: string;
    points: [number, number][];
    t: number[];
    factor: number[];
  }[];
  normalized: { points: [number, number][]; normalized: [number, number][] }[];
  envelope: {
    rows: number;
    columns: number;
    net: [number, number][];
    samples: [number, number, number, number][];
  }[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../../../../engine/core/crates/paged-vector-fx/tests/it/fixtures/ts_twins.json",
    ),
    "utf8",
  ),
);

/** `f32` arithmetic on the engine side. */
const close = (got: number, want: number) =>
  Math.abs(got - want) <= 1e-5 * Math.max(1, Math.abs(want));

describe("the TypeScript twins of paged-vector-fx", () => {
  it("widthFactorAt is WidthProfileParams::factor_at", () => {
    expect(FIXTURE.width.length).toBeGreaterThan(5);
    for (const p of FIXTURE.width) {
      p.t.forEach((t, i) => {
        const got = widthFactorAt(p.points as WidthPoint[], t);
        if (!close(got, p.factor[i]!))
          throw new Error(`${p.id} at t=${t}: ${got} != ${p.factor[i]}`);
      });
    }
  });

  it("normalizeWidthPoints is WidthProfileParams::normalized", () => {
    for (const c of FIXTURE.normalized)
      expect(normalizeWidthPoints(c.points)).toEqual(c.normalized);
  });

  it("envelopePoint is paged_vector_fx::envelope::envelope_point", () => {
    expect(FIXTURE.envelope.length).toBe(3);
    for (const e of FIXTURE.envelope) {
      for (const [u, v, x, y] of e.samples) {
        const [gx, gy] = envelopePoint(e.net, e.rows, e.columns, u, v);
        if (!close(gx, x) || !close(gy, y))
          throw new Error(
            `${e.rows}x${e.columns} at (${u}, ${v}): (${gx}, ${gy}) != (${x}, ${y})`,
          );
      }
    }
  });
});
