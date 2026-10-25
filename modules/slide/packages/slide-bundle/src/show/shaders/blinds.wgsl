// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:blinds — slats open together; dir horz gives horizontal slats.
// directions: horz vert.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let coord = select(in.uv.y, in.uv.x, u.direction == DIR_VERT);
  let s = fract(coord * 6.0);
  return mix(from_color(in.uv), to_color(in.uv), reveal(s, u.progress, 0.04));
}
