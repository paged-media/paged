// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:wheelReverse — spokes sweep counter-clockwise around the centre.
// params: spokes (slot 0).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let q = to_centered(in.uv);
  let a = atan2(-q.x, -q.y) / TAU;
  let n = max(1.0, floor(param(0u) + 0.5));
  let s = min(fract(fract(a + 1.0) * n), 0.99999);
  return mix(from_color(in.uv), to_color(in.uv), reveal(s, u.progress, 0.02));
}
