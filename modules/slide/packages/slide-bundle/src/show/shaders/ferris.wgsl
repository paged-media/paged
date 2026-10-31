// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:ferris — the slides ride a Ferris wheel: the outgoing one swings
// away along the wheel's arc, the incoming one swings in, both upright.
// 2D: the wheel turns in the slide plane. directions: l r.

const BG: vec4f = vec4f(0.0, 0.0, 0.0, 1.0);

fn gondola(angle: f32, radius: f32) -> vec2f {
  // The card centre's offset when the wheel (hub `radius` below the centre)
  // has turned by `angle` (positive = clockwise, y down).
  return vec2f(radius * sin(angle), radius * (1.0 - cos(angle)));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let q = to_centered(in.uv);
  let sx = dir_vec(u.direction).x;
  // A quarter-turn of arc between the two seats, on a wheel just big enough
  // that a seat a quarter-turn away is clear of the slide.
  let reach = PI * 0.25;
  let radius = (ratio() + 0.05) / sin(reach);
  let ot = gondola(sx * p * reach, radius);
  let it = gondola(-sx * (1.0 - p) * reach, radius);
  let si = from_centered(q - it);
  if (inside(si)) {
    return to_color(si);
  }
  let so = from_centered(q - ot);
  if (inside(so)) {
    return from_color(so);
  }
  return BG;
}
