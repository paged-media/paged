// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:wipe — a soft edge travels in `dir` and uncovers the incoming slide.
// directions: l r u d.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let s = along(in.uv, dir_vec(u.direction));
  return mix(from_color(in.uv), to_color(in.uv), reveal(s, u.progress, 0.08));
}
