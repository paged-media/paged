// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p15:prstTrans prst="curtains" — the outgoing slide is a pair of stage
// curtains drawn aside to the left and right, gathering into folds.

fn curtain(f: f32, gather: f32) -> f32 {
  // Shading of a fold at position f (0 = inner edge, 1 = wing) as the
  // curtain gathers.
  return 1.0 - gather * 0.35 * (0.5 + 0.5 * cos(f * 46.0));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let ease = p * p * (3.0 - 2.0 * p);
  let half_w = 0.5 * (1.0 - ease);
  // The hem lifts a little towards the wings as the curtains open.
  let lift = ease * 0.12;
  if (half_w <= 0.0) {
    return to_color(in.uv);
  }
  let x = in.uv.x;
  if (x < half_w) {
    let f = x / half_w;
    let hem = 1.0 - lift * (1.0 - f);
    if (in.uv.y <= hem) {
      let src = vec2f(f * 0.5, in.uv.y / hem);
      return vec4f(from_color(src).rgb * curtain(1.0 - f, ease), 1.0);
    }
  } else if (x > 1.0 - half_w) {
    let f = (1.0 - x) / half_w;
    let hem = 1.0 - lift * (1.0 - f);
    if (in.uv.y <= hem) {
      let src = vec2f(1.0 - f * 0.5, in.uv.y / hem);
      return vec4f(from_color(src).rgb * curtain(1.0 - f, ease), 1.0);
    }
  }
  return to_color(in.uv);
}
