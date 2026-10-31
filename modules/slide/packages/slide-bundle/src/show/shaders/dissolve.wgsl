// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:dissolve — small blocks of the incoming slide appear in random order.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let grid = vec2f(48.0 * ratio(), 48.0);
  let r = hash21(floor(in.uv * grid));
  return select(from_color(in.uv), to_color(in.uv), r < u.progress);
}
