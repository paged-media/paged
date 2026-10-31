// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:reveal — the outgoing slide slides away and fades, uncovering the
// incoming one; with thruBlk it fades out to black first.
// params: thruBlack (slot 0). directions: l r.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let d = dir_vec(u.direction);
  let p = u.progress;
  if (param(0u) > 0.5) {
    if (p < 0.5) {
      let q = p * 2.0;
      let src = in.uv - d * q * 0.3;
      let c = select(vec4f(0.0, 0.0, 0.0, 1.0), from_color(src), inside(src));
      return opaque(vec4f(c.rgb * (1.0 - q), 1.0));
    }
    let q = p * 2.0 - 1.0;
    let src = in.uv + d * (1.0 - q) * 0.15;
    let c = select(vec4f(0.0, 0.0, 0.0, 1.0), to_color(src), inside(src));
    return opaque(vec4f(c.rgb * q, 1.0));
  }
  let k = 0.92 + 0.08 * p;
  let under = to_color((in.uv - vec2f(0.5)) / k + vec2f(0.5));
  let src = in.uv - d * p * 0.6;
  if (!inside(src)) {
    return under;
  }
  return mix(under, from_color(src), 1.0 - p);
}
