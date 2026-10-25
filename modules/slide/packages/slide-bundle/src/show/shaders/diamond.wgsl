// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:diamond — the incoming slide grows in a diamond from the centre.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let q = abs(to_centered(in.uv));
  let n = vec2f(q.x / (ratio() * 0.5), q.y / 0.5);
  let s = (n.x + n.y) * 0.5;
  return mix(from_color(in.uv), to_color(in.uv), reveal(s, u.progress, 0.04));
}
