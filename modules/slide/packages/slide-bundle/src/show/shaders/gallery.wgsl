// This file is part of paged (https://paged.media).
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-PMEL
// Copyright (c) And The Next GmbH
// #include "_prelude.wgsl"
//
// p14:gallery — the slides hang side by side on a wall that turns in
// perspective while it slides past. directions: l r.

const BG: vec4f = vec4f(0.08, 0.08, 0.09, 1.0);

// A slide on the wall at `slot` (centered units along the wall), the wall
// turned by `phi` about the vertical axis and pushed back by `z`.
fn on_wall(scr: vec2f, slot: f32, phi: f32, z: f32) -> vec4f {
  let w = ratio();
  let c = cos(phi);
  let s = sin(phi);
  let x0 = slot - w * 0.5;
  return plane_hit(scr, vec3f(x0 * c, -0.5, z + x0 * s), vec3f(w * c, 0.0, w * s), vec3f(0.0, 1.0, 0.0));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let p = u.progress;
  let scr = to_centered(in.uv);
  let sx = dir_vec(u.direction).x;
  let w = ratio();
  let bend = sin(p * PI);
  let phi = -sx * bend * 0.5;
  let z = bend * 0.9;
  let gap = w * 1.12;
  let a = on_wall(scr, sx * p * gap, phi, z);
  let b = on_wall(scr, -sx * (1.0 - p) * gap, phi, z);
  if (b.w > 0.5) {
    return vec4f(to_color(b.xy).rgb * facing(phi), 1.0);
  }
  if (a.w > 0.5) {
    return vec4f(from_color(a.xy).rgb * facing(phi), 1.0);
  }
  return BG;
}
