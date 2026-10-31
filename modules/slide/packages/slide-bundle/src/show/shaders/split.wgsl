// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:split — the incoming slide opens from the centre line outwards (dir out)
// or closes in from both edges (dir in); orient horz splits along a
// horizontal line, vert along a vertical one.
// params: vertical (slot 0). directions: in out.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let c = select(abs(in.uv.y - 0.5), abs(in.uv.x - 0.5), param(0u) > 0.5) * 2.0;
  let s = select(c, 1.0 - c, u.direction == DIR_IN);
  return mix(from_color(in.uv), to_color(in.uv), reveal(s, u.progress, 0.06));
}
