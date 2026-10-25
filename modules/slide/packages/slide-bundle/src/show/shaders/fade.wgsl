// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:fade — a cross-fade; with thruBlk, out to black and in from black.
// params: thruBlack (slot 0).

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let a = from_color(in.uv);
  let b = to_color(in.uv);
  if (param(0u) > 0.5) {
    let black = vec4f(0.0, 0.0, 0.0, 1.0);
    if (p < 0.5) {
      return mix(a, black, p * 2.0);
    }
    return mix(black, b, p * 2.0 - 1.0);
  }
  return mix(a, b, p);
}
