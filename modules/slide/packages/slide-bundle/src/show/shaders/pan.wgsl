// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:pan — the view pans from the outgoing slide to the incoming one,
// pulling back a little on the way. directions: l r u d.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let d = dir_vec(u.direction);
  let k = 1.0 - 0.22 * sin(p * PI);
  let z = from_centered(to_centered(in.uv) / k);
  let gap = 1.06;
  let ease = p * p * (3.0 - 2.0 * p);
  let src = z - d * ease * gap;
  if (inside(src)) {
    return from_color(src);
  }
  let src2 = src + d * gap;
  if (inside(src2)) {
    return to_color(src2);
  }
  return BG;
}
