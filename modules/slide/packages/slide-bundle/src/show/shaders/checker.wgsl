// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:checker — a checkerboard: every square fills across, alternate rows a
// square later. dir horz fills across, vert down.
// directions: horz vert.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let vert = u.direction == DIR_VERT;
  let a = select(in.uv.x, in.uv.y, vert);
  let b = select(in.uv.y, in.uv.x, vert);
  let n = 8.0;
  let rows = 6.0;
  let j = floor(b * rows);
  let s = fract((a * n + (j % 2.0)) * 0.5);
  return select(from_color(in.uv), to_color(in.uv), s < u.progress);
}
