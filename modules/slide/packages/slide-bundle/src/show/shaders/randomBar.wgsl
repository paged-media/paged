// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:randomBar — thin bars of the incoming slide appear in random order;
// dir horz gives horizontal bars, vert vertical ones.
// directions: horz vert.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let coord = select(in.uv.y, in.uv.x, u.direction == DIR_VERT);
  let r = hash11(floor(coord * 100.0));
  return select(from_color(in.uv), to_color(in.uv), r < u.progress);
}
