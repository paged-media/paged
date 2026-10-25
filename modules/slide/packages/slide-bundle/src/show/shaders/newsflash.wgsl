// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:newsflash — the incoming slide spins in from the centre, growing.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  if (p <= 0.0) {
    return from_color(in.uv);
  }
  let q = rot2(-(1.0 - p) * 2.0 * TAU) * to_centered(in.uv) / p;
  let src = from_centered(q);
  if (inside(src)) {
    return to_color(src);
  }
  return from_color(in.uv);
}
