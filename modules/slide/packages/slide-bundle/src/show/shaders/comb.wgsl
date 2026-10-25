// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:comb — alternate strips push across in opposite directions; dir horz
// gives horizontal strips.
// directions: horz vert.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let vert = u.direction == DIR_VERT;
  let b = select(in.uv.y, in.uv.x, vert);
  let j = floor(b * 10.0);
  let sgn = select(1.0, -1.0, (j % 2.0) < 0.5);
  let d = select(vec2f(sgn, 0.0), vec2f(0.0, sgn), vert);
  let src = in.uv - d * u.progress;
  if (inside(src)) {
    return from_color(src);
  }
  return to_color(src + d);
}
