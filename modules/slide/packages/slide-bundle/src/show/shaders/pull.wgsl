// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:pull — the outgoing slide slides off, uncovering the incoming one.
// directions: l r u d lu ru ld rd.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let d = dir_vec(u.direction);
  let src = in.uv - d * u.progress;
  if (inside(src)) {
    return from_color(src);
  }
  return to_color(in.uv);
}
