// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:cover — the incoming slide slides in over the outgoing one.
// directions: l r u d lu ru ld rd.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let d = dir_vec(u.direction);
  let src = in.uv + d * (1.0 - u.progress);
  if (inside(src)) {
    return to_color(src);
  }
  return from_color(in.uv);
}
