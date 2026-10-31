// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p:zoom — dir in: the incoming slide zooms up from the centre; dir out: the
// outgoing slide shrinks into the centre over the incoming one.
// directions: in out.

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let c = in.uv - vec2f(0.5);
  if (u.direction == DIR_IN) {
    if (p <= 0.0) {
      return from_color(in.uv);
    }
    let src = c / p + vec2f(0.5);
    if (!inside(src)) {
      return from_color(in.uv);
    }
    return mix(from_color(in.uv), to_color(src), min(1.0, p * 3.0));
  }
  let k = 1.0 - p;
  if (k <= 0.0) {
    return to_color(in.uv);
  }
  let src = c / k + vec2f(0.5);
  if (!inside(src)) {
    return to_color(in.uv);
  }
  return mix(to_color(in.uv), from_color(src), min(1.0, k * 3.0));
}
