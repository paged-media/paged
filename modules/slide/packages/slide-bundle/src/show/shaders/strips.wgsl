// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:strips — a diagonal staircase of blocks travels from one corner.
// directions: lu ru ld rd.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let grid = vec2f(max(1.0, floor(16.0 * ratio() + 0.5)), 16.0);
  let cell = (floor(in.uv * grid) + vec2f(0.5)) / grid;
  let s = along(cell, dir_vec(u.direction));
  return select(from_color(in.uv), to_color(in.uv), s < u.progress);
}
